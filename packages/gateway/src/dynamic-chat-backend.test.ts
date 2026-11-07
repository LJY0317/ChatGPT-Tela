import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebHttpServer } from "@chatgpt-tela/http-host";
import { diagnosticFingerprint, observeDiagnosticEvents } from "@chatgpt-tela/core";
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

test("expired Goal control is reported as inventory rejection before Native invocation", async () => {
  const rows: Array<{ stage: string; [key: string]: unknown }> = [];
  const stop = observeDiagnosticEvents(event => { if (event.stage === "native_goal_control_inventory_rejected") rows.push(event); });
  let invoked = 0;
  const backend = new DynamicChatBackend(() => undefined, {
    inventory() { throw Error("unknown or retired turn capability"); },
    async invoke() { invoked++; throw Error("must not invoke Native"); },
  });
  try {
    await expect(backend.call("goal_control_call", {
      goal_control: "expired-goal-control", call_id: "one",
      wire_name: "update_goal", arguments: { status: "complete" },
    })).rejects.toThrow("unknown or retired turn capability");
    expect(invoked).toBe(0);
    expect(rows).toEqual([expect.objectContaining({
      phase: "call", reason_class: "unknown_or_retired_control",
      control_fingerprint: diagnosticFingerprint("expired-goal-control"),
    })]);
    expect(JSON.stringify(rows)).not.toContain("expired-goal-control");
  } finally { stop?.(); }
});

test("MCP inventory result rejection remains distinct from a retired Goal control", async () => {
  const rows: Array<{ stage: string; [key: string]: unknown }> = [];
  const stop = observeDiagnosticEvents(event => {
    if (event.stage === "native_goal_control_inventory_rejected") rows.push(event);
  });
  const failure = Object.assign(new Error("remote inventory failed"), { code: "tela_native_inventory_rejected" });
  const backend = new DynamicChatBackend(() => undefined, {
    inventory() { throw failure; },
    async invoke() { throw Error("must not invoke Native"); },
  });
  try {
    await expect(backend.call("goal_control_inventory", { goal_control: "scoped-control" })).rejects.toBe(failure);
    expect(rows).toEqual([expect.objectContaining({
      phase: "inventory", reason_class: "native_inventory_rejected",
      control_fingerprint: diagnosticFingerprint("scoped-control"),
    })]);
  } finally { stop?.(); }
});

test("schema-valid but un-fingerprintable Goal controls preserve inventory errors", async () => {
  for (const [capability, control] of [
    ["goal_control_inventory", ""],
    ["goal_control_call", "x".repeat(16_385)],
  ] as const) {
    const rows: Array<{ stage: string; [key: string]: unknown }> = [];
    const stop = observeDiagnosticEvents(event => {
      if (event.event === "chatgpt_tela_chat" && event.stage.startsWith("native_goal_control_")) rows.push(event);
    });
    const failure = new Error("original inventory rejection");
    let received = "";
    let invoked = 0;
    const backend = new DynamicChatBackend(() => undefined, {
      inventory(value) { received = value; throw failure; },
      async invoke() { invoked++; throw Error("must not invoke Native"); },
    });
    try {
      const args = capability === "goal_control_inventory" ? { goal_control: control }
        : { goal_control: control, call_id: "one", wire_name: "update_goal", arguments: { status: "complete" } };
      await expect(backend.call(capability, args)).rejects.toBe(failure);
      expect(received).toBe(control);
      expect(invoked).toBe(0);
      expect(rows.map(row => row.stage)).toEqual([
        "native_goal_control_received", "native_goal_control_inventory_rejected",
      ]);
      expect(rows.every(row => !("control_fingerprint" in row))).toBe(true);
      if (control) expect(JSON.stringify(rows)).not.toContain(control);
    } finally { stop?.(); }
  }
});


test("Tela Chat history read uses the existing turn transport without inventory or a Native model call", async () => {
  const calls: unknown[] = [];
  const backend = new DynamicChatBackend(() => { throw Error("not a workspace operation"); }, {
    inventory() { throw Error("history reads do not request Native tools"); },
    async invoke(control, call) { calls.push({ control, call }); return { callId: call.callId, content: { data: [] }, isError: false }; },
  });
  expect(await backend.call("read_context_history", { history_control: "selected-history", turn_id: "past" }))
    .toMatchObject({ isError: false, content: { data: [] } });
  expect(calls).toEqual([{ control: "selected-history", call: {
    callId: expect.any(String), wireName: "tela_context_history_page", mode: "structured", arguments: { turn_id: "past" },
  } }]);
  await expect(backend.call("read_context_history", { turn_id: "past" })).rejects.toThrow("history control");
});
