import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnosticFingerprint, structuralDiagnosticEvent, setPrivateDiagnosticCapture, withDiagnosticContext } from "@chatgpt-tela/core";
import { nativeRequestShape } from "./native-failure-diagnostics";
import { NativeReasoningObservation, observeNativeResponse } from "./native-reasoning-observation";
import { forwardNativeCodexRequest } from "./native-passthrough";

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
const item = (encrypted = true) => ({ type: "reasoning", id: "rs_SYNTHETIC_PRIVATE", ...(encrypted ? { encrypted_content: "SYNTHETIC_PRIVATE_CIPHER" } : {}), summary: ["SYNTHETIC_PRIVATE_TEXT"] });
const sse = (wire: string) => new Response(wire, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
function fixture(now?: () => number) {
  const observer = new NativeReasoningObservation(now), rows: any[] = [];
  const emit = (stage: string, fields: any) => rows.push({ ts: new Date().toISOString(), event: "chatgpt_tela_network", stage, ...fields });
  const read = async (response: Response, input: unknown = undefined) => new Response(observer.observe(response, nativeRequestShape(input), emit)).text();
  return { observer, rows, emit, read };
}
test("normal added→done→complete and replay identifies later loss without altering wire", async () => {
  const f = fixture();
  const wire = frame({ type: "response.output_item.added", item: item(false) })
    + frame({ type: "response.output_item.done", item: item() }) + frame({ type: "response.completed" });
  expect(await f.read(sse(wire))).toBe(wire);
  await f.read(new Response("private error", { status: 404 }), { input: [item(false)] });
  const replay = f.rows.find(x => x.stage === "native_reasoning_replayed");
  expect(replay).toMatchObject({ item_fingerprint: diagnosticFingerprint(item().id), first_seen: true,
    initial_encrypted: false, final_seen: true, final_encrypted: true, reasoning_encrypted: false,
    outcome: "completed", inspection_complete: true });
  expect(structuralDiagnosticEvent(replay)).toMatchObject({ final_encrypted: true, outcome: "completed" });
  expect(JSON.stringify(f.rows)).not.toContain("SYNTHETIC_PRIVATE");
});
test("added-only interrupted response is distinguishable from completed unencrypted output", async () => {
  const f = fixture();
  const failure = new Error("synthetic failure"), bytes = new TextEncoder().encode(frame({ type: "response.output_item.added", item: item(false) }));
  let sent = false;
  const response = new Response(new ReadableStream({ pull(c) { if (!sent) { sent = true; c.enqueue(bytes); } else c.error(failure); } }), { headers: { "content-type": "text/event-stream" } });
  await expect(f.read(response)).rejects.toBe(failure);
  await f.read(new Response(null), { input: [item(false)] });
  expect(f.rows.find(x => x.stage === "native_reasoning_replayed")).toMatchObject({ first_seen: true, final_seen: false, outcome: "body_interrupted" });
  const g = fixture();
  await g.read(sse(frame({ type: "response.output_item.done", item: item(false) }) + frame({ type: "response.completed" })));
  await g.read(new Response(null), { input: [item(false)] });
  expect(g.rows.find(x => x.stage === "native_reasoning_replayed")).toMatchObject({ final_seen: true, final_encrypted: false, outcome: "completed" });
});
test("arbitrary byte splits, multiline data and UTF8 preserve stream and classification", async () => {
  const f = fixture();
  const wire = 'data: {"type":"response.output_item.done",\r\ndata: "item":' + JSON.stringify({ ...item(), summary: ["한글"] }) + '}\r\n\r\n' + frame({ type: "response.completed" });
  const bytes = new TextEncoder().encode(wire); let i = 0;
  const body = new ReadableStream<Uint8Array>({ pull(c) { if (i < bytes.length) c.enqueue(bytes.slice(i, ++i)); else c.close(); } }, { highWaterMark: 0 });
  expect(await f.read(new Response(body, { headers: { "content-type": "text/event-stream" } }))).toBe(wire);
  expect(f.rows.at(-1)).toMatchObject({ outcome: "completed", inspection_complete: true });
});
test("oversized frames and event budget are incomplete evidence while all bytes pass through", async () => {
  for (const tail of [frame({ type: "response.output_item.done", item: { ...item(), encrypted_content: "X".repeat(70000) } }), frame({ type: "response.text.delta", delta: "private" }).repeat(130)]) {
    const f = fixture(), wire = frame({ type: "response.output_item.added", item: item(false) }) + tail + frame({ type: "response.completed" });
    expect(await f.read(sse(wire))).toBe(wire);
    expect(f.rows.at(-1).inspection_complete).toBe(false);
    await f.read(new Response(null), { input: [item(false)] });
    expect(f.rows.at(-1)).toMatchObject({ inspection_complete: false, final_seen: false });
  }
});
test("default-off and non-SSE never lock or consume the upstream body", () => {
  const prior = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  try {
    delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    const response = sse("private");
    expect(observeNativeResponse(response, nativeRequestShape(undefined))).toBe(response.body);
    expect(response.body!.locked).toBe(false);
    const json = new Response("private", { headers: { "content-type": "application/json" } });
    expect(fixture().observer.observe(json, nativeRequestShape(undefined), () => {})).toBe(json.body);
    expect(json.body!.locked).toBe(false);
  } finally { if (prior === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE; else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = prior; }
});
test("cancellation during pending read propagates exactly once without eager pulling", async () => {
  const f = fixture(); let pulls = 0, cancelled: unknown;
  const upstream = new ReadableStream<Uint8Array>({ pull() { pulls++; }, cancel(reason) { cancelled = reason; } }, { highWaterMark: 0 });
  const observed = f.observer.observe(new Response(upstream, { headers: { "content-type": "text/event-stream" } }), nativeRequestShape(undefined), f.emit)!;
  expect(pulls).toBe(0);
  const reader = observed.getReader(), pending = reader.read();
  await reader.cancel("synthetic cancel"); expect((await pending).done).toBe(true);
  expect(cancelled).toBe("synthetic cancel");
  expect(f.rows).toHaveLength(1); expect(f.rows[0].outcome).toBe("consumer_cancelled");
});
test("expiring process-local evidence and diagnostic exceptions never affect transport", async () => {
  let now = 0; const f = fixture(() => now);
  const wire = frame({ type: "response.output_item.done", item: item() });
  await f.read(sse(wire)); now = 600001;
  await f.read(new Response(null), { input: [item(false)] });
  expect(f.rows.some(x => x.stage === "native_reasoning_replayed")).toBe(false);
  const r = f.observer.observe(sse(wire), nativeRequestShape(undefined), () => { throw Error("diagnostic failure"); });
  expect(await new Response(r).text()).toBe(wire);
});
test("byte and time limits are marked incomplete without slowing or truncating delivery", async () => {
  for (const kind of ["bytes", "time"]) {
    let now = 0; const f = fixture(() => now);
    const prefix = frame({ type: "response.output_item.added", item: item(false) });
    const suffix = kind === "bytes" ? ":" + "X".repeat(1024 * 1024) + "\n\n" : frame({ type: "response.completed" });
    const chunks = [prefix, suffix];
    const body = new ReadableStream<Uint8Array>({ pull(c) { const part = chunks.shift(); if (part === undefined) c.close(); else { if (!chunks.length && kind === "time") now = 60001; c.enqueue(new TextEncoder().encode(part)); } } }, { highWaterMark: 0 });
    expect(await f.read(new Response(body, { headers: { "content-type": "text/event-stream" } }))).toBe(prefix + suffix);
    expect(f.rows.at(-1).inspection_complete).toBe(false);
  }
});
test("disabling clears old evidence even if an admitted stream later completes", async () => {
  const f = fixture(); let finish: (() => void) | undefined;
  const chunk = new TextEncoder().encode(frame({ type: "response.output_item.done", item: item() }));
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(chunk); finish = () => c.close(); } }, { highWaterMark: 0 });
  const reader = f.observer.observe(new Response(body, { headers: { "content-type": "text/event-stream" } }), nativeRequestShape(undefined), f.emit)!.getReader();
  await reader.read(); f.observer.clear(); finish!(); await reader.read();
  await f.read(new Response(null), { input: [item(false)] });
  expect(f.rows.some(x => x.stage === "native_reasoning_replayed")).toBe(false);
});
test("process index and replay emission remain bounded across requests", async () => {
  const f = fixture();
  for (let i = 0; i < 260; i++) await f.read(sse(frame({ type: "response.output_item.done", item: { ...item(), id: `rs_fixture_${i}` } })));
  f.rows.length = 0;
  await f.read(new Response(null), { input: Array.from({ length: 260 }, (_, i) => ({ ...item(false), id: `rs_fixture_${i}` })) });
  expect(f.rows).toHaveLength(16);
  expect(f.rows[0].item_fingerprint).toBe(diagnosticFingerprint("rs_fixture_4"));
});
test("public opt-in gate admits byte-preserving observation and expires without a restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-reasoning-test-"));
  const prior = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  const file = join(root, "events.jsonl"); process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = file;
  try {
    setPrivateDiagnosticCapture(join(root, "diagnostics"), 1);
    const wire = frame({ type: "response.output_item.done", item: item() }) + frame({ type: "response.completed" });
    const payload = JSON.stringify({ store: false, input: [item(false)] });
    const correlation = diagnosticFingerprint("synthetic deferred reasoning");
    const response = await withDiagnosticContext({ request_fingerprint: correlation }, () => forwardNativeCodexRequest({ request: new Request("http://localhost/v1/responses", {
      method: "POST", headers: { authorization: "Bearer synthetic" }, body: payload }), endpoint: "responses", runtimeHeaderName: "x-tela",
      fetchUpstream: async request => { expect(await request.text()).toBe(payload); return sse(wire); } }));
    expect(await response.text()).toBe(wire);
    expect(readFileSync(file, "utf8")).toContain("native_reasoning_observed");
    expect(readFileSync(file, "utf8")).not.toContain("SYNTHETIC_PRIVATE");
    const rows = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(rows.every(row => row.request_fingerprint === correlation)).toBe(true);
    setPrivateDiagnosticCapture(join(root, "diagnostics"), 0);
    const next = sse(wire);
    const afterDisable = observeNativeResponse(next, nativeRequestShape({ input: [item(false)] }));
    expect(await new Response(afterDisable).text()).toBe(wire);
    const afterRows = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(afterRows.filter(row => row.stage === "native_reasoning_observed")).toHaveLength(1);
  } finally {
    if (prior === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE; else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

test("default failure observation captures HTTP200 SSE overload outside capture and producer context", async () => {
  const correlation = diagnosticFingerprint("synthetic deferred overload");
  const wire = frame({ type: "response.failed", response: { error: { code: "server_is_overloaded", message: "SYNTHETIC_PRIVATE" } } });
  const response = await withDiagnosticContext({ request_fingerprint: correlation }, () => forwardNativeCodexRequest({
    request: new Request("http://localhost/v1/responses", { method: "POST", headers: { authorization: "Bearer synthetic" }, body: "{}" }), endpoint: "responses", runtimeHeaderName: "x-tela",
    fetchUpstream: async () => new Response(wire, { headers: { "content-type": "text/event-stream", "x-request-id": "SYNTHETIC_PRIVATE_ID" } }) }));
  expect(response.status).toBe(200); expect(await response.text()).toBe(wire);
  const rows = readFileSync(process.env.CHATGPT_TELA_DIAGNOSTIC_FILE!, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.request_fingerprint === correlation);
  const failure = rows.find(row => row.stage === "native_backend_stream_failed");
  expect(structuralDiagnosticEvent(failure)).toMatchObject({ reason_class: "server_overloaded", phase: "sse", status_code: 200, inspection_complete: true, outcome: "failed" });
  expect(rows.filter(row => row.stage === "native_backend_stream_failed")).toHaveLength(1);
  expect(rows.some(row => row.stage.startsWith("native_reasoning"))).toBe(false);
  expect(JSON.stringify(rows)).not.toContain("SYNTHETIC_PRIVATE");
});
test("shared observer detects nested, bare and incomplete errors without retrying", async () => {
  for (const event of [{ type: "error", code: "slow_down", message: "Try again in 2 seconds" },
    { type: "error", error: { code: "insufficient_quota", message: "private" } },
    { type: "response.incomplete", response: { incomplete_details: { reason: "unknown" } } }]) {
    const f = fixture(); const wire = frame(event).repeat(3);
    expect(await new Response(f.observer.observe(sse(wire), nativeRequestShape(undefined), f.emit, false)).text()).toBe(wire);
    expect(f.rows).toHaveLength(1);
    if (event.type === "error" && "code" in event) expect(f.rows[0]).toMatchObject({ reason_class: "rate_limit", retry_after_ms: 2000 });
    if ("error" in event) expect(f.rows[0].reason_class).toBe("usage_limit");
  }
});
test("late failure survives old private reasoning byte, event and time budgets", async () => {
  for (const reasoning of [false, true]) {
    let now = 0; const f = fixture(() => now);
    const prefix = frame({ type: "response.output_text.delta", delta: "SYNTHETIC_PRIVATE".repeat(300) }).repeat(300);
    const suffix = frame({ type: "response.failed", response: { error: { code: "server_is_overloaded" } } });
    const parts = [prefix, suffix];
    const body = new ReadableStream<Uint8Array>({ pull(c) { const part = parts.shift(); if (part === undefined) c.close(); else { now += 120000; c.enqueue(new TextEncoder().encode(part)); } } }, { highWaterMark: 0 });
    expect(await new Response(f.observer.observe(new Response(body, { headers: { "content-type": "text/event-stream" } }), nativeRequestShape(undefined), f.emit, reasoning)).text()).toBe(prefix + suffix);
    expect(f.rows.find(row => row.stage === "native_backend_stream_failed").reason_class).toBe("server_overloaded");
    expect(JSON.stringify(f.rows)).not.toContain("SYNTHETIC_PRIVATE");
  }
});
test("oversized or invalid frame resumes at delimiter and marks incomplete coverage", async () => {
  for (const prefix of [frame({ type: "response.output_text.delta", delta: "X".repeat(70000) }), "data: broken\n\n"]) {
    const f = fixture(); const wire = prefix + frame({ type: "error", code: "server_is_overloaded" });
    const bytes = new TextEncoder().encode(wire); let offset = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { if (offset === bytes.length) c.close(); else { c.enqueue(bytes.slice(offset, offset + 7)); offset = Math.min(bytes.length, offset + 7); } } }, { highWaterMark: 0 });
    expect(await new Response(f.observer.observe(new Response(body, { headers: { "content-type": "text/event-stream" } }), nativeRequestShape(undefined), f.emit, false)).text()).toBe(wire);
    expect(f.rows).toHaveLength(1); expect(f.rows[0]).toMatchObject({ reason_class: "server_overloaded", inspection_complete: false });
  }
});
test("failure-only success is silent; missing terminal is explicitly unproven", async () => {
  for (const terminal of [true, false]) {
    const f = fixture(); const wire = frame({ type: "response.output_text.delta", delta: "private" }) + (terminal ? frame({ type: "response.completed" }) : "");
    expect(await new Response(f.observer.observe(sse(wire), nativeRequestShape(undefined), f.emit, false)).text()).toBe(wire);
    expect(f.rows).toHaveLength(terminal ? 0 : 1);
    if (!terminal) expect(f.rows[0]).toMatchObject({ stage: "native_backend_stream_anomaly", outcome: "no_terminal_event" });
  }
});
test("failure-only cancellation and read failure preserve exact transport semantics", async () => {
  const f = fixture(); let pulls = 0, reason: unknown;
  const upstream = new ReadableStream<Uint8Array>({ pull() { pulls++; }, cancel(value) { reason = value; } }, { highWaterMark: 0 });
  const reader = f.observer.observe(new Response(upstream, { headers: { "content-type": "text/event-stream" } }), nativeRequestShape(undefined), f.emit, false)!.getReader();
  expect(pulls).toBe(0); const pending = reader.read(); await reader.cancel("synthetic cancel");
  expect((await pending).done).toBe(true); expect(reason).toBe("synthetic cancel"); expect(pulls).toBeLessThanOrEqual(1);
  expect(f.rows).toHaveLength(1); expect(f.rows[0].outcome).toBe("consumer_cancelled");
  const failure = new Error("SYNTHETIC_PRIVATE"); const g = fixture();
  const broken = new ReadableStream<Uint8Array>({ pull(c) { c.error(failure); } }, { highWaterMark: 0 });
  await expect(new Response(g.observer.observe(new Response(broken, { headers: { "content-type": "text/event-stream" } }), nativeRequestShape(undefined), g.emit, false)).text()).rejects.toBe(failure);
  expect(g.rows[0].outcome).toBe("body_interrupted"); expect(JSON.stringify(g.rows)).not.toContain("SYNTHETIC_PRIVATE");
});
