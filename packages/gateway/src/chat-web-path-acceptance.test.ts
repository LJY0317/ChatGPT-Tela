import { registerTemporaryFixtureCleanup } from "../../../tests/support/temporary-fixtures";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { readDiagnosticTail } from "@chatgpt-tela/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createChatToolRuntime, startChatService } from "@chatgpt-tela/chat-service";
import {
  CHATGPT_TELA_CHAT_CAPABILITY_CALL,
  CHATGPT_TELA_CHAT_CAPABILITY_INVENTORY,
  startCustomMcpHttpServer,
  type TurnBridgeBackend,
} from "@chatgpt-tela/mcp";
import { DynamicChatBackend } from "./dynamic-chat-backend";
import { createPublicMcpServer } from "./public-server";

function jsonContent(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const content = result.content as readonly { type: string; text?: string }[];
  expect(result.isError).not.toBe(true);
  expect(content).toHaveLength(1);
  expect(content[0]?.type).toBe("text");
  return JSON.parse(content[0]!.text!);
}

const removeFixture = registerTemporaryFixtureCleanup();

describe("Web Chat independent tool path acceptance", () => {
  test("public MCP reaches Chat workspace effects and images without invoking Native, including after a Chat outage", async () => {
    const base = mkdtempSync(join(tmpdir(), "tela-web-chat-acceptance-"));
    const previousDiagnostics = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    const diagnosticFile = join(base, "events.jsonl");
    process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = diagnosticFile;
    const root = join(base, "project");
    mkdirSync(root);
    writeFileSync(join(root, "AGENTS.md"), "project instruction receipt\n");
    writeFileSync(join(root, "README.md"), "before\n");
    const png = Buffer.from("89504e470d0a1a0a0000000049454e44ae426082", "hex");
    writeFileSync(join(root, "sample.png"), png);
    writeFileSync(join(root, "extensionless-capture"), png);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "web-route.ts"), "export const webRoute = true;\n");

    const createTools = () => createChatToolRuntime({ allowedRoots: [root], stateRoot: join(base, "chat-state") });
    const tools = createTools();
    await tools.initialize();
    const token = "c".repeat(48);
    let chat = await startChatService({ bearerToken: token, tools });
    let currentToken = token;
    let chatAvailable = true;
    const backend = new DynamicChatBackend(() => chatAvailable ? {
      version: 1, service: "chat", instanceId: chat.instanceId,
      installId: "chat-web-acceptance", pid: process.pid, endpoint: chat.endpoint.href,
      bearerToken: currentToken, startedAt: new Date(0).toISOString(),
    } : undefined);
    let nativeCalls = 0;
    const codex: TurnBridgeBackend = {
      async inventory() { nativeCalls++; throw new Error("Native inventory must not handle Web work"); },
      async invoke() { nativeCalls++; throw new Error("Native invocation must not handle Web work"); },
    };
    const mcp = await startCustomMcpHttpServer({
      label: "web-chat-acceptance",
      createServer: () => createPublicMcpServer({ chat: backend, codex }),
    });
    const transport = new StreamableHTTPClientTransport(mcp.endpointUrl, {
      requestInit: { headers: { authorization: "Bearer " + mcp.bearerToken } },
    });
    const client = new Client({ name: "web-chat-acceptance", version: "1.0.0" }, { capabilities: {} });

    const call = (capability: string, arguments_: Record<string, unknown>) =>
      client.callTool({ name: CHATGPT_TELA_CHAT_CAPABILITY_CALL, arguments: { capability, arguments: arguments_ } });
    try {
      await client.connect(transport as unknown as Transport);
      const available = jsonContent(await client.callTool({
        name: CHATGPT_TELA_CHAT_CAPABILITY_INVENTORY, arguments: { query: "" },
      })) as readonly { capability: string }[];
      expect(available.map(item => item.capability)).toEqual(expect.arrayContaining([
        "open_workspace", "apply_patch", "exec_command", "read", "view_image", "search_files",
      ]));
      const workspace = jsonContent(await call("open_workspace", { path: root })) as {
        id: string; instructionRevision: string; instructions: { content: string }[];
      };
      expect(workspace.instructions.some(row => row.content === "project instruction receipt\n")).toBe(true);
      expect(jsonContent(await call("open_workspace", {
        path: root, known_instruction_revision: workspace.instructionRevision,
      }))).toMatchObject({ instructionsUnchanged: true, instructions: [] });
      expect(jsonContent(await call("search_files", {
        workspace_id: workspace.id, query: "WEB-ROUTE", case_sensitive: false, max_results: 1,
      }))).toMatchObject({ matches: ["src/web-route.ts"], hasMore: false, scanComplete: true });
      jsonContent(await call("apply_patch", {
        workspace_id: workspace.id,
        patch: "*** Begin Patch\n*** Add File: notes.txt\n+created-through-chat\n*** End Patch",
      }));
      expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("created-through-chat\n");
      expect((jsonContent(await call("read", {
        workspace_id: workspace.id, path: "notes.txt",
      })) as { content: string }).content).toContain("created-through-chat");
      const rows = readFileSync(diagnosticFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
      const returned = rows.find(row => row.stage === "backend_call_complete" && row.kind === "object"
        && typeof row.request_fingerprint === "string" && typeof row.rpc_fingerprint === "string"
        && rows.some(child => child.stage === "capability_call_complete" && child.parent_fingerprint === row.request_fingerprint));
      const returnedRpc = returned?.rpc_fingerprint;
      expect(returned).toMatchObject({ service: "chat", kind: "object", result_bytes: expect.any(Number),
        rpc_fingerprint: expect.any(String), request_fingerprint: expect.any(String) });

      const operationId = randomUUID();
      const command = process.platform === "win32"
        ? "echo command-complete > command.txt"
        : "printf command-complete > command.txt";
      const execution = jsonContent(await call("exec_command", {
        workspace_id: workspace.id, cmd: command, operation_id: operationId, yield_time_ms: 1000,
      })) as { state: string; sessionId: number };
      if (execution.state !== "exited") {
        jsonContent(await call("write_stdin", {
          workspace_id: workspace.id, session_id: execution.sessionId, chars: "", yield_time_ms: 1000,
        }));
      }
      expect(jsonContent(await call("process_status", {
        workspace_id: workspace.id, operation_id: operationId,
      }))).toMatchObject({ state: "exited", exitCode: 0 });
      expect(readFileSync(join(root, "command.txt"), "utf8")).toContain("command-complete");

      const image = await call("view_image", { workspace_id: workspace.id, path: "sample.png" });
      expect(image.isError).not.toBe(true);
      const imageItems = image.content as readonly { type: string; mimeType: string; data: string }[];
      expect(imageItems).toHaveLength(1);
      const imageContent = imageItems[0]!;
      expect(imageContent.type).toBe("image");
      expect(imageContent.mimeType).toBe("image/png");
      expect(Buffer.from(imageContent.data, "base64")).toEqual(png);
      const extensionless = await call("view_image", { workspace_id: workspace.id, path: "extensionless-capture" });
      expect(extensionless.isError).not.toBe(true);
      expect(extensionless.content).toEqual([{ type: "image", mimeType: "image/png", data: png.toString("base64") }]);
      const delivered = readFileSync(diagnosticFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(delivered.find(row => row.stage === "mcp_rpc_emitted" && row.rpc_fingerprint === returnedRpc))
        .toMatchObject({ delivery: "transport_send_returned", kind: "text",
          part_count: 1, body_bytes: expect.any(Number), result_bytes: expect.any(Number), error_result: false });
      expect(readDiagnosticTail(diagnosticFile).events.find(row => row.stage === "mcp_rpc_emitted"
        && row.rpc_fingerprint === returnedRpc)).toMatchObject({ kind: "text", part_count: 1,
          body_bytes: expect.any(Number), result_bytes: expect.any(Number) });

      chatAvailable = false;
      const unavailable = await call("read", { workspace_id: workspace.id, path: "notes.txt" });
      expect(unavailable.isError).toBe(true);
      const errorRows = readFileSync(diagnosticFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(errorRows.some(row => row.stage === "mcp_rpc_emitted" && row.error_result === true
        && row.kind === "text" && row.delivery === "transport_send_returned")).toBe(true);
      const unavailableInventory = await client.callTool({
        name: CHATGPT_TELA_CHAT_CAPABILITY_INVENTORY, arguments: { query: "" },
      });
      expect(unavailableInventory.isError).toBe(true);
      expect(nativeCalls).toBe(0);
      chatAvailable = true;
      const recoveredInventory = jsonContent(await client.callTool({
        name: CHATGPT_TELA_CHAT_CAPABILITY_INVENTORY, arguments: { query: "" },
      })) as readonly { capability: string }[];
      expect(recoveredInventory.some(item => item.capability === "read")).toBe(true);
      expect((jsonContent(await call("read", {
        workspace_id: workspace.id, path: "notes.txt",
      })) as { content: string }).content).toContain("created-through-chat");
      expect(nativeCalls).toBe(0);

      // A real Chat service restart changes its private endpoint and bearer,
      // while the public MCP client and its approved workspace remain usable.
      const previousInstanceId = chat.instanceId;
      await chat.close();
      // The descriptor still points at the stopped Chat process. A socket-level
      // failure must stay on the Chat route, even though a Native backend is
      // present in the same public MCP connection.
      const stoppedChat = await call("read", { workspace_id: workspace.id, path: "notes.txt" });
      expect(stoppedChat.isError).toBe(true);
      expect(nativeCalls).toBe(0);
      const restartedTools = createTools();
      await restartedTools.initialize();
      currentToken = "d".repeat(48);
      chat = await startChatService({ bearerToken: currentToken, tools: restartedTools });
      expect(chat.instanceId).not.toBe(previousInstanceId);
      const recovered = jsonContent(await call("open_workspace", { path: root })) as { id: string };
      expect(recovered.id).toBe(workspace.id);
      // A restarted Chat service does not need a delivery registry to reuse a caller's retained result.
      expect(jsonContent(await call("open_workspace", {
        path: root, known_instruction_revision: workspace.instructionRevision,
      }))).toMatchObject({ instructionsUnchanged: true, instructions: [] });
      writeFileSync(join(root, "AGENTS.md"), "updated project instructions\n");
      const updated = jsonContent(await call("open_workspace", {
        path: root, known_instruction_revision: workspace.instructionRevision,
      })) as { instructionsUnchanged: boolean; instructions: { content: string }[] };
      expect(updated.instructionsUnchanged).toBe(false);
      expect(updated.instructions.some(row => row.content === "updated project instructions\n")).toBe(true);
      expect(jsonContent(await call("process_status", {
        workspace_id: recovered.id, operation_id: operationId,
      }))).toMatchObject({ state: "exited", exitCode: 0 });
      expect(nativeCalls).toBe(0);
    } finally {
      await client.close().catch(() => {});
      await mcp.stop();
      await chat.close();
      if (previousDiagnostics === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
      else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = previousDiagnostics;
      removeFixture(base);
    }
  });
});
