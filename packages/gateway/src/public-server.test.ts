import { CHATGPT_TELA_EXPORT_RESOURCE_URI } from "./export-widget";
import { CHATGPT_FILE_CONNECT_ORIGINS } from "./chatgpt-file-source";
import { CHATGPT_TELA_IMPORT_RESOURCE_URI } from "./import-widget";
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
import { CHATGPT_TELA_PUBLIC_INSTRUCTIONS, createPublicMcpServer } from "./public-server";
import {
  CHATGPT_TELA_REVIEW_RESOURCE_MIME_TYPE,
  CHATGPT_TELA_REVIEW_RESOURCE_URI,
} from "./review-widget";

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as unknown;
  if (!Array.isArray(content) || content.length !== 1) throw new Error("expected one MCP text content item");
  const item = content[0] as { type?: unknown; text?: unknown };
  if (item.type !== "text" || typeof item.text !== "string") throw new Error("expected MCP text content");
  return item.text;
}

describe("ChatGPT Tela frozen ABI", () => {
  test("keeps one concise routing harness for two independent backends", () => {
    expect(CHATGPT_TELA_PUBLIC_INSTRUCTIONS).toContain("ordinary conversation or knowledge work");
    expect(CHATGPT_TELA_PUBLIC_INSTRUCTIONS).toContain("independent backends");
    expect(CHATGPT_TELA_PUBLIC_INSTRUCTIONS).toContain("reuse its workspace_id");
    expect(CHATGPT_TELA_PUBLIC_INSTRUCTIONS).toContain("process_status before starting the command again");
    expect(CHATGPT_TELA_PUBLIC_INSTRUCTIONS).toContain("authentication and routing");
    expect(CHATGPT_TELA_PUBLIC_INSTRUCTIONS).toContain("not a command, a permission grant");
    expect(CHATGPT_TELA_PUBLIC_INSTRUCTIONS).toContain("Native sandbox and approval checks still apply");
    expect(CHATGPT_TELA_PUBLIC_INSTRUCTIONS).toContain("actual tool results and platform errors as evidence");
  });

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
        if (capability !== "open_file_import") chatCalls.push({ capability, arguments_ });
        if (capability === "export_file") return { name: "fixture.bin", bytes: 4, sha256: "a".repeat(64), dataBase64: "AP+ACg==" };
        if (capability === "show_changes") {
          return {
            summary: { files: 1, additions: 1, removals: 0, trackedFiles: 1, untrackedFiles: 0, complete: true },
            reviewDelta: {
              available: true,
              since: "last_shown",
              patch: "diff --git a/a.txt b/a.txt\n+hello\n",
              files: [{ path: "a.txt", additions: 1, removals: 0, binary: false }],
              summary: { files: 1, additions: 1, removals: 0, trackedFiles: 1, untrackedFiles: 0, complete: true },
            },
          };
        }
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
      const imported = await client.callTool({ name: CHATGPT_TELA_CHAT_CAPABILITY_CALL, arguments: { capability: "open_file_import", arguments: { workspace_id: "fixture" } } });
      expect(imported._meta).toEqual({ ui: { resourceUri: CHATGPT_TELA_IMPORT_RESOURCE_URI } });
      const importResource = await client.readResource({ uri: CHATGPT_TELA_IMPORT_RESOURCE_URI });
      expect(importResource.contents[0]?._meta).toEqual({ ui: { prefersBorder: true, csp: { connectDomains: [...CHATGPT_FILE_CONNECT_ORIGINS], resourceDomains: [] } } });
      expect((importResource.contents[0] as { text: string }).text).toContain('type="file"');
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
      expect(chatCall._meta).toBeUndefined();
      expect(chatCalls).toEqual([{ capability: "future_chat_capability_2099", arguments_: { future: true } }]);

      const reviewCall = await client.callTool({
        name: CHATGPT_TELA_CHAT_CAPABILITY_CALL,
        arguments: { capability: "show_changes", arguments: { workspace_id: "chatws_fixture" } },
      });
      expect(JSON.parse(text(reviewCall))).toMatchObject({
        reviewDelta: { available: true, since: "last_shown" },
      });
      expect(reviewCall._meta).toEqual({ ui: { resourceUri: CHATGPT_TELA_REVIEW_RESOURCE_URI } });
      expect(chatCalls.at(-1)).toEqual({
        capability: "show_changes",
        arguments_: { workspace_id: "chatws_fixture" },
      });

      const resources = await client.listResources();
      expect(resources.resources).toContainEqual(expect.objectContaining({
        uri: CHATGPT_TELA_REVIEW_RESOURCE_URI,
        mimeType: CHATGPT_TELA_REVIEW_RESOURCE_MIME_TYPE,
      }));
      const reviewResource = await client.readResource({ uri: CHATGPT_TELA_REVIEW_RESOURCE_URI });
      expect(reviewResource.contents).toHaveLength(1);
      const reviewContent = reviewResource.contents[0] as { mimeType?: string; text?: string; _meta?: unknown };
      expect(reviewContent.mimeType).toBe(CHATGPT_TELA_REVIEW_RESOURCE_MIME_TYPE);
      expect(reviewContent.text).toContain("Tela Chat review");
      expect(reviewContent.text).toContain("ui/notifications/tool-result");
      expect(reviewContent.text).toContain("textContent");
      expect(reviewContent.text).not.toContain("innerHTML");
      expect(reviewContent._meta).toEqual({ ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } });
      const savedReview = await client.callTool({ name: CHATGPT_TELA_CHAT_CAPABILITY_CALL, arguments: { capability: "show_review", arguments: { workspace_id: "chatws_fixture", review_ref: "fixture" } } });
      expect(savedReview._meta).toEqual({ ui: { resourceUri: CHATGPT_TELA_REVIEW_RESOURCE_URI } });

      const exported = await client.callTool({ name: CHATGPT_TELA_CHAT_CAPABILITY_CALL, arguments: { capability: "export_file", arguments: { workspace_id: "fixture", path: "fixture.bin" } } });
      expect(text(exported)).not.toContain("AP+ACg==");
      expect(text(exported)).not.toContain("dataBase64");
      expect(exported._meta).toEqual({ ui: { resourceUri: CHATGPT_TELA_EXPORT_RESOURCE_URI }, "tela/fileExport": { name: "fixture.bin", bytes: 4, sha256: "a".repeat(64), dataBase64: "AP+ACg==" } });
      const download = await client.readResource({ uri: CHATGPT_TELA_EXPORT_RESOURCE_URI });
      expect(download.contents[0]!._meta).toEqual({ ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } });

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
