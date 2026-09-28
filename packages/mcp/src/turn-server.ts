import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TurnBridgeBackend } from "./turn-bridge";

export interface TurnBridgeToolNames {
  readonly inventory: string;
  readonly call: string;
}

export interface TurnBridgeToolPresentation {
  readonly inventoryTitle: string;
  readonly inventoryDescription: string;
  readonly callTitle: string;
  readonly callDescription: string;
}

function jsonText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

async function inventoryPayload(bridge: TurnBridgeBackend, capability: string, query: string): Promise<string> {
  const tools = await bridge.inventory(capability, query);
  return JSON.stringify(tools.map(tool => ({
    wireName: tool.wireName,
    name: tool.name,
    ...(tool.namespace ? { namespace: tool.namespace } : {}),
    kind: tool.kind,
    description: tool.description,
    ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
  })));
}

/** Register the fixed two-tool turn bridge on one MCP server identity. */
export function registerTurnBridgeTools(
  server: McpServer,
  bridge: TurnBridgeBackend,
  names: TurnBridgeToolNames,
  presentation: TurnBridgeToolPresentation,
): void {
  server.registerTool(names.inventory, {
    title: presentation.inventoryTitle,
    description: presentation.inventoryDescription,
    inputSchema: z.object({
      turn_capability: z.string().min(20).max(256),
      query: z.string().max(1000).optional().default(""),
    }),
  }, async ({ turn_capability, query }) => ({
    content: [{ type: "text", text: await inventoryPayload(bridge, turn_capability, query) }],
  }));

  server.registerTool(names.call, {
    title: presentation.callTitle,
    description: presentation.callDescription,
    inputSchema: z.object({
      turn_capability: z.string().min(20).max(256),
      call_id: z.string().min(1).max(512),
      wire_name: z.string().min(1).max(1024),
      mode: z.enum(["structured", "freeform"]),
      arguments: z.record(z.string(), z.unknown()).optional(),
      input: z.string().optional(),
    }),
  }, async ({ turn_capability, call_id, wire_name, mode, arguments: args, input }) => {
    const invocation = mode === "structured"
      ? {
          callId: call_id,
          wireName: wire_name,
          mode: "structured" as const,
          arguments: args ?? {},
        }
      : {
          callId: call_id,
          wireName: wire_name,
          mode: "freeform" as const,
          input: input ?? "",
        };
    const result = await bridge.invoke(turn_capability, invocation);
    return {
      content: [{ type: "text", text: jsonText(result.content) }],
      ...(result.isError ? { isError: true } : {}),
    };
  });
}
