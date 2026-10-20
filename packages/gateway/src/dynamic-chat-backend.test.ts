import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebHttpServer } from "@chatgpt-tela/http-host";
import { DynamicChatBackend } from "./dynamic-chat-backend";

describe("dynamic Tela Chat backend", () => {
  test("resolves the current Chat descriptor per call and crosses only the private service protocol", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-gateway-dynamic-chat-"));
    const diagnosticPath = join(root, "gateway-diagnostics.jsonl");
    const previousDiagnosticPath = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = diagnosticPath;
    const token = "h".repeat(48);
    const seen: unknown[] = [];
    const server = await startWebHttpServer({
      hostname: "127.0.0.1",
      port: 0,
      maxRequestBodyBytes: 1024 * 1024,
      async fetch(request) {
        if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/v1/capabilities") {
          return Response.json({ contractVersion: 1, service: "chat",
            capabilities: ["read", "future_chat_capability_2099"],
            catalog: [
              { capability: "read", description: "Read a bounded workspace file",
                inputSchema: { type: "object", properties: { path: { type: "string" } } } },
              { capability: "future_chat_capability_2099", description: "Future runtime capability",
                semantics: { version: 1, authority: "chat_service", effect: "read", scope: "workspace",
                  replay: "observe_again", verification: "bounded_result", maturity: "implemented" },
                inputSchema: { type: "object", properties: { future: { type: "boolean" } } } },
            ] });
        }
        if (request.method === "POST" && url.pathname === "/v1/call") {
          const body = await request.json();
          seen.push(body);
          const capability = (body as { capability: string }).capability;
          return Response.json({ contractVersion: 1, service: "chat", capability,
            result: { capability, via: "private-http" } });
        }
        return new Response(null, { status: 404 });
      },
    });
    let available = true;
    const backend = new DynamicChatBackend(() => available
      ? {
          version: 1,
          service: "chat",
          instanceId: "chat-private-fixture",
          installId: "install-fixture",
          pid: 1,
          endpoint: `http://127.0.0.1:${server.port}/`,
          bearerToken: token,
          startedAt: "2026-09-27T00:00:00.000Z",
        }
      : undefined);
    try {
      const inventory = await backend.inventory("future");
      expect(inventory.map(item => item.capability)).toEqual(["future_chat_capability_2099"]);
      expect(inventory[0]?.semantics).toMatchObject({ version: 1, authority: "chat_service", replay: "observe_again" });
      expect(await backend.call("read", { workspace_id: "chatws_fixture", path: "README.md" }))
        .toEqual({ capability: "read", via: "private-http" });
      expect(seen).toEqual([{ capability: "read", arguments: { workspace_id: "chatws_fixture", path: "README.md" } }]);
      available = false;
      await expect(backend.call("read", {})).rejects.toThrow("Chat backend is unavailable");
      const diagnostics = readFileSync(diagnosticPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
      // The shared diagnostic stream intentionally includes HTTP transport
      // stages. Test the router's events by event type, not total line count.
      expect(diagnostics.filter(item => item.event === "chatgpt_tela_gateway")
        .map(item => [item.stage, item.service])).toEqual([
        ["backend_call_start", "chat"],
        ["backend_call_complete", "chat"],
        ["backend_call_start", "chat"],
        ["backend_call_complete", "chat"],
        ["backend_call_unmounted", "chat"],
      ]);
      expect(diagnostics.some(item => item.event === "chatgpt_tela_http"
        && item.stage === "http_response_finished")).toBe(true);
      expect(readFileSync(diagnosticPath, "utf8")).not.toContain(token);
      expect(readFileSync(diagnosticPath, "utf8")).not.toContain("chatws_fixture");
    } finally {
      await server.stop();
      if (previousDiagnosticPath === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
      else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = previousDiagnosticPath;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("Tela Chat Goal calls forward only original Goal tools without a second state engine", async () => {
  const calls: unknown[] = [];
  const bridge = {
    inventory: () => [
      { wireName: "functions.update_goal", name: "update_goal", namespace: "functions", kind: "function" as const, description: "Native Goal", observedFrom: ["Native"] },
      { wireName: "exec_command", name: "exec_command", kind: "function" as const, description: "Work", observedFrom: ["Native"] },
    ],
    async invoke(capability: string, invocation: unknown) { calls.push({ capability, invocation }); return { callId: "complete", content: { status: "complete" }, isError: false }; },
  };
  const backend = new DynamicChatBackend(() => undefined, bridge);
  expect(await backend.call("goal_control_inventory", { goal_control: "scoped-control" })).toMatchObject([{ name: "update_goal" }]);
  await expect(backend.call("goal_control_call", { goal_control: "scoped-control", call_id: "work", wire_name: "exec_command", arguments: {} })).rejects.toThrow("advertised Native Goal tool");
  expect(calls).toHaveLength(0);
  expect(await backend.call("goal_control_call", { goal_control: "scoped-control", call_id: "complete", wire_name: "functions.update_goal", arguments: { status: "complete" } })).toMatchObject({ isError: false, content: { status: "complete" } });
  expect(calls).toEqual([{ capability: "scoped-control", invocation: { callId: "complete", wireName: "functions.update_goal", mode: "structured", arguments: { status: "complete" } } }]);
});
