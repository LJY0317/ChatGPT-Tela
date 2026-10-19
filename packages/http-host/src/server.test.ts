import { expect, test } from "bun:test";
import { startWebHttpServer } from "./server";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { structuralDiagnosticEvent } from "@chatgpt-tela/core";

test("stream disconnect preserves last local write and cancellation origin without copying payloads", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tela-http-last-write-"));
  const file = join(directory, "events.jsonl"), previous = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = file;
  const controller = new AbortController();
  const payload = "private-stream-payload";
  const server = await startWebHttpServer({ hostname: "127.0.0.1", maxRequestBodyBytes: 1024,
    fetch() { return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(payload)); } })); } });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/private-route`, { signal: controller.signal });
    const reader = response.body!.getReader(); await reader.read(); controller.abort();
    const deadline = Date.now() + 1500;
    let closed: any;
    while (Date.now() < deadline) {
      closed = readFileSync(file, "utf8").trim().split("\n").map(l => JSON.parse(l)).find(r => r.stage === "http_transport_closed");
      if (closed) break; await Bun.sleep(5);
    }
    expect(closed).toMatchObject({ socket_write_count: 1, socket_write_bytes: payload.length, delivery: "socket_write_only" });
    expect(closed.last_socket_write_at_ms).toBeGreaterThan(0);
    expect(closed.last_socket_write_age_ms).toBeGreaterThanOrEqual(0);
    const canonical = structuralDiagnosticEvent(closed)!;
    expect(canonical.close_source).toBe(closed.close_source);
    expect(canonical.last_socket_write_at_ms).toBe(closed.last_socket_write_at_ms);
    expect(readFileSync(file, "utf8")).not.toContain("private");
  } finally {
    controller.abort(); await server.stop();
    if (previous === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE; else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("client closure before response headers records the transport boundary and preserves peer service", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tela-http-close-evidence-"));
  const file = join(directory, "events.jsonl");
  const previous = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = file;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const server = await startWebHttpServer({ hostname: "127.0.0.1", maxRequestBodyBytes: 1024,
    async fetch(request) {
      if (new URL(request.url).pathname === "/peer") return new Response("peer works");
      entered();
      await new Promise<void>(resolve => request.signal.addEventListener("abort", () => resolve(), { once: true }));
      return new Response("cancelled");
    } });
  const abort = new AbortController();
  try {
    const pending = fetch(`http://127.0.0.1:${server.port}/pending`, { signal: abort.signal }).catch(() => null);
    await started; abort.abort(); await pending;
    expect(await (await fetch(`http://127.0.0.1:${server.port}/peer`)).text()).toBe("peer works");
    const events = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const closed = events.filter(event => event.stage === "http_transport_closed");
    expect(closed).toHaveLength(1);
    expect(closed[0].headers_sent).toBe(false);
    // Node/Bun may emit request-aborted or response-close first; preserve the observed source.
    expect(["request_aborted", "response_closed"]).toContain(closed[0].close_source);
    expect(typeof closed[0].request_complete).toBe("boolean");
    expect(events.some(event => event.stage === "http_request_start" && event.request_fingerprint === closed[0].request_fingerprint)).toBe(true);
    await Bun.sleep(0);
  } finally {
    abort.abort(); await server.stop();
    if (previous === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an acknowledged shutdown finishes its response before closing the owner", async () => {
  let shutdown!: () => void;
  const requested = new Promise<void>(resolve => { shutdown = resolve; });
  const server = await startWebHttpServer({ hostname: "127.0.0.1", maxRequestBodyBytes: 1024,
    async fetch(_request, lifecycle) {
      void lifecycle.responseFinished.then(shutdown);
      return Response.json({ status: "shutting-down" });
    } });
  const closed = requested.then(() => server.stop());
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "shutting-down" });
    await closed;
  } finally { await server.stop(); }
});

test("owner shutdown cancels an open stream and its request without waiting for the client", async () => {
  let requestSignal!: AbortSignal;
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const server = await startWebHttpServer({ hostname: "127.0.0.1", maxRequestBodyBytes: 1024,
    fetch(request) {
      requestSignal = request.signal;
      return new Response(new ReadableStream({ start(controller) {
        stream = controller; controller.enqueue(new TextEncoder().encode("connected\n"));
      }, cancel() { cancelled = true; } }));
    } });
  const clientAbort = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}`, { signal: clientAbort.signal });
    const reader = response.body!.getReader();
    await reader.read();
    const stop = server.stop();
    const outcome = await Promise.race([stop.then(() => "stopped"),
      new Promise<string>(resolve => setTimeout(() => resolve("still waiting"), 500))]);
    expect(outcome).toBe("stopped");
    expect(requestSignal.aborted).toBe(true);
    for (let i = 0; i < 20 && !cancelled; i++) await Bun.sleep(10);
    expect(cancelled).toBe(true);
    await server.stop();
  } finally {
    clientAbort.abort();
    try { stream.close(); } catch { /* Already cancelled by the owner. */ }
    await server.stop();
  }
});

test("a disconnected client cancels its request while a peer remains usable", async () => {
  let requestSignal!: AbortSignal;
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const server = await startWebHttpServer({ hostname: "127.0.0.1", maxRequestBodyBytes: 1024,
    fetch(request) {
      if (new URL(request.url).pathname === "/peer") return new Response("peer works");
      requestSignal = request.signal;
      return new Response(new ReadableStream({ start(controller) {
        stream = controller; controller.enqueue(new TextEncoder().encode("connected\n"));
      } }));
    } });
  const clientAbort = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/stream`, { signal: clientAbort.signal });
    await response.body!.getReader().read();
    clientAbort.abort();
    for (let i = 0; i < 30 && !requestSignal.aborted; i++) await Bun.sleep(10);
    expect(requestSignal.aborted).toBe(true);
    expect(await (await fetch(`http://127.0.0.1:${server.port}/peer`)).text()).toBe("peer works");
  } finally {
    clientAbort.abort();
    try { stream.close(); } catch { /* Already cancelled by the client. */ }
    await server.stop();
  }
});

test("cleanup registered after the caller disconnects still completes owner shutdown", async () => {
  let entered!: () => void, finishCleanup!: () => void, completed!: () => void;
  const handling = new Promise<void>(resolve => { entered = resolve; });
  const cleanup = new Promise<void>(resolve => { finishCleanup = resolve; });
  const done = new Promise<void>(resolve => { completed = resolve; });
  const abort = new AbortController();
  let finished: boolean | undefined;
  const server = await startWebHttpServer({ hostname: "127.0.0.1", maxRequestBodyBytes: 1024,
    async fetch(request, lifecycle) {
      entered();
      await new Promise<void>(resolve => request.signal.addEventListener("abort", () => resolve(), { once: true }));
      await cleanup;
      // Owner cleanup can finish after the requesting app has already exited.
      void lifecycle.responseFinished.then(value => { finished = value; completed(); });
      return Response.json({ status: "shutting-down" });
    } });
  try {
    const request = fetch(`http://127.0.0.1:${server.port}/shutdown`, { signal: abort.signal });
    await handling; abort.abort(); await request.catch(() => {});
    finishCleanup(); await done;
    expect(finished).toBe(false);
  } finally { finishCleanup(); await server.stop(); }
});
