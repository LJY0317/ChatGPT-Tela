import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { CodexAppServerRpc } from "@chatgpt-tela/codex";
import { WebDelegationStore, type WebDelegationRecord } from "./web-delegation";
import { settleWebDelegationRetention, startWebDelegationRetention } from "./web-delegation-retention";
const DAY = 86_400_000;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tela-retention-")), store = new WebDelegationStore(root);
  const origin = 1_700_000_000_000;
  const record: WebDelegationRecord = { id: randomUUID(), slot: 2, cwd: root, createdAt: origin,
    promptHash: "a".repeat(64), mode: "read", state: "reserved", threadId: randomUUID(), turnId: randomUUID(),
    owner: { slot: 2, accountFingerprint: "a".repeat(64), routeFingerprint: "c".repeat(64), sessionFingerprint: "b".repeat(64) },
    session: { slot: 2, runtimeProcessId: 10, responsesRouteFingerprint: "c".repeat(64), terminalEndpoint: "ws://127.0.0.1:1234" } };
  store.reserve(record);
  store.save({ ...record, state: "completed", answer: "result", finalEvidence: "explicit-final-phase" });
  const native = { exists: true, archived: false, updatedAt: origin / 1000, status: "idle", turnStatus: "completed", tailId: record.turnId, queued: false, accountChanged: false, failArchive: false };
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
      if (method === "thread/read") return { thread: { id: record.threadId, updatedAt: native.updatedAt } };
      if (method === "thread/delete") { native.exists = false; return {}; }
      throw Error(`Unexpected RPC ${method}`);
    },
  };
  const adapters = { store, owner: async () => ({ binding: { ...record.owner, ...(native.accountChanged ? { accountFingerprint: "d".repeat(64) } : {}) }, session: record.session }), connect: async () => rpc };
  const run = (now: number) => settleWebDelegationRetention(adapters, { now, signal: new AbortController().signal });
  return { root, store, record, native, calls, origin, adapters, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("first result collection starts 24h clock, repeated reads do not extend it, auto archive deletes seven days later", async () => {
  const f = fixture();
  try {
    f.store.collect(f.record.id, f.origin + DAY);
    f.store.collect(f.record.id, f.origin + 2 * DAY);
    expect(f.store.collectedAt(f.record.id)).toBe(f.origin + DAY);
    const immutable = readFileSync(join(f.root, `${f.record.id}.json.completed`), "utf8");
    await f.run(f.origin + 2 * DAY - 1); expect(f.calls).toHaveLength(0);
    await f.run(f.origin + 2 * DAY); expect(f.native.archived).toBe(true);
    await f.run(f.origin + 9 * DAY - 1); expect(f.native.exists).toBe(true);
    await f.run(f.origin + 9 * DAY); expect(f.native.exists).toBe(false);
    expect(f.calls.filter(c => c.method === "thread/archive")).toHaveLength(1);
    expect(f.calls.filter(c => c.method === "thread/delete")).toHaveLength(1);
    expect(readFileSync(join(f.root, `${f.record.id}.json.completed`), "utf8")).toBe(immutable);
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
      await f.run(f.origin + 14 * DAY);
      await f.run(f.origin + 30 * DAY);
      expect(f.calls.filter(c => c.method === "thread/delete")).toHaveLength(0);
      expect(f.calls.filter(c => c.method === "thread/archive")).toHaveLength(action === "restore" || action === "activity" ? 1 : 0);
    } finally { f.cleanup(); }
  }
});
test("an unknown mutation outcome is never retried; another account cannot act on the stored thread", async () => {
  const f = fixture();
  try {
    f.native.accountChanged = true; await f.run(f.origin + 8 * DAY); expect(f.calls).toHaveLength(0);
    f.native.accountChanged = false; f.native.failArchive = true;
    await f.run(f.origin + 8 * DAY);
    await f.run(f.origin + 30 * DAY);
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
