import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { CodexAppServerRpc } from "@chatgpt-tela/codex";
import { runReadOnlyWebDelegation, WebDelegationStore, reconcileWebDelegation } from "./web-delegation";

async function fixture(options: { uncertain?: boolean; changedOwner?: boolean; foreignFinal?: boolean; silent?: boolean; finalPhase?: string | null; answer?: string; collaboration?: boolean } = {}) {
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
      if (method === "thread/start") return { model: "chatgpt-tela-web/family/aaaaaaaaaaaaaaaaaaaa", approvalPolicy: "never", sandbox: { type: "readOnly" }, thread: { id: threadId, cwd: root, historyMode: "paginated", ephemeral: false } };
      if (method === "turn/start") {
        if (options.uncertain) throw Error("lost acknowledgement");
        if (options.silent) return { turn: { id: turnId } };
        // Synchronously complete BEFORE turn/start's ACK, exercising the real notification race.
        notify("item/completed", { threadId: options.foreignFinal ? randomUUID() : threadId, turnId, item: { id: "final", type: "agentMessage", ...(options.finalPhase === null ? {} : { phase: options.finalPhase ?? "final_answer" }), text: options.answer ?? "verified design" } });
        notify("item/completed", { threadId, turnId, item: { id: "read", type: "commandExecution" } });
        if (options.collaboration) notify("item/completed", { threadId, turnId, item: { id: "collab", type: "collabAgentToolCall" } });
        notify("turn/completed", { threadId, turn: { id: turnId, status: "completed" } });
        return { turn: { id: turnId } };
      }
      if (method === "thread/turns/list") return { data: [{ id: turnId, status: "completed", items: [
        { id: "final", type: "agentMessage", ...(options.finalPhase === null ? {} : { phase: options.finalPhase ?? "final_answer" }), text: options.answer ?? "verified recovered design" },
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
  return { root, store, calls, id, run: () => runReadOnlyWebDelegation(adapters, { id, slot: 1, cwd: root, prompt: "Read this fixture and design only", signal: AbortSignal.timeout(1000) }), reconcile: () => reconcileWebDelegation(adapters, id, AbortSignal.timeout(1000)), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("new read-only durable Web job buffers ACK race, returns exact final and never loads a source conversation", async () => {
  const f = await fixture();
  try {
    const result = await f.run();
    expect(result).toMatchObject({ state: "completed", answer: "verified design", toolItems: 1 });
    expect(f.calls.find(call => call.method === "thread/start")?.params).toMatchObject({ ephemeral: false, historyMode: "paginated", sandbox: "read-only", approvalPolicy: "never" });
    expect(f.calls.find(call => call.method === "turn/start")?.params).toMatchObject({ effort: "xhigh", sandboxPolicy: { type: "readOnly" }, approvalPolicy: "never" });
    expect(f.calls.map(call => call.method)).toEqual(["model/list", "thread/start", "turn/start"]);
    await expect(f.run()).rejects.toThrow();
    expect(f.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
    expect(new WebDelegationStore(f.root).get(f.id)?.answer).toBe("verified design");
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

test("phase-less promises and commentary are never recovered as a final result", async () => {
  for (const finalPhase of [null, "commentary"]) {
    const f = await fixture({ finalPhase, answer: "I will investigate." });
    try {
      await expect(f.run()).rejects.toThrow("proven final answer");
      expect(f.store.get(f.id)?.answer).toBeUndefined();
      await expect(f.reconcile()).rejects.toThrow("bounded and proven");
      expect(f.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
    } finally { f.cleanup(); }
  }
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
