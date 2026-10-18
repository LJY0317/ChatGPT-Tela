import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { CodexAppServerRpc } from "@chatgpt-tela/codex";
import { runWebDelegation, WebDelegationStore, reconcileWebDelegation } from "./web-delegation";

async function fixture(options: { uncertain?: boolean; changedOwner?: boolean; foreignFinal?: boolean; silent?: boolean; finalPhase?: string | null; answer?: string; collaboration?: boolean; summaryToolResult?: boolean; failedTool?: boolean; enormousOutput?: boolean; mode?: "read" | "write" } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tela-web-delegate-")));
  const store = new WebDelegationStore(root), id = randomUUID(), threadId = randomUUID(), turnId = randomUUID();
  const calls: Array<{ method: string; params: unknown }> = [];
  let notify: (method: string, params: unknown) => void = () => {};
  let observedOwners = 0;
  const rpc: CodexAppServerRpc = {
    subscribe(callback) { notify = callback; return () => {}; },
    async close() {},
    async request(method, params) {
      calls.push({ method, params });
      if (method === "model/list") return { data: [{ model: "chatgpt-tela-web/family/aaaaaaaaaaaaaaaaaaaa", displayName: "6 (Web)", supportedReasoningEfforts: [{ reasoningEffort: "xhigh" }] }] };
      if (method === "thread/start") return { model: "chatgpt-tela-web/family/aaaaaaaaaaaaaaaaaaaa", approvalPolicy: "never", sandbox: { type: options.mode === "write" ? "workspaceWrite" : "readOnly" }, thread: { id: threadId, cwd: root, historyMode: "paginated", ephemeral: false } };
      if (method === "turn/start") {
        if (options.uncertain) throw Error("lost acknowledgement");
        if (options.silent) return { turn: { id: turnId } };
        // Synchronously complete BEFORE turn/start's ACK, exercising the real notification race.
        notify("item/completed", { threadId: options.foreignFinal ? randomUUID() : threadId, turnId, item: { id: "final", type: "agentMessage", ...(options.finalPhase === null ? {} : { phase: options.finalPhase ?? "final_answer" }), text: options.answer ?? "verified design" } });
        notify("item/completed", { threadId, turnId, item: { id: "read", type: "commandExecution",
          status: options.failedTool ? "failed" : "completed",
          aggregatedOutput: options.enormousOutput ? "x".repeat(140 * 1024) : "fixture-result-not-in-journal" } });
        if (options.collaboration) notify("item/completed", { threadId, turnId, item: { id: "collab", type: "collabAgentToolCall" } });
        notify("turn/completed", { threadId, turn: { id: turnId, status: "completed" } });
        return { turn: { id: turnId } };
      }
      if (method === "thread/turns/list") return { data: [{ id: turnId, status: "completed", items: [
        { id: "final", type: "agentMessage", ...(options.finalPhase === null ? {} : { phase: options.finalPhase ?? "final_answer" }), text: options.answer ?? "verified recovered design" },
        ...(options.summaryToolResult ? [{ id: "read", type: "commandExecution",
          status: "completed", aggregatedOutput: "fixture-summary-result" }] : []),
      ] }] };
      throw Error("Unexpected operation");
    },
  };
  const adapters = {
    store, connect: async () => rpc,
    owner: async () => {
      observedOwners++;
      return {
        binding: { slot: 1, accountFingerprint: options.changedOwner && observedOwners > 1 ? "b".repeat(64) : "a".repeat(64), sessionFingerprint: "b".repeat(64), routeFingerprint: "c".repeat(64) },
        session: { slot: 1, runtimeProcessId: 10, responsesRouteFingerprint: "c".repeat(64), terminalEndpoint: "ws://127.0.0.1:1234" },
      };
    },
  };
  return { root, store, calls, id, run: () => runWebDelegation(adapters, { id, slot: 1, cwd: root, prompt: "Read this fixture and design only", mode: options.mode ?? "read", signal: AbortSignal.timeout(1000) }), reconcile: () => reconcileWebDelegation(adapters, id, AbortSignal.timeout(1000)), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("new read-only durable Web job buffers ACK race, returns exact final and never loads a source conversation", async () => {
  const f = await fixture();
  try {
    const result = await f.run();
    expect(result).toMatchObject({ state: "completed", answer: "verified design",
      toolItems: 1, toolResultItems: 1, toolResultCoverage: "live-events" });
    expect(f.calls.find(call => call.method === "thread/start")?.params).toMatchObject({ ephemeral: false, historyMode: "paginated", sandbox: "read-only", approvalPolicy: "never" });
    expect(f.calls.find(call => call.method === "turn/start")?.params).toMatchObject({ effort: "xhigh", sandboxPolicy: { type: "readOnly" }, approvalPolicy: "never" });
    expect(f.calls.map(call => call.method)).toEqual(["model/list", "thread/start", "turn/start"]);
    await expect(f.run()).rejects.toThrow();
    expect(f.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
    expect(new WebDelegationStore(f.root).get(f.id)?.answer).toBe("verified design");
    expect(JSON.stringify(new WebDelegationStore(f.root).get(f.id))).not.toContain("fixture-result-not-in-journal");
  } finally { f.cleanup(); }
});
test("a write Web delegation requests and proves workspace-only Native sandbox", async () => {
  const f = await fixture({ mode: "write" });
  try {
    const result = await f.run();
    expect(result).toMatchObject({ state: "completed", mode: "write" });
    expect(f.calls.find(call => call.method === "thread/start")?.params).toMatchObject({
      sandbox: "workspace-write", approvalPolicy: "never",
    });
    expect(f.calls.find(call => call.method === "turn/start")?.params).toMatchObject({
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [f.root], networkAccess: false },
      approvalPolicy: "never",
    });
    expect(f.store.capacity(1, "write", f.root)).toMatchObject({ available: true,
      writers: { used: 0, limit: 1 } });
  } finally { f.cleanup(); }
});
test("uncertain send is journaled and never replayed", async () => {
  const f = await fixture({ uncertain: true });
  try {
    await expect(f.run()).rejects.toThrow();
    expect(f.store.get(f.id)?.state).toBe("uncertain");
    await expect(f.run()).rejects.toThrow();
    expect(f.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
  } finally { f.cleanup(); }
});
test("changed owner blocks creation and unrelated answers cannot finish the job", async () => {
  for (const options of [{ changedOwner: true }, { foreignFinal: true }]) {
    const f = await fixture(options);
    try {
      await expect(f.run()).rejects.toThrow();
      expect(f.store.get(f.id)?.answer).toBeUndefined();
      if (options.changedOwner) expect(f.calls.some(call => call.method === "thread/start")).toBe(false);
    } finally { f.cleanup(); }
  }
});
test("an acknowledged job with lost completion events is recovered from its exact bounded turn without a new model request", async () => {
  const f = await fixture({ silent: true });
  try {
    await expect(f.run()).rejects.toThrow();
    expect(f.store.get(f.id)?.state).toBe("uncertain");
    const recovered = await f.reconcile();
    expect(recovered).toMatchObject({ state: "completed", answer: "verified recovered design" });
    expect(f.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
    expect(f.calls.find(call => call.method === "thread/turns/list")?.params).toMatchObject({ limit: 1, itemsView: "summary" });
    const { answer, ...olderObserver } = recovered;
    f.store.save({ ...olderObserver, state: "uncertain" });
    expect(f.store.get(f.id)?.answer).toBe("verified recovered design");
  } finally { f.cleanup(); }
});
test("one unphased assistant message from a completed turn is delivered, live or recovered", async () => {
  for (const silent of [false, true]) {
    const f = await fixture({ finalPhase: null, silent, answer: "Finished." });
    try {
      if (silent) await expect(f.run()).rejects.toThrow();
      const result = silent ? await f.reconcile() : await f.run();
      expect(result).toMatchObject({ state: "completed", answer: "Finished.",
        finalEvidence: "sole-completed-message", taskOutcome: "unassessed" });
      expect(f.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
      expect((await f.reconcile()).answer).toBe("Finished.");
    } finally { f.cleanup(); }
  }
});
test("a commentary message does not become a final just because the turn completed", async () => {
  const f = await fixture({ finalPhase: "commentary", answer: "I will investigate." });
  try {
    await expect(f.run()).rejects.toThrow("proven final answer");
    expect(f.store.get(f.id)?.answer).toBeUndefined();
    await expect(f.reconcile()).rejects.toThrow("bounded and proven");
  } finally { f.cleanup(); }
});
test("an explicit final blockage report is an execution result with task success unassessed", async () => {
  const f = await fixture({ answer: "Blocked by the permission check; implementation remains incomplete." });
  try {
    expect(await f.run()).toMatchObject({ state: "completed", finalEvidence: "explicit-final-phase", taskOutcome: "unassessed" });
  } finally { f.cleanup(); }
});
test("collaboration calls are observed without claiming complete execution coverage", async () => {
  const f = await fixture({ collaboration: true });
  try {
    expect(await f.run()).toMatchObject({ toolItems: 2, toolItemCoverage: "live-events" });
  } finally { f.cleanup(); }
});
test("summary recovery preserves earlier observations and marks its limited coverage", async () => {
  const f = await fixture({ silent: true });
  try {
    await expect(f.run()).rejects.toThrow();
    const prior = f.store.get(f.id)!;
    f.store.save({ ...prior, toolItems: 3 });
    expect(await f.reconcile()).toMatchObject({ toolItems: 3, toolItemCoverage: "history-summary" });
    expect(f.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
  } finally { f.cleanup(); }
});

test("bounded Native tool-result evidence is content-free and absent results are never manufactured", async () => {
  const f = await fixture({ silent: true, summaryToolResult: true });
  try {
    await expect(f.run()).rejects.toThrow();
    const recovered = await f.reconcile();
    expect(recovered).toMatchObject({ toolItems: 1, toolResultItems: 1,
      toolResultCoverage: "history-summary" });
    expect(JSON.stringify(recovered)).not.toContain("fixture-summary-result");
    expect(f.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
  } finally { f.cleanup(); }
});

test("failed and oversized Native tool items never become completed-result evidence", async () => {
  for (const options of [{ failedTool: true }, { enormousOutput: true }]) {
    const f = await fixture(options);
    try {
      expect(await f.run()).toMatchObject({ state: "completed", toolItems: 1,
        toolResultItems: 0, toolResultCoverage: "live-events" });
    } finally { f.cleanup(); }
  }
});

test("profile reader capacity refuses a concurrent job before any model request and releases on terminal final", async () => {
  const f = await fixture({ silent: true });
  try {
    const initial = f.store.capacity(1);
    expect(initial.readers).toMatchObject({ used: 0, limit: 2 });
    const active = f.run();
    // Fixture responds synchronously to turn/start. Wait for its acknowledged journal state.
    for (let i = 0; i < 100 && f.store.get(f.id)?.state !== "running"; i++) await Bun.sleep(1);
    const secondId = randomUUID();
    const first = f.store.get(f.id)!;
    const another = { ...first, id: secondId, state: "reserved" as const };
    f.store.reserve(another);
    expect(f.store.capacity(1)).toMatchObject({
      readers: { used: 2, limit: 2 }, available: false, blockCode: "CAPACITY_READER_PROFILE",
    });
    expect(() => f.store.reserve({ ...another, id: randomUUID() })).toThrow("읽기");
    await expect(active).rejects.toThrow();
    expect(f.store.capacity(1).available).toBe(false);
    expect(await f.reconcile()).toMatchObject({ state: "completed" });
    expect(f.store.capacity(1)).toMatchObject({ readers: { used: 1, limit: 2, uncertain: 0 } });
  } finally { f.cleanup(); }
});

test("a durable final receipt survives a late stale snapshot and keeps its answer available", async () => {
  const f = await fixture();
  try {
    const final = await f.run();
    expect(final.answer).toBe("verified design");
    writeFileSync(join(f.root, `${f.id}.json`), JSON.stringify({ ...final,
      state: "uncertain", answer: undefined, finalEvidence: undefined }));
    const saved = new WebDelegationStore(f.root).get(f.id)!;
    expect(saved).toMatchObject({ state: "completed", answer: "verified design" });
    const { answer: _answer, ...noAnswer } = saved;
    expect(f.store.save({ ...noAnswer, state: "uncertain" })).toMatchObject({
      state: "completed", answer: "verified design",
    });
    expect(f.store.capacity(1).available).toBe(true);
  } finally { f.cleanup(); }
});

test("temporary per-profile policy reserves one writer and two readers with checkout exclusivity", async () => {
  const f = await fixture();
  try {
    const template = { id: f.id, slot: 1, mode: "read" as const, cwd: f.root, createdAt: Date.now(),
      promptHash: "a".repeat(64), owner: (await f.run()).owner, session: (await f.reconcile()).session,
      state: "reserved" as const };
    const read1 = { ...template, id: randomUUID() };
    const read2 = { ...template, id: randomUUID() };
    f.store.reserve(read1);
    f.store.reserve(read2);
    const writer = { ...template, id: randomUUID(), mode: "write" as const };
    f.store.reserve(writer);
    expect(f.store.capacity(1, "read")).toMatchObject({
      readers: { used: 2, limit: 2 }, writers: { used: 1, limit: 1 },
      total: { used: 3, limit: 3 }, available: false, blockCode: "CAPACITY_TOTAL_PROFILE",
    });
    expect(() => f.store.reserve({ ...writer, id: randomUUID() })).toThrow();
    expect(f.store.capacity(2, "write", f.root)).toMatchObject({
      available: false, blockCode: "CAPACITY_WRITER_CHECKOUT",
    });
  } finally { f.cleanup(); }
});
