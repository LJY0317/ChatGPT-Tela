import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { startCustomMcpHttpServer, type TurnBridgeBackend } from "@chatgpt-tela/mcp";
import {
  CHATGPT_TELA_UNIFIED_CODEX_CALL,
  CHATGPT_TELA_UNIFIED_CODEX_INVENTORY,
  UNIFIED_CHAT_TOOL_DEFINITIONS,
  createUnifiedDevelopmentMcpServer,
} from "./unified-server";

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as unknown;
  if (!Array.isArray(content) || content.length !== 1) throw new Error("expected one MCP text content item");
  const item = content[0] as { type?: unknown; text?: unknown };
  if (item.type !== "text" || typeof item.text !== "string") throw new Error("expected MCP text content");
  return item.text;
}

describe("unified ChatGPT Tela development MCP", () => {
  test("one schema exposes stable Chat tools plus two dynamic Codex control tools", async () => {
    const chatCalls: Array<{ capability: string; arguments_: Readonly<Record<string, unknown>> }> = [];
    const chat = {
      async call(capability: string, arguments_: Readonly<Record<string, unknown>>) {
        chatCalls.push({ capability, arguments_ });
        if (capability === "show_changes") throw new Error("Tela Chat backend unavailable fixture");
        return { capability, ok: true };
      },
    };
    const codex: TurnBridgeBackend = {
      async inventory(capability, query = "") {
        return [{
          wireName: "future_native_tool_2099",
          name: "future_native_tool_2099",
          kind: "function",
          description: `runtime future tool ${query}`,
          inputSchema: { type: "object" },
          observedFrom: [capability],
        }];
      },
      async invoke(_capability, invocation) {
        return { callId: invocation.callId, content: `invoked:${invocation.wireName}`, isError: false };
      },
    };
    const server = await startCustomMcpHttpServer({
      createServer: () => createUnifiedDevelopmentMcpServer({ chat, codex }),
      label: "unified-development-test",
    });
    const transport = new StreamableHTTPClientTransport(server.endpointUrl, {
      requestInit: { headers: { authorization: `Bearer ${server.bearerToken}` } },
    });
    const client = new Client({ name: "tela-unified-test", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport as unknown as Transport);
      const listed = await client.listTools();
      const expected = [
        ...UNIFIED_CHAT_TOOL_DEFINITIONS.map(tool => tool.name),
        CHATGPT_TELA_UNIFIED_CODEX_INVENTORY,
        CHATGPT_TELA_UNIFIED_CODEX_CALL,
      ].sort();
      expect(listed.tools.map(tool => tool.name).sort()).toEqual(expected);
      expect(listed.tools.map(tool => tool.name)).not.toContain("future_native_tool_2099");

      const chatResult = await client.callTool({
        name: "tela_chat_read",
        arguments: { workspace_id: "chatws_fixture", path: "README.md", offset: 1, limit: 2 },
      });
      expect(chatResult.isError).not.toBe(true);
      expect(JSON.parse(text(chatResult))).toEqual({ capability: "read", ok: true });
      expect(chatCalls[0]).toEqual({
        capability: "read",
        arguments_: { workspace_id: "chatws_fixture", path: "README.md", offset: 1, limit: 2 },
      });

      const agentResult = await client.callTool({
        name: "tela_chat_start_agent",
        arguments: {
          workspace_id: "chatws_fixture",
          target: "openai-responses",
          prompt: "Inspect this workspace",
          write_mode: "read_only",
        },
      });
      expect(agentResult.isError).not.toBe(true);
      expect(JSON.parse(text(agentResult))).toEqual({ capability: "start_agent", ok: true });
      expect(chatCalls[1]).toEqual({
        capability: "start_agent",
        arguments_: {
          workspace_id: "chatws_fixture",
          target: "openai-responses",
          prompt: "Inspect this workspace",
          write_mode: "read_only",
        },
      });

      const chatFailure = await client.callTool({
        name: "tela_chat_show_changes",
        arguments: { workspace_id: "chatws_fixture" },
      });
      expect(chatFailure.isError).toBe(true);
      expect(text(chatFailure)).toContain("Chat backend unavailable fixture");

      const inventory = await client.callTool({
        name: CHATGPT_TELA_UNIFIED_CODEX_INVENTORY,
        arguments: { turn_capability: `turnr_ProfileA1_${"x".repeat(43)}`, query: "future" },
      });
      expect(inventory.isError).not.toBe(true);
      expect(JSON.parse(text(inventory))[0].wireName).toBe("future_native_tool_2099");

      const invoked = await client.callTool({
        name: CHATGPT_TELA_UNIFIED_CODEX_CALL,
        arguments: {
          turn_capability: `turnr_ProfileA1_${"x".repeat(43)}`,
          call_id: "call-future",
          wire_name: "future_native_tool_2099",
          mode: "structured",
          arguments: { arbitrary: true },
        },
      });
      expect(text(invoked)).toBe("invoked:future_native_tool_2099");
    } finally {
      await client.close().catch(() => {});
      await server.stop();
    }
  });
});
