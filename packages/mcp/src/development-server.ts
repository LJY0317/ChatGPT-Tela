import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { TurnCapabilityResolver } from "@chatgpt-tela/runtime";
import { registerTurnBridgeTools } from "./turn-server";
import { McpTurnBridge, type TurnBridgeBackend } from "./turn-bridge";

export const CHATGPT_TELA_DEVELOPMENT_MCP_SERVER_NAME = "chatgpt-tela-development";
export const CHATGPT_TELA_DEVELOPMENT_MCP_SERVER_VERSION = "0.0.0";
export type DevelopmentMcpTransport = Transport;

export interface DevelopmentMcpConnection {
  readonly server: McpServer;
  close(): Promise<void>;
}

/**
 * Unpublished development MCP surface. Tool names/schema may change until the first real connector
 * canary freezes ChatGPT Tela's public ABI. Runtime ownership remains in ActiveTurnRegistry/McpTurnBridge.
 */
export function createDevelopmentMcpServer(turns: TurnCapabilityResolver): McpServer {
  return createDevelopmentMcpServerForBridge(new McpTurnBridge(turns));
}

export function createDevelopmentMcpServerForBridge(bridge: TurnBridgeBackend): McpServer {
  const server = new McpServer({
    name: CHATGPT_TELA_DEVELOPMENT_MCP_SERVER_NAME,
    version: CHATGPT_TELA_DEVELOPMENT_MCP_SERVER_VERSION,
  }, {
    capabilities: { tools: { listChanged: false } },
    instructions: "Development-only ChatGPT Tela MCP bridge. A turn capability identifies exactly one active Native Codex turn.",
  });

  registerTurnBridgeTools(server, bridge, {
    inventory: "chatgpt_tela_dev_tool_inventory",
    call: "chatgpt_tela_dev_tool_call",
  }, {
    inventoryTitle: "ChatGPT Tela development tool inventory",
    inventoryDescription: "List Native Codex tools advertised by one exact active ChatGPT Tela turn.",
    callTitle: "ChatGPT Tela development Native tool call",
    callDescription: "Invoke one tool from the exact current-turn Native Codex inventory.",
  });

  return server;
}

export async function connectDevelopmentMcpServer(
  turns: TurnCapabilityResolver,
  transport: DevelopmentMcpTransport,
): Promise<DevelopmentMcpConnection> {
  const server = createDevelopmentMcpServer(turns);
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

export async function serveDevelopmentMcpStdio(turns: TurnCapabilityResolver): Promise<void> {
  await connectDevelopmentMcpServer(turns, new StdioServerTransport());
}
