import { expect, test } from "bun:test";
import { startWebHttpServer } from "./server";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
      lifecycle.afterResponse(shutdown);
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
