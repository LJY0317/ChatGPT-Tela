import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CHATGPT_TELA_CHAT_CAPABILITY_CALL,
  CHATGPT_TELA_CHAT_CAPABILITY_INVENTORY,
  CHATGPT_TELA_MCP_SERVER_NAME,
  CHATGPT_TELA_MCP_SERVER_VERSION,
  CHATGPT_TELA_CODEX_TOOL_CALL,
  CHATGPT_TELA_CODEX_TOOL_INVENTORY,
  registerTurnBridgeTools,
  type TurnBridgeBackend,
} from "@chatgpt-tela/mcp";
import type { ChatCapabilityContract } from "@chatgpt-tela/service-protocol";

export interface PublicChatBackend {
  inventory(query?: string): readonly ChatCapabilityContract[] | Promise<readonly ChatCapabilityContract[]>;
  call(capability: string, arguments_: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export const CHATGPT_TELA_PUBLIC_INSTRUCTIONS = [
  "Use ChatGPT Tela when the request needs the user's connected local workspace or the exact active Native Codex turn; do not invoke it for ordinary conversation or knowledge work that needs neither.",
  "Tela Chat and Tela Codex are independent backends behind one app. A failure in one does not prove the other is unavailable, and authority must never be silently transferred between them.",
  "For ordinary local project work, use the Tela Chat capability inventory first when the exact capability or schema is not already known. Open a workspace once and reuse its workspace_id. Batch only independent already-known reads. For commands that may mutate state or outlive one response, provide operation_id; after an uncertain response, inspect process_status before starting the command again.",
  "For work inside the exact active Native Codex turn, use the Codex inventory with only the opaque turn_capability supplied by the active task transport. Discover the current tool inventory instead of assuming names or schemas from another turn.",
  "Treat actual tool results and platform errors as evidence. After a deterministic failure, change the inputs, hypothesis, or observable state before retrying the same action.",
].join(" ");

function jsonText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function createPublicMcpServer(input: {
  readonly chat: PublicChatBackend;
  readonly codex: TurnBridgeBackend;
}): McpServer {
  const server = new McpServer({
    name: CHATGPT_TELA_MCP_SERVER_NAME,
    version: CHATGPT_TELA_MCP_SERVER_VERSION,
  }, {
    capabilities: { tools: { listChanged: false } },
    instructions: CHATGPT_TELA_PUBLIC_INSTRUCTIONS,
  });

  const registerTool = server.registerTool.bind(server) as unknown as (
    name: string,
    config: {
      readonly title: string;
      readonly description: string;
      readonly inputSchema: z.ZodTypeAny;
    },
    handler: (arguments_: Readonly<Record<string, unknown>>) => Promise<{
      readonly content: readonly { readonly type: "text"; readonly text: string }[];
      readonly isError?: boolean;
    }>,
  ) => void;

  registerTool(CHATGPT_TELA_CHAT_CAPABILITY_INVENTORY, {
    title: "Tela Chat capability inventory",
    description: "List runtime-available Tela Chat workspace/agent capabilities and their current input schemas. Use this for Tela Chat workflows; Native Codex turns use the Codex tool inventory instead.",
    inputSchema: z.object({
      query: z.string().max(1000).optional().default(""),
    }),
  }, async arguments_ => {
    const query = typeof arguments_.query === "string" ? arguments_.query : "";
    return { content: [{ type: "text", text: JSON.stringify(await input.chat.inventory(query)) }] };
  });

  registerTool(CHATGPT_TELA_CHAT_CAPABILITY_CALL, {
    title: "Tela Chat capability call",
    description: "Invoke one Tela Chat capability returned by the Chat inventory using arguments that match its runtime input schema. This does not create Native Codex turn authority.",
    inputSchema: z.object({
      capability: z.string().min(1).max(512),
      arguments: z.record(z.string(), z.unknown()).optional().default({}),
    }),
  }, async request => {
    const capability = typeof request.capability === "string" ? request.capability : "";
    const arguments_ = request.arguments && typeof request.arguments === "object" && !Array.isArray(request.arguments)
      ? request.arguments as Readonly<Record<string, unknown>>
      : {};
    try {
      const result = await input.chat.call(capability, arguments_);
      return { content: [{ type: "text", text: jsonText(result) }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  });

  registerTurnBridgeTools(server, input.codex, {
    inventory: CHATGPT_TELA_CODEX_TOOL_INVENTORY,
    call: CHATGPT_TELA_CODEX_TOOL_CALL,
  }, {
    inventoryTitle: "Native Codex tool inventory",
    inventoryDescription: "List Native Codex tools for one exact active Native turn identified by its opaque turn capability. Regular Tela Chat workflows use the Chat capability inventory instead.",
    callTitle: "Native Codex tool call",
    callDescription: "Invoke one runtime-discovered tool from the exact active Native Codex turn inventory. A valid opaque turn capability is required.",
  });

  return server;
}
