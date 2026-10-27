import { createHash } from "node:crypto";
import { CONTEXT_HISTORY_TOOL, diagnosticFingerprint, emitDiagnosticEvent, isNativeGoalTool } from "@chatgpt-tela/core";
import type {
  NativeToolCatalogEntry,
  NativeToolInvocation,
  NativeToolResult,
  DiagnosticScalar,
} from "@chatgpt-tela/core";
import type { TurnCapabilityResolver } from "@chatgpt-tela/runtime";

export interface TurnBridgeBackend {
  inventory(
    capability: string,
    query?: string,
  ): readonly NativeToolCatalogEntry[] | Promise<readonly NativeToolCatalogEntry[]>;
  invoke(capability: string, invocation: NativeToolInvocation): Promise<NativeToolResult>;
}

/**
 * Internal MCP-facing turn bridge used while ChatGPT Tela's public connector ABI is still unpublished.
 * It deliberately owns no connector name or schema generation; those are frozen only after a real
 * end-to-end tool round proves the contract.
 */
export class McpTurnBridge implements TurnBridgeBackend {
  constructor(readonly turns: TurnCapabilityResolver) {}

  inventory(capability: string, query = ""): readonly NativeToolCatalogEntry[] {
    const goalControl = this.turns.resolveGoalControl?.(capability);
    const channel = goalControl ?? this.turns.resolve(capability);
    const tools = channel.binding.tools.search(query).filter(tool => !goalControl || isNativeGoalTool(tool));
    let fields: Record<string, DiagnosticScalar>;
    try {
      fields = {
        scope_fingerprint: diagnosticFingerprint(channel.binding.authority.threadId),
        turn_fingerprint: diagnosticFingerprint(channel.binding.authority.turnId),
        goal_only: !!goalControl, query_empty: query.length === 0, count: tools.length,
      };
    } catch { return tools; }
    emitDiagnosticEvent("chatgpt_tela_work", "native_tool_inventory_queried", fields);
    return tools;
  }

  invoke(capability: string, invocation: NativeToolInvocation): Promise<NativeToolResult> {
    if (invocation.wireName === CONTEXT_HISTORY_TOOL.wireName) {
      if (!this.turns.readHistoryPage || invocation.mode !== "structured") throw Error("history read is unavailable");
      const { turn_id, cursor, offset_bytes, page_digest } = invocation.arguments;
      const anchor = cursor && typeof cursor === "object" && !Array.isArray(cursor)
        ? cursor as Record<string, unknown> : undefined;
      if (Object.keys(invocation.arguments).some(key => !["turn_id", "cursor", "offset_bytes", "page_digest"].includes(key))
        || typeof turn_id !== "string" || !turn_id.trim()
        || offset_bytes !== undefined && (!Number.isSafeInteger(offset_bytes) || (offset_bytes as number) < 0)
        || page_digest !== undefined && typeof page_digest !== "string"
        || cursor !== undefined && !(typeof cursor === "string" && cursor.length > 0)
          && !(anchor?.type === "item" && typeof anchor.itemId === "string" && anchor.itemId.length > 0
            && Object.keys(anchor).length === 2)) throw Error("invalid history page selection");
      return this.turns.readHistoryPage(capability, { turnId: turn_id, limit: 4,
        ...(cursor === undefined ? {} : { cursor: cursor as string | { type: "item"; itemId: string } }),
        ...(offset_bytes === undefined ? {} : { offsetBytes: offset_bytes as number }),
        ...(page_digest === undefined ? {} : { pageDigest: page_digest as string }),
      }).then(content => ({ callId: invocation.callId, content: JSON.stringify(content), isError: false }));
    }
    const goalControl = this.turns.resolveGoalControl?.(capability);
    const channel = goalControl ?? this.turns.resolve(capability);
    const tool = channel.binding.tools.exact(invocation.wireName);
    const goalTool = !!goalControl && !!tool && isNativeGoalTool(tool);
    // An exact, bounded Goal intent groups repeated logical requests without
    // retaining argument bodies. The caller and Native operation remain distinct.
    let goalIntent: Record<string, DiagnosticScalar> = {};
    try {
      if (goalTool && invocation.mode === "structured") {
        const action = tool!.name === "get_goal" ? "read" : "update";
        const fields = invocation.arguments;
        const status = action === "read" && Object.keys(fields).length === 0 ? "read"
          : action === "update" && Object.keys(fields).length === 1
            && ["complete", "paused", "blocked"].includes(String(fields.status))
            ? String(fields.status) : "unknown";
        goalIntent = { action, status,
          parent_fingerprint: diagnosticFingerprint(invocation.callId),
          ...(status === "unknown" ? {} : { logical_fingerprint: diagnosticFingerprint(JSON.stringify([
            channel.binding.authority.threadId, channel.binding.authority.turnId, tool!.name, status,
          ])) }),
        };
      }
    } catch { /* Diagnostic-only projection must never replace the Native call. */ }
    // Use Native's correlation ID so these events join its existing tool lifecycle.
    const callId = goalControl ? "goal_" + createHash("sha256").update(JSON.stringify([
      channel.binding.authority.threadId, channel.binding.authority.turnId, invocation.callId,
    ])).digest("hex").slice(0, 56) : invocation.callId;
    const trace = (stage: string, project: () => Record<string, DiagnosticScalar> = () => ({})) => {
      let fields: Record<string, DiagnosticScalar>;
      try {
        fields = {
          scope_fingerprint: diagnosticFingerprint(channel.binding.authority.threadId),
          turn_fingerprint: diagnosticFingerprint(channel.binding.authority.turnId),
          operation_fingerprint: diagnosticFingerprint(callId),
          goal_only: !!goalControl, goal_tool: goalTool, ...goalIntent, ...project(),
        };
      } catch { return; }
      emitDiagnosticEvent("chatgpt_tela_work", stage, fields);
    };
    trace("native_tool_bridge_invoke_started");
    try {
      if (goalControl && (!tool || !isNativeGoalTool(tool))) throw Error("Goal control cannot invoke Native work tools");
      return channel.requestTool(goalControl ? { ...invocation, callId } : invocation).then(result => {
        trace("native_tool_bridge_invoke_returned", () => resultEvidence(result, goalTool));
        return goalControl ? { ...result, callId: invocation.callId } : result;
      }, error => {
        trace("native_tool_bridge_invoke_failed");
        throw error;
      });
    } catch (error) {
      trace("native_tool_bridge_invoke_failed");
      throw error;
    }
  }
}

/** Diagnostic projection only; never normalize or replace Native's product return value. */
function resultEvidence(result: NativeToolResult, goalTool: boolean): Record<string, DiagnosticScalar> {
  const body = result.content;
  const fields: Record<string, DiagnosticScalar> = {
    is_error: result.isError,
    kind: body === null ? "null" : Array.isArray(body) ? "array" : typeof body,
    body_present: body !== undefined && body !== null && body !== "",
    body_size_known: false,
  };
  try {
    const serialized = typeof body === "string" ? body : JSON.stringify(body);
    if (serialized !== undefined) {
      fields.body_bytes = Buffer.byteLength(serialized);
      fields.body_size_known = true;
    }
  } catch { /* Circular/non-JSON bodies still have structural evidence. */ }
  if (goalTool) {
    fields.status = "unknown";
    try {
      const parsed = typeof body === "string" ? JSON.parse(body) : body;
      const goal = parsed?.goal;
      if (goal === null) fields.status = "absent";
      else if (["active", "complete", "paused", "blocked"].includes(goal?.status)) fields.status = goal.status;
    } catch { /* An opaque/non-JSON Goal result is not an empty result. */ }
  }
  return fields;
}
