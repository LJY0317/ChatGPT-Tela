import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  NativeToolInventory,
  defineNativeTurnAuthority,
} from "@chatgpt-tela/core";
import type { NativeTurnBinding } from "@chatgpt-tela/codex";
import {
  ActiveTurnRegistry,
  acceptNativeResponsesToolResult,
  nextNativeResponsesToolCall,
} from "@chatgpt-tela/runtime";
import { fingerprintMcpToolContracts } from "./abi";
import { createDevelopmentMcpServer } from "./development-server";

function binding(): NativeTurnBinding {
  const tools = [{
    wireName: "exec_command",
    name: "exec_command",
    description: "Execute a command",
    kind: "function" as const,
    inputSchema: {
      type: "object",
      properties: { cmd: { type: "array", items: { type: "string" } } },
      required: ["cmd"],
    },
  }];
  return {
    claim: {
      threadId: "thread-1",
      turnId: "turn-1",
      requestKind: "turn",
      toolObservations: [{ source: "fixture", tools }],
    },
    authority: defineNativeTurnAuthority({
      threadId: "thread-1",
      turnId: "turn-1",
      cwd: "/workspace",
      workspaceRoots: ["/workspace"],
      sandbox: { kind: "read-only", network: "restricted" },
    }),
    tools: NativeToolInventory.fromObservations("thread-1", "turn-1", [
      { source: "fixture", tools },
    ]),
    canonicalEvidence: {
      threadId: "thread-1",
      turnId: "turn-1",
      cwd: "/workspace",
      workspaceRoots: ["/workspace"],
      sandbox: { kind: "read-only", network: "restricted" },
      proof: "turn-context",
      environmentSourceTurnId: "turn-1",
    },
  };
}

async function connected(turns: ActiveTurnRegistry) {
  const server = createDevelopmentMcpServer(turns);
  const client = new Client({ name: "chatgpt-tela-test-client", version: "0.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { server, client };
}

describe("unpublished development MCP server", () => {
  test("lists only ChatGPT Tela's development control tools", async () => {
    const turns = new ActiveTurnRegistry();
    const connection = await connected(turns);
    try {
      const listed = await connection.client.listTools();
      expect(listed.tools.map(tool => tool.name).sort()).toEqual([
        "chatgpt_tela_dev_tool_call",
        "chatgpt_tela_dev_tool_inventory",
      ]);
      expect(fingerprintMcpToolContracts(listed.tools.map(tool => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema,
      })))).toBe("cff62bee1aeca5d887522df6b6685418fba8d895638ca2abad726c2ff9d367cd");
    } finally {
      await connection.client.close();
      await connection.server.close();
    }
  });

  test("inventory and call stay scoped to one opaque active-turn capability", async () => {
    const turns = new ActiveTurnRegistry();
    const registered = turns.register(binding());
    registered.channel.markSubmitted();
    registered.channel.markAccepted();
    const connection = await connected(turns);
    try {
      const inventory = await connection.client.callTool({
        name: "chatgpt_tela_dev_tool_inventory",
        arguments: { turn_capability: registered.capability, query: "command" },
      });
      expect(inventory.isError).not.toBe(true);
      const inventoryContent = inventory.content as unknown[];
      const inventoryText = inventoryContent[0] as { type?: unknown; text?: unknown } | undefined;
      expect(inventoryText?.type).toBe("text");
      if (inventoryText?.type !== "text" || typeof inventoryText.text !== "string") {
        throw new Error("expected text inventory result");
      }
      expect(JSON.parse(inventoryText.text)).toEqual([{
        wireName: "exec_command",
        name: "exec_command",
        kind: "function",
        description: "Execute a command",
        inputSchema: {
          type: "object",
          properties: { cmd: { type: "array", items: { type: "string" } } },
          required: ["cmd"],
        },
      }]);

      const mcpCall = connection.client.callTool({
        name: "chatgpt_tela_dev_tool_call",
        arguments: {
          turn_capability: registered.capability,
          call_id: "call-1",
          wire_name: "exec_command",
          mode: "structured",
          arguments: { cmd: ["printf", "ok"] },
        },
      });
      expect(await nextNativeResponsesToolCall(registered.channel)).toEqual({
        type: "function_call",
        call_id: "call-1",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: ["printf", "ok"] }),
      });
      acceptNativeResponsesToolResult(registered.channel, {
        input: [{ type: "function_call_output", call_id: "call-1", output: "ok" }],
      });
      registered.channel.releaseNativeToolResultToWeb("call-1");

      const result = await mcpCall;
      expect(result.isError).not.toBe(true);
      expect(result.content as unknown).toEqual([{ type: "text", text: "ok" }]);

      turns.retire(registered.capability);
      const retired = await connection.client.callTool({
        name: "chatgpt_tela_dev_tool_inventory",
        arguments: { turn_capability: registered.capability },
      });
      expect(retired.isError).toBe(true);
    } finally {
      await connection.client.close();
      await connection.server.close();
    }
  });
});
