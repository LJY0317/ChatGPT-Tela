import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { CodexAppServerRpc } from "@chatgpt-tela/codex";
import { runWebDelegation, collectWebDelegationResult, prefixInitialWebDelegationTitle, WebDelegationStore, reconcileWebDelegation, verifiedWebDelegationAnswer, type WebDelegationRecord } from "./web-delegation";
import { WebDelegationProgressProjection, indexedWebDelegationProgress } from "./web-delegation-progress";

async function fixture(options: { titleReadFails?: boolean; titleSetFails?: boolean; slot?: number; uncertain?: boolean; changedOwner?: boolean; foreignFinal?: boolean; silent?: boolean; finalPhase?: string | null; answer?: string; collaboration?: boolean; summaryToolResult?: boolean; failedTool?: boolean; enormousOutput?: boolean; mode?: "read" | "write"; closeFails?: boolean; disconnect?: boolean; failedTurn?: boolean; manualTurn?: boolean; ambiguousFirstTurn?: boolean; publicProgress?: boolean; indexedProgress?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tela-web-delegate-")));
  const slot = options.slot ?? 1;
  const store = new WebDelegationStore(root), id = randomUUID(), threadId = randomUUID(), turnId = randomUUID();
  const changes: WebDelegationRecord[] = [];
  const calls: Array<{ method: string; params: unknown }> = [];
  let currentTurnId = turnId;
  let notify: (method: string, params: unknown) => void = () => {};
  let disconnected: () => void = () => {};
  let observedOwners = 0;
  let attached = false;
  let currentTitle: string | null = null;
  const rpc: CodexAppServerRpc = {
    subscribe(callback, onDisconnected) { notify = callback; disconnected = onDisconnected; return () => {}; },
    async close() { if (options.closeFails) throw Error("connection already closed"); },
    async request(method, params) {
      calls.push({ method, params });
      if (method === "model/list") return { data: [{ model: "chatgpt-tela-web/family/aaaaaaaaaaaaaaaaaaaa", displayName: "6 (Web)", supportedReasoningEfforts: [{ reasoningEffort: "xhigh" }] }] };
      if (method === "thread/resume") { attached = true; return { thread: { id: threadId } }; }
      if (method === "thread/start") { attached = true; return { model: "chatgpt-tela-web/family/aaaaaaaaaaaaaaaaaaaa", approvalPolicy: "never", sandbox: { type: options.mode === "write" ? "workspaceWrite" : "readOnly" }, thread: { id: threadId, cwd: root, historyMode: "paginated", ephemeral: false } }; }
      if (method === "thread/read") { if (options.titleReadFails) throw Error("Fixture metadata unavailable"); return { thread: { id: threadId, name: currentTitle } }; }
      if (method === "thread/name/set") {
        if (options.titleSetFails) throw Error("Fixture naming RPC failed");
        currentTitle = (params as { name: string }).name;
        return {};
      }
      if (method === "turn/start") {
        if (calls.filter(call => call.method === "turn/start").length > 1) currentTurnId = randomUUID();
        if (options.uncertain) throw Error("lost acknowledgement");
        if (options.publicProgress) {
          notify("item/reasoning/summaryPartAdded", { threadId, turnId: currentTurnId, itemId: "reasoning", summaryIndex: 0 });
          notify("item/reasoning/summaryTextDelta", { threadId, turnId: currentTurnId, itemId: "reasoning", summaryIndex: 0, delta: "Approval needed in the Web browser." });
          notify("item/reasoning/summaryTextDelta", { threadId: randomUUID(), turnId: currentTurnId, itemId: "foreign", summaryIndex: 0, delta: "foreign-thread" });
          notify("item/reasoning/summaryTextDelta", { threadId, turnId: randomUUID(), itemId: "foreign", summaryIndex: 0, delta: "foreign-turn" });
        }
        if (options.silent) { if (options.disconnect) queueMicrotask(() => disconnected()); return { turn: { id: currentTurnId } }; }
        if (!attached) return { turn: { id: currentTurnId } };
        // Synchronously complete BEFORE turn/start's ACK, exercising the real notification race.
        notify("item/completed", { threadId: options.foreignFinal ? randomUUID() : threadId, turnId: currentTurnId, item: { id: "final", type: "agentMessage", ...(options.finalPhase === null ? {} : { phase: options.finalPhase ?? "final_answer" }), text: options.answer ?? "verified design" } });
        notify("item/completed", { threadId, turnId: currentTurnId, item: { id: "read", type: "commandExecution",
          status: options.failedTool ? "failed" : "completed",
          aggregatedOutput: options.enormousOutput ? "x".repeat(140 * 1024) : "fixture-result-not-in-journal" } });
        if (options.collaboration) notify("item/completed", { threadId, turnId: currentTurnId, item: { id: "collab", type: "collabAgentToolCall" } });
        notify("turn/completed", { threadId, turn: { id: currentTurnId, status: options.failedTurn ? "failed" : "completed" } });
        return { turn: { id: currentTurnId } };
      }
      if (method === "thread/turns/list") {
        const cursor = (params as { cursor?: string }).cursor;
        if (options.manualTurn && !cursor) return { data: [{ id: randomUUID(), status: "completed", items: [] }], nextCursor: "older" };
        if (options.uncertain) return { data: [
          { id: currentTurnId, status: "completed", items: [
            { id: "input", type: "userMessage", content: [{ type: "text", text: "Read this fixture and design only" }] },
            { id: "final", type: "agentMessage", phase: "finalAnswer", text: "Recovered after lost ACK" },
          ] },
          ...(options.ambiguousFirstTurn ? [{ id: randomUUID(), status: "completed", items: [] }] : []),
        ], nextCursor: null };
        return { data: [{ id: currentTurnId, status: options.indexedProgress ? "inProgress" : options.failedTurn ? "failed" : "completed", items: [
        ...(options.indexedProgress ? [{ id: "reasoning", type: "reasoning", summary: ["Earlier public summary", "Approval needed" + "x".repeat(5000)], rawContent: "hidden-reasoning-must-not-be-read" }] : []),
        { id: "final", type: "agentMessage", ...(options.foreignFinal ? { phase: "commentary" } : options.finalPhase === null ? {} : { phase: options.finalPhase ?? "final_answer" }), text: options.answer ?? "verified recovered design" },
        ...(options.summaryToolResult ? [{ id: "read", type: "commandExecution",
          status: "completed", aggregatedOutput: "fixture-summary-result" }] : []),
      ] }], nextCursor: null };
      }
      throw Error("Unexpected operation");
    },
  };
  const adapters = {
    store, changed: (record: WebDelegationRecord) => changes.push(record), connect: async () => { attached = false; return rpc; },
    owner: async () => {
      observedOwners++;
      return {
        binding: { slot, accountFingerprint: options.changedOwner && observedOwners > 1 ? "b".repeat(64) : "a".repeat(64), sessionFingerprint: "b".repeat(64), routeFingerprint: "c".repeat(64) },
        session: { slot, runtimeProcessId: 10, responsesRouteFingerprint: "c".repeat(64), terminalEndpoint: "ws://127.0.0.1:1234" },
      };
    },
  };
  return { root, store, calls, changes, id,
    collect: (jobId = id) => collectWebDelegationResult(adapters, jobId),
    setTitle: (name: string | null) => { currentTitle = name; },
    title: async (name: string | null, options: { foreign?: boolean; stale?: boolean; otherAccount?: boolean } = {}) => {
      currentTitle = options.stale ? "User rename" : name;
      await prefixInitialWebDelegationTitle({ store, slot, rpc, owner: async () => {
        const owner = await adapters.owner();
        return options.otherAccount ? { ...owner, binding: { ...owner.binding, accountFingerprint: "f".repeat(64) } } : owner;
      } }, { threadId: options.foreign ? randomUUID() : threadId, threadName: name });
    }, continue: (parentJobId: string, prompt = "Follow up", mode: "read" | "write" = options.mode ?? "read") => runWebDelegation(adapters, { id: randomUUID(), slot, cwd: root, prompt, mode, parentJobId, signal: AbortSignal.timeout(1000) }), run: () => runWebDelegation(adapters, { id, slot, cwd: root, prompt: "Read this fixture and design only", mode: options.mode ?? "read", signal: AbortSignal.timeout(1000) }), reconcile: () => reconcileWebDelegation(adapters, id, AbortSignal.timeout(1000)), cleanup: () => rmSync(root, { recursive: true, force: true }) };
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
test("first title arriving after completion is prefixed once without delaying the task", async () => {
  const f = await fixture();
  try {
    const first = await f.run();
    expect(f.calls.filter(call => call.method === "thread/name/set")).toHaveLength(0);
    expect(f.store.hasPendingTitle(first.id)).toBe(true);
    await f.title(null); await f.title(""); await f.title("Other", { foreign: true });
    await f.title("Review context", { otherAccount: true });
    expect(f.store.hasPendingTitle(first.id)).toBe(true);
    await Promise.all([f.title("Review context"), f.title("Review context")]);
    expect(f.calls.filter(call => call.method === "thread/name/set")).toEqual([{
      method: "thread/name/set", params: { threadId: first.threadId, name: "[Tela Agent] Review context" },
    }]);
    await f.continue(first.id);
    await f.title("Personal rename");
    expect(f.calls.filter(call => call.method === "thread/name/set")).toHaveLength(1);
    expect(f.store.hasPendingTitle(first.id)).toBe(false);
  } finally { f.cleanup(); }
});
test("an initial existing prefix and a superseded title do not overwrite later names", async () => {
  for (const stale of [false, true]) {
    const f = await fixture();
    try {
      const first = await f.run();
      await f.title(stale ? "Generated title" : "[Tela Agent] Existing title", { stale });
      await f.title("Later rename");
      expect(f.calls.filter(call => call.method === "thread/name/set")).toHaveLength(0);
      expect(f.store.hasPendingTitle(first.id)).toBe(false);
    } finally { f.cleanup(); }
  }
});
test("failed title RPC does not change the completed delegation or retry on later renames", async () => {
  const f = await fixture({ titleSetFails: true });
  try {
    const first = await f.run();
    await f.title("Review context"); await f.title("Later rename"); await f.collect();
    expect(f.store.get(first.id)).toMatchObject({ state: "completed", answer: "verified design" });
    expect(f.calls.filter(call => call.method === "thread/name/set")).toHaveLength(1);
  } finally { f.cleanup(); }
});
test("a title marker write failure does not prevent the task from running", async () => {
  const f = await fixture();
  try {
    f.store.waitForTitle = () => { throw Error("Fixture marker write failed"); };
    expect(await f.run()).toMatchObject({ state: "completed", answer: "verified design" });
  } finally { f.cleanup(); }
});
test("collection repairs a missed first-title event and preserves later manual removal", async () => {
  const f = await fixture();
  try {
    const first = await f.run();
    f.setTitle("Generated title");
    expect(await f.collect()).toBe("verified design");
    expect(f.calls.filter(call => call.method === "thread/name/set")).toEqual([{
      method: "thread/name/set", params: { threadId: first.threadId, name: "[Tela Agent] Generated title" },
    }]);
    f.setTitle("User removed prefix");
    const before = f.calls.length;
    await f.collect();
    expect(f.calls).toHaveLength(before);
  } finally { f.cleanup(); }
});
test("collection leaves an unnamed conversation pending and never blocks its answer", async () => {
  const f = await fixture();
  try {
    await f.run();
    expect(await f.collect()).toBe("verified design");
    expect(f.store.hasPendingTitle(f.id)).toBe(true);
    f.setTitle("Late generated title");
    await f.collect();
    expect(f.calls.filter(call => call.method === "thread/name/set")).toHaveLength(1);
  } finally { f.cleanup(); }
});
test("title read failure preserves both the local answer and pending naming", async () => {
  const f = await fixture({ titleReadFails: true });
  try {
    await f.run();
    f.setTitle("Generated title");
    expect(await f.collect()).toBe("verified design");
    expect(f.store.hasPendingTitle(f.id)).toBe(true);
    expect(f.calls.filter(call => call.method === "thread/name/set")).toHaveLength(0);
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
      total: { used: 0, limit: 3 } });
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
test("lost first-turn ACK recovers exact single input without a second send", async () => {
  const f = await fixture({ uncertain: true });
  try {
    await expect(f.run()).rejects.toThrow("lost acknowledgement");
    expect(f.store.get(f.id)?.state).toBe("uncertain");
    expect(f.store.get(f.id)?.turnId).toBeUndefined();
    const recovered = await f.reconcile();
    expect(recovered).toMatchObject({ state: "completed", answer: "Recovered after lost ACK" });
    expect(f.store.capacity(1)).toMatchObject({ available: true, total: { used: 0 } });
    expect(f.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
  } finally { f.cleanup(); }
});
test("ambiguous lost ACK keeps the reservation and never guesses a turn", async () => {
  const f = await fixture({ uncertain: true, ambiguousFirstTurn: true });
  try {
    await expect(f.run()).rejects.toThrow();
    await expect(f.reconcile()).rejects.toThrow("uniquely proven");
    expect(f.store.get(f.id)?.state).toBe("uncertain");
    expect(f.store.get(f.id)?.turnId).toBeUndefined();
    expect(f.store.capacity(1)).toMatchObject({ total: { used: 1 } });
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
    expect(f.calls.find(call => call.method === "thread/turns/list")?.params).toMatchObject({ limit: 8, itemsView: "summary" });
    const { answer, ...olderObserver } = recovered;
    f.store.save({ ...olderObserver, state: "uncertain" });
    expect(f.store.get(f.id)?.answer).toBe("verified recovered design");
  } finally { f.cleanup(); }
});
test("exact completed turn recovers after session replacement under the same account", async () => {
  const f = await fixture({ silent: true });
  try {
    await expect(f.run()).rejects.toThrow();
    const original = f.store.get(f.id)!;
    const replacement = {
      binding: { ...original.owner, sessionFingerprint: "d".repeat(64), routeFingerprint: "e".repeat(64) },
      session: { ...original.session, runtimeProcessId: 42, responsesRouteFingerprint: "e".repeat(64), terminalEndpoint: "ws://127.0.0.1:4321" },
    };
    const adapters = {
      store: f.store, owner: async () => replacement,
      connect: async (endpoint: string) => {
        expect(endpoint).toBe(replacement.session.terminalEndpoint);
        return { close: async () => {}, request: async (method: string) => {
          expect(method).toBe("thread/turns/list");
          return { data: [{ id: original.turnId, status: "completed", items: [
            { type: "agentMessage", phase: "finalAnswer", text: "recovered on replacement" },
          ] }], nextCursor: null };
        } };
      },
    };
    expect(await reconcileWebDelegation(adapters, f.id, AbortSignal.timeout(1000))).toMatchObject({
      state: "completed", answer: "recovered on replacement",
    });
    expect(f.store.capacity(1).total.used).toBe(0);
  } finally { f.cleanup(); }
});
test("account replacement cannot recover an existing Web job", async () => {
  const f = await fixture({ silent: true });
  try {
    await expect(f.run()).rejects.toThrow();
    const original = f.store.get(f.id)!;
    let connected = false;
    await expect(reconcileWebDelegation({ store: f.store,
      owner: async () => ({ binding: { ...original.owner, accountFingerprint: "d".repeat(64) }, session: original.session }),
      connect: async () => { connected = true; throw Error("unexpected connection"); },
    }, f.id, AbortSignal.timeout(1000))).rejects.toThrow("owner changed");
    expect(connected).toBe(false);
    expect(f.store.capacity(1).total.used).toBe(1);
  } finally { f.cleanup(); }
});
test("recovered final remains deliverable when closing its RPC fails", async () => {
  const f = await fixture({ silent: true, closeFails: true });
  try {
    await expect(f.run()).rejects.toThrow();
    const recovered = await f.reconcile();
    expect(recovered).toMatchObject({ state: "completed", answer: "verified recovered design" });
    expect(f.store.capacity(1)).toMatchObject({ available: true, total: { used: 0 } });
    expect(f.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
  } finally { f.cleanup(); }
});

test("connection loss after acknowledged turn keeps the lease until exact recovery", async () => {
  const f = await fixture({ silent: true, disconnect: true });
  try {
    await expect(f.run()).rejects.toThrow("connection lost");
    expect(f.store.get(f.id)).toMatchObject({ state: "uncertain", failure: "transport_or_ack" });
    expect(f.store.capacity(1)).toMatchObject({ available: true, total: { used: 1, limit: 3 } });
    expect(f.store.capacity(1)).toMatchObject({ total: { used: 1 }, uncertain: 1 });
    expect(await f.reconcile()).toMatchObject({ state: "completed", answer: "verified recovered design" });
    expect(f.store.capacity(1)).toMatchObject({ total: { used: 0 }, available: true });
    expect(f.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
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
    expect(await f.reconcile()).toMatchObject({ state: "failed", failure: "result_unavailable" });
    expect(f.store.capacity(1).total.used).toBe(0);
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

test("three concurrent tasks admit before the fourth and release on a proven final", async () => {
  const f = await fixture({ silent: true });
  try {
    const initial = f.store.capacity(1);
    expect(initial.total).toMatchObject({ used: 0, limit: 3 });
    const active = f.run();
    // Fixture responds synchronously to turn/start. Wait for its acknowledged journal state.
    for (let i = 0; i < 100 && f.store.get(f.id)?.state !== "running"; i++) await Bun.sleep(1);
    const secondId = randomUUID();
    const first = f.store.get(f.id)!;
    const another = { ...first, id: secondId, state: "reserved" as const };
    f.store.reserve(another);
    expect(f.store.capacity(1)).toMatchObject({
      total: { used: 2, limit: 3 }, available: true,
    });
    f.store.reserve({ ...another, id: randomUUID() });
    expect(() => f.store.reserve({ ...another, id: randomUUID() })).toThrow("실행 한도");
    await expect(active).rejects.toThrow();
    expect(f.store.capacity(1).available).toBe(false);
    expect(await f.reconcile()).toMatchObject({ state: "completed" });
    expect(f.store.capacity(1)).toMatchObject({ total: { used: 2, limit: 3 } });
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

test("legacy completed records without final evidence do not block free profile slots", async () => {
  const f = await fixture();
  try {
    const completed = await f.run();
    const legacy = { ...completed, id: randomUUID(), finalEvidence: undefined };
    writeFileSync(join(f.root, `${legacy.id}.json`), JSON.stringify(legacy));
    expect(f.store.get(legacy.id)?.finalEvidence).toBeUndefined();
    expect(f.store.capacity(1)).toMatchObject({ available: true, total: { used: 0 } });
  } finally { f.cleanup(); }
});

test("65+ retained receipts do not deny profile 2 admission, recovery or same-thread continuation", async () => {
  const f = await fixture({ slot: 2, mode: "write" });
  try {
    const savedIds: string[] = [];
    for (let i = 0; i < 65; i++) {
      const id = randomUUID();
      savedIds.push(id);
      writeFileSync(join(f.root, `${id}.json`), JSON.stringify({
        id, slot: 2, mode: "write", cwd: f.root, createdAt: Date.now(),
        promptHash: "a".repeat(64), state: "completed", finalEvidence: "explicit-final-phase",
        answer: `historical final ${i}`, threadId: randomUUID(), turnId: randomUUID(),
        owner: { slot: 2, accountFingerprint: "a".repeat(64), sessionFingerprint: "b".repeat(64), routeFingerprint: "c".repeat(64) },
        session: { slot: 2, runtimeProcessId: 10, responsesRouteFingerprint: "c".repeat(64), terminalEndpoint: "ws://127.0.0.1:1234" },
      }));
    }
    const firstPath = join(f.root, `${savedIds[0]}.json`);
    const firstBytes = readFileSync(firstPath);
    expect(f.store.capacity(2, "write", f.root)).toMatchObject({
      available: true, total: { used: 0, limit: 3 },
      records: { retained: 65, limit: 64, admissionBound: false },
      nextAction: "start_if_profile_ready",
    });

    const original = await f.run();
    expect(original).toMatchObject({ state: "completed", slot: 2, answer: "verified design" });
    const continued = await f.continue(original.id);
    expect(continued).toMatchObject({ state: "completed", slot: 2,
      threadId: original.threadId, parentJobId: original.id, answer: "verified design" });
    expect(f.calls.filter(call => call.method === "thread/start")).toHaveLength(1);
    expect(f.calls.filter(call => call.method === "thread/resume")).toHaveLength(1);
    expect(f.store.capacity(2, "write", f.root)).toMatchObject({
      available: true, total: { used: 0, limit: 3 },
      records: { retained: 67, limit: 64, admissionBound: false },
    });
    expect(f.store.get(savedIds[0]!)?.answer).toBe("historical final 0");
    expect(readFileSync(firstPath)).toEqual(firstBytes);
    expect(new WebDelegationStore(f.root).get(continued.id)?.answer).toBe("verified design");
  } finally { f.cleanup(); }
});

test("profile 2 lost-first-turn ACK is recovered without replay or leaking a lease", async () => {
  const f = await fixture({ slot: 2, uncertain: true });
  try {
    await expect(f.run()).rejects.toThrow("lost acknowledgement");
    expect(f.store.get(f.id)).toMatchObject({ slot: 2, state: "uncertain" });
    expect(f.store.capacity(2).total.used).toBe(1);
    expect(await f.reconcile()).toMatchObject({ slot: 2, state: "completed", answer: "Recovered after lost ACK" });
    expect(f.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
    expect(f.store.capacity(2)).toMatchObject({ available: true, total: { used: 0, limit: 3 } });
  } finally { f.cleanup(); }
});

test("full profile rejects a fourth job before any model or provider request", async () => {
  const f = await fixture();
  try {
    const base = { id: randomUUID(), slot: 1, mode: "read" as const, cwd: f.root,
      createdAt: Date.now(), promptHash: "a".repeat(64),
      owner: { slot: 1, accountFingerprint: "a".repeat(64), sessionFingerprint: "b".repeat(64), routeFingerprint: "c".repeat(64) },
      session: { slot: 1, runtimeProcessId: 10, responsesRouteFingerprint: "c".repeat(64), terminalEndpoint: "ws://127.0.0.1:1234" },
      state: "reserved" as const };
    f.store.reserve(base);
    f.store.reserve({ ...base, id: randomUUID() });
    f.store.reserve({ ...base, id: randomUUID(), mode: "write" as const });
    await expect(f.run()).rejects.toMatchObject({ code: "CAPACITY_TOTAL_PROFILE" });
    expect(f.calls).toHaveLength(0);
    expect(f.store.get(f.id)).toBeUndefined();
    expect(f.store.capacity(1)).toMatchObject({ total: { used: 3, limit: 3 },
      available: false, blockCode: "CAPACITY_TOTAL_PROFILE" });
  } finally { f.cleanup(); }
});

test("three total slots retain same checkout writer exclusivity", async () => {
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
            total: { used: 3, limit: 3 }, available: false, blockCode: "CAPACITY_TOTAL_PROFILE",
    });
    expect(() => f.store.reserve({ ...writer, id: randomUUID() })).toThrow();
    expect(f.store.capacity(2, "write", f.root)).toMatchObject({
      available: false, blockCode: "CAPACITY_WRITER_CHECKOUT",
    });
  } finally { f.cleanup(); }
});

test("reader admission is independent of a writer on the same checkout", async () => {
  const f = await fixture();
  try {
    const completed = await f.run();
    const { answer: _answer, finalEvidence: _finalEvidence, ...base } = completed;
    f.store.reserve({ ...base, id: randomUUID(), state: "running", mode: "write" });
    expect(f.store.capacity(1, "read", f.root)).toMatchObject({ available: true, total: { used: 1 } });
    expect(f.store.capacity(1, "write", f.root)).toMatchObject({ available: false, blockCode: "CAPACITY_WRITER_CHECKOUT" });
    f.store.reserve({ ...base, id: randomUUID(), state: "reserved", mode: "read" });
    expect(f.store.capacity(1, "read", f.root).total.used).toBe(2);
  } finally { f.cleanup(); }
});


test("continuation appends a new turn to the same Native thread without creating another thread", async () => {
  const f = await fixture({ mode: "write" });
  try {
    const original = await f.run();
    const followup = await f.continue(original.id, "Please implement the next change");
    expect(followup).toMatchObject({ state: "completed", parentJobId: original.id, threadId: original.threadId });
    expect(followup.turnId).not.toBe(original.turnId);
    expect(f.calls.filter(call => call.method === "thread/start")).toHaveLength(1);
    expect(f.calls.filter(call => call.method === "turn/start")).toHaveLength(2);
    expect(f.calls.filter(call => call.method === "thread/turns/list")).toHaveLength(1);
    expect(f.calls.filter(call => call.method === "thread/resume")).toEqual([{
      method: "thread/resume", params: { threadId: original.threadId, excludeTurns: true },
    }]);
    expect(f.store.get(original.id)?.answer).toBe("verified design");
    expect(f.store.get(followup.id)?.answer).toBe("verified design");
    const third = await f.continue(followup.id, "One more follow-up");
    expect(third).toMatchObject({ parentJobId: followup.id, threadId: original.threadId, state: "completed" });
    expect(f.calls.filter(call => call.method === "thread/start")).toHaveLength(1);
    expect(f.calls.filter(call => call.method === "turn/start")).toHaveLength(3);
  } finally { f.cleanup(); }
});

test("recovery identifies the delegated turn after a direct user message", async () => {
  const f = await fixture({ silent: true, manualTurn: true });
  try {
    await expect(f.run()).rejects.toThrow();
    const recovered = await f.reconcile();
    expect(recovered).toMatchObject({ state: "completed", answer: "verified recovered design" });
    expect(f.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
  } finally { f.cleanup(); }
});

test("direct user turn after delegation permits continuation in the same thread", async () => {
  const f = await fixture({ mode: "write", manualTurn: true });
  try {
    const original = await f.run();
    const next = await f.continue(original.id);
    expect(next.threadId).toBe(original.threadId);
    expect(next.state).toBe("completed");
    expect(f.calls.filter(call => call.method === "thread/start")).toHaveLength(1);
  } finally { f.cleanup(); }
});

test("a read-only continuation stays read-only and rejects an explicit upgrade", async () => {
  const f = await fixture();
  try {
    const original = await f.run();
    const continued = await f.continue(original.id);
    expect(continued).toMatchObject({ mode: "read", threadId: original.threadId });
    expect(f.calls.filter(call => call.method === "turn/start")).toHaveLength(2);
    expect(f.calls.filter(call => call.method === "turn/start").at(-1)?.params).toMatchObject({ sandboxPolicy: { type: "readOnly" } });
    await expect(f.continue(original.id, "Upgrade", "write")).rejects.toThrow("same sandbox mode");
  } finally { f.cleanup(); }
});

test("an unsettled continuation owns the thread and refuses a second continuation", async () => {
  const f = await fixture();
  try {
    const original = await f.run();
    const { answer: _answer, finalEvidence: _finalEvidence, ...base } = original;
    const active = { ...base, id: randomUUID(), parentJobId: original.id,
      state: "running" as const };
    f.store.reserve(active);
    expect(() => f.store.reserve({ ...active, id: randomUUID() })).toThrow();
    expect(f.store.capacity(1)).toMatchObject({ total: { used: 1 } });
    f.store.save({ ...active, state: "failed", failure: "turn_failed" });
    expect(f.store.capacity(1)).toMatchObject({ total: { used: 0 } });
  } finally { f.cleanup(); }
});

test("an unleased unresolved historical job stays available for recovery without blocking a new independent task", async () => {
  const f = await fixture();
  try {
    const completed = await f.run();
    const orphan = { ...completed, id: randomUUID(), state: "uncertain" as const,
      finalEvidence: undefined, answer: undefined, failure: "owner_changed" as const };
    writeFileSync(join(f.root, `${orphan.id}.json`), JSON.stringify(orphan));
    expect(f.store.capacity(1)).toMatchObject({ available: true, total: { used: 0 } });
    expect(f.store.get(orphan.id)).toMatchObject({ state: "uncertain", failure: "owner_changed" });
  } finally { f.cleanup(); }
});

test("three different checkouts can hold write work while one checkout rejects a second writer", async () => {
  const f = await fixture();
  const roots = [0, 1, 2].map(i => realpathSync(mkdtempSync(join(tmpdir(), `tela-wt-${i}-`))));
  try {
    const original = await f.run();
    const base = { ...original, id: randomUUID(), state: "reserved" as const, mode: "write" as const };
    for (const root of roots) f.store.reserve({ ...base, id: randomUUID(), cwd: root });
    expect(f.store.capacity(1)).toMatchObject({ total: { used: 3, limit: 3 }, available: false, blockCode: "CAPACITY_TOTAL_PROFILE" });
    expect(f.store.capacity(2, "write", roots[0])).toMatchObject({ available: false, blockCode: "CAPACITY_WRITER_CHECKOUT" });
  } finally { f.cleanup(); roots.forEach(root => rmSync(root, { recursive: true, force: true })); }
});


test("failed Native turn releases its task lease; completed turn without final reports result unavailable", async () => {
  for (const options of [{ failedTurn: true }, { finalPhase: "commentary" }]) {
    const f = await fixture(options);
    try {
      await expect(f.run()).rejects.toThrow();
      expect(f.store.get(f.id)).toMatchObject({ state: "failed",
        failure: options.failedTurn ? "turn_failed" : "result_unavailable" });
      expect(f.store.capacity(1)).toMatchObject({ available: true, total: { used: 0, limit: 3 } });
    } finally { f.cleanup(); }
  }
});

test("failed Native turn preserves an explicit final for result retrieval without success or continuation", async () => {
  for (const silent of [false, true]) {
    const f = await fixture({ slot: 2, failedTurn: true, silent, answer: "An error occurred after the final response." });
    try {
      if (silent) await expect(f.run()).rejects.toThrow();
      else await expect(f.run()).rejects.toThrow("turn failed");
      const record = silent ? await f.reconcile() : f.store.get(f.id)!;
      expect(record).toMatchObject({ state: "failed", failure: "turn_failed", slot: 2,
        finalEvidence: "explicit-final-phase", taskOutcome: "unassessed" });
      expect(verifiedWebDelegationAnswer(record)).toBe("An error occurred after the final response.");
      expect(new WebDelegationStore(f.root).get(f.id)?.state).toBe("failed");
      expect(f.store.capacity(2).total.used).toBe(0);
      await expect(f.continue(f.id)).rejects.toThrow("Continuation requires a completed");
      expect(f.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
    } finally { f.cleanup(); }
  }
});

test("reconciliation of a completed Native turn without a final settles result_unavailable", async () => {
  const f = await fixture({ silent: true, finalPhase: "commentary" });
  try {
    await expect(f.run()).rejects.toThrow();
    expect(f.store.capacity(1).total.used).toBe(1);
    const result = await f.reconcile();
    expect(result).toMatchObject({ state: "failed", failure: "result_unavailable" });
    expect(verifiedWebDelegationAnswer(result)).toBeUndefined();
    expect(f.store.capacity(1).total.used).toBe(0);
    expect(await f.reconcile()).toMatchObject({ state: "failed", failure: "result_unavailable" });
    expect(f.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
  } finally { f.cleanup(); }
});

test("an earlier failed receipt can acquire an exact verified failed-turn final without losing failure", async () => {
  const f = await fixture({ silent: true, failedTurn: true });
  try {
    await expect(f.run()).rejects.toThrow();
    const early = f.store.save({ ...f.store.get(f.id)!, state: "failed", failure: "turn_failed" });
    expect(verifiedWebDelegationAnswer(early)).toBeUndefined();
    const recovered = await f.reconcile();
    expect(recovered).toMatchObject({ state: "failed", failure: "turn_failed",
      finalEvidence: "explicit-final-phase", answer: "verified recovered design" });
    expect(new WebDelegationStore(f.root).get(f.id)?.answer).toBe("verified recovered design");
    expect(f.store.capacity(1).total.used).toBe(0);
  } finally { f.cleanup(); }
});

test("Git root normalizes subdirectory aliases to the same physical writer lease", async () => {
  const f = await fixture();
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tela-git-checkout-")));
  try {
    execFileSync("git", ["init", "-q", repo]);
    const first = join(repo, "a"), second = join(repo, "b");
    mkdirSync(first); mkdirSync(second);
    const completed = await f.run();
    const reservation = { ...completed, id: randomUUID(), cwd: first,
      state: "reserved" as const, mode: "write" as const };
    f.store.reserve(reservation);
    expect(f.store.capacity(2, "write", second)).toMatchObject({ available: false,
      blockCode: "CAPACITY_WRITER_CHECKOUT" });
    expect(() => f.store.reserve({ ...reservation, id: randomUUID(), slot: 2, cwd: second }))
      .toThrow("작업 디렉터리");
  } finally { f.cleanup(); rmSync(repo, { recursive: true, force: true }); }
});

test("a legacy writer checkout lease is released after exact terminal evidence", async () => {
  const f = await fixture();
  try {
    const result = await f.run();
    const id = randomUUID();
    const { finalEvidence: _evidence, answer: _answer, ...withoutAnswer } = result;
    const old = { ...withoutAnswer, id, mode: "write" as const, state: "running" as const };
    writeFileSync(join(f.root, `${id}.json`), JSON.stringify(old));
    writeFileSync(join(f.root, "writer-1.lease"), id);
    const oldHash = createHash("sha256").update(f.root).digest("hex");
    const oldLease = join(f.root, `writer-checkout-${oldHash}.lease`);
    writeFileSync(oldLease, id);
    expect(f.store.capacity(2, "write", f.root).blockCode).toBe("CAPACITY_WRITER_CHECKOUT");
    f.store.save({ ...old, state: "failed", failure: "turn_failed" });
    expect(f.store.capacity(2, "write", f.root).available).toBe(true);
  } finally { f.cleanup(); }
});


test("profile limits 1 to 5 share admission, preserve running leases after shrink, and keep writer exclusivity", async () => {
  const f = await fixture();
  try {
    let limit = 5;
    const store = new WebDelegationStore(f.root, () => limit);
    const result = await f.run();
    const { answer: _answer, finalEvidence: _evidence, ...base } = result;
    for (let index = 0; index < 4; index++) {
      store.reserve({ ...base, id: randomUUID(), state: "reserved", mode: "read" });
    }
    expect(store.capacity(1)).toMatchObject({ total: { used: 4, limit: 5 }, available: true });
    store.reserve({ ...base, id: randomUUID(), state: "reserved", mode: "write" });
    expect(store.capacity(2, "write", f.root).blockCode).toBe("CAPACITY_WRITER_CHECKOUT");
    limit = 1;
    expect(store.capacity(1)).toMatchObject({ total: { used: 5, limit: 1 }, blockCode: "CAPACITY_TOTAL_PROFILE" });
    expect(() => store.reserve({ ...base, id: randomUUID(), state: "reserved" })).toThrow();
    expect(store.capacity(2).total.limit).toBe(1);
  } finally { f.cleanup(); }
});


test("public approval progress survives the ACK race, excludes foreign turns, and clears on completion", async () => {
  const f = await fixture({ publicProgress: true });
  try {
    const result = await f.run();
    const observed = f.changes.filter(record => record.progress).map(record => record.progress!);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ summary: "Approval needed in the Web browser.", source: "native-public-summary" });
    expect(observed[0]!.observedAt).toBeGreaterThan(0);
    expect(result.progress).toBeUndefined();
    expect(f.store.get(f.id)!.progress).toBeUndefined();
  } finally { f.cleanup(); }
});

test("explicit reconcile observes only bounded indexed public summaries without replaying a running turn", async () => {
  const f = await fixture({ silent: true, disconnect: true, indexedProgress: true });
  try {
    await expect(f.run()).rejects.toThrow("connection lost");
    const result = await f.reconcile();
    expect(result.progress?.summary.startsWith("Approval needed")).toBe(true);
    expect(result.progress?.summary).toHaveLength(2048);
    expect(result.progress?.source).toBe("native-indexed-summary");
    expect(JSON.stringify(result)).not.toContain("hidden-reasoning-must-not-be-read");
    expect(f.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
    expect(result.state).toBe("uncertain");
  } finally { f.cleanup(); }
});

test("public progress replaces the previous summary, bounds deltas, and never reads raw reasoning", () => {
  const projection = new WebDelegationProgressProjection();
  const first = { itemId: "public-reasoning", summaryIndex: 0 };
  const second = { ...first, summaryIndex: 1 };
  expect(projection.observe("item/reasoning/summaryTextDelta", { ...first, delta: "Approval needed" }, 1)?.summary).toBe("Approval needed");
  expect(projection.observe("item/reasoning/summaryPartAdded", second, 2)).toBeUndefined();
  expect(projection.observe("item/reasoning/summaryTextDelta", { ...second, delta: "Task resumed" }, 3)?.summary).toBe("Task resumed");
  expect(projection.observe("item/reasoning/summaryTextDelta", { ...first, delta: "stale" }, 4)).toBeUndefined();
  expect(projection.observe("item/reasoning/summaryTextDelta", { ...second, delta: "x".repeat(9000) }, 5)?.summary).toHaveLength(2048);
  expect(projection.observe("item/reasoning/summaryTextDelta", { ...second, delta: "overflow" }, 6)).toBeUndefined();
  expect(indexedWebDelegationProgress([{ type: "reasoning", summary: [], get rawContent() { throw Error("private reasoning read"); } }], 7)).toBeUndefined();
  expect(projection.observe("item/started", { item: { type: "reasoning", summary: [] } }, 8)).toBeUndefined();
  expect(projection.observe("item/completed", { item: { type: "reasoning", summary: ["Task has resumed"] } }, 9)).toEqual({
    summary: "Task has resumed", observedAt: 9, source: "native-public-summary",
  });
});

test("failed Native turns clear approval presentation instead of preserving an apparent current blocker", async () => {
  const f = await fixture({ publicProgress: true, failedTurn: true });
  try {
    await expect(f.run()).rejects.toThrow("Web job turn failed");
    expect(f.changes.some(record => record.progress?.summary.startsWith("Approval needed"))).toBe(true);
    expect(f.store.get(f.id)).toMatchObject({ state: "failed" });
    expect(f.store.get(f.id)?.progress).toBeUndefined();
  } finally { f.cleanup(); }
});
