import { describe, expect, test } from "bun:test";
import type { CodexAppServerRpc } from "@chatgpt-tela/codex";
import type { LocalProfileBinding } from "./cross-profile-thread-relay";
import { LocalOriginalThreadRelay } from "./cross-profile-thread-relay";
import { createReadOnlyOriginalNativeThreadOwner } from "./cross-profile-native-reader";
import type { TrustedNativeProfileSession } from "./cross-profile-account-proof";

const T = "12345678-1234-4123-8123-123456789abc";
const P = "87654321-1234-4123-8123-abcdefabcdef";
const newest = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const older = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const fp = (char: string) => char.repeat(64);
const sourceBinding: LocalProfileBinding = {
  slot: 1, accountFingerprint: fp("a"), sessionFingerprint: fp("b"), routeFingerprint: fp("c"),
};
const destinationBinding: LocalProfileBinding = {
  slot: 2, accountFingerprint: fp("d"), sessionFingerprint: fp("e"), routeFingerprint: fp("f"),
};
function fixture() {
  let account = sourceBinding;
  let session: TrustedNativeProfileSession = {
    slot: 1, runtimeProcessId: 221, terminalEndpoint: "ws://127.0.0.1:9911",
    responsesRouteFingerprint: sourceBinding.routeFingerprint,
  };
  let historyMode: "legacy" | "paginated" = "paginated";
  let status: "idle" | "active" | "notLoaded" = "idle";
  let timestamp = 1_791_901_000;
  let changedDuringSummary = false;
  let malformedHead = false;
  let foreignHead = false;
  let oversized = false;
  let badItemsView = false;
  let accountChangedDuringSummary = false;
  let sessionChangedDuringSummary = false;
  let activeDuringSummary = false;
  let loginChangedAfterRead = false;
  let closes = 0, connects = 0;
  const calls: { method: string; params: unknown }[] = [];
  const owner = createReadOnlyOriginalNativeThreadOwner({
    sourceSlot: 1, fingerprintKey: Buffer.alloc(32, 9),
    async profile(slot) {
      if (slot !== 1) throw Error("not the source owner");
      return account;
    },
    async resolveOwnedSession(slot) {
      if (slot !== 1) throw Error("not the source session");
      return session;
    },
    async connect(endpoint) {
      if (endpoint !== session.terminalEndpoint) throw Error("wrong Native account endpoint");
      connects++;
      return {
        async request(method, params) {
          calls.push({ method, params });
          if ((params as { threadId?: string })?.threadId !== T) {
            throw Error("unselected private Native thread");
          }
          if (method === "thread/read") {
            return { thread: {
              id: T, historyMode, cwd: "/synthetic-owned-project",
              updatedAt: timestamp, status: { type: status },
              // These values are never disclosed by the preview.
              name: "UNRELATED_PRIVATE_THREAD_TITLE",
              path: "/synthetic-private-rollout-path.jsonl",
            } };
          }
          if (method === "thread/turns/list") {
            const request = params as { itemsView?: string; limit?: number; sortDirection?: string };
            if (request.sortDirection !== "desc" || (request.itemsView !== "summary" && request.itemsView !== "notLoaded")) {
              throw Error("unbounded original Native API invocation");
            }
            if (historyMode !== "paginated") throw Error("must not list opaque Legacy history");
            if (request.itemsView === "notLoaded") {
              return { data: [{
                id: foreignHead ? P : newest, status: "completed",
                itemsView: "notLoaded", items: malformedHead ? ["unexpected"] : [],
              }], nextCursor: "synthetic_cursor" };
            }
            if (changedDuringSummary) timestamp++;
            if (accountChangedDuringSummary) account = { ...account, accountFingerprint: fp("d") };
            if (sessionChangedDuringSummary) session = { ...session, runtimeProcessId: session.runtimeProcessId + 1 };
            if (activeDuringSummary) status = "active";
            return {
              data: [{
                id: newest, status: "completed", itemsView: badItemsView ? "full" : "summary",
                items: [
                  { id: "a", type: "userMessage", content: [{ type: "text", text: "continue the chosen original task" }] },
                  { id: "b", type: "agentMessage", text: oversized ? "long".repeat(40_000) : "completed task T" },
                  { id: "c", type: "commandExecution", command: "UNRELATED_PRIVATE_TOOL_COMMAND",
                    aggregatedOutput: "UNRELATED_PRIVATE_TOOL_OUTPUT" },
                  { id: "d", type: "reasoning", content: ["UNRELATED_PRIVATE_REASONING"] },
                ],
              }, {
                id: older, status: "completed", itemsView: "summary",
                items: [{ id: "z", type: "agentMessage", text: "older task T" }],
              }],
              nextCursor: "synthetic_cursor",
            };
          }
          throw Error("unapproved cross-profile Native method");
        },
        async close() {
          closes++;
          if (loginChangedAfterRead) account = { ...account, accountFingerprint: fp("2") };
        },
      } as Pick<CodexAppServerRpc, "request" | "close">;
    },
  });
  return {
    owner, calls, counts: () => ({ closes, connects }),
    setLegacy: () => { historyMode = "legacy"; },
    setStatus: (value: "idle" | "active" | "notLoaded") => { status = value; },
    setChangeDuringSummary: () => { changedDuringSummary = true; },
    setMalformedHead: () => { malformedHead = true; },
    setForeignHead: () => { foreignHead = true; },
    setOversized: () => { oversized = true; },
    setBadItemsView: () => { badItemsView = true; },
    setAccountChangedDuringSummary: () => { accountChangedDuringSummary = true; },
    setSessionChangedDuringSummary: () => { sessionChangedDuringSummary = true; },
    setActiveDuringSummary: () => { activeDuringSummary = true; },
    setLoginChangedAfterRead: () => { loginChangedAfterRead = true; },
    setSession: (value: TrustedNativeProfileSession) => { session = value; },
    currentSession: () => session,
    setAccount: (value: LocalProfileBinding) => { account = value; },
  };
}

describe("owner-only public indexed Native preview (read-only)", () => {
  test("proves exact selected thread, returns bounded chat summary and omits reasoning, tools and paths", async () => {
    const f = fixture();
    const proof = await f.owner.prove(T);
    const read = await f.owner.read(T, 128 * 1024);
    expect(proof).toMatchObject({
      threadId: T, owner: sourceBinding, state: "idle",
    });
    expect(proof.revision).toBe(read.revision);
    expect(proof.workspaceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(read).toMatchObject({ threadId: T, hasMore: true });
    expect(read.turns.map(t => t.turnId)).toEqual([older, newest]);
    const rendered = JSON.stringify(read);
    expect(rendered).toContain("continue the chosen original task");
    expect(rendered).toContain("completed task T");
    expect(rendered).toContain("omitted from preview");
    expect(rendered).not.toContain("UNRELATED_PRIVATE_TOOL");
    expect(rendered).not.toContain("UNRELATED_PRIVATE_REASONING");
    expect(rendered).not.toContain("UNRELATED_PRIVATE_THREAD_TITLE");
    expect(rendered).not.toContain("/synthetic");
    expect(f.calls.every(x =>
      (x.method === "thread/read" && (x.params as { includeTurns?: boolean }).includeTurns === false)
      || (x.method === "thread/turns/list"
        && (x.params as { limit: number }).limit <= 4))).toBe(true);
    expect(f.counts()).toEqual({ connects: 2, closes: 2 });
  });

  test("indexed original-thread owner composes with the existing selected-T relay, without another writer", async () => {
    const f = fixture();
    const relay = new LocalOriginalThreadRelay({
      async profile(slot) {
        if (slot === 1) return sourceBinding;
        if (slot === 2) return destinationBinding;
        throw Error("foreign profile");
      },
      async delegate(caller) {
        if (caller === "from-real-destination-adapter") return destinationBinding;
        throw Error("foreign delegate");
      },
      async approve(input) {
        return input.sourceSlot === 1 && input.destinationSlot === 2
          && input.threadId === T && input.permission === "read";
      },
      async owner(slot) {
        if (slot !== 1) throw Error("unowned writer");
        return f.owner;
      },
    });
    const grant = await relay.grant({
      sourceSlot: 1, destinationSlot: 2, threadId: T, permission: "read",
    });
    const result = await relay.read(grant.capability, "from-real-destination-adapter");
    expect(result.turns.map(t => t.threadId)).toEqual([T, T]);
    expect(f.calls.every(x => (x.params as { threadId?: string }).threadId === T)).toBe(true);
    expect(f.calls.some(x => x.method === "thread/list" || x.method === "turn/start")).toBe(false);
    await expect(relay.read(grant.capability, "foreign-profile")).rejects.toThrow();
    expect((await relay.read(grant.capability, "from-real-destination-adapter")).threadId).toBe(T);
  });

  test("Legacy, active and missing persisted turns never cause an unbounded Native replay", async () => {
    const legacy = fixture();
    legacy.setLegacy();
    await expect(legacy.owner.prove(T)).rejects.toThrow("Legacy");
    expect(legacy.calls.map(x => x.method)).toEqual(["thread/read"]);
    const active = fixture();
    active.setStatus("active");
    await expect(active.owner.read(T, 128 * 1024)).rejects.toThrow("idle");
    expect(active.calls.every(x => (x.params as { itemsView?: string }).itemsView !== "summary")).toBe(true);
    const invalid = fixture();
    invalid.setMalformedHead();
    await expect(invalid.owner.prove(T)).rejects.toThrow("latest turn");
  });

  test("source content and identity drift, foreign turns and oversized API results fail closed", async () => {
    for (const configure of [
      (f: ReturnType<typeof fixture>) => f.setChangeDuringSummary(),
      (f: ReturnType<typeof fixture>) => f.setForeignHead(),
      (f: ReturnType<typeof fixture>) => f.setOversized(),
      (f: ReturnType<typeof fixture>) => f.setBadItemsView(),
      (f: ReturnType<typeof fixture>) => f.setAccountChangedDuringSummary(),
      (f: ReturnType<typeof fixture>) => f.setSessionChangedDuringSummary(),
      (f: ReturnType<typeof fixture>) => f.setActiveDuringSummary(),
    ]) {
      const f = fixture();
      configure(f);
      await expect(f.owner.read(T, 128 * 1024)).rejects.toThrow();
      expect(f.calls.some(x => x.method === "turn/start" || x.method === "thread/list")).toBe(false);
      expect(f.counts()).toMatchObject({ connects: 1, closes: 1 });
    }
  });

  test("bad caller input, unsafe endpoint and replaced runtime cannot read another profile", async () => {
    const f = fixture();
    await expect(f.owner.prove(P)).rejects.toThrow("unselected private");
    await expect(f.owner.read(T, 0)).rejects.toThrow("bounded admission");
    f.setSession({ ...f.currentSession(), terminalEndpoint: "ws://192.0.2.10:9090" });
    await expect(f.owner.prove(T)).rejects.toThrow("unowned endpoint");
    f.setSession({ ...f.currentSession(), terminalEndpoint: "ws://127.0.0.1:9911", runtimeProcessId: 441,
      responsesRouteFingerprint: fp("f") });
    await expect(f.owner.prove(T)).rejects.toThrow("exact profile owner");
  });

  test("the actual Native writer is deliberately unavailable until an atomic original-turn lease exists", async () => {
    const f = fixture();
    await expect(f.owner.continue({
      threadId: T, expectedRevision: fp("a"),
      operationId: "synthetic", message: "do not dispatch",
    })).rejects.toThrow("exclusive writer");
    expect(f.calls).toHaveLength(0);
  });
});
