import { test, expect } from "bun:test";
import { startNativeAccountLifecycle } from "./native-account-lifecycle";
import type { CodexAppServerRpc } from "@chatgpt-tela/codex";
const signed = (email = "one@example.test", container = "space") => ({ account: { type: "chatgpt", email }, workspaceRouting: { chatgptAccountId: container } });
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(read: (n: number, signal?: AbortSignal) => Promise<unknown>, observe?: Parameters<typeof startNativeAccountLifecycle>[0]["observe"]) {
  let notification!: (method: string, params: unknown) => void;
  let disconnected!: () => void;
  let reads = 0, closes = 0, unsubscribes = 0;
  const reasons: string[] = [];
  const done = deferred<void>();
  const rpc: CodexAppServerRpc = {
    async request(method, params, signal) { expect(method).toBe("account/read"); expect(params).toEqual({ refreshToken: false }); return read(++reads, signal); },
    async close() { closes++; },
    subscribe(n, d) { notification = n; disconnected = d; return () => { unsubscribes++; }; },
  };
  const lifecycle = startNativeAccountLifecycle({ ...(observe ? { observe } : {}), signal: new AbortController().signal, connect: async () => rpc,
    async invalidate(reason) { reasons.push(reason); done.resolve(); } });
  return { lifecycle, reasons, done, notify(method: string, params: unknown) { notification(method, params); }, event() { notification("account/updated", {}); }, unrelated() { notification("thread/started", {}); }, disconnected() { disconnected(); }, get reads() { return reads; }, get closes() { return closes; } };
}
async function settle() { await new Promise(r => setTimeout(r, 0)); }
test("initial state and repeated same-account notifications do not revoke Web", async () => {
  const f = fixture(async () => signed());
  await f.lifecycle.ready; f.event(); await settle(); f.unrelated(); await settle();
  expect(f.reasons).toEqual([]); expect(f.reads).toBe(2);
  await f.lifecycle.stop(); expect(f.closes).toBe(1);
});
test("signed out and same-auth-mode account switch automatically revoke old Web authority", async () => {
  for (const after of [null, signed("two@example.test"), signed("one@example.test", "other")]) {
    const f = fixture(async n => n === 1 ? signed() : after === null ? { account: null } : after);
    await f.lifecycle.ready; f.event(); await f.done.promise;
    expect(f.reasons).toEqual([after === null ? "signed_out" : "account_changed"]);
    await f.lifecycle.stop();
  }
});
test("event during initial read excludes stale signed-in result", async () => {
  const held = deferred<unknown>();
  const f = fixture(async n => n === 1 ? held.promise : { account: null });
  await settle(); f.event(); held.resolve(signed());
  await f.lifecycle.ready;
  expect(f.reads).toBe(2); expect(f.reasons).toEqual(["signed_out"]);
  await f.lifecycle.stop();
});
test("disconnect or malformed observation revokes without login/logout requests", async () => {
  const f = fixture(async n => n === 1 ? signed() : {});
  await f.lifecycle.ready; f.event(); await f.done.promise;
  expect(f.reasons).toEqual(["observation_unavailable"]);
  await f.lifecycle.stop();
  const g = fixture(async () => signed()); await g.lifecycle.ready; g.disconnected(); await g.done.promise;
  expect(g.reasons).toEqual(["observation_unavailable"]); await g.lifecycle.stop();
});
test("shutdown cancels pending read and suppresses auth changes after observer disposal", async () => {
  const f = fixture(async (_n, signal) => new Promise((_resolve, reject) => {
    signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
  }));
  await settle(); await f.lifecycle.stop();
  expect(f.reasons).toEqual([]); expect(f.closes).toBe(1);
});


test("repeated signed-out events do not repeat account cleanup", async () => {
  const f = fixture(async () => ({ account: null }));
  await f.lifecycle.ready; f.event(); await settle();
  expect(f.reasons).toEqual(["signed_out"]); expect(f.reads).toBe(2);
  await f.lifecycle.stop();
});

test("event bursts are bounded and cannot publish a superseded result", async () => {
  const held = deferred<unknown>();
  const f = fixture(async n => n === 1 ? held.promise : signed());
  await settle(); for (let n = 0; n < 50; n++) f.event();
  held.resolve(signed()); await f.lifecycle.ready;
  expect(f.reads).toBe(2); expect(f.reasons).toEqual([]);
  await f.lifecycle.stop();
});


test("late connection after shutdown is closed without account reads or invalidation", async () => {
  const connected = deferred<CodexAppServerRpc>(); let reads = 0, closes = 0, invalidations = 0;
  const lifecycle = startNativeAccountLifecycle({ signal: new AbortController().signal, connect: async () => connected.promise,
    async invalidate() { invalidations++; } });
  const stopped = lifecycle.stop();
  connected.resolve({ async request() { reads++; return signed(); }, async close() { closes++; } });
  await stopped;
  expect(reads).toBe(0); expect(closes).toBe(1); expect(invalidations).toBe(0);
});

test("failed Web cleanup is reported once rather than retried as a different auth failure", async () => {
  let calls = 0;
  const lifecycle = startNativeAccountLifecycle({ signal: new AbortController().signal,
    connect: async () => ({ async request() { return { account: null }; }, async close() {}, subscribe() { return () => {}; } }),
    async invalidate() { calls++; throw new Error("cleanup failed"); } });
  await expect(lifecycle.ready).rejects.toThrow("cleanup failed");
  expect(calls).toBe(1);
  await expect(lifecycle.stop()).rejects.toThrow("cleanup failed");
});


test("profile notification connection forwards late title events and drains its owned work on shutdown", async () => {
  const held = deferred<void>();
  const events: unknown[] = [];
  const f = fixture(async () => signed(), async (method, params) => {
    if (method !== "thread/name/updated") return;
    events.push(params); await held.promise;
  });
  await f.lifecycle.ready;
  f.notify("thread/name/updated", { threadId: "owned", threadName: "Late generated title" });
  expect(events).toEqual([{ threadId: "owned", threadName: "Late generated title" }]);
  let stopped = false;
  const stopping = f.lifecycle.stop().then(() => { stopped = true; });
  await settle(); expect(stopped).toBe(false);
  f.notify("thread/name/updated", { threadId: "owned", threadName: "After stop" });
  held.resolve(); await stopping;
  expect(events).toHaveLength(1); expect(f.closes).toBe(1); expect(f.reasons).toEqual([]);
});
