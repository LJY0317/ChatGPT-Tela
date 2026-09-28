import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CHATGPT_TELA_CODEX_TOOL_CALL,
  CHATGPT_TELA_CODEX_TOOL_INVENTORY,
  CHATGPT_TELA_CHAT_CAPABILITY_CALL,
  CHATGPT_TELA_CHAT_CAPABILITY_INVENTORY,
  CHATGPT_TELA_DISPLAY_NAME,
  CHATGPT_TELA_MCP_SERVER_NAME,
  CHATGPT_TELA_SCHEMA_FINGERPRINT,
  fingerprintMcpToolContracts,
  startCustomMcpHttpServer,
  type TurnBridgeBackend,
} from "@chatgpt-tela/mcp";
import type { ChatCapabilityContract } from "@chatgpt-tela/service-protocol";
import { createPublicMcpServer } from "./public-server";

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as unknown;
  if (!Array.isArray(content) || content.length !== 1) throw new Error("expected one MCP text content item");
  const item = content[0] as { type?: unknown; text?: unknown };
  if (item.type !== "text" || typeof item.text !== "string") throw new Error("expected MCP text content");
  return item.text;
}

describe("ChatGPT Tela frozen ABI", () => {
  test("exposes exactly four generic tools and freezes their real MCP schema fingerprint", async () => {
    const catalog: readonly ChatCapabilityContract[] = [{
      capability: "future_chat_capability_2099",
      description: "future runtime capability",
      inputSchema: { type: "object", properties: { future: { type: "boolean" } } },
    }];
    const chatCalls: Array<{ capability: string; arguments_: Readonly<Record<string, unknown>> }> = [];
    const chat = {
      async inventory(query = "") { return query ? catalog.filter(item => item.capability.includes(query)) : catalog; },
      async call(capability: string, arguments_: Readonly<Record<string, unknown>>) {
        chatCalls.push({ capability, arguments_ });
        return { capability, ok: true };
      },
    };
    const codex: TurnBridgeBackend = {
      async inventory(capability, query = "") {
        return [{ wireName: "future_native_tool_2099", name: "future_native_tool_2099", kind: "function",
          description: `future native ${query}`, inputSchema: { type: "object" }, observedFrom: [capability] }];
      },
      async invoke(_capability, invocation) {
        return { callId: invocation.callId, content: `invoked:${invocation.wireName}`, isError: false };
      },
    };
    const server = await startCustomMcpHttpServer({
      createServer: () => createPublicMcpServer({ chat, codex }),
      label: "stable-freeze-test",
    });
    const transport = new StreamableHTTPClientTransport(server.endpointUrl, {
      requestInit: { headers: { authorization: `Bearer ${server.bearerToken}` } },
    });
    const client = new Client({ name: "chatgpt-tela-public-test", version: "1.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport as unknown as Transport);
      const listed = await client.listTools();
      expect(listed.tools.map(tool => tool.name).sort()).toEqual([
        CHATGPT_TELA_CHAT_CAPABILITY_CALL,
        CHATGPT_TELA_CHAT_CAPABILITY_INVENTORY,
        CHATGPT_TELA_CODEX_TOOL_CALL,
        CHATGPT_TELA_CODEX_TOOL_INVENTORY,
      ].sort());
      expect(listed.tools.map(tool => tool.name)).not.toContain("future_chat_capability_2099");
      expect(listed.tools.map(tool => tool.name)).not.toContain("future_native_tool_2099");
      const fingerprint = fingerprintMcpToolContracts(listed.tools.map(tool => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema,
      })));
      expect(fingerprint).toBe(CHATGPT_TELA_SCHEMA_FINGERPRINT);
      expect(CHATGPT_TELA_DISPLAY_NAME).toBe("ChatGPT Tela");
      expect(CHATGPT_TELA_MCP_SERVER_NAME).toBe("chatgpt-tela");

      const chatInventory = await client.callTool({
        name: CHATGPT_TELA_CHAT_CAPABILITY_INVENTORY,
        arguments: { query: "future_chat" },
      });
      expect(JSON.parse(text(chatInventory))).toEqual(catalog);
      const chatCall = await client.callTool({
        name: CHATGPT_TELA_CHAT_CAPABILITY_CALL,
        arguments: { capability: "future_chat_capability_2099", arguments: { future: true } },
      });
      expect(JSON.parse(text(chatCall))).toEqual({ capability: "future_chat_capability_2099", ok: true });
      expect(chatCalls).toEqual([{ capability: "future_chat_capability_2099", arguments_: { future: true } }]);

      const codexInventory = await client.callTool({
        name: CHATGPT_TELA_CODEX_TOOL_INVENTORY,
        arguments: { turn_capability: `turnr_ProfileA1_${"x".repeat(43)}`, query: "future" },
      });
      expect(JSON.parse(text(codexInventory))[0].wireName).toBe("future_native_tool_2099");
    } finally {
      await client.close().catch(() => {});
      await server.stop();
    }
  });
});
