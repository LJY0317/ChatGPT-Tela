import { diagnosticFingerprint, emitDiagnosticEvent } from "@chatgpt-tela/core";
import type {
  NativeToolCatalogEntry,
  NativeToolInvocation,
  NativeToolResult,
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
    const channel = this.turns.resolve(capability);
    const tools = channel.binding.tools.search(query);
    emitDiagnosticEvent("chatgpt_tela_work", "native_tool_inventory_queried", {
      scope_fingerprint: diagnosticFingerprint(channel.binding.authority.threadId),
      turn_fingerprint: diagnosticFingerprint(channel.binding.authority.turnId),
      query_empty: query.length === 0, count: tools.length,
    });
    return tools;
  }

  invoke(capability: string, invocation: NativeToolInvocation): Promise<NativeToolResult> {
    return this.turns.resolve(capability).requestTool(invocation);
  }
}
