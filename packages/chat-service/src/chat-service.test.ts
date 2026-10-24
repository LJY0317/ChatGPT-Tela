import { describe, expect, test } from "bun:test";
import { startChatService } from "./index";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setPrivateDiagnosticCapture, readDiagnosticTail } from "@chatgpt-tela/core";
import { createChatToolRuntime } from "./tools";


describe("Tela Chat service boundary", () => {
  test("starts independently with no Codex/browser dependency and serves only a private loopback contract", async () => {
    const token = "c".repeat(48);
    const service = await startChatService({ bearerToken: token });
    try {
      const response = await fetch(new URL("v1/status", service.endpoint), {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      expect((await response.json() as { state: string }).state).toBe("ready");
      const unauthenticated = await fetch(new URL("v1/status", service.endpoint));
      expect(unauthenticated.status).toBe(401);
    } finally {
      await service.close();
    }
  });
});


function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function shutdownFixture() {
  const base = mkdtempSync(join(tmpdir(), "tela-chat-shutdown-"));
  const root = join(base, "root"); mkdirSync(root);
  const tools = createChatToolRuntime({ allowedRoots: [root], stateRoot: join(base, "state") });
  const token = "fixture-shutdown-token".repeat(3);
  return { base, root, tools, token };
}

test("a failure after shutdown admission never advertises a partially closed runtime as ready", async () => {
  const f = shutdownFixture(); let attempts = 0;
  const service = await startChatService({ bearerToken: f.token, tools: { ...f.tools,
    async close() { attempts++; if (attempts === 1) throw new Error("synthetic teardown failure"); await f.tools.close(); },
  } });
  try {
    await expect(service.close()).rejects.toThrow("teardown failure");
    expect(service.status().state).toBe("stopping");
    const response = await fetch(new URL("v1/call", service.endpoint), { method: "POST",
      headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
      body: JSON.stringify({ capability: "open_workspace", arguments: { path: f.root } }) });
    expect(response.status).toBe(503);
    await Promise.all([service.close(), service.close()]); expect(attempts).toBe(2);
  } finally { await service.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("refused shutdown preserves the private endpoint and work; completion allows one close", async () => {
  const f = shutdownFixture(); let unresolved = true, closes = 0;
  const service = await startChatService({ bearerToken: f.token, tools: { ...f.tools,
    assertCanClose() { if (unresolved) throw new Error("synthetic unresolved owner"); },
    async close() { closes++; await f.tools.close(); },
  } });
  const request = (path: string, init: RequestInit = {}) => fetch(new URL(path, service.endpoint), {
    ...init, headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
  });
  try {
    const blocked = await request("v1/shutdown", { method: "POST" });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ contractVersion: 1, service: "chat", instanceId: service.instanceId, shutdown: "not-started" });
    expect(await (await request("v1/status?shutdown-readiness=1")).json()).toMatchObject({ shutdownReadiness: "blocked" });
    expect(await (await request("v1/status")).json()).not.toHaveProperty("shutdownReadiness");
    await expect(service.close()).rejects.toThrow("unresolved owner");
    expect(closes).toBe(0); expect(service.status().state).toBe("ready");
    expect((await request("v1/status")).status).toBe(200);
    const opened = await request("v1/call", { method: "POST", body: JSON.stringify({ capability: "open_workspace", arguments: { path: f.root } }) });
    expect(opened.status).toBe(200); await opened.json();
    unresolved = false;
    expect(await (await request("v1/status?shutdown-readiness=1")).json()).toMatchObject({ shutdownReadiness: "ready" });
    expect((await request("v1/shutdown", { method: "POST" })).status).toBe(200);
    await service.shutdownRequested;
    expect(service.status().state).toBe("stopping");
    const repeated = await request("v1/shutdown", { method: "POST" });
    expect(repeated.status).toBe(409);
    expect(await repeated.json()).not.toHaveProperty("shutdown");
    expect((await request("v1/call", { method: "POST", body: JSON.stringify({ capability: "open_workspace", arguments: { path: f.root } }) })).status).toBe(503);
    await Promise.all([service.close(), service.close()]); expect(closes).toBe(1);
  } finally { unresolved = false; await service.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("blocked shutdown is classified without exposing unresolved owner's exception text", async () => {
  const previous = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  const f = shutdownFixture();
  const log = join(f.base, "structural.jsonl");
  process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = log;
  let unresolved = true;
  const service = await startChatService({ bearerToken: f.token, tools: { ...f.tools,
    assertCanClose() { if (unresolved) throw Error("private /Users/someone/executable task pending"); },
  } });
  try {
    const response = await fetch(new URL("v1/shutdown", service.endpoint), {
      method: "POST", headers: { authorization: `Bearer ${f.token}` },
    });
    expect(response.status).toBe(409);
    const safeEvents = readFileSync(log, "utf8");
    expect(safeEvents).toContain('"stage":"shutdown_rejected"');
    expect(safeEvents).toContain('"reason_class":"unresolved_work"');
    expect(safeEvents).not.toContain("private /Users/");
  } finally {
    unresolved = false;
    await service.close();
    if (previous === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = previous;
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("HTTP capability errors preserve a safe reason class without logging request payload", async () => {
  const previous = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  const f = shutdownFixture();
  const log = join(f.base, "http-safe.jsonl");
  process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = log;
  const secret = "absolute-private-location-and-command-should-not-be-logged";
  const service = await startChatService({ bearerToken: f.token, tools: { ...f.tools,
    async call() { throw Error(`Tela Chat process operation registry is at capacity; no process was started: ${secret}`); },
  } });
  try {
    const response = await fetch(new URL("v1/call", service.endpoint), {
      method: "POST",
      headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
      body: JSON.stringify({ capability: "exec_command", arguments: {
        workspace_id: "opaque-fixture", cmd: secret,
      } }),
    });
    expect(response.status).toBe(409);
    const safeEvents = readFileSync(log, "utf8");
    expect(safeEvents).toContain('"stage":"capability_call_failed"');
    expect(safeEvents).toContain('"reason_class":"capacity_exhausted"');
    expect(safeEvents).not.toContain(secret);
    expect(safeEvents).not.toContain("opaque-fixture");
  } finally {
    await service.close();
    if (previous === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = previous;
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("admitted asynchronous work blocks shutdown until completed delivery", async () => {
  const f = shutdownFixture(), admitted = deferred<void>(), release = deferred<void>(); let closes = 0;
  const service = await startChatService({ bearerToken: f.token, tools: { ...f.tools,
    async call() { admitted.resolve(); await release.promise; return { fixtureComplete: true }; },
    async close() { closes++; await f.tools.close(); },
  } });
  const request = (path: string, init: RequestInit = {}) => fetch(new URL(path, service.endpoint), {
    ...init, headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
  });
  const pending = request("v1/call", { method: "POST", body: JSON.stringify({ capability: "read" }) });
  try {
    await admitted.promise;
    expect((await request("v1/shutdown", { method: "POST" })).status).toBe(409);
    await expect(service.close()).rejects.toThrow("active capability"); expect(closes).toBe(0);
    release.resolve(); expect(await (await pending).json()).toMatchObject({ result: { fixtureComplete: true } });
    expect((await request("v1/shutdown", { method: "POST" })).status).toBe(200);
    await service.shutdownRequested; await service.close(); expect(closes).toBe(1);
  } finally { release.resolve(); await pending; await service.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("disconnected capability work continues to block shutdown until its actual completion", async () => {
  const f = shutdownFixture(), admitted = deferred<void>(), release = deferred<void>(), finished = deferred<void>();
  const service = await startChatService({ bearerToken: f.token, tools: { ...f.tools,
    async call() { admitted.resolve(); await release.promise; finished.resolve(); return {}; },
  } });
  const controller = new AbortController();
  const pending = fetch(new URL("v1/call", service.endpoint), { method: "POST", signal: controller.signal,
    headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" }, body: JSON.stringify({ capability: "read" }) }).catch(() => {});
  try {
    await admitted.promise; controller.abort(); await pending;
    await expect(service.close()).rejects.toThrow("active capability"); expect(service.status().state).toBe("ready");
    release.resolve(); await finished.promise;
    await fetch(new URL("v1/status", service.endpoint), { headers: { authorization: `Bearer ${f.token}` } });
    await service.close();
  } finally { release.resolve(); await finished.promise; await service.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("unknown caller capability names cannot leak private input into structural diagnostics",async()=>{
 const {observeDiagnosticEvents}=await import('@chatgpt-tela/core');const events:any[]=[];
 const stop=observeDiagnosticEvents(row=>{if(row.stage.startsWith('capability_call_'))events.push(row)});
 const f=shutdownFixture();const service=await startChatService({bearerToken:f.token,tools:{...f.tools,
  async call(){throw Error('PRIVATE_FAILURE /some/user/source')},
 }});
 try{
  const response=await fetch(new URL('v1/call',service.endpoint),{method:'POST',headers:{authorization:`Bearer ${f.token}`,'content-type':'application/json'},
   body:JSON.stringify({capability:'PRIVATE_CAPABILITY',arguments:{}})});
  expect(response.status).toBe(409);
  expect(events.map(row=>row.capability)).toEqual(['unknown','unknown']);
  expect(JSON.stringify(events)).not.toMatch(/PRIVATE_|some\/user/);
 }finally{stop?.();await service.close();rmSync(f.base,{recursive:true,force:true})}
});


test.each([false, true])("failed patch headers and exact errors use existing opt-in capture only: %s", async enabled => {
  const f = shutdownFixture();
  const previous = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  const log = join(f.base, "events.jsonl");
  process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = log;
  if (enabled) setPrivateDiagnosticCapture(join(f.base, "diagnostics"), 1);
  const workspace = f.tools.workspaces.open(f.root);
  const header = `*** Add File: ${join(f.root, "private-path.txt")}`;
  const secretBody = "source-hunk-must-not-enter-failure-capture";
  const service = await startChatService({ bearerToken: f.token, tools: f.tools });
  try {
    const response = await fetch(new URL("v1/call", service.endpoint), {
      method: "POST", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
      body: JSON.stringify({ capability: "apply_patch", arguments: { workspace_id: workspace.id,
        patch: `*** Begin Patch\n${header}\n+${secretBody}\n*** End Patch` } }),
    });
    expect(response.status).toBe(409);
    expect(readFileSync(log, "utf8")).not.toContain("private-path.txt");
    expect(readFileSync(log, "utf8")).not.toContain(secretBody);
    const directory = join(f.base, "diagnostics", "private");
    const files = enabled ? readdirSync(directory).filter(name => name.endsWith(".json") && !name.endsWith(".meta.json")) : [];
    expect(files).toHaveLength(enabled ? 1 : 0);
    if (enabled) {
      const captured = JSON.parse(readFileSync(join(directory, files[0]!), "utf8"));
      expect(captured.value.patchHeaders).toEqual([header]);
      expect(captured.value.error).toBe("workspace-relative path must not be absolute");
      expect(JSON.stringify(captured)).not.toContain(secretBody);
    }
  } finally {
    await service.close();
    if (previous === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = previous;
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("empty and populated Chat capability results survive sanitized durable readback", async () => {
  const f = shutdownFixture(), path = join(f.base, "call-events.jsonl");
  const previous = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = path;
  let calls = 0;
  const service = await startChatService({ bearerToken: f.token, tools: { ...f.tools,
    async call() { return ++calls === 1 ? {} : { finished: true, privateText: "PRIVATE_RESULT", isError: true }; },
  } });
  try {
    for (let i = 0; i < 2; i++) {
      const reply = await fetch(new URL("v1/call", service.endpoint), {
        method: "POST", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
        body: JSON.stringify({ capability: "read", arguments: {} }),
      });
      expect(reply.status).toBe(200);
      await reply.json();
    }
    const rows = readDiagnosticTail(path).events.filter(row => row.stage === "capability_call_complete");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ result_present: true, result_empty: true, result_bytes: 2, result_kind: "object", result_is_error: false });
    expect(rows[1]).toMatchObject({ result_present: true, result_empty: false, result_kind: "object", result_is_error: true });
    expect(readDiagnosticTail(path).events.filter(row => row.stage === "capability_call_complete")).toMatchObject(rows);
    expect(JSON.stringify(rows)).not.toContain("PRIVATE_RESULT");
  } finally {
    await service.close();
    if (previous === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = previous;
    rmSync(f.base, { recursive: true, force: true });
  }
});
