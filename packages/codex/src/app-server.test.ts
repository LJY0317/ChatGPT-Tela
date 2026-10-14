import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { diagnosticFingerprint, NativeLiveTurnRegistry, setPrivateDiagnosticCapture, withDiagnosticContext } from "@chatgpt-tela/core";
import {
  AppServerCurrentTurnSource,
  connectCodexAppServerWebSocket,
  interruptLoadedAppServerTurns,
  type CodexAppServerRpc,
  type CodexAppServerRpcFactory,
} from "./app-server";

class FixtureRpc implements CodexAppServerRpc {
  readonly calls: Array<{ method: string; params?: unknown }> = [];
  closed = 0;

  constructor(readonly responses: Readonly<Record<string, unknown>>) {}

  async request(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, ...(params !== undefined ? { params } : {}) });
    if (!(method in this.responses)) throw new Error(`unexpected RPC method: ${method}`);
    return structuredClone(this.responses[method]);
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}

/** Isolated regression fixtures for the old official Desktop snapshot shape.
 * Never the production current-turn default: includeTurns:true may hydrate
 * private Legacy history and must not become an implicit call-site choice.
 */
function legacySnapshotFixtureSource(
  connect: CodexAppServerRpcFactory,
  options: { readonly includeNativeGoal?: boolean } = {},
): AppServerCurrentTurnSource {
  return new AppServerCurrentTurnSource(connect, {
    ...options, preferBoundedTurnProof: false,
  });
}

function activeThread(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const workspace = resolve("/workspace");
  return {
    id: "thread-1",
    cwd: workspace,
    status: { type: "active", activeFlags: [] },
    parentThreadId: null,
    source: "cli",
    turns: [],
    environments: [{
      environmentId: "env-1",
      cwd: resolve(workspace, "project"),
      runtimeWorkspaceRoots: [workspace],
    }],
    ...overrides,
  };
}

describe("Codex app-server current-turn authority", () => {
  test("an owned engine-acknowledged Legacy live turn uses only metadata and never pages historical history", async () => {
    const live = new NativeLiveTurnRegistry();
    const owner = {};
    expect(live.accept("thread-1", "turn-live", owner)).toBe(true);
    const calls: string[] = [];
    const rpc: CodexAppServerRpc = {
      async request(method, params) {
        calls.push(method);
        if (method !== "thread/read" || (params as { includeTurns?: boolean }).includeTurns !== false) {
          throw new Error("Legacy must not page, resume, fork or start a Native model");
        }
        return { thread: activeThread({ historyMode: "legacy", turns: undefined }) };
      },
      async close() {},
    };
    const source = new AppServerCurrentTurnSource(async () => rpc, {
      liveTurnProof: live,
    });
    expect(await source.currentTurn("thread-1")).toMatchObject({
      threadId: "thread-1", turnId: "turn-live",
      proof: "app-server-acknowledged-live-turn",
    });
    expect(calls).toEqual(["thread/read", "thread/read"]);
    live.retire("thread-1", "turn-live");
    await expect(source.currentTurn("thread-1")).rejects.toMatchObject({
      code: "native_history_bootstrap_required", recoveryReason: "unindexed_history",
    });
    expect(calls).toEqual(["thread/read", "thread/read", "thread/read"]);
    expect(live.accept("thread-1", "turn-replaced", owner)).toBe(true);
    await expect(source.currentTurn("thread-1")).resolves.toMatchObject({
      turnId: "turn-replaced",
    });
  });

  test("Legacy live receipt loss, metadata owner change or unknown storage mode fails before historical RPC", async () => {
    for (const reason of ["revoked", "owner_changed", "unknown_mode"] as const) {
      const live = new NativeLiveTurnRegistry();
      const owner = {};
      live.accept("thread-1", "turn-live", owner);
      const calls: string[] = [];
      const rpc: CodexAppServerRpc = {
        async request(method, params) {
          calls.push(method);
          if (method !== "thread/read" || (params as { includeTurns?: boolean }).includeTurns !== false) {
            throw new Error("Legacy history is never read or resumed");
          }
          if (reason === "revoked") live.retire("thread-1", "turn-live");
          return { thread: activeThread({
            historyMode: reason === "unknown_mode" ? undefined : "legacy",
            turns: undefined,
            ...(reason === "owner_changed" && calls.length > 1 ? {
              environments: [{ cwd: "/different/owner",
                runtimeWorkspaceRoots: ["/different/owner"] }],
            } : {}),
          }) };
        },
        async close() {},
      };
      await expect(new AppServerCurrentTurnSource(async () => rpc, {
        liveTurnProof: live,
      }).currentTurn("thread-1")).rejects.toMatchObject({
        code: "native_history_bootstrap_required", recoveryReason: "unindexed_history",
      });
      expect(calls.every(method => method === "thread/read")).toBe(true);
      expect(calls.length).toBeLessThanOrEqual(2);
    }
  });
  test("a default-constructed current-turn source rejects unindexed history before any expensive RPC", async () => {
    for (const historyMode of ["legacy", undefined, "new-unindexed-mode"]) {
      const methods: Array<{ method: string; params: unknown }> = [];
      let closed = 0;
      const rpc: CodexAppServerRpc = {
        async request(method, params) {
          methods.push({ method, params });
          if (method !== "thread/read" || (params as { includeTurns?: boolean }).includeTurns !== false) {
            throw new Error("A default Native owner reader must never hydrate Legacy history");
          }
          return { thread: activeThread({ historyMode, turns: undefined }) };
        },
        async close() { closed++; },
      };
      await expect(new AppServerCurrentTurnSource(async () => rpc).currentTurn("thread-1"))
        .rejects.toMatchObject({
          code: "native_history_bootstrap_required",
          recoveryReason: "unindexed_history",
        });
      expect(methods).toEqual([{ method: "thread/read",
        params: { threadId: "thread-1", includeTurns: false } }]);
      expect(closed).toBe(1);
    }
  });

  test("bounded current-turn proof never reads an entire 73 MB Native history", async () => {
    const methods: Array<{ method: string; params: any }> = [];
    let closed = 0;
    const noTurns = activeThread({ turns: undefined, historyMode: "paginated" });
    const page = { data: [
      { id: "turn-current", status: "inProgress", itemsView: "notLoaded", items: [] },
      { id: "turn-previous", status: "completed", itemsView: "notLoaded", items: [] },
    ], nextCursor: "more-native-turns" };
    const rpc: CodexAppServerRpc = {
      async request(method, params) {
        methods.push({ method, params });
        if (method === "thread/read") {
          if ((params as any).includeTurns !== false) throw Error("Whole-history read forbidden");
          return { thread: noTurns };
        }
        if (method === "thread/turns/list") return page;
        throw Error("Unapproved public request");
      },
      async close() { closed++; },
    };
    const current = await new AppServerCurrentTurnSource(async () => rpc,
      { preferBoundedTurnProof: true }).currentTurn("thread-1");
    expect(current?.turnId).toBe("turn-current");
    expect(current?.proof).toBe("app-server-active-turn");
    expect(closed).toBe(1);
    expect(methods.map(item => item.method))
      .toEqual(["thread/read", "thread/turns/list", "thread/read"]);
    expect(methods[1]?.params).toMatchObject({
      threadId: "thread-1", limit: 2, itemsView: "notLoaded", sortDirection: "desc",
    });
  });

  test("bounded current-turn proof cannot silently fall back to exporting full history", async () => {
    for (const bad of [
      { data: [{ id: "current", status: "inProgress", items: ["private-output"] }] },
      { data: [{ id: "same", status: "inProgress", items: [] },
        { id: "same", status: "completed", items: [] }] },
      { data: [] },
    ]) {
      let closed = 0;
      const rpc: CodexAppServerRpc = {
        async request(method, params) {
          if (method === "thread/read") {
            if ((params as any).includeTurns) throw Error("Unbounded history was requested");
            return { thread: activeThread({ turns: undefined, historyMode: "paginated" }) };
          }
          if (method === "thread/turns/list") return bad;
          throw Error("Unexpected method");
        },
        async close() { closed++; },
      };
      await expect(new AppServerCurrentTurnSource(async () => rpc,
        { preferBoundedTurnProof: true }).currentTurn("thread-1")).rejects.toThrow();
      expect(closed).toBe(1);
    }
    let closed = 0;
    const unsupported: CodexAppServerRpc = {
      async request(method, params) {
        if (method === "thread/read") {
          if ((params as any).includeTurns) throw Error("Whole history fallback forbidden");
          return { thread: activeThread({ turns: undefined, historyMode: "paginated" }) };
        }
        throw Error("thread/turns/list is not supported yet");
      },
      async close() { closed++; },
    };
    await expect(new AppServerCurrentTurnSource(async () => unsupported,
      { preferBoundedTurnProof: true }).currentTurn("thread-1"))
      .rejects.toThrow("full history was not read");
    expect(closed).toBe(1);
  });
  test("active Legacy or unverified history cannot trigger even shallow turn paging", async () => {
    for (const historyMode of ["legacy", undefined, "future-unindexed-mode"]) {
      const calls: Array<{ method: string; params: unknown }> = [];
      let closed = 0;
      const rpc: CodexAppServerRpc = {
        async request(method, params) {
          calls.push({ method, params });
          if (method === "thread/read") {
            if ((params as any).includeTurns !== false) throw Error("Unbounded read forbidden");
            return { thread: activeThread({ historyMode, turns: undefined }) };
          }
          throw Error("Unapproved paging or model operation");
        },
        async close() { closed++; },
      };
      await expect(new AppServerCurrentTurnSource(async () => rpc,
        { preferBoundedTurnProof: true }).currentTurn("thread-1"))
        .rejects.toThrow("unindexed history was not paged");
      expect(calls.map(call => call.method)).toEqual(["thread/read"]);
      expect(closed).toBe(1);
    }
  });

  test("unindexed Native metadata refusal is traceable without leaking thread identifiers", async () => {
    const previousLog = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    const base = mkdtempSync(resolve(tmpdir(), "tela-native-proof-diagnostics-"));
    const path = resolve(base, "events.jsonl");
    process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = path;
    const rawThreadId = "thread-private-identifier";
    let calls = 0;
    const rpc: CodexAppServerRpc = {
      async request(method, params) {
        calls++;
        if (method !== "thread/read" || (params as any).includeTurns !== false) {
          throw Error("unapproved unbounded Native read");
        }
        return { thread: activeThread({ id: rawThreadId, historyMode: "legacy", turns: undefined }) };
      },
      async close() {},
    };
    try {
      await expect(new AppServerCurrentTurnSource(async () => rpc,
        { preferBoundedTurnProof: true }).currentTurn(rawThreadId))
        .rejects.toThrow("unindexed history was not paged");
      expect(calls).toBe(1);
      const log = readFileSync(path, "utf8");
      expect(log).toContain('"stage":"native_current_turn_rejected"');
      expect(log).toContain('"reason_class":"unindexed_history"');
      expect(log).toContain('"scope_fingerprint":"');
      expect(log).not.toContain(rawThreadId);
    } finally {
      if (previousLog === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
      else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = previousLog;
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("bounded current-turn proof refuses history mode drift after paging", async () => {
    let reads = 0;
    const methods: string[] = [];
    let closed = 0;
    const rpc: CodexAppServerRpc = {
      async request(method, params) {
        methods.push(method);
        if (method === "thread/read") {
          if ((params as any).includeTurns !== false) throw Error("Whole history forbidden");
          return { thread: activeThread({
            historyMode: ++reads === 1 ? "paginated" : "legacy",
            turns: undefined,
          }) };
        }
        if (method === "thread/turns/list") return {
          data: [{ id: "current", status: "inProgress", itemsView: "notLoaded", items: [] }],
          nextCursor: null,
        };
        throw Error("Unexpected RPC");
      },
      async close() { closed++; },
    };
    await expect(new AppServerCurrentTurnSource(async () => rpc,
      { preferBoundedTurnProof: true }).currentTurn("thread-1"))
      .rejects.toThrow("changed during paginated owner proof");
    expect(methods).toEqual(["thread/read", "thread/turns/list", "thread/read"]);
    expect(closed).toBe(1);
  });

  test("idle Legacy metadata can be skipped without any turn list call", async () => {
    const methods: string[] = [];
    let closed = 0;
    const rpc: CodexAppServerRpc = {
      async request(method, params) {
        methods.push(method);
        if (method !== "thread/read" || (params as any).includeTurns !== false) {
          throw Error("Unsafe request");
        }
        return { thread: activeThread({
          status: { type: "idle" }, historyMode: "legacy", turns: undefined,
        }) };
      },
      async close() { closed++; },
    };
    expect(await new AppServerCurrentTurnSource(async () => rpc,
      { preferBoundedTurnProof: true }).currentTurn("thread-1")).toBeUndefined();
    expect(methods).toEqual(["thread/read"]);
    expect(closed).toBe(1);
  });

  test("optional read-only Native goal observation requires the same active public thread and preserves Native ownership", async () => {
    const active = activeThread({ turns: [{ id: "turn-1", status: "inProgress", items: [] }] });
    const goal = {
      threadId: "thread-1", objective: "Review a bounded test document", status: "active",
      tokenBudget: 8000, tokensUsed: 55, timeUsedSeconds: 13, updatedAt: 42,
    };
    const rpc = new FixtureRpc({
      "thread/read": { thread: active },
      "thread/goal/get": { goal },
    });
    const source = legacySnapshotFixtureSource(async () => rpc, { includeNativeGoal: true });
    const observed = await source.currentTurn("thread-1");
    expect(observed?.nativeGoal).toEqual(goal);
    expect(observed?.turnId).toBe("turn-1");
    expect(rpc.calls.map(entry => entry.method)).toEqual(["thread/read", "thread/goal/get"]);
    expect(rpc.calls.at(-1)?.params).toEqual({ threadId: "thread-1" });
    expect(rpc.closed).toBe(1);
    const absent = new FixtureRpc({
      "thread/read": { thread: active },
      "thread/goal/get": { goal: null },
    });
    const noGoal = await legacySnapshotFixtureSource(
      async () => absent, { includeNativeGoal: true }).currentTurn("thread-1");
    expect(noGoal?.nativeGoal).toBeUndefined();
    expect(noGoal?.nativeGoalState).toBe("absent");
    const wrong = new FixtureRpc({
      "thread/read": { thread: active },
      "thread/goal/get": { goal: { ...goal, threadId: "foreign" } },
    });
    await expect(legacySnapshotFixtureSource(
      async () => wrong, { includeNativeGoal: true }).currentTurn("thread-1"))
      .rejects.toThrow("ownership");
    expect(wrong.closed).toBe(1);
  });

  test("an absent optional Native Goal API is explicitly unavailable without breaking active-turn authority", async () => {
    for (const unavailable of ["goals feature is disabled", "Method not found"]) {
      const methods: string[] = [];
      let closed = 0;
      const rpc: CodexAppServerRpc = {
        async request(method) {
          methods.push(method);
          if (method === "thread/read") {
            return { thread: activeThread({ turns: [{ id: "turn-1", status: "inProgress", items: [] }] }) };
          }
          if (method === "thread/goal/get") throw Error(unavailable);
          throw Error("Unexpected method");
        },
        async close() { closed++; },
      };
      const current = await legacySnapshotFixtureSource(
        async () => rpc, { includeNativeGoal: true }).currentTurn("thread-1");
      expect(current?.turnId).toBe("turn-1");
      expect(current?.nativeGoal).toBeUndefined();
      expect(current?.nativeGoalState).toBe("unavailable");
      expect(methods).toEqual(["thread/read", "thread/goal/get"]);
      expect(closed).toBe(1);
    }
  });

  test("unknown goal errors, malformed and foreign goal ownership never get downgraded to feature absence", async () => {
    for (const failure of ["Access denied", "Native app-server WebSocket closed"]) {
      const rpc: CodexAppServerRpc = {
        async request(method) {
          if (method === "thread/read") {
            return { thread: activeThread({ turns: [{ id: "turn-1", status: "inProgress", items: [] }] }) };
          }
          throw Error(failure);
        },
        async close() {},
      };
      await expect(legacySnapshotFixtureSource(async () => rpc, { includeNativeGoal: true })
        .currentTurn("thread-1")).rejects.toThrow(failure);
    }
    const invalid = new FixtureRpc({
      "thread/read": { thread: activeThread({ turns: [{ id: "turn-1", status: "inProgress", items: [] }] }) },
      "thread/goal/get": { unrelated: "no goal" },
    });
    await expect(legacySnapshotFixtureSource(async () => invalid, { includeNativeGoal: true })
      .currentTurn("thread-1")).rejects.toThrow("malformed");
  });

  test("goal read mode does not query goal for an inactive or ambiguous Native turn", async () => {
    const rpc = new FixtureRpc({
      "thread/read": { thread: activeThread({ status: { type: "idle" },
        turns: [{ id: "completed", status: "completed", items: [] }] }) },
    });
    expect(await legacySnapshotFixtureSource(
      async () => rpc, { includeNativeGoal: true }).currentTurn("thread-1")).toBeUndefined();
    expect(rpc.calls.map(entry => entry.method)).toEqual(["thread/read"]);
  });
  test("binds one active newest turn using only public app-server thread/environment state", async () => {
    const rpc = new FixtureRpc({
      "thread/read": {
        thread: activeThread({
          turns: [
            { id: "turn-old", status: "completed", items: [] },
            { id: "turn-current", status: "inProgress", items: [] },
          ],
          parentThreadId: "parent-1",
          source: {
            subAgent: {
              thread_spawn: {
                parent_thread_id: "parent-1",
                agent_path: "agent/worker",
              },
            },
          },
        }),
      },
    });
    const source = legacySnapshotFixtureSource(async () => rpc);

    expect(await source.currentTurn("thread-1")).toEqual({
      threadId: "thread-1",
      turnId: "turn-current",
      parentThreadId: "parent-1",
      agentName: "agent/worker",
      cwd: resolve("/workspace/project"),
      workspaceRoots: [resolve("/workspace")],
      sandbox: { kind: "native-enforced" },
      proof: "app-server-active-turn",
      environmentSourceTurnId: "turn-current",
    });
    expect(rpc.calls).toEqual([
      {
        method: "thread/read",
        params: { threadId: "thread-1", includeTurns: true },
      },
    ]);
    expect(rpc.closed).toBe(1);
  });

  test("rejects missing or ambiguous turns without consulting an unsupported listing API", async () => {
    for (const entries of [undefined, [null], [
      { id: "turn-a", status: "inProgress", items: [] },
      { id: "turn-a", status: "inProgress", items: [] },
    ]]) {
      const rpc = new FixtureRpc({ "thread/read": { thread: activeThread({ turns: entries }) } });
      await expect(legacySnapshotFixtureSource(async () => rpc).currentTurn("thread-1"))
        .rejects.toThrow();
      expect(rpc.calls.map(call => call.method)).toEqual(["thread/read"]);
      expect(rpc.closed).toBe(1);
    }
  });

  test("binds the newest active turn when interrupted history retains inProgress", async () => {
    const rpc = new FixtureRpc({ "thread/read": { thread: activeThread({ turns: [
      { id: "interrupted", status: "inProgress", items: [] },
      { id: "later-completed", status: "completed", items: [] },
      { id: "current", status: "inProgress", items: [] },
    ] }) } });
    const evidence = await legacySnapshotFixtureSource(async () => rpc).currentTurn("thread-1");
    expect(evidence?.turnId).toBe("current");
    expect(evidence?.environmentSourceTurnId).toBe("current");
    expect(rpc.closed).toBe(1);
  });

  test("falls back conservatively to the public thread cwd when environments are unavailable", async () => {
    const rpc = new FixtureRpc({
      "thread/read": { thread: activeThread({ environments: null, cwd: resolve("/plain"), turns: [{ id: "turn-1", status: "inProgress", items: [] }] }) },
    });
    const source = legacySnapshotFixtureSource(async () => rpc);

    const evidence = await source.currentTurn("thread-1");
    expect(evidence?.cwd).toBe(resolve("/plain"));
    expect(evidence?.workspaceRoots).toEqual([resolve("/plain")]);
    expect(evidence?.sandbox).toEqual({ kind: "native-enforced" });
  });

  test("does not create current-turn authority for an inactive stored thread", async () => {
    const rpc = new FixtureRpc({
      "thread/read": { thread: activeThread({ status: { type: "idle" } }) },
    });
    const source = legacySnapshotFixtureSource(async () => rpc);

    expect(await source.currentTurn("thread-1")).toBeUndefined();
    expect(rpc.calls.map(call => call.method)).toEqual(["thread/read"]);
    expect(rpc.closed).toBe(1);
  });

  test("fails closed when current-turn ordering or lineage is ambiguous", async () => {
    const staleNewest = new FixtureRpc({
      "thread/read": { thread: activeThread({ turns: [
        { id: "turn-running", status: "inProgress", items: [] },
        { id: "turn-completed", status: "completed", items: [] },
      ] }) },
    });
    await expect(legacySnapshotFixtureSource(async () => staleNewest).currentTurn("thread-1"))
      .rejects.toThrow("not the newest turn");

    const conflictingOwner = new FixtureRpc({
      "thread/read": {
        thread: activeThread({
          turns: [{ id: "turn-1", status: "inProgress", items: [] }],
          parentThreadId: "parent-a",
          source: {
            subAgent: {
              thread_spawn: {
                parent_thread_id: "parent-b",
                agent_path: "agent/worker",
              },
            },
          },
        }),
      },
    });
    await expect(legacySnapshotFixtureSource(async () => conflictingOwner).currentTurn("thread-1"))
      .rejects.toThrow("lineage is internally inconsistent");
  });
});

describe("Codex app-server lifecycle interruption", () => {
  test("paginated lifecycle interruption proves the newest turn without a full Native history read", async () => {
    const calls: Array<{ method: string; params?: any }> = [];
    let closed = 0;
    const thread = activeThread({
      id: "thread-paged", historyMode: "paginated", turns: undefined,
    });
    const rpc: CodexAppServerRpc = {
      async request(method, params) {
        calls.push({ method, params });
        if (method === "thread/loaded/list") {
          return { data: ["thread-paged"], nextCursor: null };
        }
        if (method === "thread/read") {
          if ((params as any).includeTurns !== false) {
            throw Error("73 MB of Native history must not be downloaded");
          }
          return { thread };
        }
        if (method === "thread/turns/list") {
          return { data: [
            { id: "turn-paged", status: "inProgress", itemsView: "notLoaded", items: [] },
            { id: "turn-prior", status: "completed", itemsView: "notLoaded", items: [] },
          ], nextCursor: "older" };
        }
        if (method === "turn/interrupt") return {};
        throw Error(`Unexpected public method: ${method}`);
      },
      async close() { closed += 1; },
    };
    expect(await interruptLoadedAppServerTurns("ws://127.0.0.1:1", {
      connect: async () => rpc,
    })).toBe(1);
    expect(calls.filter(call => call.method === "turn/interrupt")).toEqual([{
      method: "turn/interrupt", params: { threadId: "thread-paged", turnId: "turn-paged" },
    }]);
    expect(calls.filter(call => call.method === "thread/read")
      .every(call => call.params.includeTurns === false)).toBe(true);
    expect(calls.filter(call => call.method === "thread/turns/list")
      .map(call => call.params)).toEqual([{
        threadId: "thread-paged", limit: 2, sortDirection: "desc", itemsView: "notLoaded",
      }]);
    expect(closed).toBe(1);
  });

  test("malformed paginated owner evidence blocks the entire interruption batch without legacy fallback", async () => {
    const calls: Array<{ method: string; params?: any }> = [];
    const rpc: CodexAppServerRpc = {
      async request(method, params) {
        calls.push({ method, params });
        if (method === "thread/loaded/list") {
          return { data: ["thread-legacy", "thread-paged"], nextCursor: null };
        }
        if (method === "thread/read") {
          const threadId = (params as any).threadId;
          if (threadId === "thread-legacy") return { thread: activeThread({
            id: threadId, historyMode: "legacy", status: { type: "idle" },
            turns: [{ id: "legacy-active", status: "inProgress", items: [] }],
          }) };
          if ((params as any).includeTurns !== false) throw Error("Unbounded paginated history");
          return { thread: activeThread({ id: threadId, historyMode: "paginated", turns: undefined }) };
        }
        if (method === "thread/turns/list") return { data: [
          { id: "changed", status: "inProgress", itemsView: "notLoaded", items: ["unexpected"] },
        ] };
        if (method === "turn/interrupt") throw Error("Must not interrupt a partially proven batch");
        throw Error("Unexpected method");
      },
      async close() {},
    };
    await expect(interruptLoadedAppServerTurns("ws://127.0.0.1:1", {
      connect: async () => rpc,
    })).rejects.toThrow("identity is invalid");
    expect(calls.filter(call => call.method === "turn/interrupt")).toEqual([]);
    expect(calls.filter(call => call.method === "thread/read"
      && call.params.threadId === "thread-paged")
      .every(call => call.params.includeTurns === false)).toBe(true);
  });

  test("unknown history mode never triggers a legacy whole-thread lifecycle read", async () => {
    const calls: Array<{ method: string; params?: any }> = [];
    const rpc: CodexAppServerRpc = {
      async request(method, params) {
        calls.push({ method, params });
        if (method === "thread/loaded/list") return { data: ["thread-future"], nextCursor: null };
        if (method === "thread/read") {
          if ((params as any).includeTurns !== false) throw Error("Unexpected full history");
          return { thread: activeThread({ id: "thread-future", historyMode: "new-format" }) };
        }
        throw Error("Unexpected lifecycle action");
      },
      async close() {},
    };
    await expect(interruptLoadedAppServerTurns("ws://127.0.0.1:1", {
      connect: async () => rpc,
    })).rejects.toThrow("cannot safely prove an unindexed active turn");
    expect(calls.map(call => call.method)).toEqual(["thread/loaded/list", "thread/read"]);
  });

  test("active Legacy and mode-unknown lifecycle scans refuse hidden whole-history replay and all interrupts", async () => {
    for (const historyMode of ["legacy", undefined, "new-storage-mode"]) {
      const calls: Array<{ method: string; params?: unknown }> = [];
      let closed = 0;
      const rpc: CodexAppServerRpc = {
        async request(method, params) {
          calls.push({ method, params });
          if (method === "thread/loaded/list") return { data: ["private-active"], nextCursor: null };
          if (method === "thread/read") {
            if ((params as { includeTurns?: boolean }).includeTurns !== false) {
              throw Error("unbounded Native history must not be requested");
            }
            return { thread: activeThread({
              id: "private-active", historyMode, turns: undefined,
            }) };
          }
          throw Error("no turn paging, model call or interruption permitted");
        },
        async close() { closed++; },
      };
      await expect(interruptLoadedAppServerTurns("ws://127.0.0.1:1", {
        connect: async () => rpc,
      })).rejects.toThrow("cannot safely prove an unindexed active turn");
      expect(calls.map(call => call.method)).toEqual(["thread/loaded/list", "thread/read"]);
      expect(closed).toBe(1);
    }
  });

  test("interrupts only exact newest in-progress turns from loaded active threads", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    let closed = 0;
    const threads: Record<string, unknown> = {
      "thread-a": activeThread({ id: "thread-a", historyMode: "paginated", turns: [
        { id: "turn-old", status: "completed", items: [] },
        { id: "turn-a", status: "inProgress", items: [] },
      ] }),
      "thread-b": activeThread({ id: "thread-b", historyMode: "legacy", status: { type: "idle" }, turns: [
        { id: "turn-b", status: "inProgress", items: [] },
      ] }),
      "thread-c": activeThread({ id: "thread-c", historyMode: "paginated", turns: [
        { id: "turn-c", status: "completed", items: [] },
      ] }),
    };
    const rpc: CodexAppServerRpc = {
      async request(method, params) {
        calls.push({ method, ...(params !== undefined ? { params } : {}) });
        if (method === "thread/loaded/list") return { data: Object.keys(threads), nextCursor: null };
        if (method === "thread/read") {
          const query = params as { threadId: string; includeTurns?: boolean };
          if (query.includeTurns !== false) throw Error("full Native history must not be read");
          const threadId = query.threadId;
          return { thread: threads[threadId] };
        }
        if (method === "thread/turns/list") {
          const threadId = (params as { threadId: string }).threadId;
          return { data: [
            { id: threadId === "thread-a" ? "turn-a" : "turn-c",
              status: threadId === "thread-a" ? "inProgress" : "completed",
              itemsView: "notLoaded", items: [] },
          ], nextCursor: null };
        }
        if (method === "turn/interrupt") return {};
        throw new Error(`unexpected RPC method: ${method}`);
      },
      async close() { closed += 1; },
    };

    expect(await interruptLoadedAppServerTurns("ws://127.0.0.1:1", {
      connect: async () => rpc,
    })).toBe(1);
    expect(calls.filter(call => call.method === "turn/interrupt")).toEqual([{
      method: "turn/interrupt",
      params: { threadId: "thread-a", turnId: "turn-a" },
    }]);
    expect(closed).toBe(1);
  });

  test("fails before interruption when the indexed newest-turn identities are duplicated", async () => {
    const calls: string[] = [];
    const rpc: CodexAppServerRpc = {
      async request(method) {
        calls.push(method);
        if (method === "thread/loaded/list") return { data: ["thread-a"], nextCursor: null };
        if (method === "thread/read") return { thread: activeThread({
          id: "thread-a", historyMode: "paginated", turns: undefined,
        }) };
        if (method === "thread/turns/list") return { data: [
          { id: "same", status: "inProgress", itemsView: "notLoaded", items: [] },
          { id: "same", status: "completed", itemsView: "notLoaded", items: [] },
        ], nextCursor: null };
        if (method === "turn/interrupt") return {};
        throw new Error(`unexpected RPC method: ${method}`);
      },
      async close() {},
    };
    await expect(interruptLoadedAppServerTurns("ws://127.0.0.1:1", {
      connect: async () => rpc,
    })).rejects.toThrow("identity is invalid");
    expect(calls).not.toContain("turn/interrupt");
  });
});

class FixtureWebSocket extends EventTarget {
  readyState = 0;
  readonly sent: unknown[] = [];
  closed: { code?: number; reason?: string } | undefined;

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  send(data: string): void {
    const message = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(message);
    if (message.method === "initialize" && typeof message.id === "number") {
      queueMicrotask(() => {
        this.dispatchEvent(new MessageEvent("message", {
          data: JSON.stringify({ id: message.id, result: { userAgent: "fixture" } }),
        }));
      });
    }
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closed = {
      ...(code !== undefined ? { code } : {}),
      ...(reason !== undefined ? { reason } : {}),
    };
    this.dispatchEvent(new Event("close"));
  }
}

describe("Codex app-server WebSocket transport", () => {
  test("performs the official initialize/initialized handshake on a loopback endpoint", async () => {
    const socket = new FixtureWebSocket();
    const connecting = connectCodexAppServerWebSocket("ws://127.0.0.1:19001", {
      createWebSocket(url) {
        expect(url).toBe("ws://127.0.0.1:19001/");
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const rpc = await connecting;

    expect(socket.sent).toEqual([
      {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "chatgpt-tela",
            title: "ChatGPT Tela",
            version: "0.0.0",
          },
          capabilities: { experimentalApi: true },
        },
      },
      { method: "initialized" },
    ]);
    await rpc.close();
    expect(socket.closed?.code).toBe(1000);
  });

  test("refuses non-loopback or secure-remote endpoints before creating a socket", async () => {
    let created = 0;
    const createWebSocket = () => {
      created += 1;
      return new FixtureWebSocket();
    };
    await expect(connectCodexAppServerWebSocket("wss://example.com/rpc", { createWebSocket }))
      .rejects.toThrow("must use ws://");
    await expect(connectCodexAppServerWebSocket("ws://192.0.2.1:19001", { createWebSocket }))
      .rejects.toThrow("loopback-only");
    expect(created).toBe(0);
  });
});

test("normal shutdown scans idle thread status without downloading history", async () => {
  const reads: unknown[] = [];
  const rpc: CodexAppServerRpc = {
    async request(method, params) {
      if (method === "thread/loaded/list") return { data: ["idle-thread"], nextCursor: null };
      if (method === "thread/read") {
        reads.push(params);
        if ((params as { includeTurns?: boolean }).includeTurns) throw new Error("history response would close socket");
        return { thread: { id: "idle-thread", status: { type: "idle" } } };
      }
      throw new Error("No interruption expected");
    },
    async close() {},
  };
  expect(await interruptLoadedAppServerTurns("ws://127.0.0.1:1", { connect: async () => rpc })).toBe(0);
  expect(reads).toEqual([{ threadId: "idle-thread", includeTurns: false }]);
});

describe("Native turn termination observation", () => {
  test("engine-acknowledged live Legacy observation never calls thread/resume and cancels on original owner loss", async () => {
    const live = new NativeLiveTurnRegistry();
    const owner = {};
    live.accept("thread-legacy", "live-current", owner);
    const calls: string[] = [];
    let unsubscriptions = 0;
    let closes = 0;
    const rpc: CodexAppServerRpc = {
      async request(method, params) {
        calls.push(method);
        if (method !== "thread/read"
          || (params as { includeTurns?: boolean }).includeTurns !== false) {
          throw Error("No Legacy history hydration, attach, model or tool action");
        }
        return { thread: activeThread({ id: "thread-legacy",
          historyMode: "legacy", turns: undefined }) };
      },
      subscribe() { return () => { unsubscriptions++; }; },
      async close() { closes++; },
    };
    const watcher = await new AppServerCurrentTurnSource(async () => rpc, {
      liveTurnProof: live,
    }).watchTurn("thread-legacy", "live-current");
    expect(watcher.signal.aborted).toBe(false);
    expect(calls).toEqual(Array(4).fill("thread/read"));
    live.retireOwner(owner);
    expect(watcher.signal.aborted).toBe(true);
    await watcher.close();
    expect(unsubscriptions).toBe(1);
    expect(closes).toBe(1);
  });
  test("a default-constructed watcher rejects a Legacy active turn before thread/resume", async () => {
    const methods: string[] = [];
    let closed = 0;
    let unsubscribed = 0;
    const rpc: CodexAppServerRpc = {
      async request(method, params) {
        methods.push(method);
        if (method !== "thread/read"
          || (params as { includeTurns?: boolean }).includeTurns !== false) {
          throw Error("No hidden Legacy history replay or thread/resume allowed");
        }
        return { thread: activeThread({ id: "thread-legacy",
          historyMode: "legacy", turns: undefined }) };
      },
      subscribe() { return () => { unsubscribed++; }; },
      async close() { closed++; },
    };
    await expect(new AppServerCurrentTurnSource(async () => rpc)
      .watchTurn("thread-legacy", "active-turn"))
      .rejects.toMatchObject({ code: "native_history_bootstrap_required",
        recoveryReason: "unindexed_history" });
    expect(methods).toEqual(["thread/read"]);
    expect(unsubscribed).toBe(1);
    expect(closed).toBe(1);
  });

  test("an already cancelled watcher never connects to Native or creates a live lease", async () => {
    const cancelled = new AbortController();
    cancelled.abort(new DOMException("fixture cancelled", "AbortError"));
    let connections = 0;
    const source = new AppServerCurrentTurnSource(async () => {
      connections++;
      throw Error("Cancellation must be checked before Native connect");
    }, { preferBoundedTurnProof: true });
    await expect(source.watchTurn("thread-paged", "turn-exact", cancelled.signal))
      .rejects.toHaveProperty("name", "AbortError");
    expect(connections).toBe(0);
  });

  test("indexed observation proves ownership before resume and again after attach", async () => {
    const calls: string[] = [];
    let closed = 0;
    let unsubscribed = 0;
    const thread = activeThread({
      id: "thread-paged", historyMode: "paginated", turns: undefined,
    });
    const rpc: CodexAppServerRpc = {
      async request(method, params) {
        calls.push(method);
        if (method === "thread/read") {
          expect((params as { includeTurns?: boolean }).includeTurns).toBe(false);
          return { thread };
        }
        if (method === "thread/turns/list") return { data: [
          { id: "turn-exact", status: "inProgress", itemsView: "notLoaded", items: [] },
        ], nextCursor: null };
        if (method === "thread/resume") {
          expect(params).toEqual({ threadId: "thread-paged", excludeTurns: true });
          return {};
        }
        throw new Error("No history hydration, model or tool request permitted");
      },
      subscribe() { return () => { unsubscribed++; }; },
      async close() { closed++; },
    };
    const watcher = await new AppServerCurrentTurnSource(async () => rpc, {
      preferBoundedTurnProof: true,
    }).watchTurn("thread-paged", "turn-exact");
    expect(watcher.signal.aborted).toBe(false);
    expect(calls).toEqual([
      "thread/read", "thread/turns/list", "thread/read",
      "thread/resume",
      "thread/read", "thread/turns/list", "thread/read",
    ]);
    await watcher.close();
    expect(unsubscribed).toBe(1);
    expect(closed).toBe(1);
  });

  test("Legacy or unknown history mode cannot cause even an excludeTurns resume", async () => {
    for (const historyMode of ["legacy", undefined, "future"]) {
      const calls: string[] = [];
      let closed = 0;
      let unsubscribed = 0;
      const rpc: CodexAppServerRpc = {
        async request(method, params) {
          calls.push(method);
          if (method === "thread/read") {
            expect((params as { includeTurns?: boolean }).includeTurns).toBe(false);
            return { thread: activeThread({
              id: "thread-unindexed", historyMode, turns: undefined,
            }) };
          }
          throw Error("Do not load Native Legacy rollout or attach a watcher");
        },
        subscribe() { return () => { unsubscribed++; }; },
        async close() { closed++; },
      };
      await expect(new AppServerCurrentTurnSource(async () => rpc, {
        preferBoundedTurnProof: true,
      }).watchTurn("thread-unindexed", "turn-exact")).rejects.toMatchObject({
        code: "native_history_bootstrap_required",
        recoveryReason: "unindexed_history",
      });
      expect(calls).toEqual(["thread/read"]);
      expect(unsubscribed).toBe(1);
      expect(closed).toBe(1);
    }
  });

  test("a storage-mode change during watcher attachment prevents the second indexed page", async () => {
    const calls: string[] = [];
    let resumed = false;
    let closed = 0;
    const rpc: CodexAppServerRpc = {
      async request(method) {
        calls.push(method);
        if (method === "thread/read") return { thread: activeThread({
          id: "thread-paged",
          historyMode: resumed ? "legacy" : "paginated", turns: undefined,
        }) };
        if (method === "thread/turns/list") return { data: [
          { id: "turn-exact", status: "inProgress", itemsView: "notLoaded", items: [] },
        ], nextCursor: null };
        if (method === "thread/resume") { resumed = true; return {}; }
        throw Error("No other app-server action may execute");
      },
      subscribe() { return () => {}; },
      async close() { closed++; },
    };
    await expect(new AppServerCurrentTurnSource(async () => rpc, {
      preferBoundedTurnProof: true,
    }).watchTurn("thread-paged", "turn-exact")).rejects.toMatchObject({
      code: "native_history_bootstrap_required",
      recoveryReason: "unindexed_history",
    });
    expect(calls).toEqual([
      "thread/read", "thread/turns/list", "thread/read",
      "thread/resume", "thread/read",
    ]);
    expect(closed).toBe(1);
  });

  function fixture() {
    const rpc = new FixtureRpc({ "thread/resume": {}, "thread/read": { thread: activeThread({ turns: [{ id: "turn-1", status: "inProgress" }] }) } });
    let notify!: (method: string, params: unknown) => void;
    let disconnect!: () => void;
    let removed = 0;
    const observed = Object.assign(rpc, { subscribe(n: typeof notify, d: typeof disconnect) {
      notify = n; disconnect = d; return () => { removed++; };
    } });
    return { rpc, source: legacySnapshotFixtureSource(async () => observed),
      emit: (threadId: string, id: string, status: string, error?: unknown) => notify("turn/completed", {threadId, turn: { id, status, error }}),
      input: (threadId: string, turnId: string, item: unknown) => notify("item/completed", { threadId, turnId, item }),
      disconnect: () => disconnect(), removed: () => removed };
  }
  test("only exact Native terminal events revoke the watcher including successful completion", async () => {
    const f = fixture(); const watch = await f.source.watchTurn("thread-1", "turn-1");
    f.emit("thread-other", "turn-1", "interrupted");
    f.emit("thread-1", "turn-other", "interrupted");
    expect(watch.signal.aborted).toBe(false);
    f.emit("thread-1", "turn-1", "completed");
    expect(watch.signal.aborted).toBe(true);
    f.emit("thread-1", "turn-1", "interrupted");
    expect(watch.signal.aborted).toBe(true);
    await watch.close(); expect(f.removed()).toBe(1); expect(f.rpc.closed).toBe(1);
    expect(f.rpc.calls[0]).toEqual({method:"thread/resume",params:{threadId:"thread-1",excludeTurns:true}});
  });
  test("a Native observation disconnect invalidates authority and closes without persistent observation", async () => {
    const f = fixture(); const watch = await f.source.watchTurn("thread-1", "turn-1");
    f.disconnect(); expect(watch.signal.aborted).toBe(true); await watch.close();
    expect(f.removed()).toBe(1);
  });
  test("only exact Native user-message events grant bounded input witnesses", async () => {
    const f = fixture(), watch = await f.source.watchTurn("thread-1", "turn-1");
    const item = { type: "userMessage", id: "new-input", content: [{ type: "text", text: "synthetic steering" }] };
    f.input("foreign", "turn-1", item); f.input("thread-1", "foreign", item);
    expect(watch.inputs()).toEqual([]);
    f.input("thread-1", "turn-1", item); f.input("thread-1", "turn-1", item);
    expect(watch.inputs()).toHaveLength(1);
    f.input("thread-1", "turn-1", { ...item, content: [{ type: "text", text: "changed" }] });
    expect(watch.signal.aborted).toBe(true);
    await watch.close();
  });
  test("termination during snapshot setup is not missed", async () => {
    const f = fixture(); const read = f.rpc.request.bind(f.rpc);
    f.rpc.request = async (method, params) => { f.emit("thread-1", "turn-1", "interrupted"); return read(method, params); };
    const watch = await f.source.watchTurn("thread-1", "turn-1");
    expect(watch.signal.aborted).toBe(true); await watch.close();
  });
  test("a stale snapshot rejects the previous turn's continued execution", async () => {
    const f = fixture(); f.rpc.request = async () => ({ thread: activeThread({turns:[{id:"new-turn",status:"inProgress"}]}) });
    const watch = await f.source.watchTurn("thread-1", "turn-1");
    expect(watch.signal.aborted).toBe(true); await watch.close();
  });
  test("termination records the first exact cause with captured request identity; normal close is silent", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "tela-watch-evidence-"));
    const file = resolve(directory, "events.jsonl");
    const previous = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = file;
    try {
      const f = fixture();
      const watch = await withDiagnosticContext({ request_fingerprint: diagnosticFingerprint("fixture_request") },
        () => f.source.watchTurn("thread-1", "turn-1"));
      f.emit("thread-other", "turn-1", "failed");
      f.emit("thread-1", "turn-1", "interrupted");
      f.emit("thread-1", "turn-1", "failed"); f.disconnect();
      await watch.close(); f.disconnect();
      const g = fixture(); const observer = await g.source.watchTurn("thread-1", "turn-1");
      g.disconnect(); await observer.close();
      setPrivateDiagnosticCapture(resolve(directory, "diagnostics"), 1);
      const failed = fixture();
      const failureWatch = await withDiagnosticContext({ request_fingerprint: diagnosticFingerprint("failed_fixture") },
        () => failed.source.watchTurn("thread-1", "turn-1"));
      failed.emit("thread-1", "turn-1", "failed", { message: "fixture-only-failure Bearer synthetic-secret" });
      await failureWatch.close();
      const h = fixture(); const normal = await h.source.watchTurn("thread-1", "turn-1");
      await normal.close(); h.disconnect();
      const events = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line))
        .filter(event => event.stage === "native_watch_terminated");
      expect(events.map(event => event.reason_class)).toEqual(["native_interrupted", "observer_disconnected", "native_failed"]);
      expect(events[0].request_fingerprint).toBe(diagnosticFingerprint("fixture_request"));
      expect(events[0].scope_fingerprint).toBe(diagnosticFingerprint("thread-1"));
      expect(events[0].turn_fingerprint).toBe(diagnosticFingerprint("turn-1"));
      expect(JSON.stringify(events)).not.toContain("thread-1");
      expect(readFileSync(file, "utf8")).not.toContain("fixture-only-failure");
      const privateRoot = resolve(directory, "diagnostics/private");
      const captures = readdirSync(privateRoot).filter(name => name.endsWith(".json"))
        .map(name => JSON.parse(readFileSync(resolve(privateRoot, name), "utf8")));
      const capturedFailure = captures.find(capture => capture.phase === "native_turn_failure");
      expect(capturedFailure.value.error.message).toBe("fixture-only-failure Bearer [REDACTED]");
      await Bun.sleep(0);
    } finally {
      if (previous === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
      else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
