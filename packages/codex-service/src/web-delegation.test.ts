import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { CodexAppServerRpc } from "@chatgpt-tela/codex";
import { runWebDelegation, inspectWebDelegationResult, collectWebDelegationResult, WebDelegationStore, reconcileWebDelegation, verifiedWebDelegationAnswer, type WebDelegationRecord } from "./web-delegation";
import { WebDelegationProgressProjection, indexedWebDelegationProgress } from "./web-delegation-progress";

async function fixture(options: { titleReadFails?: boolean; titleSetFails?: boolean; slot?: number; uncertain?: boolean; changedOwner?: boolean; foreignFinal?: boolean; silent?: boolean; finalPhase?: string | null; answer?: string; collaboration?: boolean; summaryToolResult?: boolean; failedTool?: boolean; enormousOutput?: boolean; closeFails?: boolean; disconnect?: boolean; failedTurn?: boolean; latestStatus?: "failed" | "interrupted"; manualTurn?: boolean; ambiguousFirstTurn?: boolean; publicProgress?: boolean; indexedProgress?: boolean } = {}) {
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
  let modeModel = "native-fixture";
  const executionModels: string[] = [];
  const queuedExecutionModels: string[] = [];
  const rpc: CodexAppServerRpc = {
    subscribe(callback, onDisconnected) { notify = callback; disconnected = onDisconnected; return () => {}; },
    async close() { if (options.closeFails) throw Error("connection already closed"); },
    async request(method, params) {
      calls.push({ method, params });
      if (method === "model/list") return { data: [{ model: "chatgpt-tela-web/family/aaaaaaaaaaaaaaaaaaaa", displayName: "6 (Web)", supportedReasoningEfforts: [{ reasoningEffort: "xhigh" }] }] };
      if (method === "thread/resume") { attached = true; return { thread: { id: threadId } }; }
      if (method === "thread/settings/update") {
        const settings = params as { collaborationMode?: { settings: { model: string } } };
        modeModel = settings.collaborationMode?.settings.model ?? modeModel;
        // A queued Goal continuation reads the persisted preset without our turn/start arguments.
        queuedExecutionModels.push(modeModel);
        return { thread: { id: threadId }, model: modeModel };
      }
      if (method === "thread/start") { attached = true; return { model: "chatgpt-tela-web/family/aaaaaaaaaaaaaaaaaaaa", approvalPolicy: "never", sandbox: { type: "workspaceWrite" }, thread: { id: threadId, cwd: root, historyMode: "paginated", ephemeral: false } }; }
      if (method === "thread/read") { if (options.titleReadFails) throw Error("Fixture metadata unavailable"); return { thread: { id: threadId, name: currentTitle, preview: "Read this fixture and design only\nMore context" } }; }
      if (method === "thread/queue/add") {
        const request = params as { clientUserMessageId: string };
        return { queuedSubmission: { id: randomUUID(), clientUserMessageId: request.clientUserMessageId, input: [] } };
      }
      if (method === "thread/name/set") {
        if (options.titleSetFails) throw Error("Fixture naming RPC failed");
        currentTitle = (params as { name: string }).name;
        return {};
      }
      if (method === "turn/start") {
        const request = params as { collaborationMode?: { settings: { model: string } }; model?: string };
        // Native applies the retained collaboration preset before top-level model overrides.
        modeModel = request.collaborationMode?.settings.model ?? modeModel;
        executionModels.push(modeModel);
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
        return { data: [{ id: currentTurnId, status: options.indexedProgress ? "inProgress" : options.latestStatus ?? (options.failedTurn ? "failed" : "completed"), items: [
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
  return { root, store, calls, changes, id, slot, adapters, executionModels, queuedExecutionModels,
    setModeModel: (model: string) => { modeModel = model; },
    inspect: (jobId: string = id) => inspectWebDelegationResult(adapters, jobId),
    collect: (jobId: string = id) => collectWebDelegationResult(adapters, jobId),
    setTitle: (name: string | null) => { currentTitle = name; },
    continue: (parentJobId: string, prompt = "Follow up") => runWebDelegation(adapters, { id: randomUUID(), slot, cwd: root, prompt, parentJobId, signal: AbortSignal.timeout(1000) }), run: () => runWebDelegation(adapters, { id, slot, cwd: root, prompt: "Read this fixture and design only", signal: AbortSignal.timeout(1000) }), runWithCoordinator: () => runWebDelegation(adapters, { id, slot, cwd: root, prompt: "Read this fixture and design only", coordinator: { slot, threadId, accountFingerprint: "a".repeat(64) }, signal: AbortSignal.timeout(1000) }), reconcile: () => reconcileWebDelegation(adapters, id, AbortSignal.timeout(1000)), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("failure notice queues once to the explicitly owned coordinator and preserves the original failure", async () => {
  const f = await fixture({ failedTurn: true, answer: "" });
  try {
    await expect(f.runWithCoordinator()).rejects.toThrow("Web job turn failed");
    const failed = f.store.get(f.id)!;
    expect(failed).toMatchObject({ state: "failed", failure: "turn_failed", coordinatorNotice: "queued",
      coordinatorQueueItemId: expect.any(String), coordinatorClientUserMessageId: expect.any(String), coordinatorFollowThrough: "unobserved" });
    const notice = f.calls.filter(call => call.method === "thread/queue/add");
    expect(notice).toHaveLength(1);
    expect(notice[0]?.params).toMatchObject({ threadId: failed.coordinator?.threadId,
      clientUserMessageId: failed.coordinatorClientUserMessageId,
      input: [{ type: "text", text: expect.stringContaining(`job_id: ${f.id}`) }] });
    await expect(f.runWithCoordinator()).rejects.toThrow();
    expect(f.calls.filter(call => call.method === "thread/queue/add")).toHaveLength(1);
  } finally { f.cleanup(); }
});

test("new durable Web job buffers ACK race, returns exact final and never loads a source conversation", async () => {
  const f = await fixture();
  try {
    const result = await f.run();
    expect(result).toMatchObject({ state: "completed", answer: "verified design",
      toolItems: 1, toolResultItems: 1, toolResultCoverage: "live-events" });
    expect(f.calls.find(call => call.method === "thread/start")?.params).toMatchObject({ ephemeral: false, historyMode: "paginated", sandbox: "workspace-write", approvalPolicy: "never" });
    expect(f.calls.find(call => call.method === "turn/start")?.params).toMatchObject({ collaborationMode: { mode: "default", settings: { model: "chatgpt-tela-web/family/aaaaaaaaaaaaaaaaaaaa", reasoning_effort: "xhigh", developer_instructions: null } }, sandboxPolicy: { type: "workspaceWrite", writableRoots: [f.root], networkAccess: false }, approvalPolicy: "never" });
    expect(f.calls.map(call => call.method)).toEqual(["model/list", "thread/start", "thread/settings/update", "turn/start"]);
    expect(f.calls.find(call => call.method === "thread/settings/update")?.params).toMatchObject({
      model: "chatgpt-tela-web/family/aaaaaaaaaaaaaaaaaaaa", effort: "xhigh",
      collaborationMode: { settings: { model: "chatgpt-tela-web/family/aaaaaaaaaaaaaaaaaaaa" } },
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
    expect(new WebDelegationStore(f.root).get(f.id)?.answer).toBe("verified design");
    expect(JSON.stringify(new WebDelegationStore(f.root).get(f.id))).not.toContain("fixture-result-not-in-journal");
  } finally { f.cleanup(); }
});
test("new and resumed delegation override a retained Native collaboration model", async () => {
  const f = await fixture();
  try {
    const first = await f.run();
    f.setModeModel("native-fixture");
    await f.continue(first.id);
    expect(f.executionModels).toEqual(Array(2).fill(first.selection!.model));
    expect(f.queuedExecutionModels).toEqual(Array(2).fill(first.selection!.model));
    for (const call of f.calls.filter(call => call.method === "turn/start")) {
      expect(call.params).not.toHaveProperty("model");
      expect(call.params).not.toHaveProperty("effort");
    }
  } finally { f.cleanup(); }
});
test("first collection names once and preserves later manual removal", async () => {
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
test("failed result inspection names once without starting collected retention", async () => {
  const f = await fixture({ failedTurn: true, answer: "" });
  try {
    await expect(f.run()).rejects.toThrow("Web job turn failed");
    const result = f.store.get(f.id)!;
    expect(result.state).toBe("failed");
    f.setTitle("Failed task");
    await f.inspect();
    expect(f.calls.filter(call => call.method === "thread/name/set")).toEqual([{
      method: "thread/name/set", params: { threadId: result.threadId, name: "[Tela Agent] Failed task" },
    }]);
    expect(f.store.collectedAt(f.id)).toBeUndefined();
    f.setTitle("User rename");
    await expect(f.collect()).rejects.toThrow("No verified final result");
    expect(f.calls.filter(call => call.method === "thread/name/set")).toHaveLength(1);
    f.store.removeDeletedThread({ slot: result.slot, accountFingerprint: result.owner.accountFingerprint, threadId: result.threadId! });
    expect(() => readFileSync(join(f.root, `${f.id}.json.named`))).toThrow();
  } finally { f.cleanup(); }
});
test("an existing collected receipt preserves manual titles after upgrade", async () => {
  const f = await fixture();
  try {
    await f.run();
    f.store.collect(f.id);
    f.setTitle("Personal rename");
    const before = f.calls.length;
    await f.inspect();
    expect(f.calls).toHaveLength(before);
  } finally { f.cleanup(); }
});
test("unnamed collection uses the preview first line and concurrent collection names once", async () => {
  const f = await fixture();
  try {
    const first = await f.run();
    expect(await Promise.all([f.collect(), f.collect()])).toEqual(["verified design", "verified design"]);
    expect(f.calls.filter(call => call.method === "thread/name/set")).toEqual([{
      method: "thread/name/set", params: { threadId: first.threadId, name: "[Tela Agent] Read this fixture and design only" },
    }]);
    f.setTitle("Personal rename");
    const next = await f.continue(first.id);
    await f.collect(next.id);
    expect(f.calls.filter(call => call.method === "thread/name/set")).toHaveLength(1);
  } finally { f.cleanup(); }
});
test("an existing prefix is not duplicated on collection", async () => {
  const f = await fixture();
  try {
    await f.run();
    f.setTitle("[Tela Agent] Existing title");
    expect(await f.collect()).toBe("verified design");
    expect(f.calls.filter(call => call.method === "thread/name/set")).toHaveLength(0);
  } finally { f.cleanup(); }
});
test("naming failure preserves the answer without rearming naming", async () => {
  for (const options of [{ titleReadFails: true }, { titleSetFails: true }]) {
    const f = await fixture(options);
    try {
      await f.run();
      expect(await f.collect()).toBe("verified design");
      const before = f.calls.length;
      expect(await f.collect()).toBe("verified design");
      expect(f.calls).toHaveLength(before);
      expect(f.store.collectedAt(f.id)).toBeNumber();
    } finally { f.cleanup(); }
  }
});
test("default Web delegation requests and proves workspace-only Native sandbox", async () => {
  const f = await fixture();
  try {
    const result = await f.run();
    expect(result).toMatchObject({ state: "completed" });
    expect(f.calls.find(call => call.method === "thread/start")?.params).toMatchObject({
      sandbox: "workspace-write", approvalPolicy: "never",
    });
    expect(f.calls.find(call => call.method === "turn/start")?.params).toMatchObject({
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [f.root], networkAccess: false },
      approvalPolicy: "never",
    });
    expect(f.store.capacity(1, f.root)).toMatchObject({ available: true,
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

test("three different workspaces use the profile permits and release after a proven final", async () => {
  const f = await fixture({ silent: true });
  try {
    const workspaces = ["second", "third", "fourth"].map(name => join(f.root, name));
    for (const cwd of workspaces) mkdirSync(cwd);
    expect(f.store.capacity(1).total).toMatchObject({ used: 0, limit: 3 });
    const active = f.run();
    for (let i = 0; i < 100 && f.store.get(f.id)?.state !== "running"; i++) await Bun.sleep(1);
    const first = f.store.get(f.id)!;
    const another = { ...first, id: randomUUID(), cwd: workspaces[0]!, state: "reserved" as const };
    f.store.reserve(another);
    expect(f.store.capacity(1)).toMatchObject({ total: { used: 2, limit: 3 }, available: true });
    f.store.reserve({ ...another, id: randomUUID(), cwd: workspaces[1]! });
    expect(() => f.store.reserve({ ...another, id: randomUUID(), cwd: workspaces[2]! }))
      .toThrow("실행 한도");
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
  const f = await fixture({ slot: 2 });
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
    expect(f.store.capacity(2, f.root)).toMatchObject({
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
    expect(f.store.capacity(2, f.root)).toMatchObject({
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

test("full profile rejects a fourth independent checkout before any provider request", async () => {
  const f = await fixture();
  try {
    const others = ["second", "third"].map(name => join(f.root, name));
    for (const cwd of others) mkdirSync(cwd);
    const base = { id: randomUUID(), slot: 1, cwd: f.root,
      createdAt: Date.now(), promptHash: "a".repeat(64),
      owner: { slot: 1, accountFingerprint: "a".repeat(64), sessionFingerprint: "b".repeat(64), routeFingerprint: "c".repeat(64) },
      session: { slot: 1, runtimeProcessId: 10, responsesRouteFingerprint: "c".repeat(64), terminalEndpoint: "ws://127.0.0.1:1234" },
      state: "reserved" as const };
    f.store.reserve(base);
    f.store.reserve({ ...base, id: randomUUID(), cwd: others[0]! });
    f.store.reserve({ ...base, id: randomUUID(), cwd: others[1]! });
    await expect(f.run()).rejects.toMatchObject({ code: "CAPACITY_TOTAL_PROFILE" });
    expect(f.calls).toHaveLength(0);
    expect(f.store.get(f.id)).toBeUndefined();
    expect(f.store.capacity(1)).toMatchObject({ total: { used: 3, limit: 3 },
      available: false, blockCode: "CAPACITY_TOTAL_PROFILE" });
  } finally { f.cleanup(); }
});

test("unsettled legacy reader journals remain visible and their leases release only on terminal proof", async () => {
  const f = await fixture();
  try {
    const completed = await f.run();
    const { answer: _answer, finalEvidence: _finalEvidence, ...historical } = completed;
    const old = { ...historical, id: randomUUID(), mode: "read" as const,
      state: "running" as const };
    writeFileSync(join(f.root, `${old.id}.json`), JSON.stringify(old));
    writeFileSync(join(f.root, "reader-1.lease"), old.id);
    expect(new WebDelegationStore(f.root).get(old.id)).toMatchObject({ mode: "read", state: "running" });
    expect(f.store.capacity(1, f.root)).toMatchObject({ total: { used: 1 },
      available: false, blockCode: "CAPACITY_WRITER_CHECKOUT" });
    f.store.save({ ...old, state: "failed", failure: "turn_failed" });
    expect(f.store.capacity(1, f.root)).toMatchObject({ total: { used: 0 }, available: true });
  } finally { f.cleanup(); }
});

test("continuation appends a new turn to the same Native thread without creating another thread", async () => {
  const f = await fixture();
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

test.each(["failed", "interrupted"] as const)("new authorized follow-up reuses a %s thread without requiring a prior answer", async latestStatus => {
  const options = { failedTurn: true, answer: "", latestStatus };
  const f = await fixture(options);
  try {
    await expect(f.run()).rejects.toThrow("turn failed");
    const prior = f.store.get(f.id)!;
    expect(verifiedWebDelegationAnswer(prior)).toBeUndefined();
    options.failedTurn = false;
    options.answer = "Reviewed existing effects and continued";
    const next = await f.continue(f.id, "Review existing work, then continue");
    expect(next).toMatchObject({ state: "completed", threadId: prior.threadId, parentJobId: prior.id });
    expect(next.turnId).not.toBe(prior.turnId);
    expect(f.store.get(f.id)?.state).toBe("failed");
    expect(f.calls.filter(call => call.method === "thread/start")).toHaveLength(1);
    expect(f.calls.filter(call => call.method === "turn/start")).toHaveLength(2);
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
  const f = await fixture({ manualTurn: true });
  try {
    const original = await f.run();
    const next = await f.continue(original.id);
    expect(next.threadId).toBe(original.threadId);
    expect(next.state).toBe("completed");
    expect(f.calls.filter(call => call.method === "thread/start")).toHaveLength(1);
  } finally { f.cleanup(); }
});

test("a historical read-only conversation continues as a workspace-write turn in the same thread", async () => {
  const f = await fixture();
  try {
    const original = await f.run();
    const oldRecord = { ...original, mode: "read" as const };
    writeFileSync(join(f.root, `${original.id}.json.completed`), JSON.stringify(oldRecord));
    const continued = await f.continue(original.id, "Implement the analyzed change");
    expect(continued).toMatchObject({ state: "completed", threadId: original.threadId, parentJobId: original.id });
    expect(continued.mode).toBeUndefined();
    expect(f.calls.filter(call => call.method === "thread/start")).toHaveLength(1);
    expect(f.calls.filter(call => call.method === "thread/resume")).toHaveLength(1);
    expect(f.calls.filter(call => call.method === "turn/start")).toHaveLength(2);
    expect(f.calls.filter(call => call.method === "turn/start").at(-1)?.params).toMatchObject({
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [f.root], networkAccess: false },
    });
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
    const base = { ...original, id: randomUUID(), state: "reserved" as const };
    for (const root of roots) f.store.reserve({ ...base, id: randomUUID(), cwd: root });
    expect(f.store.capacity(1)).toMatchObject({ total: { used: 3, limit: 3 }, available: false, blockCode: "CAPACITY_TOTAL_PROFILE" });
    expect(f.store.capacity(2, roots[0])).toMatchObject({ available: false, blockCode: "CAPACITY_WRITER_CHECKOUT" });
  } finally { f.cleanup(); roots.forEach(root => rmSync(root, { recursive: true, force: true })); }
});


test("failed Native turn releases its task lease; completed turn without final reports result unavailable", async () => {
  for (const options of [{ failedTurn: true }, { finalPhase: "commentary" }]) {
    const f = await fixture(options);
    try {
      await expect(f.run()).rejects.toThrow();
      expect(f.store.get(f.id)).toMatchObject({ state: "failed",
        failure: options.failedTurn ? "turn_failed" : "result_unavailable",
        failureStage: options.failedTurn ? "turn_complete" : "final_result",
        failureClass: "unknown", failureIncidentRef: expect.stringMatching(/^incident_[0-9a-f-]{36}$/),
        failureNextAction: options.failedTurn ? "inspect_diagnostics" : "inspect_job" });
      expect(f.store.capacity(1)).toMatchObject({ available: true, total: { used: 0, limit: 3 } });
    } finally { f.cleanup(); }
  }
});

test("failed Native turn preserves an explicit final without misreporting success", async () => {
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
      state: "reserved" as const };
    f.store.reserve(reservation);
    expect(f.store.capacity(2, second)).toMatchObject({ available: false,
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
    expect(f.store.capacity(2, f.root).blockCode).toBe("CAPACITY_WRITER_CHECKOUT");
    f.store.save({ ...old, state: "failed", failure: "turn_failed" });
    expect(f.store.capacity(2, f.root).available).toBe(true);
  } finally { f.cleanup(); }
});


test("profile limits 1 to 5 preserve active permits after shrinking and independent checkout writers", async () => {
  const f = await fixture();
  try {
    let limit = 5;
    const store = new WebDelegationStore(f.root, () => limit);
    const result = await f.run();
    const { answer: _answer, finalEvidence: _evidence, ...base } = result;
    for (let index = 0; index < 4; index++) {
      const cwd = join(f.root, `checkout-${index}`);
      mkdirSync(cwd);
      store.reserve({ ...base, id: randomUUID(), cwd, state: "reserved" });
    }
    expect(store.capacity(1)).toMatchObject({ total: { used: 4, limit: 5 }, available: true });
    store.reserve({ ...base, id: randomUUID(), state: "reserved" });
    expect(store.capacity(2, f.root).blockCode).toBe("CAPACITY_WRITER_CHECKOUT");
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

test("explicit image input reaches start and same-thread continuation exactly once", async () => {
  const f = await fixture();
  const png = `data:image/png;base64,${Buffer.from([137,80,78,71,13,10,26,10,0]).toString("base64")}`;
  try {
    const first = await runWebDelegation(f.adapters, { id: f.id, slot: f.slot, cwd: f.root,
      prompt: "Review image", images: [png], signal: AbortSignal.timeout(1000) });
    const one = f.calls.find(call => call.method === "turn/start")!;
    expect(one.params).toMatchObject({ input: [{ type: "text" }, { type: "image", url: png }] });
    await runWebDelegation(f.adapters, { id: randomUUID(), slot: f.slot, cwd: f.root,
      parentJobId: first.id, prompt: "Follow up", signal: AbortSignal.timeout(1000) });
    const last = f.calls.filter(call => call.method === "turn/start").at(-1)!;
    expect(last.params).toMatchObject({ input: [{ type: "text", text: "Follow up", textElements: [] }] });
    expect(f.calls.filter(call => call.method === "thread/start")).toHaveLength(1);
    await expect(runWebDelegation(f.adapters, { id: randomUUID(), slot: f.slot, cwd: f.root,
      prompt: "Invalid image", images: ["https://example.invalid/image.png"], signal: AbortSignal.timeout(1000) })).rejects.toThrow();
    expect(f.calls.filter(call => call.method === "turn/start")).toHaveLength(2);
  } finally { f.cleanup(); }
});
