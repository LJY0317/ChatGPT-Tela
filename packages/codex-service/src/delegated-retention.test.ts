import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDelegatedRetention } from "./delegated-retention";

const HOUR = 3_600_000;
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "tela-managed-retention-"));
  let now = 1_000_000_000, scope = "install/profile-one", busy = false, descendant: "active" | "archived" | undefined;
  let turnPersisted = true;
  let assignment: string | undefined;
  let webAccount = "a".repeat(64), savedWebAnswer: string | undefined;
  const calls: { method: string; lifecycle: boolean; slot: number }[] = [];
  const thread: any = { id: "child", parentThreadId: "parent", status: { type: "idle" },
    source: { subAgent: { thread_spawn: { parent_thread_id: "parent" } } } };
  const turn: any = { id: "turn", status: "completed", completedAt: now / 1000 };
  const item: any = { id: "answer", type: "agentMessage", phase: "final_answer", text: "PRIVATE_BODY" };
  const options = { directory: join(directory, "records"), acknowledgementDirectory: join(directory, "ack"),
    now: () => now, automatic: false,
    profile: (slot: number) => ({
      scope: scope + slot,
      webAccountFingerprint: () => webAccount,
      async readSavedWebAnswer(account: string, threadId: string, turnId: string) {
        return account === webAccount && slot === 2 && threadId === "child" && turnId === "turn" ? savedWebAnswer : undefined;
      },
      async connect(_: string, lifecycle: boolean, delegatedTitle?: boolean) {
      let leased = false;
      return { async close() { leased = false; }, async request(method: string, params?: any): Promise<any> {
        calls.push({ method, lifecycle, slot });
        if (method === "thread/read") return { thread };
        if (method === "thread/turns/list") return { data: turnPersisted ? [turn] : [] };
        if (method === "thread/name/set") {
          expect(delegatedTitle).toBe(true);
          expect(params.threadId).toBe(thread.id);
          thread.name = params.name;
          return {};
        }
        if (method === "thread/items/list") {
          const selected = params.sortDirection === "asc" && assignment !== undefined
            ? { id: "prompt", type: "userMessage", content: [{ type: "text", text: assignment }] } : item;
          return { data: [{ turnId: params.turnId ?? "turn", item: selected }], nextCursor: null };
        }
        if (method === "thread/resume") {
          if (!lifecycle || busy) throw Error("WRITER_BUSY");
          expect(params).toEqual({ threadId: "child", excludeTurns: true });
          leased = true; return { thread };
        }
        if (method === "thread/list") return { data: (descendant === "archived" ? params.archived : descendant === "active" && !params.archived) ? [{ id: "unenrolled-descendant" }] : [], nextCursor: null };
        if (method === "thread/archive") { expect(leased).toBe(true); return {}; }
        throw Error("Unexpected operation " + method);
      } };
    } }),
  };
  const manager = createDelegatedRetention(options);
  return { directory, options, manager, thread, turn, item, calls,
    setTurnPersisted(value: boolean) { turnPersisted = value; },
    setAssignment(value: string) { assignment = value; },
    setWebAnswer(value: string) { savedWebAnswer = value; },
    setWebAccount(value: string) { webAccount = value; },
    advance(hours: number) { now += hours * HOUR; }, setBusy(value: boolean) { busy = value; }, changeScope() { scope = "new-install"; }, setDescendant(value: "active" | "archived" | undefined) { descendant = value; },
    receipt() { return JSON.parse(readFileSync(join(options.directory, readdirSync(options.directory)[0]!), "utf8")); },
    async close() { await manager.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const answer = { parentThreadId: "parent", threadId: "child", turnId: "turn", outcome: "answer", itemId: "answer" } as const;

test("a coordinator recovers its exact dispatched answer after restart without submitting again", async () => {
  const f = fixture();
  try {
    Object.assign(f.thread, { source: "cli", parentThreadId: null, modelProvider: "openai", name: "[Tela Agent] Dispatch" });
    f.setTurnPersisted(false);
    const assignment = "PRIVATE_ASSIGNMENT";
    const fingerprint = createHash("sha256").update(assignment).digest("hex");
    await f.manager.registerDispatch(2, "parent", "child", fingerprint);
    expect(await f.manager.readResult(2, "parent", "child")).toEqual({ threadId: "child", outcome: "pending" });
    expect(JSON.stringify(f.receipt())).not.toContain(assignment);
    await f.manager.close();
    f.setTurnPersisted(true);
    const restarted = createDelegatedRetention(f.options);
    try {
      expect((await restarted.listForParent(2, "parent")).tracked.map(r => r.threadId)).toEqual(["child"]);
      await expect(restarted.readResult(2, "other", "child")).rejects.toThrow("Register");
      await expect(restarted.readResult(1, "parent", "child")).rejects.toThrow("Register");
      f.setAssignment("A different request");
      expect(await restarted.readResult(2, "parent", "child")).toEqual({ threadId: "child", outcome: "pending" });
      await expect(restarted.acknowledge(2, answer)).rejects.toThrow("submitted Web assignment");
      f.setAssignment(assignment);
      expect(await restarted.readResult(2, "parent", "child")).toEqual({
        threadId: "child", turnId: "turn", itemId: "answer", text: "PRIVATE_BODY", outcome: "answer",
      });
      expect(f.receipt().acknowledgement).toBeUndefined();
      await restarted.acknowledge(2, answer);
      expect(f.receipt().dueAt).toBe(f.receipt().enrolledAt + 12 * HOUR);
      expect(f.calls.every(({ method }) => method === "thread/read" || method === "thread/turns/list" || method === "thread/items/list")).toBe(true);
    } finally { await restarted.close(); }
  } finally { await f.close(); }
});

test("recovers and acknowledges an already saved Web answer after the official turn is interrupted", async () => {
  const f = fixture();
  try {
    Object.assign(f.thread, { source: "cli", parentThreadId: null, modelProvider: "openai", name: "[Tela Agent] Interrupted" });
    const assignment = "Find the exact answer";
    f.setTurnPersisted(false);
    f.setAssignment(assignment);
    await f.manager.registerDispatch(2, "parent", "child", createHash("sha256").update(assignment).digest("hex"));
    f.setTurnPersisted(true);
    f.turn.status = "interrupted";
    expect(await f.manager.readResult(2, "parent", "child")).toMatchObject({ outcome: "interrupted" });
    f.setWebAnswer("Already saved in Web");
    const recovered = await f.manager.readResult(2, "parent", "child");
    if (recovered.outcome !== "answer") throw Error("Expected saved Web answer");
    expect(recovered).toMatchObject({ source: "web", text: "Already saved in Web" });
    f.setWebAccount("b".repeat(64));
    expect(await f.manager.readResult(2, "parent", "child")).toMatchObject({ outcome: "interrupted" });
    const webReceipt = { ...answer, itemId: recovered.itemId };
    await expect(f.manager.acknowledge(2, webReceipt)).rejects.toThrow("saved Web answer changed");
    f.setWebAccount("a".repeat(64));
    await f.manager.acknowledge(2, webReceipt);
    const due = f.receipt().dueAt;
    expect(due).toBe(f.receipt().enrolledAt + 12 * HOUR);
    f.advance(12);
    expect((await f.manager.reconcile()).outcomes).toEqual([{ threadId: "child", status: "archived" }]);
    expect(f.calls.some(call => call.method === "turn/start")).toBe(false);
  } finally { await f.close(); }
});

test("explicit standalone Web registration uses the existing receipt and archive lifecycle", async () => {
  const f = fixture();
  const { parentThreadId: _, ...result } = answer;
  try {
    await expect(f.manager.acknowledge(1, result)).rejects.toThrow("Register");
    await expect(f.manager.enroll(1, undefined, "child")).rejects.toThrow("lineage");
    f.thread.source = "vscode";
    f.thread.parentThreadId = null;
    f.thread.model = "gpt-native";
    await expect(f.manager.enroll(1, undefined, "child")).rejects.toThrow("does not have a Web model");
    f.thread.model = "chatgpt-tela-web/family/12345678901234567890";
    f.thread.name = "Standalone";
    f.setTurnPersisted(false);
    const beforeRegistration = f.calls.length;
    await f.manager.enroll(1, undefined, "child");
    expect(f.calls.slice(beforeRegistration).map(call => call.method)).toEqual(["thread/read", "thread/name/set"]);
    expect(await f.manager.readResult(1, undefined, "child")).toEqual({ threadId: "child", outcome: "pending" });
    f.setTurnPersisted(true);
    expect(f.receipt().parentThreadId).toBeUndefined();
    expect(f.receipt().title).toBe("[Tela Agent] Standalone");
    const enrolledAt = f.receipt().enrolledAt;
    f.advance(1);
    await f.manager.enroll(1, undefined, "child");
    expect(f.receipt().enrolledAt).toBe(enrolledAt);
    await expect(f.manager.readResult(2, undefined, "child")).rejects.toThrow("Register");
    await expect(f.manager.readResult(1, "foreign-parent", "child")).rejects.toThrow("Register");
    expect(await f.manager.readResult(1, undefined, "child")).toEqual({ ...result, text: "PRIVATE_BODY" });
    expect(f.receipt().dueAt).toBe(enrolledAt + 7 * 24 * HOUR);
    expect(f.receipt().acknowledgement).toBeUndefined();
    f.turn.status = "inProgress";
    expect(await f.manager.readResult(1, undefined, "child")).toEqual({ threadId: "child", turnId: "turn", outcome: "pending" });
    f.turn.status = "failed";
    expect(await f.manager.readResult(1, undefined, "child")).toMatchObject({ outcome: "failed" });
    // A final-looking item on a failed turn cannot shorten its retention.
    await expect(f.manager.acknowledge(1, result)).rejects.toThrow("latest completed turn");
    expect(f.receipt().dueAt).toBe(enrolledAt + 7 * 24 * HOUR);
    f.turn.status = "completed";
    await f.manager.acknowledge(1, result);
    expect(f.receipt().dueAt).toBe(enrolledAt + 13 * HOUR);
    f.advance(12);
    expect((await f.manager.reconcile()).outcomes).toEqual([{ threadId: "child", status: "archived" }]);
  } finally { await f.close(); }
});

test("only explicitly enrolled official children are archived; unconfirmed clock is seven days", async () => {
  const f = fixture();
  try {
    f.advance(200); expect((await f.manager.reconcile()).outcomes).toEqual([]); expect(f.calls).toEqual([]);
    f.thread.source = "cli";
    await expect(f.manager.enroll(1, "parent", "child")).rejects.toThrow("lineage");
    f.thread.source = { subAgent: { thread_spawn: { parent_thread_id: "parent" } } };
    await f.manager.enroll(1, "parent", "child");
    expect((await f.manager.reconcile()).outcomes).toEqual([]);
    f.advance(7 * 24);
    expect((await f.manager.reconcile()).outcomes).toEqual([{ threadId: "child", status: "archived" }]);
    expect(f.calls.filter(c => c.method === "thread/archive")).toHaveLength(1);
    await f.manager.reconcile(); expect(f.calls.filter(c => c.method === "thread/archive")).toHaveLength(1);
  } finally { await f.close(); }
});

test("only an exact answer receipt starts twelve hours from first collection", async () => {
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

test("a replacement final in the same turn invalidates the old receipt and cannot be replaced by stale confirmation", async () => {
  const f = fixture();
  try {
    await f.manager.enroll(1, "parent", "child");
    await f.manager.acknowledge(1, answer);
    f.item.id = "new-final";
    f.advance(12);
    expect((await f.manager.reconcile()).outcomes[0]?.status).toBe("not_due");
    await f.manager.acknowledge(1, { ...answer, itemId: "new-final" });
    const current = f.receipt();
    await expect(f.manager.acknowledge(1, answer)).rejects.toThrow("no longer the latest final");
    expect(f.receipt()).toEqual(current);
    expect(f.calls.some(call => call.method === "thread/archive")).toBe(false);
  } finally { await f.close(); }
});

test("acknowledged failures remain seven-day fallback and repeated checks cannot postpone it", async () => {
  const f = fixture();
  try {
    await f.manager.enroll(1, "parent", "child"); const due = f.receipt().dueAt;
    f.turn.status = "failed"; f.advance(24);
    await f.manager.acknowledge(1, { ...answer, outcome: "failed" });
    expect(f.receipt().dueAt).toBe(due);
    f.advance(6 * 24); f.setBusy(true); await f.manager.reconcile();
    const review = f.receipt().reviewAfter;
    f.advance(1); await f.manager.reconcile();
    expect(f.receipt().reviewAfter).toBe(review);
    expect(f.receipt().dueAt).toBe(due);
    f.setBusy(false);
    expect((await f.manager.reconcile()).outcomes[0]?.status).toBe("archived");
  } finally { await f.close(); }
});

test("restart preserves the twelve-hour deadline for a late confirmed collection", async () => {
  const f = fixture();
  let restarted: ReturnType<typeof createDelegatedRetention> | undefined;
  try {
    await f.manager.enroll(1, "parent", "child");
    f.advance(7 * 24 - 1);
    await f.manager.acknowledge(1, answer);
    const deadline = f.receipt().dueAt;
    await f.manager.close();
    f.advance(2);
    restarted = createDelegatedRetention(f.options);
    const before = f.calls.length;
    expect(restarted.status().overdue).toEqual([]);
    expect((await restarted.reconcile()).outcomes).toEqual([]);
    expect(f.calls).toHaveLength(before);
    f.advance(10);
    expect((await restarted.reconcile()).outcomes).toMatchObject([{ status: "archived" }]);
    expect(f.receipt().dueAt).toBe(deadline);
  } finally { await restarted?.close(); await f.close(); }
});

test("writer conflicts defer without interruption; release wakeup or restart can reconcile", async () => {
  for (const restart of [false, true]) {
    const f = fixture();
    let restarted: ReturnType<typeof createDelegatedRetention> | undefined;
    try {
      await f.manager.enroll(1, "parent", "child"); f.advance(7 * 24); f.setBusy(true);
      expect((await f.manager.reconcile()).outcomes[0]?.status).toBe("deferred");
      expect(f.calls.some(c => c.method === "thread/archive")).toBe(false);
      f.setBusy(false);
      if (restart) { await f.manager.close(); restarted = createDelegatedRetention(f.options); }
      const manager = restarted ?? f.manager;
      expect((await manager.reconcile(1)).outcomes[0]?.status).toBe("archived");
      await manager.reconcile(1);
      expect(f.calls.filter(c => c.method === "thread/archive")).toHaveLength(1);
      expect(f.calls.some(c => ["turn/start", "turn/interrupt", "thread/delete"].includes(c.method))).toBe(false);
    } finally { await restarted?.close(); await f.close(); }
  }
});

test("deferred archives retain their policy clock and are scheduled again without hooks", async () => {
  const f = fixture();
  try {
    await f.manager.enroll(1, "parent", "child"); f.advance(7 * 24); f.setBusy(true);
    const due = f.receipt().dueAt;
    expect((await f.manager.reconcile(undefined, true)).outcomes[0]?.status).toBe("deferred");
    expect(f.receipt().dueAt).toBe(due);
    expect(f.receipt().reviewAfter).toBe(due + 12 * HOUR);
    const count = f.calls.length;
    f.setBusy(false); f.advance(11);
    expect((await f.manager.reconcile(undefined, true)).outcomes).toEqual([]);
    expect(f.calls.length).toBe(count);
    f.advance(1);
    expect((await f.manager.reconcile(undefined, true)).outcomes[0]?.status).toBe("archived");
    expect(f.receipt().dueAt).toBe(due);
    expect(f.receipt().reviewAfter).toBeUndefined();
    expect(f.calls.filter(c => c.method === "thread/archive")).toHaveLength(1);
  } finally { await f.close(); }
});

test("persisted deferral returns to the same automatic timer when its review is due", async () => {
  const f = fixture();
  let automatic: ReturnType<typeof createDelegatedRetention> | undefined;
  try {
    await f.manager.enroll(1, "parent", "child"); f.advance(7 * 24); f.setBusy(true);
    await f.manager.reconcile(); await f.manager.close();
    f.setBusy(false); f.advance(12);
    let observed!: () => void;
    const archived = new Promise<void>(resolve => { observed = resolve; });
    automatic = createDelegatedRetention({ ...f.options, automatic: true, profile(slot) {
      const base = f.options.profile(slot);
      return { ...base, async connect(id, lifecycle) {
        const rpc = await base.connect(id, lifecycle);
        return { close: () => rpc.close(), async request(method, params) {
          const result = await rpc.request(method, params);
          if (method === "thread/archive") observed();
          return result;
        } };
      } };
    } });
    await Promise.race([archived, new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(Error("Deferred timer did not resume")), 2000); timer.unref();
    })]);
    await automatic.close(); automatic = undefined;
    expect(f.calls.filter(c => c.method === "thread/archive")).toHaveLength(1);
    expect(f.receipt().reviewAfter).toBeUndefined();
  } finally { await automatic?.close(); await f.close(); }
});

test("lifecycle wakeup can archive before a deferred scheduled review and acknowledgement starts twelve hours", async () => {
  const f = fixture();
  try {
    await f.manager.enroll(1, "parent", "child"); await f.manager.acknowledge(1, answer);
    f.advance(12); f.setBusy(true);
    expect((await f.manager.reconcile()).outcomes[0]?.status).toBe("deferred");
    const due = f.receipt().dueAt;
    f.advance(1); f.setBusy(false);
    expect((await f.manager.reconcile(1)).outcomes[0]?.status).toBe("archived");
    expect(f.receipt().dueAt).toBe(due);
    expect(f.calls.some(c => ["turn/start", "turn/interrupt", "thread/delete"].includes(c.method))).toBe(false);
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

test("reconciliation prunes expired settled metadata without restarting the service", async () => {
  const f = fixture();
  try {
    await f.manager.enroll(1, "parent", "child");
    await f.manager.enroll(2, "parent", "child");
    f.advance(7 * 24);
    expect((await f.manager.reconcile(1)).outcomes[0]?.status).toBe("archived");
    expect(readdirSync(f.options.directory)).toHaveLength(2);
    f.advance(61 * 24);
    const calls = f.calls.length;
    expect((await f.manager.reconcile(1)).outcomes).toEqual([]);
    expect(f.calls).toHaveLength(calls);
    expect(readdirSync(f.options.directory)).toHaveLength(1);
    expect(f.receipt()).toMatchObject({ slot: 2, threadId: "child" });
    expect(f.manager.status().overdue).toMatchObject([{ slot: 2 }]);
  } finally { await f.close(); }
});

test("a malformed tracking record preserves its file and leaves other profiles usable", async () => {
  const f = fixture();
  let reopened: ReturnType<typeof createDelegatedRetention> | undefined;
  try {
    await f.manager.enroll(1, "parent", "child");
    await f.manager.enroll(2, "parent", "child");
    await f.manager.close();
    const corrupt = readdirSync(f.options.directory).map(name => join(f.options.directory, name))
      .find(file => JSON.parse(readFileSync(file, "utf8")).slot === 1)!;
    writeFileSync(corrupt, "{");
    const start = f.calls.length;
    reopened = createDelegatedRetention(f.options);
    await expect(reopened.enroll(1, "parent", "child")).rejects.toThrow("Unreadable delegation record");
    expect(f.calls).toHaveLength(start);
    expect(await reopened.readResult(2, "parent", "child")).toMatchObject({ outcome: "answer" });
    await reopened.acknowledge(2, answer);
    f.advance(12);
    expect((await reopened.reconcile(2)).outcomes).toMatchObject([{ status: "archived" }]);
    expect(readFileSync(corrupt, "utf8")).toBe("{");
    expect(f.calls.slice(start).every(call => call.slot === 2)).toBe(true);
  } finally { await reopened?.close(); await f.close(); }
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

test("automatic retention backs off when even the deferral cannot be persisted", async () => {
  const f = fixture();
  let automatic: ReturnType<typeof createDelegatedRetention> | undefined;
  try {
    await f.manager.enroll(1, "parent", "child");
    await f.manager.close();
    f.advance(7 * 24);
    let observe!: () => void;
    const attempted = new Promise<void>(resolve => { observe = resolve; });
    automatic = createDelegatedRetention({ ...f.options, automatic: true, profile(slot) {
      const profile = f.options.profile(slot);
      return { ...profile, async connect(threadId, lifecycle) {
        observe();
        return profile.connect(threadId, lifecycle);
      } };
    } });
    const path = f.options.directory;
    const preserved = path + "-preserved";
    renameSync(path, preserved);
    writeFileSync(path, "");
    await Promise.race([attempted, Bun.sleep(1_000).then(() => { throw Error("Automatic review did not run"); })]);
    await Bun.sleep(25);
    expect(f.calls.filter(c => c.method === "thread/resume")).toHaveLength(1);
    expect(f.calls.some(c => c.method === "thread/archive")).toBe(false);
    unlinkSync(path);
    renameSync(preserved, path);
    expect((await automatic.reconcile()).outcomes).toMatchObject([{ status: "archived" }]);
    expect(f.calls.filter(c => c.method === "thread/archive")).toHaveLength(1);
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
    expect((await manager.reconcile()).outcomes[0]?.status).toBe("archive_unconfirmed");
    expect(f.receipt().archivePending).toBe(true); expect(f.receipt().archivedAt).toBeUndefined();
    await manager.close();
    manager = createDelegatedRetention(f.options);
    expect((await manager.reconcile()).outcomes[0]?.status).toBe("archive_unconfirmed");
    expect(f.calls.filter(c => c.method === "thread/archive")).toHaveLength(1);

    const pending = manager.status().overdue[0]!;
    const priorCalls = f.calls.length;
    await expect(manager.stopTracking(pending.trackingId, pending.enrolledAt - 1)).rejects.toThrow("no longer pending");
    f.changeScope();
    expect(await manager.stopTracking(pending.trackingId, pending.enrolledAt)).toEqual({ stopped: true });
    expect(manager.status().overdue).toEqual([]);
    expect(f.calls).toHaveLength(priorCalls);
    await manager.close();
    manager = createDelegatedRetention(f.options);
    expect((await manager.reconcile()).outcomes).toEqual([]);
    expect(manager.status().overdue).toEqual([]);
    expect(f.calls).toHaveLength(priorCalls);
  } finally { await manager?.close(); await f.close(); }
});

test("unknown completion, failures and new uncollected turns share the fixed seven-day fallback", async () => {
  for (const status of ["completed", "failed", "interrupted", "inProgress"]) {
    const f = fixture();
    try {
      await f.manager.enroll(1, "parent", "child");
      const due = f.receipt().dueAt;
      f.turn.completedAt = null; f.turn.status = status; f.turn.id = "new-turn";
      f.advance(7 * 24);
      expect((await f.manager.reconcile()).outcomes[0]?.status).toBe("archived");
      expect(f.receipt().dueAt).toBe(due);
    } finally { await f.close(); }
  }
});

test("actual running state is reported as overdue rather than pretending seven days guarantees a stop", async () => {
  const f = fixture();
  try {
    await f.manager.enroll(1, "parent", "child"); f.advance(7 * 24); f.thread.status.type = "active";
    expect((await f.manager.reconcile()).outcomes[0]?.status).toBe("deferred");
    expect(f.manager.status().overdue[0]?.reason).toBe("running");
    f.thread.status.type = "idle";
    expect((await f.manager.reconcile()).outcomes[0]?.status).toBe("archived");
  } finally { await f.close(); }
});

test("recursive archive retains blocked conversations for user review without touching descendants", async () => {
  for (const state of ["active", "archived"] as const) {
    const f = fixture();
    try {
      await f.manager.enroll(1, "parent", "child"); f.advance(7 * 24); f.setDescendant(state);
      expect((await f.manager.reconcile()).outcomes).toEqual([{ threadId: "child", status: "deferred" }]);
      expect(f.calls.some(c => c.method === "thread/archive")).toBe(false);
      expect(f.manager.status().overdue[0]?.reason).toBe("descendants_present");
      expect(readdirSync(f.options.directory)).toHaveLength(1);
      await f.manager.reconcile();
      expect(f.calls.some(c => c.method === "thread/archive")).toBe(false);
    } finally { await f.close(); }
  }
});

test("Native spawn evidence requires review even when restore races across list buckets", async () => {
  for (const creationItem of [
    { id: "spawn", type: "collabAgentToolCall", tool: "spawnAgent", receiverThreadIds: ["restored-descendant"] },
    { id: "started", type: "subAgentActivity", kind: "started", agentThreadId: "restored-descendant" },
  ]) {
    const f = fixture();
    let manager: ReturnType<typeof createDelegatedRetention> | undefined;
    try {
      await f.manager.enroll(1, "parent", "child"); await f.manager.close(); f.advance(7 * 24);
      manager = createDelegatedRetention({ ...f.options, profile(slot) {
        const profile = f.options.profile(slot);
        return { ...profile, async connect(threadId, lifecycle) {
          const rpc = await profile.connect(threadId, lifecycle);
          return { close: () => rpc.close(), async request(method, params: any) {
            if (method === "thread/items/list") return params.cursor
              ? { data: [{ turnId: "older", item: creationItem }], nextCursor: null }
              : { data: [{ turnId: "newer", item: { id: "recent", type: "agentMessage" } }], nextCursor: "older-page" };
            // Empty bucket queries cannot override the durable creation evidence.
            return rpc.request(method, params);
          } };
        } };
      } });
      expect((await manager.reconcile()).outcomes[0]?.status).toBe("deferred");
      expect(f.calls.some(c => c.method === "thread/archive")).toBe(false);
      expect(f.calls.some(c => c.method === "thread/list")).toBe(false);
    } finally { await manager?.close(); await f.close(); }
  }
});


test("automatic Web enrollment requires the canonical first child turn and never enrolls a later switch", async () => {
  const f = fixture();
  try {
    f.thread.name = "Review update";
    expect(await f.manager.enroll(1, "parent", "child", "later-web-turn"))
      .toEqual({ enrolled: false, reason: "not_first_turn" });
    expect(readdirSync(f.options.directory)).toEqual([]);
    expect(f.thread.name).toBe("Review update");
    await f.manager.enroll(1, "parent", "child", "turn");
    expect(f.receipt().threadId).toBe("child");
    expect(f.thread.name).toBe("[Tela Agent] Review update");
    expect(f.receipt().title).toBe(f.thread.name);
    const reads = f.calls.length;
    await f.manager.enroll(1, "parent", "child", "turn");
    expect(f.calls.length).toBe(reads);
    expect(f.calls.filter(c => c.method === "thread/name/set")).toHaveLength(1);
    await expect(f.manager.enroll(1, "foreign", "child", "turn")).rejects.toThrow("lineage");
    expect(f.calls.some(c => c.method === "thread/archive")).toBe(false);
    f.advance(7 * 24);
    expect((await f.manager.reconcile()).outcomes[0]?.status).toBe("archived");
    const archived = f.receipt();
    await f.manager.enroll(1, "parent", "child", "turn");
    expect(f.receipt()).toEqual(archived);
    await f.manager.reconcile();
    expect(f.calls.filter(c => c.method === "thread/archive")).toHaveLength(1);
  } finally { await f.close(); }
});

test("automatic Web metadata cannot enroll a normal chat or claim another Native parent", async () => {
  const f = fixture();
  try {
    await expect(f.manager.enroll(1, "foreign", "child", "turn")).rejects.toThrow("lineage");
    f.thread.source = "cli";
    await expect(f.manager.enroll(1, "parent", "child", "turn")).rejects.toThrow("lineage");
    expect(readdirSync(f.options.directory)).toEqual([]);
  } finally { await f.close(); }
});

test("an unpersisted first Web turn survives restart and archives a failed child at its original deadline", async () => {
  const f = fixture();
  let restarted: ReturnType<typeof createDelegatedRetention> | undefined;
  try {
    f.thread.name = "Review update";
    f.setTurnPersisted(false);
    const result = await f.manager.enroll(1, "parent", "child", "turn");
    expect(result).toEqual({ enrolled: false, reason: "first_turn_pending" });
    expect(f.manager.status(true)).toMatchObject({ tracked: [] });
    expect(f.thread.name).toBe("Review update");
    const { dueAt, enrolledAt } = f.receipt();
    expect(dueAt - enrolledAt).toBe(7 * 24 * HOUR);
    await f.manager.close();

    restarted = createDelegatedRetention(f.options);
    f.advance(7 * 24 - 1);
    f.turn.status = "failed";
    f.setTurnPersisted(true);
    expect((await restarted.listForParent(1, "other-parent")).tracked).toEqual([]);
    expect(f.thread.name).toBe("Review update");
    expect((await restarted.listForParent(1, "parent")).tracked).toMatchObject([{
      threadId: "child", title: "[Tela Agent] Review update", enrolledAt, dueAt,
    }]);
    expect(await restarted.readResult(1, "parent", "child")).toMatchObject({ outcome: "failed" });
    expect((await restarted.reconcile(undefined, true)).outcomes).toEqual([]);
    f.advance(1);
    expect((await restarted.reconcile(undefined, true)).outcomes).toEqual([{ threadId: "child", status: "archived" }]);
    expect(f.calls.filter(call => call.method === "thread/archive")).toHaveLength(1);
  } finally { await restarted?.close(); await f.close(); }
});

test("an unverified observation never changes a conversation and expires if the first turn cannot match", async () => {
  for (const history of ["empty", "different", "matching"] as const) {
    const f = fixture();
    try {
      f.setTurnPersisted(false);
      await f.manager.enroll(1, "parent", "child", "turn");
      if (history !== "empty") {
        f.setTurnPersisted(true);
        if (history === "different") f.turn.id = "older-native-turn";
      }
      f.advance(7 * 24);
      const { outcomes } = await f.manager.reconcile(undefined, true);
      if (history === "matching") {
        expect(outcomes).toEqual([{ threadId: "child", status: "archived" }]);
      } else {
        expect(outcomes).toEqual([]);
        expect(readdirSync(f.options.directory)).toEqual([]);
        expect(f.calls.some(call => ["thread/name/set", "thread/archive"].includes(call.method))).toBe(false);
      }
    } finally { await f.close(); }
  }
});
