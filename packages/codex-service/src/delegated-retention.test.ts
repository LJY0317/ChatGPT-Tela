import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDelegatedRetention } from "./delegated-retention";

const HOUR = 3_600_000;
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "tela-managed-retention-"));
  let now = 1_000_000_000, scope = "install/profile-one", busy = false;
  const calls: { method: string; lifecycle: boolean; slot: number }[] = [];
  const thread: any = { id: "child", parentThreadId: "parent", status: { type: "idle" },
    source: { subAgent: { thread_spawn: { parent_thread_id: "parent" } } } };
  const turn: any = { id: "turn", status: "completed", completedAt: now / 1000 };
  const item: any = { id: "answer", type: "agentMessage", phase: "final_answer", text: "PRIVATE_BODY" };
  const options = { directory: join(directory, "records"), acknowledgementDirectory: join(directory, "ack"),
    now: () => now, automatic: false,
    profile: (slot: number) => ({ scope: scope + slot, async connect(_: string, lifecycle: boolean) {
      let leased = false;
      return { async close() { leased = false; }, async request(method: string, params?: any): Promise<any> {
        calls.push({ method, lifecycle, slot });
        if (method === "thread/read") return { thread };
        if (method === "thread/turns/list") return { data: [turn] };
        if (method === "thread/items/list") return { data: [{ turnId: params.turnId, item }], nextCursor: null };
        if (method === "thread/resume") {
          if (!lifecycle || busy) throw Error("WRITER_BUSY");
          expect(params).toEqual({ threadId: "child", excludeTurns: true });
          leased = true; return { thread };
        }
        if (method === "thread/archive") { expect(leased).toBe(true); return {}; }
        throw Error("Unexpected operation " + method);
      } };
    } }),
  };
  const manager = createDelegatedRetention(options);
  return { directory, options, manager, thread, turn, calls,
    advance(hours: number) { now += hours * HOUR; }, setBusy(value: boolean) { busy = value; }, changeScope() { scope = "new-install"; },
    receipt() { return JSON.parse(readFileSync(join(options.directory, readdirSync(options.directory)[0]!), "utf8")); },
    async close() { await manager.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const answer = { parentThreadId: "parent", threadId: "child", turnId: "turn", outcome: "answer", itemId: "answer" } as const;

test("only explicitly enrolled official children are archived; unconfirmed clock is seven days", async () => {
  const f = fixture();
  try {
    f.advance(200); expect((await f.manager.reconcile()).outcomes).toEqual([]); expect(f.calls).toEqual([]);
    f.thread.source = "cli";
    await expect(f.manager.enroll(1, "parent", "child")).rejects.toThrow("lineage");
    f.thread.source = { subAgent: { thread_spawn: { parent_thread_id: "parent" } } };
    await f.manager.enroll(1, "parent", "child");
    expect((await f.manager.reconcile()).outcomes).toEqual([{ threadId: "child", status: "archived" }]);
    expect(f.calls.filter(c => c.method === "thread/archive")).toHaveLength(1);
    await f.manager.reconcile(); expect(f.calls.filter(c => c.method === "thread/archive")).toHaveLength(1);
  } finally { await f.close(); }
});

test("acknowledgement uses the later of exact result confirmation and terminal activity plus twelve hours", async () => {
  const f = fixture();
  try {
    await f.manager.enroll(1, "parent", "child"); f.advance(4);
    await f.manager.acknowledge(1, answer); const firstDue = f.receipt().dueAt;
    f.advance(2); await f.manager.acknowledge(1, answer); expect(f.receipt().dueAt).toBe(firstDue);
    f.advance(9); expect((await f.manager.reconcile()).outcomes).toEqual([]);
    f.advance(1); expect((await f.manager.reconcile()).outcomes[0]?.status).toBe("archived");
    expect(JSON.stringify(f.receipt())).not.toContain("PRIVATE_BODY");
  } finally { await f.close(); }
});

test("a newer turn invalidates an older acknowledgement without moving time for status queries", async () => {
  const f = fixture();
  try {
    await f.manager.enroll(1, "parent", "child"); await f.manager.acknowledge(1, answer);
    f.advance(12); f.turn.id = "new-turn"; f.turn.completedAt += 10 * 3600;
    expect((await f.manager.reconcile()).outcomes[0]?.status).toBe("not_due");
    const due = f.receipt().dueAt; f.advance(1); await f.manager.reconcile(); expect(f.receipt().dueAt).toBe(due);
    expect(f.calls.some(c => c.method === "thread/archive")).toBe(false);
    f.advance(7 * 24); expect((await f.manager.reconcile()).outcomes[0]?.status).toBe("archived");
  } finally { await f.close(); }
});

test("writer conflicts defer without interrupting or acquiring an old active result; restart can reconcile", async () => {
  const f = fixture();
  try {
    await f.manager.enroll(1, "parent", "child"); f.advance(7 * 24); f.setBusy(true);
    expect((await f.manager.reconcile()).outcomes[0]?.status).toBe("deferred");
    expect(f.calls.some(c => c.method === "thread/archive")).toBe(false);
    await f.manager.close(); f.setBusy(false);
    const restarted = createDelegatedRetention(f.options);
    try { expect((await restarted.reconcile()).outcomes[0]?.status).toBe("archived"); }
    finally { await restarted.close(); }
  } finally { await f.close(); }
});

test("profile-scoped reconciliation and changed installation cannot mutate another profile", async () => {
  const f = fixture();
  try {
    await f.manager.enroll(2, "parent", "child"); f.advance(7 * 24);
    const before = f.calls.length; expect((await f.manager.reconcile(1)).outcomes).toEqual([]); expect(f.calls.length).toBe(before);
    f.changeScope(); expect((await f.manager.reconcile(2)).outcomes[0]?.status).toBe("deferred");
    expect(f.calls.some(c => c.method === "thread/resume")).toBe(false);
  } finally { await f.close(); }
});

test("archived records are not archived again after manual restore or restart and never delete", async () => {
  const f = fixture();
  try {
    await f.manager.enroll(1, "parent", "child"); f.advance(7 * 24); await f.manager.reconcile();
    await f.manager.close();
    const restarted = createDelegatedRetention(f.options); const count = f.calls.length;
    try { f.advance(31 * 24); await restarted.reconcile(); expect(f.calls.length).toBe(count); }
    finally { await restarted.close(); }
    expect(f.calls.some(c => ["thread/delete", "turn/start", "turn/interrupt"].includes(c.method))).toBe(false);
    f.advance(31 * 24);
    const expired = createDelegatedRetention(f.options);
    await expired.close(); expect(readdirSync(f.options.directory)).toEqual([]);
  } finally { await f.close(); }
});

test("one automatic next-due wakeup executes a persisted eligible archive", async () => {
  const f = fixture();
  let automatic: ReturnType<typeof createDelegatedRetention> | undefined;
  try {
    await f.manager.enroll(1, "parent", "child"); await f.manager.close(); f.advance(7 * 24);
    let archiveObserved!: () => void;
    const archived = new Promise<void>(resolve => { archiveObserved = resolve; });
    automatic = createDelegatedRetention({ ...f.options, automatic: true, profile(slot) {
      const profile = f.options.profile(slot);
      return { ...profile, async connect(threadId, lifecycle) {
        const rpc = await profile.connect(threadId, lifecycle);
        return { close: () => rpc.close(), async request(method, params) {
          const value = await rpc.request(method, params);
          if (method === "thread/archive") archiveObserved();
          return value;
        } };
      } };
    } });
    await Promise.race([archived, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(Error("Automatic due event absent")), 2000); timer.unref(); })]);
    await automatic.close(); automatic = undefined;
    expect(f.calls.filter(c => c.method === "thread/archive")).toHaveLength(1);
    expect(f.receipt().archivedAt).toBeDefined();
  } finally { await automatic?.close(); await f.close(); }
});

test("ambiguous archive preserves durable intent and never repeats after restart or restore", async () => {
  const f = fixture();
  let manager: ReturnType<typeof createDelegatedRetention> | undefined;
  try {
    await f.manager.enroll(1, "parent", "child"); await f.manager.close(); f.advance(7 * 24);
    manager = createDelegatedRetention({ ...f.options, profile(slot) {
      const profile = f.options.profile(slot);
      return { ...profile, async connect(threadId, lifecycle) {
        const rpc = await profile.connect(threadId, lifecycle);
        return { close: () => rpc.close(), async request(method, params) {
          const value = await rpc.request(method, params);
          if (method === "thread/archive") throw Error("Archive applied but response connection lost");
          return value;
        } };
      } };
    } });
    expect((await manager.reconcile()).outcomes[0]?.status).toBe("deferred");
    expect(f.receipt().archivePending).toBe(true); expect(f.receipt().archivedAt).toBeUndefined();
    await manager.close();
    manager = createDelegatedRetention(f.options);
    expect((await manager.reconcile()).outcomes[0]?.status).toBe("archive_unconfirmed");
    expect(f.calls.filter(c => c.method === "thread/archive")).toHaveLength(1);
  } finally { await manager?.close(); await f.close(); }
});

test("missing terminal completion time and a newer unfinished turn never inherit an old archive deadline", async () => {
  const f = fixture();
  try {
    await f.manager.enroll(1, "parent", "child"); f.advance(7 * 24);
    f.turn.completedAt = null;
    expect((await f.manager.reconcile()).outcomes[0]?.status).toBe("deferred");
    f.turn.id = "in-progress-turn"; f.turn.status = "inProgress";
    expect((await f.manager.reconcile()).outcomes[0]?.status).toBe("deferred");
    expect(f.calls.some(c => c.method === "thread/archive")).toBe(false);
  } finally { await f.close(); }
});
