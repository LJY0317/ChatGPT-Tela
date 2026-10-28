import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnosticFingerprint, readDiagnosticTail, structuralDiagnosticEvent } from "@chatgpt-tela/core";
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
import { DynamicChatBackend } from "./dynamic-chat-backend";
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
    expect(CHATGPT_TELA_PUBLIC_INSTRUCTIONS).toContain("Omit it or use an empty string to discover all capabilities");
    expect(CHATGPT_TELA_PUBLIC_INSTRUCTIONS).toContain("Do not paste a user's full request, conversation titles");
    expect(CHATGPT_TELA_PUBLIC_INSTRUCTIONS).toContain("Inventory is read-only");
    expect(CHATGPT_TELA_PUBLIC_INSTRUCTIONS).toContain("process_status before starting the command again");
    expect(CHATGPT_TELA_PUBLIC_INSTRUCTIONS).toContain("identifying that exact local task for routing");
    expect(CHATGPT_TELA_PUBLIC_INSTRUCTIONS).toContain("continue the same user goal with another relevant available tool or method");
    expect(CHATGPT_TELA_PUBLIC_INSTRUCTIONS).toContain("actual tool results and platform errors as evidence");
    expect(CHATGPT_TELA_PUBLIC_INSTRUCTIONS).toContain("claim transport loss only when an explicit transport failure or connection-close event is observed");
    expect(CHATGPT_TELA_PUBLIC_INSTRUCTIONS).toContain("An HTTP rejection for one capability and an MCP isError response establish that call's failure");
    expect(CHATGPT_TELA_PUBLIC_INSTRUCTIONS).toContain("does not prove model receipt");
    expect(CHATGPT_TELA_PUBLIC_INSTRUCTIONS).toContain("Native Goal token counters do not establish Web usage or billing");
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
      const fullChatInventory = await client.callTool({
        name: CHATGPT_TELA_CHAT_CAPABILITY_INVENTORY,
        arguments: {},
      });
      expect(JSON.parse(text(fullChatInventory))).toEqual(catalog);
      const chatCall = await client.callTool({
        name: CHATGPT_TELA_CHAT_CAPABILITY_CALL,
        arguments: { capability: "future_chat_capability_2099", arguments: { future: true } },
      });
      expect(JSON.parse(text(chatCall))).toEqual({ capability: "future_chat_capability_2099", ok: true });
      expect(chatCall._meta).toBeUndefined();
      expect(chatCalls).toEqual([{ capability: "future_chat_capability_2099", arguments_: { future: true } }]);

      const imageCall = await client.callTool({ name: CHATGPT_TELA_CHAT_CAPABILITY_CALL,
        arguments: { capability: "view_image", arguments: { workspace_id: "fixture", path: "sample.png" } } });
      expect(imageCall.isError).toBe(true); // Fixture backend supplies no image receipt.

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


test("public Goal result uses Native MCP content and error semantics", async () => {
  const goalTools = [{ wireName: "get_goal", name: "get_goal", kind: "function" as const,
    description: "Read current Goal", observedFrom: ["native"] }];
  let failed = false;
  let empty = false;
  const bridge: TurnBridgeBackend = {
    inventory: () => goalTools,
    async invoke(_capability, invocation) {
      return { callId: invocation.callId, content: empty ? undefined : JSON.stringify({ goal: { status: failed ? "blocked" : "active" } }),
        isError: failed };
    },
  };
  const chat = new DynamicChatBackend(() => undefined, bridge);
  const server = await startCustomMcpHttpServer({ label: "goal-result-contract",
    createServer: () => createPublicMcpServer({ chat, codex: bridge }) });
  const transport = new StreamableHTTPClientTransport(server.endpointUrl, {
    requestInit: { headers: { authorization: `Bearer ${server.bearerToken}` } },
  });
  const client = new Client({ name: "goal-result-contract", version: "1" }, { capabilities: {} });
  try {
    await client.connect(transport as unknown as Transport);
    const inventory = await client.callTool({ name: CHATGPT_TELA_CHAT_CAPABILITY_CALL,
      arguments: { capability: "goal_control_inventory", arguments: { goal_control: "fixture" } } });
    expect(JSON.parse(text(inventory))).toMatchObject([{ name: "get_goal" }]);
    const invoke = () => client.callTool({ name: CHATGPT_TELA_CHAT_CAPABILITY_CALL,
      arguments: { capability: "goal_control_call", arguments: {
        goal_control: "fixture", call_id: "read", wire_name: "get_goal", arguments: {},
      } } });
    const normal = await invoke();
    expect(normal.isError).not.toBe(true);
    expect(JSON.parse(text(normal))).toEqual({ goal: { status: "active" } });
    failed = true;
    const errored = await invoke();
    expect(errored.isError).toBe(true);
    expect(JSON.parse(text(errored))).toEqual({ goal: { status: "blocked" } });
    empty = true;
    const absent = await invoke();
    expect(absent.content).toEqual([]);
    expect(absent.isError).toBe(true);
  } finally {
    await client.close();
    await server.stop();
  }
});

test("MCP discovery evidence distinguishes listed tools, empty queries and pre-handler refusal without private data", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-discovery-proof-")), file = join(root, "events.jsonl");
  const prior = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = file;
  const server = await startCustomMcpHttpServer({ label: "discovery-proof", createServer: () => createPublicMcpServer({
    chat: { inventory: () => [], call: async () => ({ ok: true }) },
    codex: { inventory: () => { throw new Error("PRIVATE_FAILURE"); }, invoke: async () => { throw Error("unused"); } },
  }) });
  const client = new Client({ name: "fixture", version: "1" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(server.endpointUrl, { requestInit: { headers: { authorization: `Bearer ${server.bearerToken}` } } });
  try {
    const rejected = await fetch(server.endpointUrl, { method: "POST", headers: { authorization: "Bearer PRIVATE_BAD_AUTH" }, body: "PRIVATE_BODY" });
    expect(rejected.status).toBe(401);
    await client.connect(transport as unknown as Transport);
    expect((await client.listTools()).tools).toHaveLength(4);
    await client.callTool({ name: CHATGPT_TELA_CHAT_CAPABILITY_INVENTORY, arguments: { query: "PRIVATE_QUERY" } });
    expect((await client.callTool({ name: "PRIVATE_UNREGISTERED", arguments: { secret: "PRIVATE_ARGUMENT" } })).isError).toBe(true);
    await expect(client.callTool({ name: CHATGPT_TELA_CODEX_TOOL_INVENTORY, arguments: { turn_capability: "PRIVATE_CAPABILITY_0123456789" } })).resolves.toMatchObject({ isError: true });
    const raw = readFileSync(file, "utf8"), rows = raw.trim().split("\n").map(line => JSON.parse(line));
    const list = rows.find(row => row.stage === "mcp_rpc_emitted" && row.phase === "tools_list");
    expect(list).toMatchObject({ count: 4, chat_inventory_present: true, chat_call_present: true, codex_inventory_present: true, codex_call_present: true, delivery: "transport_send_returned" });
    expect(rows.find(row => row.stage === "mcp_rpc_received" && row.rpc_fingerprint === list.rpc_fingerprint)).toMatchObject({ method_class: "tools_list", connection_fingerprint: list.connection_fingerprint });
    expect(rows.find(row => row.stage === "mcp_chat_inventory_returned")).toMatchObject({ count: 0, query_empty: false });
    expect(rows.some(row => row.stage === "mcp_rpc_received" && row.kind === "other")).toBe(true);
    expect(rows.some(row => row.stage === "mcp_rpc_emitted" && row.error_result === true)).toBe(true);
    expect(rows.some(row => row.stage === "mcp_http_rejected" && row.http_status === 401)).toBe(true);
    for (const row of rows) expect(structuralDiagnosticEvent(row)).toEqual(row);
    expect(raw).not.toContain("PRIVATE_");
  } finally {
    await client.close(); await server.stop();
    if (prior === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE; else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["goal_control_call", "read_context_history"])("public %s preserves Native MCP content and error semantics without wrapping", async capabilityName => {
  const body = JSON.stringify(capabilityName === "read_context_history"
    ? { type: "native_history_page", text: '{"data":[{"text":"original answer"}]}' }
    : { goal: { status: "complete" } });
  let nativeError = false;
  const chat = {
    inventory: async () => [],
    async call(capability: string) {
      if (capability === capabilityName) {
        return { callId: "fixture", content: body, isError: nativeError };
      }
      if (capability === "goal_control_inventory") return [{ name: "get_goal" }];
      return { ok: true };
    },
  };
  const server = await startCustomMcpHttpServer({
    label: "goal-public-result",
    createServer: () => createPublicMcpServer({
      chat,
      codex: { inventory: () => [], invoke: async () => { throw Error("unused"); } },
    }),
  });
  const transport = new StreamableHTTPClientTransport(server.endpointUrl, {
    requestInit: { headers: { authorization: `Bearer ${server.bearerToken}` } },
  });
  const client = new Client({ name: "goal-public-result", version: "1" }, { capabilities: {} });
  try {
    await client.connect(transport as unknown as Transport);
    const call = (capability: string) => client.callTool({
      name: CHATGPT_TELA_CHAT_CAPABILITY_CALL, arguments: { capability, arguments: {} },
    });
    const success = await call(capabilityName);
    expect(success.isError).not.toBe(true);
    expect(text(success)).toBe(body);
    expect(JSON.parse(text(success))).toEqual(JSON.parse(body));
    nativeError = true;
    const error = await call(capabilityName);
    expect(error.isError).toBe(true);
    expect(text(error)).toBe(body);
    const inventory = await call("goal_control_inventory");
    expect(JSON.parse(text(inventory))).toEqual([{ name: "get_goal" }]);
    const ordinaryChat = await call("ordinary_chat");
    expect(JSON.parse(text(ordinaryChat))).toEqual({ ok: true });
  } finally {
    await client.close();
    await server.stop();
  }
});

test("completed Goal and subsequent error keep separate persisted MCP receipts", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-goal-receipts-"));
  const file = join(root, "events.jsonl");
  const prior = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = file;
  let calls = 0;
  const bridge: TurnBridgeBackend = {
    inventory: () => [{ wireName: "update_goal", name: "update_goal", kind: "function", description: "Goal", observedFrom: ["fixture"] }],
    async invoke(_token, invocation) {
      calls++;
      return { callId: invocation.callId,
        content: calls === 1 ? JSON.stringify({ goal: { status: "complete" } }) : "Native goal is already complete",
        isError: calls !== 1 };
    },
  };
  const server = await startCustomMcpHttpServer({ label: "goal-receipts",
    createServer: () => createPublicMcpServer({ chat: new DynamicChatBackend(() => undefined, bridge), codex: bridge }) });
  const transport = new StreamableHTTPClientTransport(server.endpointUrl, {
    requestInit: { headers: { authorization: `Bearer ${server.bearerToken}` } },
  });
  const client = new Client({ name: "goal-receipts", version: "1" }, { capabilities: {} });
  try {
    await client.connect(transport as unknown as Transport);
    const invoke = (id: string) => client.callTool({ name: CHATGPT_TELA_CHAT_CAPABILITY_CALL,
      arguments: { capability: "goal_control_call", arguments: {
        goal_control: "fixture", call_id: id, wire_name: "update_goal", arguments: { status: "complete" },
      } },
    });
    expect((await invoke("first-goal")).isError).not.toBe(true);
    expect((await invoke("second-goal")).isError).toBe(true);
    const rows = readDiagnosticTail(file).events;
    for (const [id, error] of [["first-goal", false], ["second-goal", true]] as const) {
      const related = rows.filter(row => row.parent_fingerprint === diagnosticFingerprint(id));
      expect(related.some(row => row.stage === "tool_settled" && row.error_result === error)).toBe(true);
      expect(related.some(row => row.stage === "mcp_native_result_projected"
        && row.error_result_reported === error && row.kind === "text"
        && typeof row.text_bytes === "number" && row.text_bytes > 0)).toBe(true);
    }
    expect(JSON.stringify(rows)).not.toContain("Native goal is already complete");
  } finally {
    await client.close(); await server.stop();
    if (prior === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = prior;
    rmSync(root, { recursive: true, force: true });
  }
});
