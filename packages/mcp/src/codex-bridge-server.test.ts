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
import {
  CHATGPT_TELA_CODEX_TOOL_CALL,
  CHATGPT_TELA_CODEX_TOOL_INVENTORY,
} from "./public-abi";
import { createCodexBridgeMcpServer } from "./codex-bridge-server";

function binding(): NativeTurnBinding {
  const tools = [{
    wireName: "exec_command",
    name: "exec_command",
    description: "Execute a command",
    kind: "function" as const,
    inputSchema: { type: "object", properties: { cmd: { type: "array", items: { type: "string" } } } },
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
    tools: NativeToolInventory.fromObservations("thread-1", "turn-1", [{ source: "fixture", tools }]),
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
  const server = createCodexBridgeMcpServer(turns);
  const client = new Client({ name: "chatgpt-tela-codex-bridge-test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

describe("ChatGPT Tela private Codex bridge MCP server", () => {
  test("exposes exactly the two stable Codex bridge controls", async () => {
    const connection = await connected(new ActiveTurnRegistry());
    try {
      const listed = await connection.client.listTools();
      expect(listed.tools.map(tool => tool.name).sort()).toEqual([
        CHATGPT_TELA_CODEX_TOOL_CALL,
        CHATGPT_TELA_CODEX_TOOL_INVENTORY,
      ]);
    } finally {
      await connection.client.close();
      await connection.server.close();
    }
  });

  test("relays one exact current-turn Native invocation through the public names", async () => {
    const turns = new ActiveTurnRegistry();
    const registered = turns.register(binding());
    registered.channel.markSubmitted();
    registered.channel.markAccepted();
    const connection = await connected(turns);
    try {
      const inventory = await connection.client.callTool({
        name: CHATGPT_TELA_CODEX_TOOL_INVENTORY,
        arguments: { turn_capability: registered.capability, query: "command" },
      });
      expect(inventory.isError).not.toBe(true);

      const call = connection.client.callTool({
        name: CHATGPT_TELA_CODEX_TOOL_CALL,
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
      const result = await call;
      expect(result.isError).not.toBe(true);
      expect(result.content as unknown).toEqual([{ type: "text", text: "ok" }]);
    } finally {
      await connection.client.close();
      await connection.server.close();
    }
  });
});
