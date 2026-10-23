import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, realpathSync, existsSync, writeFileSync, lstatSync, mkdirSync, utimesSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { CodexAppServerRpc } from "@chatgpt-tela/codex";
import { WebDelegationStore, linkNativeThreadForRetention, type WebDelegationRecord } from "./web-delegation";
import { settleWebDelegationRetention, startWebDelegationRetention } from "./web-delegation-retention";
const DAY = 86_400_000;
test("exact Native creation ACK links once without sending or reserving a task", async () => {
  const f = fixture();
  try {
    const threadId = randomUUID(), turnId = randomUUID(), cwd = realpathSync(f.root);
    const receipt = { slot: 2, cwd, createdAt: f.origin,
      accountFingerprint: f.record.owner.accountFingerprint, threadId, turnId };
    const rpc = { async close() {}, async request(method: string) {
      if (method === "thread/read") return { thread: { id: threadId, cwd, historyMode: "paginated" } };
      if (method === "thread/turns/list") return { data: [{ id: turnId, status: "completed" }], nextCursor: null };
      throw Error(`Unexpected mutation ${method}`);
    } };
    const adapters = { ...f.adapters, connect: async () => rpc as any };
    const linked = await linkNativeThreadForRetention(adapters, receipt, new AbortController().signal);
    expect(f.store.get(linked.id)?.origin).toBe("native-thread-link");
    expect(f.store.get(linked.id)?.state).toBe("linked");
    expect(f.store.capacity(2, f.root).total.used).toBe(0);
    await expect(linkNativeThreadForRetention(adapters, receipt, new AbortController().signal)).rejects.toThrow("already managed");
    await expect(linkNativeThreadForRetention(adapters, { ...receipt, accountFingerprint: "f".repeat(64) }, new AbortController().signal)).rejects.toThrow("owner mismatch");
  } finally { f.cleanup(); }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tela-retention-")), store = new WebDelegationStore(root);
  const origin = 1_700_000_000_000;
  const record: WebDelegationRecord = { id: randomUUID(), slot: 2, cwd: root, createdAt: origin,
    promptHash: "a".repeat(64), mode: "read", state: "reserved", threadId: randomUUID(), turnId: randomUUID(),
    owner: { slot: 2, accountFingerprint: "a".repeat(64), routeFingerprint: "c".repeat(64), sessionFingerprint: "b".repeat(64) },
    session: { slot: 2, runtimeProcessId: 10, responsesRouteFingerprint: "c".repeat(64), terminalEndpoint: "ws://127.0.0.1:1234" } };
  store.reserve(record);
  store.save({ ...record, state: "completed", answer: "result", finalEvidence: "explicit-final-phase" });
  const native = { exists: true, cwd: root, archived: false, updatedAt: origin / 1000, status: "idle", turnStatus: "completed", tailId: record.turnId, queued: false, accountChanged: false, failArchive: false };
  const calls: Array<{ method: string; params: any }> = [];
  const rpc: CodexAppServerRpc = {
    async close() {},
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/list") {
        return { data: native.exists && (params as any).archived === native.archived
          ? [{ id: record.threadId, cwd: root, updatedAt: native.updatedAt, status: { type: native.status } }] : [], nextCursor: null };
      }
      if (method === "thread/turns/list") return { data: [{ id: native.tailId, status: native.turnStatus }] };
      if (method === "thread/queue/list") return { data: native.queued ? [{ id: "queued" }] : [], nextCursor: null };
      if (method === "thread/archive") {
        native.archived = true;
        native.updatedAt++;
        if (native.failArchive) throw Error("ACK lost after archive");
        return {};
      }
      if (method === "thread/read") {
        if (!native.exists) throw Error(`thread not loaded: ${record.threadId}`);
        return { thread: { id: record.threadId, cwd: native.cwd ?? root, updatedAt: native.updatedAt } };
      }
      if (method === "thread/delete") { native.exists = false; return {}; }
      throw Error(`Unexpected RPC ${method}`);
    },
  };
  const adapters = { store, owner: async () => ({ binding: { ...record.owner, ...(native.accountChanged ? { accountFingerprint: "d".repeat(64) } : {}) }, session: record.session }), connect: async () => rpc };
  const run = async (now: number) => {
    const path = join(root, `thread-${record.slot}-${record.owner.accountFingerprint}-${record.threadId}.retention`);
    const previous = existsSync(path) ? statSync(path).mtimeMs : undefined;
    const result = await settleWebDelegationRetention(adapters, { now, signal: new AbortController().signal });
    if (existsSync(path) && store.threadRetention(record)?.state === "excluded"
      && (!previous || statSync(path).mtimeMs !== previous)) utimesSync(path, now / 1000, now / 1000);
    return result;
  };
  return { root, store, record, native, calls, origin, adapters, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("first result collection starts 24h clock, repeated reads do not extend it, auto archive deletes thirty days later", async () => {
  const f = fixture();
  try {
    f.store.collect(f.record.id, f.origin + DAY);
    f.store.collect(f.record.id, f.origin + 2 * DAY);
    expect(f.store.collectedAt(f.record.id)).toBe(f.origin + DAY);
    const immutable = readFileSync(join(f.root, `${f.record.id}.json.completed`), "utf8");
    await f.run(f.origin + 2 * DAY - 1);
    expect(f.calls.every(c => c.method === "thread/list")).toBe(true);
    expect(await f.run(f.origin + 2 * DAY)).toBe(f.origin + 32 * DAY); expect(f.native.archived).toBe(true);
    expect(await f.run(f.origin + 9 * DAY)).toBe(f.origin + 32 * DAY);
    expect(f.native.exists).toBe(true);
    await f.run(f.origin + 32 * DAY - 1); expect(f.native.exists).toBe(true);
    await f.run(f.origin + 32 * DAY); expect(f.native.exists).toBe(false);
    expect(f.calls.filter(c => c.method === "thread/archive")).toHaveLength(1);
    expect(f.calls.filter(c => c.method === "thread/delete")).toHaveLength(1);
    expect(immutable).toContain("result");
    expect(f.store.get(f.record.id)).toBeUndefined();
    expect(f.store.records()).toHaveLength(0);
    expect(existsSync(join(f.root, `${f.record.id}.json.completed`))).toBe(false);
  } finally { f.cleanup(); }
});
test("uncollected results use seven actual idle days, polling never resets activity", async () => {
  const f = fixture();
  try {
    f.native.updatedAt += DAY / 1000;
    expect(await f.run(f.origin + 7 * DAY)).toBe(f.origin + 8 * DAY);
    expect(f.native.archived).toBe(false);
    await f.run(f.origin + 8 * DAY); expect(f.native.archived).toBe(true);
  } finally { f.cleanup(); }
});
test("active or queued work is protected and settles on the next actual job change", async () => {
  const f = fixture();
  try {
    f.native.status = "active"; await f.run(f.origin + 8 * DAY);
    f.native.status = "idle"; f.native.turnStatus = "inProgress"; await f.run(f.origin + 8 * DAY);
    f.native.turnStatus = "completed"; f.native.queued = true; await f.run(f.origin + 8 * DAY);
    expect(f.native.archived).toBe(false);
    f.native.queued = false; await f.run(f.origin + 8 * DAY);
    expect(f.native.archived).toBe(true);
  } finally { f.cleanup(); }
});
test("manual archive, restore, activity and delete relinquish automatic ownership without recreating threads", async () => {
  for (const action of ["archive", "restore", "activity", "delete", "direct-turn"] as const) {
    const f = fixture();
    try {
      if (action === "restore" || action === "activity") await f.run(f.origin + 7 * DAY);
      if (action === "archive") f.native.archived = true;
      if (action === "restore") f.native.archived = false;
      if (action === "activity") f.native.updatedAt++;
      if (action === "delete") f.native.exists = false;
      if (action === "direct-turn") f.native.tailId = randomUUID();
      await f.run(f.origin + 37 * DAY);
      await f.run(f.origin + 40 * DAY);
      expect(f.calls.filter(c => c.method === "thread/delete")).toHaveLength(0);
      expect(f.calls.filter(c => c.method === "thread/archive")).toHaveLength(action === "restore" || action === "activity" ? 1 : 0);
    } finally { f.cleanup(); }
  }
});
test("manual archive then delete cleans an excluded thread before its due date", async () => {
  const f = fixture();
  try {
    f.native.archived = true;
    await f.run(f.origin + DAY);
    expect(f.store.threadRetention(f.record)?.state).toBe("excluded");
    expect(f.store.get(f.record.id)?.answer).toBe("result");
    f.native.archived = false;
    await f.run(f.origin + 2 * DAY);
    expect(f.store.get(f.record.id)?.answer).toBe("result");
    f.native.exists = false;
    await f.run(f.origin + 3 * DAY);
    expect(f.store.get(f.record.id)).toBeUndefined();
    expect(f.store.records()).toHaveLength(0);
    expect(f.calls.filter(c => c.method === "thread/delete" || c.method === "thread/archive")).toHaveLength(0);
  } finally { f.cleanup(); }
});
test("a later managed continuation reclaims manual exclusion, while old history does not", async () => {
  const f = fixture();
  try {
    f.native.archived = true;
    await f.run(f.origin + DAY);
    expect(f.store.threadRetention(f.record)?.state).toBe("excluded");
    f.native.archived = false;
    await f.run(f.origin + 8 * DAY);
    expect(f.native.archived).toBe(false);
    const child = { ...f.record, id: randomUUID(), parentJobId: f.record.id,
      turnId: randomUUID(), createdAt: f.origin + 9 * DAY };
    f.store.reserve(child);
    f.store.save({ ...child, state: "completed", answer: "continued", finalEvidence: "explicit-final-phase" });
    f.native.tailId = child.turnId;
    f.native.updatedAt = child.createdAt / 1000;
    await f.run(f.origin + 10 * DAY);
    expect(f.store.threadRetention(child)).toBeUndefined();
    expect(f.native.archived).toBe(false);
    await f.run(f.origin + 16 * DAY);
    expect(f.native.archived).toBe(true);
  } finally { f.cleanup(); }
});
test("legacy excluded receipt uses its mtime; a later copied timestamp stays excluded", async () => {
  const f = fixture();
  try {
    const path = join(f.root, `thread-${f.record.slot}-${f.record.owner.accountFingerprint}-${f.record.threadId}.retention`);
    writeFileSync(path, JSON.stringify({ state: "excluded" }));
    utimesSync(path, (f.origin + DAY) / 1000, (f.origin + DAY) / 1000);
    const child = { ...f.record, id: randomUUID(), parentJobId: f.record.id, createdAt: f.origin + 2 * DAY, turnId: randomUUID() };
    f.store.reserve(child);
    f.store.save({ ...child, state: "completed", answer: "continued", finalEvidence: "explicit-final-phase" });
    f.native.tailId = child.turnId;
    f.native.updatedAt = child.createdAt / 1000;
    utimesSync(path, (f.origin + 3 * DAY) / 1000, (f.origin + 3 * DAY) / 1000);
    await f.run(f.origin + 4 * DAY);
    expect(f.store.threadRetention(child)?.state).toBe("excluded");
    utimesSync(path, (f.origin + DAY) / 1000, (f.origin + DAY) / 1000);
    await f.run(f.origin + 4 * DAY);
    expect(f.store.threadRetention(child)).toBeUndefined();
  } finally { f.cleanup(); }
});
test("before-due manual deletion is reconciled without an automatic mutation", async () => {
  const f = fixture();
  try {
    f.native.exists = false;
    await f.run(f.origin + DAY);
    expect(f.store.get(f.record.id)).toBeUndefined();
    expect(f.calls.some(c => c.method === "thread/archive" || c.method === "thread/delete")).toBe(false);
  } finally { f.cleanup(); }
});
test("one owner and cwd share metadata listings across managed threads", async () => {
  const f = fixture();
  try {
    const other = { ...f.record, id: randomUUID(), threadId: randomUUID(), turnId: randomUUID() };
    f.store.reserve(other);
    f.store.save({ ...other, state: "completed", answer: "other", finalEvidence: "explicit-final-phase" });
    await f.run(f.origin + DAY);
    expect(f.calls.filter(c => c.method === "thread/list")).toHaveLength(2);
    expect(f.calls.filter(c => c.method === "thread/read")).toHaveLength(1);
    expect(f.store.get(other.id)?.answer).toBe("other");
  } finally { f.cleanup(); }
});
test("excluded absence remains local under another account or transport error", async () => {
  const f = fixture();
  try {
    f.native.archived = true;
    await f.run(f.origin + DAY);
    f.native.exists = false;
    f.native.accountChanged = true;
    await f.run(f.origin + 2 * DAY);
    expect(f.store.get(f.record.id)?.answer).toBe("result");
    f.native.accountChanged = false;
    const adapters = { ...f.adapters, connect: async () => ({
      close: async () => {},
      request: async () => { throw Error("Socket closed"); },
    }) as any };
    await settleWebDelegationRetention(adapters, { now: f.origin + 3 * DAY, signal: new AbortController().signal });
    expect(f.store.get(f.record.id)?.answer).toBe("result");
    await f.run(f.origin + 4 * DAY);
    expect(f.store.get(f.record.id)).toBeUndefined();
  } finally { f.cleanup(); }
});
test("excluded moved cwd remains alive after an empty cwd-filtered list", async () => {
  const f = fixture();
  try {
    f.native.archived = true;
    await f.run(f.origin + DAY);
    f.native.cwd = join(f.root, "moved");
    const adapters = { ...f.adapters, connect: async () => {
      const rpc = await f.adapters.connect();
      return { ...rpc, request: async (method: string, params: any, signal?: AbortSignal) =>
        method === "thread/list" ? { data: [], nextCursor: null } : rpc.request(method, params, signal) };
    } };
    await settleWebDelegationRetention(adapters, { now: f.origin + 2 * DAY, signal: new AbortController().signal });
    expect(f.store.get(f.record.id)?.answer).toBe("result");
    expect(f.native.exists).toBe(true);
    expect(f.calls.some(c => c.method === "thread/delete")).toBe(false);
  } finally { f.cleanup(); }
});
test("an unknown mutation outcome is never retried; another account cannot act on the stored thread", async () => {
  const f = fixture();
  try {
    f.native.accountChanged = true; await f.run(f.origin + 8 * DAY); expect(f.calls).toHaveLength(0);
    f.native.accountChanged = false; f.native.failArchive = true;
    await f.run(f.origin + 8 * DAY);
    await f.run(f.origin + 40 * DAY);
    expect(f.calls.filter(c => c.method === "thread/archive")).toHaveLength(1);
    expect(f.calls.filter(c => c.method === "thread/delete")).toHaveLength(0);
  } finally { f.cleanup(); }
});
test("a managed continuation resets the thread policy, not an older collected job", async () => {
  const f = fixture();
  try {
    f.store.collect(f.record.id, f.origin);
    const child = { ...f.record, id: randomUUID(), parentJobId: f.record.id, createdAt: f.origin + 6 * DAY, turnId: randomUUID() };
    f.store.reserve(child); f.store.save({ ...child, state: "completed", answer: "new result", finalEvidence: "explicit-final-phase" });
    f.native.tailId = child.turnId; f.native.updatedAt = child.createdAt / 1000;
    expect(await f.run(f.origin + 7 * DAY)).toBe(f.origin + 13 * DAY);
    expect(f.native.archived).toBe(false);
  } finally { f.cleanup(); }
});
test("daemon lifecycle starts due maintenance without polling and closes its watcher", async () => {
  const f = fixture(), abort = new AbortController();
  const retention = startWebDelegationRetention(f.adapters, abort.signal);
  try {
    // Close drains the already-started pass; fixture dates are in the past.
    await retention.close();
    expect(f.native.archived).toBe(true);
  } finally { abort.abort(); f.cleanup(); }
});

test("confirmed deletion removes only matching thread jobs and survives interrupted cleanup", async () => {
  const f = fixture();
  try {
    const other = { ...f.record, id: randomUUID(), threadId: randomUUID(), turnId: randomUUID() };
    f.store.reserve(other);
    f.store.save({ ...other, state: "completed", answer: "other", finalEvidence: "explicit-final-phase" });
    f.store.collect(f.record.id, f.origin);
    const base = join(f.root, `${f.record.id}.json`);
    const receipt = join(f.root, `${f.record.id}.json.completed`);
    // A prior cleanup was interrupted after terminal artifacts were removed.
    const key = { slot: f.record.slot, accountFingerprint: f.record.owner.accountFingerprint, threadId: f.record.threadId! };
    const retention = join(f.root, `thread-${key.slot}-${key.accountFingerprint}-${key.threadId}.retention`);
    writeFileSync(retention, JSON.stringify({ state: "deleted" }));
    writeFileSync(base, JSON.stringify({ ...f.record, state: "completed", answer: "result", finalEvidence: "explicit-final-phase" }));
    rmSync(receipt);
    expect(existsSync(base)).toBe(true);
    expect(f.store.removeDeletedThread(key).jobs).toBe(1);
    expect(existsSync(base)).toBe(false);
    expect(existsSync(retention)).toBe(false);
    expect(existsSync(join(f.root, `${f.record.id}.json.collected`))).toBe(false);
    expect(f.store.get(f.record.id)).toBeUndefined();
    expect(f.store.get(other.id)?.answer).toBe("other");
    expect(f.store.records()).toHaveLength(1);
    expect(f.store.removeDeletedThread(key).jobs).toBe(0);
  } finally { f.cleanup(); }
});

test("a deletion receipt rejects late result collection and observer save", () => {
  const f = fixture();
  try {
    const key = { slot: f.record.slot, accountFingerprint: f.record.owner.accountFingerprint, threadId: f.record.threadId! };
    const retention = join(f.root, `thread-${key.slot}-${key.accountFingerprint}-${key.threadId}.retention`);
    writeFileSync(retention, JSON.stringify({ state: "deleted" }));
    expect(() => f.store.collect(f.record.id)).toThrow("No verified Web result");
    expect(() => f.store.save({ ...f.record, state: "running" })).toThrow("not reserved");
    expect(existsSync(join(f.root, `${f.record.id}.json.collected`))).toBe(false);
    f.store.removeDeletedThread(key);
    expect(() => f.store.save({ ...f.record, state: "running" })).toThrow("not reserved");
  } finally { f.cleanup(); }
});

test("confirmed deletion settles unresolved jobs and releases only their leases", async () => {
  const f = fixture();
  try {
    const pending = { ...f.record, id: randomUUID(), threadId: f.record.threadId!, turnId: randomUUID(), state: "running" as const };
    f.store.reserve(pending);
    const separate = { ...f.record, id: randomUUID(), threadId: randomUUID(), turnId: randomUUID(), state: "running" as const };
    const otherCwd = join(f.root, "other-checkout");
    mkdirSync(otherCwd);
    f.store.reserve({ ...separate, cwd: otherCwd });
    const key = { slot: f.record.slot, accountFingerprint: f.record.owner.accountFingerprint, threadId: f.record.threadId! };
    writeFileSync(join(f.root, `thread-${key.slot}-${key.accountFingerprint}-${key.threadId}.retention`), JSON.stringify({ state: "deleted" }));
    expect(f.store.get(pending.id)).toBeUndefined();
    expect(f.store.records().map(job => job.id)).toEqual([separate.id]);
    f.native.exists = false;
    await f.run(f.origin + 40 * DAY);
    expect(f.store.get(pending.id)).toBeUndefined();
    expect(f.store.get(separate.id)?.state).toBe("running");
    expect(f.store.capacity(2, f.root).total.used).toBe(1);
    expect(f.store.get(f.record.id)).toBeUndefined();
  } finally { f.cleanup(); }
});

test("cleanup uses the authoritative terminal receipt when a base snapshot predates thread creation", async () => {
  const f = fixture();
  try {
    const base = join(f.root, `${f.record.id}.json`);
    writeFileSync(base, JSON.stringify({ ...f.record, state: "creating", threadId: undefined, turnId: undefined }));
    const key = { slot: f.record.slot, accountFingerprint: f.record.owner.accountFingerprint, threadId: f.record.threadId! };
    writeFileSync(join(f.root, `thread-${key.slot}-${key.accountFingerprint}-${key.threadId}.retention`), JSON.stringify({ state: "deleted" }));
    f.native.exists = false;
    await f.run(f.origin + 40 * DAY);
    expect(f.store.get(f.record.id)).toBeUndefined();
    expect(existsSync(base)).toBe(false);
    expect(existsSync(`${base}.completed`)).toBe(false);
  } finally { f.cleanup(); }
});

test("cwd-filter absence preserves relocated Native thread and its local answer", async () => {
  const f = fixture();
  try {
    f.native.cwd = join(f.root, "moved");
    const rpc = f.adapters.connect;
    const adapters = { ...f.adapters, connect: async (endpoint: string) => {
      const original = await rpc();
      return { ...original, request: async (method: string, params: any, signal?: AbortSignal) => {
        if (method === "thread/list") return { data: [], nextCursor: null };
        return original.request(method as any, params, signal);
      } };
    } };
    await settleWebDelegationRetention(adapters, { now: f.origin + 8 * DAY, signal: new AbortController().signal });
    expect(f.store.get(f.record.id)?.answer).toBe("result");
    expect(f.native.exists).toBe(true);
    expect(f.calls.some(c => c.method === "thread/delete")).toBe(false);
    expect(f.store.threadRetention(f.record)?.state).toBe("excluded");
  } finally { f.cleanup(); }
});

test("stale deleted receipt is rechecked; a living moved thread keeps terminal result", async () => {
  const f = fixture();
  try {
    const key = { slot: f.record.slot, accountFingerprint: f.record.owner.accountFingerprint, threadId: f.record.threadId! };
    writeFileSync(join(f.root, `thread-${key.slot}-${key.accountFingerprint}-${key.threadId}.retention`), JSON.stringify({ state: "deleted" }));
    f.native.cwd = join(f.root, "moved");
    await f.run(f.origin + 40 * DAY);
    expect(f.store.get(f.record.id)?.answer).toBe("result");
    expect(f.store.threadRetention(f.record)?.state).toBe("excluded");
    expect(f.calls.some(c => c.method === "thread/delete")).toBe(false);
  } finally { f.cleanup(); }
});

test("interrupted base-first cleanup discovers terminal-only ownership on restart", async () => {
  const f = fixture();
  try {
    const base = join(f.root, `${f.record.id}.json`);
    writeFileSync(base, JSON.stringify({ ...f.record, state: "creating", threadId: undefined }));
    const key = { slot: f.record.slot, accountFingerprint: f.record.owner.accountFingerprint, threadId: f.record.threadId! };
    writeFileSync(join(f.root, `thread-${key.slot}-${key.accountFingerprint}-${key.threadId}.retention`), JSON.stringify({ state: "deleted" }));
    rmSync(base);
    f.native.exists = false;
    expect(f.store.recordsForThread(key).map(job => job.id)).toEqual([f.record.id]);
    await f.run(f.origin + 40 * DAY);
    expect(existsSync(`${base}.completed`)).toBe(false);
    expect(existsSync(join(f.root, `thread-${key.slot}-${key.accountFingerprint}-${key.threadId}.retention`))).toBe(false);
  } finally { f.cleanup(); }
});


test("post-delete read still present keeps local answer", async () => {
  const f = fixture();
  try {
    await f.run(f.origin + 8 * DAY);
    const adapters = { ...f.adapters, connect: async () => {
      const original = await f.adapters.connect();
      return { ...original, request: async (method: string, params: any, signal?: AbortSignal) => {
        if (method === "thread/delete") return {};
        return original.request(method as any, params, signal);
      } };
    } };
    await settleWebDelegationRetention(adapters, { now: f.origin + 40 * DAY, signal: new AbortController().signal });
    expect(f.store.get(f.record.id)?.answer).toBe("result");
    expect(f.store.threadRetention(f.record)?.state).toBe("excluded");
  } finally { f.cleanup(); }
});

test("partial terminal cleanup resumes from each remaining sidecar and clears receipt-only residue", async () => {
  for (const remaining of ["completed-collected", "completed", "failed", "none"] as const) {
    const f = fixture();
    try {
      const base = join(f.root, `${f.record.id}.json`);
      const key = { slot: f.record.slot, accountFingerprint: f.record.owner.accountFingerprint, threadId: f.record.threadId! };
      const receipt = join(f.root, `thread-${key.slot}-${key.accountFingerprint}-${key.threadId}.retention`);
      writeFileSync(receipt, JSON.stringify({ state: "deleted" }));
      if (remaining === "failed") writeFileSync(`${base}.failed`, JSON.stringify({ ...f.record, state: "failed", failure: "turn_failed" }));
      if (remaining === "completed-collected") writeFileSync(`${base}.collected`, String(f.origin));
      rmSync(base);
      for (const suffix of ["completed", "failed", "collected"] as const) {
        if (suffix !== remaining && !(remaining === "completed-collected" && (suffix === "completed" || suffix === "collected"))) rmSync(`${base}.${suffix}`, { force: true });
      }
      f.native.exists = false;
      await f.run(f.origin + 40 * DAY);
      expect(existsSync(receipt)).toBe(false);
      expect(existsSync(`${base}.completed`)).toBe(false);
      expect(existsSync(`${base}.failed`)).toBe(false);
      expect(existsSync(`${base}.collected`)).toBe(false);
    } finally { f.cleanup(); }
  }
});

test("excluded collected local history expires without Native mutation or late recreation", async () => {
  const f = fixture();
  try {
    f.store.collect(f.record.id, f.origin);
    f.native.archived = true;
    await f.run(f.origin + DAY);
    expect(f.store.threadRetention(f.record)?.state).toBe("excluded");
    expect(await f.run(f.origin + 29 * DAY)).toBe(f.origin + 30 * DAY);
    expect(f.store.get(f.record.id)?.answer).toBe("result");
    await f.run(f.origin + 30 * DAY);
    expect(f.store.get(f.record.id)).toBeUndefined();
    expect(f.store.records()).toHaveLength(0);
    expect(() => f.store.collect(f.record.id)).toThrow();
    expect(() => f.store.save({ ...f.record, state: "running" })).toThrow();
    expect(f.native.exists).toBe(true);
    expect(f.calls.filter(call => call.method === "thread/delete" || call.method === "thread/archive")).toHaveLength(0);
  } finally { f.cleanup(); }
});

test("excluded history waits for empty Native queue and the managed latest turn", async () => {
  const f = fixture();
  try {
    f.store.collect(f.record.id, f.origin);
    f.native.archived = true;
    await f.run(f.origin + DAY);
    f.native.queued = true;
    await f.run(f.origin + 40 * DAY);
    expect(f.store.get(f.record.id)?.answer).toBe("result");
    f.native.queued = false;
    f.native.tailId = randomUUID();
    await f.run(f.origin + 41 * DAY);
    expect(f.store.get(f.record.id)?.answer).toBe("result");
  } finally { f.cleanup(); }
});

test("multiple collected continuations prune together while an uncollected sibling protects all", async () => {
  const f = fixture();
  try {
    f.store.collect(f.record.id, f.origin);
    const child = { ...f.record, id: randomUUID(), parentJobId: f.record.id, createdAt: f.origin + DAY, turnId: randomUUID() };
    f.store.reserve(child);
    f.store.save({ ...child, state: "completed", answer: "followup", finalEvidence: "explicit-final-phase" });
    f.native.tailId = child.turnId;
    f.native.archived = true;
    await f.run(f.origin + 2 * DAY);
    await f.run(f.origin + 40 * DAY);
    expect(f.store.get(f.record.id)?.answer).toBe("result");
    f.store.collect(child.id, f.origin + 2 * DAY);
    await f.run(f.origin + 40 * DAY);
    expect(f.store.records()).toHaveLength(0);
    expect(f.native.exists).toBe(true);
  } finally { f.cleanup(); }
});

test("interrupted excluded history cleanup resumes from terminal and collection proof", async () => {
  const f = fixture();
  try {
    f.store.collect(f.record.id, f.origin);
    f.native.archived = true;
    await f.run(f.origin + DAY);
    const base = join(f.root, `${f.record.id}.json`);
    // Interrupted after unlinking the base, before deleting the terminal.
    rmSync(base);
    expect(f.store.get(f.record.id)?.answer).toBe("result");
    expect(existsSync(`${base}.collected`)).toBe(true);
    await f.run(f.origin + 30 * DAY);
    expect(f.store.get(f.record.id)).toBeUndefined();
    expect(existsSync(`${base}.completed`)).toBe(false);
    expect(existsSync(`${base}.collected`)).toBe(false);
    expect(f.store.threadRetention(f.record)).toBeUndefined();
    expect(f.native.exists).toBe(true);
    expect(f.calls.some(call => call.method === "thread/delete" || call.method === "thread/archive")).toBe(false);
  } finally { f.cleanup(); }
});

test("interrupted terminal removal sweeps a collected-only marker and excluded receipt", async () => {
  const f = fixture();
  try {
    f.store.collect(f.record.id, f.origin);
    f.native.archived = true;
    await f.run(f.origin + DAY);
    const base = join(f.root, `${f.record.id}.json`);
    // Interrupted after removing every answer-bearing file, before the
    // collection timestamp and excluded receipt were unlinked.
    rmSync(base);
    rmSync(`${base}.completed`);
    expect(existsSync(`${base}.collected`)).toBe(true);
    await f.run(f.origin + 40 * DAY);
    expect(existsSync(`${base}.collected`)).toBe(false);
    expect(f.store.threadRetention(f.record)).toBeUndefined();
    expect(f.native.exists).toBe(true);
  } finally { f.cleanup(); }
});

test("terminal-only excluded answer without collection proof remains protected", async () => {
  const f = fixture();
  try {
    f.store.collect(f.record.id, f.origin);
    f.native.archived = true;
    await f.run(f.origin + DAY);
    const base = join(f.root, `${f.record.id}.json`);
    // A legacy interrupted sequence lost its collection proof first. Do not
    // guess whether this remaining terminal answer was ever collected.
    rmSync(base);
    rmSync(`${base}.collected`);
    await f.run(f.origin + 40 * DAY);
    expect(f.store.get(f.record.id)?.answer).toBe("result");
    expect(existsSync(`${base}.completed`)).toBe(true);
    expect(f.store.threadRetention(f.record)?.state).toBe("excluded");
  } finally { f.cleanup(); }
});

test("late same-thread continuation lease protects collected excluded history", async () => {
  const f = fixture();
  try {
    f.store.collect(f.record.id, f.origin);
    f.native.archived = true;
    await f.run(f.origin + DAY);
    const lease = join(f.root, `continuation-thread-${f.record.threadId}.lease`);
    writeFileSync(lease, randomUUID());
    await f.run(f.origin + 40 * DAY);
    expect(f.store.get(f.record.id)?.answer).toBe("result");
    rmSync(lease);
    await f.run(f.origin + 40 * DAY);
    expect(f.store.get(f.record.id)).toBeUndefined();
  } finally { f.cleanup(); }
});

test("only eligible collected bytes trigger the 16 MiB history budget", () => {
  const f = fixture();
  try {
    const eligible = new Set<string>();
    const exclude = (record: WebDelegationRecord) => {
      const key = `${record.slot}:${record.owner.accountFingerprint}:${record.threadId}`;
      eligible.add(key);
      writeFileSync(join(f.root, `thread-${record.slot}-${record.owner.accountFingerprint}-${record.threadId}.retention`),
        JSON.stringify({ state: "excluded" }));
    };
    f.store.collect(f.record.id, f.origin);
    exclude(f.record);
    const protectedJobs: WebDelegationRecord[] = [];
    const largeAnswer = "x".repeat(500 * 1024);
    for (let i = 0; i < 35; i++) {
      const job = { ...f.record, id: randomUUID(), threadId: randomUUID(), turnId: randomUUID(), createdAt: f.origin + i };
      f.store.reserve(job);
      f.store.save({ ...job, state: "completed", answer: largeAnswer, finalEvidence: "explicit-final-phase" });
      exclude(job);
      protectedJobs.push(job);
    }
    // Uncollected results exceed 16 MiB but are outside the reclaimable budget.
    expect(f.store.pruneCollectedHistory(eligible, f.origin + DAY).removed).toBe(0);
    expect(f.store.get(f.record.id)?.answer).toBe("result");
    for (const [index, job] of protectedJobs.entries()) f.store.collect(job.id, f.origin + DAY + index);
    const pruned = f.store.pruneCollectedHistory(eligible, f.origin + 2 * DAY);
    expect(pruned.removed).toBeGreaterThan(1);
    const remaining = [f.record, ...protectedJobs].filter(job => f.store.get(job.id));
    expect(remaining.length).toBeGreaterThan(0);
    expect(f.store.get(protectedJobs.at(-1)!.id)?.answer?.length).toBe(largeAnswer.length);
    const bytes = remaining.reduce((sum, job) => sum + ["", ".collected", ".failed", ".completed"].reduce((size, suffix) => {
      const path = join(f.root, `${job.id}.json${suffix}`);
      return size + (existsSync(path) ? lstatSync(path).size : 0);
    }, 0), 0);
    expect(bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
  } finally { f.cleanup(); }
});
