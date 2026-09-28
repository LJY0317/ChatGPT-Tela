import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  NativeToolCatalogEntry,
  NativeToolInvocation,
  NativeToolKind,
  NativeToolResult,
} from "@chatgpt-tela/core";
import {
  CHATGPT_TELA_CODEX_TOOL_CALL,
  CHATGPT_TELA_CODEX_TOOL_INVENTORY,
} from "./public-abi";
import type { TurnBridgeBackend } from "./turn-bridge";

export interface RemoteTurnBridge extends TurnBridgeBackend {
  close(): Promise<void>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function textContent(result: unknown): string {
  const root = record(result);
  if (!root || !Array.isArray(root.content) || root.content.length !== 1) {
    throw new Error("remote turn bridge returned an invalid text result");
  }
  const item = record(root.content[0]);
  if (!item || item.type !== "text" || typeof item.text !== "string") {
    throw new Error("remote turn bridge returned an invalid text result");
  }
  return item.text;
}

const TOOL_KINDS = new Set<NativeToolKind>(["function", "freeform", "discovery", "gateway", "other"]);

function inventoryEntry(value: unknown): NativeToolCatalogEntry {
  const item = record(value);
  if (!item
    || typeof item.wireName !== "string" || !item.wireName
    || typeof item.name !== "string" || !item.name
    || typeof item.description !== "string"
    || typeof item.kind !== "string" || !TOOL_KINDS.has(item.kind as NativeToolKind)
    || (item.namespace !== undefined && typeof item.namespace !== "string")
    || (item.inputSchema !== undefined && !record(item.inputSchema))) {
    throw new Error("remote turn bridge returned an invalid Native tool inventory entry");
  }
  return Object.freeze({
    wireName: item.wireName,
    name: item.name,
    ...(typeof item.namespace === "string" ? { namespace: item.namespace } : {}),
    kind: item.kind as NativeToolKind,
    description: item.description,
    ...(item.inputSchema !== undefined
      ? { inputSchema: Object.freeze({ ...(item.inputSchema as Record<string, unknown>) }) }
      : {}),
    observedFrom: Object.freeze(["remote-turn-bridge"]),
  });
}

export async function connectCodexTurnBridge(input: {
  readonly endpoint: URL | string;
  readonly bearerToken: string;
  readonly clientName?: string;
}): Promise<RemoteTurnBridge> {
  if (input.bearerToken.length < 32) throw new Error("remote turn bridge bearer token is too short");
  const endpoint = input.endpoint instanceof URL ? new URL(input.endpoint.href) : new URL(input.endpoint);
  if (endpoint.protocol !== "http:"
    || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) {
    throw new Error("remote turn bridge endpoint must use loopback http://");
  }
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { authorization: `Bearer ${input.bearerToken}` } },
  });
  const client = new Client({ name: input.clientName ?? "chatgpt-tela-remote-turn-bridge", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport as unknown as Transport);
  let closed = false;
  return Object.freeze({
    async inventory(capability: string, query = "") {
      const result = await client.callTool({
        name: CHATGPT_TELA_CODEX_TOOL_INVENTORY,
        arguments: { turn_capability: capability, query },
      });
      if (result.isError) throw new Error("remote turn bridge rejected Native tool inventory request");
      let parsed: unknown;
      try { parsed = JSON.parse(textContent(result)); }
      catch (error) { throw new Error("remote turn bridge returned invalid Native tool inventory JSON", { cause: error }); }
      if (!Array.isArray(parsed)) throw new Error("remote turn bridge returned a non-array Native tool inventory");
      return Object.freeze(parsed.map(inventoryEntry));
    },
    async invoke(capability: string, invocation: NativeToolInvocation): Promise<NativeToolResult> {
      const arguments_ = invocation.mode === "structured"
        ? {
            turn_capability: capability,
            call_id: invocation.callId,
            wire_name: invocation.wireName,
            mode: "structured" as const,
            arguments: invocation.arguments,
          }
        : {
            turn_capability: capability,
            call_id: invocation.callId,
            wire_name: invocation.wireName,
            mode: "freeform" as const,
            input: invocation.input,
          };
      const result = await client.callTool({ name: CHATGPT_TELA_CODEX_TOOL_CALL, arguments: arguments_ });
      return Object.freeze({
        callId: invocation.callId,
        content: textContent(result),
        isError: result.isError === true,
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      await client.close();
    },
  });
}
