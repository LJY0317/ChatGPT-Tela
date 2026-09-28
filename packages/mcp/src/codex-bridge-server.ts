import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { TurnCapabilityResolver } from "@chatgpt-tela/runtime";
import {
  CHATGPT_TELA_CODEX_TOOL_CALL,
  CHATGPT_TELA_CODEX_TOOL_INVENTORY,
} from "./public-abi";
import { registerTurnBridgeTools } from "./turn-server";
import { McpTurnBridge, type TurnBridgeBackend } from "./turn-bridge";

export type CodexBridgeMcpTransport = Transport;

export interface CodexBridgeMcpConnection {
  readonly server: McpServer;
  close(): Promise<void>;
}

/** Private two-tool bridge used between one profile runtime and Tela Codex. */
export function createCodexBridgeMcpServer(turns: TurnCapabilityResolver): McpServer {
  return createCodexBridgeMcpServerForBridge(new McpTurnBridge(turns));
}

export function createCodexBridgeMcpServerForBridge(bridge: TurnBridgeBackend): McpServer {
  const server = new McpServer({
    name: "chatgpt-tela-codex-bridge",
    version: "1.0.0",
  }, {
    capabilities: { tools: { listChanged: false } },
    instructions: "Private ChatGPT Tela Codex bridge. A turn capability identifies exactly one active Native Codex turn.",
  });

  registerTurnBridgeTools(server, bridge, {
    inventory: CHATGPT_TELA_CODEX_TOOL_INVENTORY,
    call: CHATGPT_TELA_CODEX_TOOL_CALL,
  }, {
    inventoryTitle: "Native Codex tool inventory",
    inventoryDescription: "List Native Codex tools available to one exact active ChatGPT Tela turn.",
    callTitle: "Native Codex tool call",
    callDescription: "Invoke one tool from the exact active Native Codex turn inventory.",
  });
  return server;
}

export async function connectCodexBridgeMcpServer(
  turns: TurnCapabilityResolver,
  transport: CodexBridgeMcpTransport,
): Promise<CodexBridgeMcpConnection> {
  const server = createCodexBridgeMcpServer(turns);
  await server.connect(transport);
  let closed = false;
  return Object.freeze({
    server,
    async close() {
      if (closed) return;
      closed = true;
      await server.close();
    },
  });
}

export async function serveCodexBridgeMcpStdio(turns: TurnCapabilityResolver): Promise<void> {
  await connectCodexBridgeMcpServer(turns, new StdioServerTransport());
}
