import { createHash } from "node:crypto";
import { diagnosticFingerprint, emitDiagnosticEvent, isNativeGoalTool } from "@chatgpt-tela/core";
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
    const goalControl = this.turns.resolveGoalControl?.(capability);
    const channel = goalControl ?? this.turns.resolve(capability);
    const tool = channel.binding.tools.exact(invocation.wireName);
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
          goal_only: !!goalControl, goal_tool: !!tool && isNativeGoalTool(tool), ...project(),
        };
      } catch { return; }
      emitDiagnosticEvent("chatgpt_tela_work", stage, fields);
    };
    trace("native_tool_bridge_invoke_started");
    try {
      if (goalControl && (!tool || !isNativeGoalTool(tool))) throw Error("Goal control cannot invoke Native work tools");
      return channel.requestTool(goalControl ? { ...invocation, callId } : invocation).then(result => {
        trace("native_tool_bridge_invoke_returned", () => resultEvidence(result, !!tool && isNativeGoalTool(tool)));
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
