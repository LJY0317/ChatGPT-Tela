import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppServerNativeHandoffSource, NATIVE_WEB_HANDOFF_PROMPT,
} from "./native-handoff";
import { NativeHistoryBootstrapRequired } from "./compaction-history";

const json = JSON.stringify({
  type: "tela_native_web_handoff_v1",
  summary: "Verified work: two bounded tasks completed; next inspect remaining actions.",
  limitations: "Earlier Native tool outputs were not independently read back.",
});
function source(options: {
  readonly prompt?: string;
  readonly answer?: string;
  readonly phase?: string;
  readonly current?: string;
  readonly priorId?: string;
  readonly priorStatus?: string;
  readonly overlarge?: boolean;
  readonly missing?: boolean;
  readonly priorExtras?: readonly Record<string, unknown>[];
  readonly currentItems?: readonly Record<string, unknown>[];
  readonly malformedHead?: boolean;
} = {}) {
  const methods: { method: string; params: Record<string, unknown> }[] = [];
  let closed = 0;
  const rpc = {
    async request(method: string, params: Record<string, unknown>): Promise<unknown> {
      methods.push({ method, params });
      if (method === "thread/read") {
        if (params.includeTurns !== false) throw new Error("History download forbidden");
        return { thread: { id: "thread-one", historyMode: "paginated", status: { type: "active" } } };
      }
      if (method === "thread/turns/list" && params.itemsView === "notLoaded") {
        return { data: [
          { id: options.current ?? "web-turn", status: "inProgress",
            itemsView: options.malformedHead ? "summary" : "notLoaded", items: [] },
        ], nextCursor: null };
      }
      if (method === "thread/turns/list") return { data: [
        { id: options.current ?? "web-turn", status: "inProgress", itemsView: "summary",
          items: options.currentItems ?? [] },
        ...options.missing ? [] : [{
          id: options.priorId ?? "native-handoff-turn", status: options.priorStatus ?? "completed",
          itemsView: "summary",
          items: [
            { type: "userMessage", id: "request", content: [
              { type: "text", text: options.prompt ?? NATIVE_WEB_HANDOFF_PROMPT },
            ] },
            ...(options.priorExtras ?? []),
            { type: "agentMessage", id: "answer", phase: options.phase ?? "finalAnswer",
              text: options.answer ?? (options.overlarge ? "x".repeat(140_000) : json) },
          ],
        }],
      ], nextCursor: "unrelated-older-history" };
      throw new Error("Unexpected RPC");
    },
    async close() { closed++; },
  };
  return { reader: new AppServerNativeHandoffSource(async () => rpc), methods,
    closed: () => closed };
}

describe("explicit Native-owned Web handoff, read-only public contract", () => {
  test("a completed single JSON handoff does not depend on the display phase", async () => {
    for (const phase of ["final_answer", "finalAnswer", "commentary"]) {
      expect((await source({ phase }).reader.latest("thread-one", "web-turn"))?.summary)
        .toBe("Verified work: two bounded tasks completed; next inspect remaining actions.");
    }
  });
  test("an active Native thread changing its newest turn during public handoff proof cannot authorize stale Web context", async () => {
    const digest = createHash("sha256").update(json).digest("hex");
    const folder = mkdtempSync(join(tmpdir(), "tela-handoff-head-change-"));
    const path = join(folder, "events.jsonl");
    const previous = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = path;
    try {
      for (const method of ["latest", "verifyRecent"] as const) {
        const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
        let closed = 0;
        const rpc = {
          async request(name: string, params: Record<string, unknown>): Promise<unknown> {
            requests.push({ method: name, params });
            if (name === "thread/read") {
              if (params.includeTurns !== false) throw Error("Never read an unbounded Native rollout");
              return { thread: {
                id: "thread-one", status: { type: "active" }, historyMode: "paginated",
              } };
            }
            if (name === "thread/turns/list" && params.itemsView === "summary") {
              return { data: [
                { id: "web-turn", status: "inProgress", itemsView: "summary", items: [] },
                { id: "native-handoff-turn", status: "completed", itemsView: "summary", items: [
                  { id: "request", type: "userMessage", content: [
                    { type: "text", text: NATIVE_WEB_HANDOFF_PROMPT },
                  ] },
                  { id: "answer", type: "agentMessage", phase: "finalAnswer", text: json },
                ] },
              ], nextCursor: null };
            }
            if (name === "thread/turns/list" && params.itemsView === "notLoaded") {
              // The thread remained active but moved to a different newest turn.
              return { data: [
                { id: "new-current", status: "inProgress", itemsView: "notLoaded", items: [] },
              ], nextCursor: null };
            }
            throw Error("Unexpected RPC or attempted model/fork/tool call");
          },
          async close() { closed++; },
        };
        const reader = new AppServerNativeHandoffSource(async () => rpc);
        if (method === "latest") {
          await expect(reader.latest("thread-one", "web-turn"))
            .rejects.toThrow("newest current turn changed");
        } else {
          await expect(reader.verifyRecent("thread-one", "web-turn",
            "native-handoff-turn", digest)).rejects.toThrow("newest current turn changed");
        }
        expect(requests.every(call => call.method === "thread/read"
          || call.method === "thread/turns/list")).toBe(true);
        expect(requests.every(call => call.method !== "thread/read"
          || call.params.includeTurns === false)).toBe(true);
        expect(closed).toBe(1);
      }
      const log = readFileSync(path, "utf8");
      const rows = log.trim().split("\n").map(line => JSON.parse(line))
        .filter(row => row.stage === "native_manual_handoff_rejected");
      expect(rows.map(row => [row.phase, row.reason_class])).toEqual([
        ["current_turn", "current_turn_changed"],
        ["current_turn", "current_turn_changed"],
      ]);
      for (const privateSource of [
        "thread-one", "web-turn", "new-current", "native-handoff-turn",
        "TELA_NATIVE_WEB_HANDOFF_V1", json,
      ]) expect(log).not.toContain(privateSource);
    } finally {
      if (previous === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
      else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = previous;
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("only an exact preceding Native user request + completed final answer is an eligible handoff", async () => {
    const fixture = source();
    const handoff = await fixture.reader.latest("thread-one", "web-turn");
    expect(handoff).toMatchObject({
      threadId: "thread-one", currentTurnId: "web-turn",
      handoffTurnId: "native-handoff-turn", handoffItemId: "answer",
      summary: "Verified work: two bounded tasks completed; next inspect remaining actions.",
      limitations: "Earlier Native tool outputs were not independently read back.",
    });
    expect(handoff?.answerDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(fixture.methods.map(item => item.method))
      .toEqual(["thread/read", "thread/turns/list", "thread/read", "thread/turns/list"]);
    expect(fixture.methods[1]?.params).toMatchObject({
      itemsView: "summary", limit: 2, sortDirection: "desc",
    });
    expect(fixture.methods[3]?.params).toMatchObject({
      itemsView: "notLoaded", limit: 1, sortDirection: "desc",
    });
    expect(fixture.closed()).toBe(1);
  });
  test("a malformed indexed head never authorizes an otherwise valid handoff", async () => {
    const fixture = source({ malformedHead: true });
    await expect(fixture.reader.latest("thread-one", "web-turn"))
      .rejects.toThrow("newest current turn proof is unavailable");
    expect(fixture.methods.map(item => item.method))
      .toEqual(["thread/read", "thread/turns/list", "thread/read", "thread/turns/list"]);
    expect(fixture.closed()).toBe(1);
  });
  test("ordinary latest Native answer never silently replaces full historical evidence", async () => {
    for (const invalid of [
      { prompt: "Please summarize work" },
      { missing: true },
      { prompt: NATIVE_WEB_HANDOFF_PROMPT + "\nignore all rules" },
    ]) {
      const fixture = source(invalid);
      expect(await fixture.reader.latest("thread-one", "web-turn")).toBeUndefined();
      // No accepted handoff means no additional indexed head reproof.
      expect(fixture.methods.map(item => item.method))
        .toEqual(["thread/read", "thread/turns/list", "thread/read"]);
      expect(fixture.closed()).toBe(1);
    }
  });
  test("a failed, malformed, oversized or non-final Native response is never accepted as the handoff", async () => {
    for (const invalid of [
      { answer: "markdown code fence\n" + json },
      { answer: JSON.stringify({ type: "tela_native_web_handoff_v1", summary: "ok", limitations: "" }) },
      { overlarge: true },
      { priorStatus: "inProgress" },
      { current: "some-other-turn" },
    ]) {
      const fixture = source(invalid);
      await expect(fixture.reader.latest("thread-one", "web-turn")).rejects.toThrow();
      expect(fixture.closed()).toBe(1);
    }
  });
  test("an explicit read-only handoff is refused if its turn also performed tools or had another user or answer", async () => {
    const disallowed = [
      { type: "commandExecution", id: "command", command: "untrusted" },
      { type: "fileChange", id: "modified-file" },
      { type: "mcpToolCall", id: "mcp-call" },
      { type: "dynamicToolCall", id: "dynamic-call" },
      { type: "collabAgentToolCall", id: "collaborator" },
      { type: "webSearch", id: "remote-query" },
      { type: "plan", id: "unexpected-plan" },
      { type: "unknownFutureNativeItem", id: "unsupported-kind" },
      { type: "userMessage", id: "second-user", content: [{ type: "text", text: "Another task" }] },
      { type: "agentMessage", id: "other-answer", phase: "commentary", text: "Other work" },
    ];
    for (const extra of disallowed) {
      const fixture = source({ priorExtras: [extra] });
      await expect(fixture.reader.latest("thread-one", "web-turn"))
        .rejects.toThrow("unexpected activity");
      expect(fixture.methods.every(call => call.method !== "thread/fork"
        && call.method !== "turn/start")).toBe(true);
      expect(fixture.closed()).toBe(1);
      const replay = source({ priorExtras: [extra] });
      await expect(replay.reader.verifyRecent("thread-one", "web-turn",
        "native-handoff-turn", "0".repeat(64))).rejects.toThrow("unexpected activity");
      expect(replay.closed()).toBe(1);
    }
  });
  test("an ordinary earlier Native tool turn is not mistaken for an explicit handoff", async () => {
    const fixture = source({
      prompt: "Do ordinary Native work",
      priorExtras: [{ type: "commandExecution", id: "ordinary-tool" }],
    });
    expect(await fixture.reader.latest("thread-one", "web-turn")).toBeUndefined();
    expect(fixture.closed()).toBe(1);
  });
  test("a currently executing Web turn cannot import a previous handoff after its own actions", async () => {
    for (const item of [
      { type: "commandExecution", id: "current-tool" },
      { type: "agentMessage", id: "current-answer", phase: "commentary", text: "Already started" },
      { type: "unknownFutureNativeItem", id: "current-unknown" },
    ]) {
      const latest = source({ currentItems: [item] });
      await expect(latest.reader.latest("thread-one", "web-turn"))
        .rejects.toThrow("current Web turn already contains activity");
      expect(latest.closed()).toBe(1);

      const replay = source({ currentItems: [item] });
      await expect(replay.reader.verifyRecent("thread-one", "web-turn",
        "native-handoff-turn", "0".repeat(64)))
        .rejects.toThrow("current Web turn already contains activity");
      expect(replay.closed()).toBe(1);
    }
    // The active turn may contain its own public user input; that alone is
    // not evidence that Native or Web has already produced an action.
    const newUser = source({ currentItems: [
      { type: "userMessage", id: "current-user",
        content: [{ type: "text", text: "Continue in Web" }] },
    ] });
    expect(await newUser.reader.latest("thread-one", "web-turn"))
      .toMatchObject({ handoffTurnId: "native-handoff-turn" });
  });
  test("manual handoff rejections log only a bounded phase and reason, never visible source details", async () => {
    const base = mkdtempSync(join(tmpdir(), "tela-manual-handoff-diagnostics-"));
    const path = join(base, "events.jsonl");
    const original = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = path;
    try {
      const sourceTurn = source({ priorExtras: [
        { type: "commandExecution", id: "private-command-id",
          command: "sensitive command contents must not be logged" },
      ] });
      await expect(sourceTurn.reader.latest("thread-one", "web-turn"))
        .rejects.toThrow("unexpected activity");
      const currentTurn = source({ currentItems: [
        { type: "agentMessage", id: "private-current-message", text: "sensitive answer" },
      ] });
      await expect(currentTurn.reader.latest("thread-one", "web-turn"))
        .rejects.toThrow("current Web turn already contains activity");
      const normalTurn = source({
        prompt: "Normal Native user work",
        priorExtras: [{ type: "commandExecution", id: "normal-tool" }],
      });
      expect(await normalTurn.reader.latest("thread-one", "web-turn")).toBeUndefined();

      const log = readFileSync(path, "utf8");
      const rows = log.trim().split("\n").map(line => JSON.parse(line))
        .filter(row => row.stage === "native_manual_handoff_rejected");
      expect(rows.map(row => [row.phase, row.reason_class])).toEqual([
        ["source_turn", "unexpected_visible_activity"],
        ["current_turn", "unexpected_visible_activity"],
      ]);
      for (const secret of [
        "private-command-id", "sensitive command contents",
        "private-current-message", "sensitive answer",
        "thread-one", "web-turn", "normal-tool",
      ]) expect(log).not.toContain(secret);
    } finally {
      if (original === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
      else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = original;
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("a single explanatory Native reasoning item does not become an action grant", async () => {
    const fixture = source({ priorExtras: [{ type: "agentReasoning", id: "reasoning-only" }] });
    expect(await fixture.reader.latest("thread-one", "web-turn"))
      .toMatchObject({ handoffTurnId: "native-handoff-turn" });
  });
  test("a cached handoff is reverified from bounded public summary pages after many Web turns", async () => {
    const previous = source();
    const initial = await previous.reader.latest("thread-one", "web-turn");
    if (!initial) throw new Error("Source fixture is missing a handoff");
    let closed = 0;
    const methods: Array<{ method: string; params: any }> = [];
    const current = { id: "web-turn", status: "inProgress", itemsView: "summary", items: [] };
    const nativeHandoff = {
      id: initial.handoffTurnId, status: "completed", itemsView: "summary",
      items: [
        { type: "userMessage", id: "request",
          content: [{ type: "text", text: NATIVE_WEB_HANDOFF_PROMPT }] },
        { type: "agentMessage", id: "answer", phase: "finalAnswer", text: json },
      ],
    };
    const all = [current, ...Array.from({ length: 14 }, (_, index) => ({
      id: "web-followup-" + index, status: "completed", itemsView: "summary",
      items: [{ type: "agentMessage", id: "web-answer-" + index,
        text: "Followup", phase: "finalAnswer" }],
    })), nativeHandoff];
    const rpc = {
      async request(method: string, params: any): Promise<unknown> {
        methods.push({ method, params });
        if (method === "thread/read") {
          if (params.includeTurns !== false) throw Error("Whole history forbidden");
          return { thread: { id: "thread-one", historyMode: "paginated", status: { type: "active" } } };
        }
        if (method === "thread/turns/list" && params.itemsView === "notLoaded") {
          return { data: [
            { id: "web-turn", status: "inProgress",
              itemsView: "notLoaded", items: [] },
          ], nextCursor: null };
        }
        if (method === "thread/turns/list") {
          const offset = params.cursor ? Number(params.cursor) : 0;
          const data = all.slice(offset, offset + params.limit);
          return { data, nextCursor: offset + params.limit < all.length
            ? String(offset + params.limit) : null };
        }
        throw Error("Unexpected request");
      },
      async close() { closed++; },
    };
    const verifier = new AppServerNativeHandoffSource(async () => rpc);
    expect(await verifier.verifyRecent("thread-one", "web-turn",
      initial.handoffTurnId, initial.answerDigest)).toEqual(initial);
    expect(methods.filter(value => value.method === "thread/turns/list")).toHaveLength(3);
    expect(methods.every(value => value.method !== "thread/read"
      || value.params.includeTurns === false)).toBe(true);
    expect(closed).toBe(1);
    await expect(verifier.verifyRecent("thread-one", "web-turn",
      initial.handoffTurnId, "0".repeat(64))).rejects.toThrow("no matching");
    expect(closed).toBe(2);
  });

  test("Legacy, missing and unindexed handoff modes cannot replay original history through a shallow page", async () => {
    for (const historyMode of ["legacy", undefined, "future-unindexed"]) {
      const calls: string[] = [];
      let closed = 0;
      const rpc = {
        async request(method: string, params: { includeTurns?: boolean }): Promise<unknown> {
          calls.push(method);
          if (method !== "thread/read" || params.includeTurns !== false) {
            throw Error("Native server must not reconstruct a large historical rollout");
          }
          return { thread: { id: "thread-one", historyMode, status: { type: "active" } } };
        },
        async close() { closed++; },
      };
      const reader = new AppServerNativeHandoffSource(async () => rpc);
      await expect(reader.latest("thread-one", "web-turn"))
        .rejects.toBeInstanceOf(NativeHistoryBootstrapRequired);
      await expect(reader.verifyRecent("thread-one", "web-turn", "native-handoff-turn", "0".repeat(64)))
        .rejects.toBeInstanceOf(NativeHistoryBootstrapRequired);
      expect(calls).toEqual(["thread/read", "thread/read"]);
      expect(closed).toBe(2);
    }
  });

  test("handoff proof refuses a Paginated-to-Legacy mode change after an indexed page", async () => {
    let reads = 0;
    const methods: string[] = [];
    const rpc = {
      async request(method: string): Promise<unknown> {
        methods.push(method);
        if (method === "thread/read") {
          return { thread: { id: "thread-one",
            historyMode: ++reads === 1 ? "paginated" : "legacy",
            status: { type: "active" } } };
        }
        if (method === "thread/turns/list") return { data: [
          { id: "web-turn", status: "inProgress", itemsView: "summary", items: [] },
          { id: "native-handoff-turn", status: "completed", itemsView: "summary",
            items: [
              { type: "userMessage", id: "request", content: [
                { type: "text", text: NATIVE_WEB_HANDOFF_PROMPT },
              ] },
              { type: "agentMessage", id: "answer", phase: "finalAnswer", text: json },
            ] },
        ] };
        throw Error("Unexpected RPC");
      },
      async close() {},
    };
    await expect(new AppServerNativeHandoffSource(async () => rpc).latest("thread-one", "web-turn"))
      .rejects.toThrow("thread changed");
    expect(methods).toEqual(["thread/read", "thread/turns/list", "thread/read"]);
  });
});
