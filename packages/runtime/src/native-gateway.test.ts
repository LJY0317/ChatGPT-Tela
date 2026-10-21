import { describe, expect, test } from "bun:test";
import type { CanonicalCurrentTurnSource } from "@chatgpt-tela/codex";
import { ActiveTurnRegistry } from "./registry";
import { NativeResponsesGateway } from "./native-gateway";
import { acceptNativeResponsesToolResult } from "./native-round";
import { diagnosticContext, diagnosticFingerprint, withDiagnosticContext } from "@chatgpt-tela/core";

function request(turnId: string, input: unknown[] = []): unknown {
  return {
    client_metadata: {
      "x-codex-turn-metadata": {
        request_kind: "turn",
        thread_id: "thread-1",
        turn_id: turnId,
      },
    },
    input,
    tools: [{
      type: "function",
      name: "exec_command",
      description: "command",
      parameters: { type: "object" },
    }],
  };
}

const source: CanonicalCurrentTurnSource = {
  async currentTurn(threadId) {
    return {
      threadId,
      turnId: "turn-1",
      cwd: "/workspace",
      workspaceRoots: ["/workspace"],
      sandbox: { kind: "read-only", network: "restricted" },
      proof: "turn-context",
      environmentSourceTurnId: "turn-1",
    };
  },
};

describe("Native Responses semantic gateway", () => {
  test("planning failure retains request and canonical Native scope", async () => {
    const requestFingerprint = "a".repeat(24);
    let observed: ReturnType<typeof diagnosticContext> | undefined;
    const gateway = new NativeResponsesGateway(source, new ActiveTurnRegistry(), async () => {
      await Promise.resolve();
      observed = diagnosticContext();
      throw new Error("planning failed");
    });
    try {
      await expect(withDiagnosticContext({ request_fingerprint: requestFingerprint }, () =>
        gateway.handle(request("turn-1")))).rejects.toThrow("planning failed");
      expect(observed).toMatchObject({
        request_fingerprint: requestFingerprint,
        scope_fingerprint: diagnosticFingerprint("thread-1"),
        turn_fingerprint: diagnosticFingerprint("turn-1"),
      });
    } finally { await gateway.close(); }
  });

  test("reconnection replaces the old response waiter without restarting or cancelling Web execution", async () => {
    let release!: () => void, ready!: () => void;
    const prepared = new Promise<void>(r => { ready = r; });
    const gate = new Promise<void>(r => { release = r; });
    const turns = new ActiveTurnRegistry(); let launches = 0, executionAborted = false;
    const gateway = new NativeResponsesGateway(source, turns, async (registered, _body, signal) => {
      launches++; signal?.addEventListener("abort", () => { executionAborted = true; });
      ready(); await gate; registered.channel.markSubmitted(); registered.channel.markAccepted();
      await registered.channel.requestTool({ callId: "reconnect-call", wireName: "exec_command", mode: "structured", arguments: {} });
    });
    const old = gateway.handle(request("turn-1"));
    const oldResult = old.then(() => "unexpected outcome", e => e.name);
    try {
      await prepared; await new Promise(r => setImmediate(r));
      const fresh = gateway.handle(request("turn-1"));
      await new Promise(r => setImmediate(r));
      release();
      const outcome = await fresh;
      expect(outcome.type).toBe("tool-call");
      expect(await oldResult).toBe("AbortError");
      expect(launches).toBe(1); expect(executionAborted).toBe(false);
    } finally { release(); await gateway.close(); }
  });

  test("disconnect releases only the transport wait and permits a later exact request", async () => {
    let finish!: () => void, ready!: () => void;
    const gate = new Promise<void>(r => { finish = r; });
    const prepared = new Promise<void>(r => { ready = r; });
    const gateway = new NativeResponsesGateway(source, new ActiveTurnRegistry(), async registered => {
      ready(); await gate; registered.channel.markSubmitted(); registered.channel.markAccepted(); registered.channel.complete("done once");
    });
    const abort = new AbortController();
    const first = gateway.handle(request("turn-1"), { onProgress() {}, signal: abort.signal });
    const old = first.then(() => "unexpected outcome", e => e.name);
    try {
      await prepared; abort.abort();
      // Abort must settle the old transport before the provider produces any result.
      expect(await Promise.race([old, Bun.sleep(100).then(() => "still waiting")])).toBe("AbortError");
      const fresh = gateway.handle(request("turn-1")); finish();
      expect(await fresh).toMatchObject({ type: "final", answer: "done once" });
    } finally { finish(); await gateway.close(); }
  });
  test("failed preparation releases authority without replaying the failed Native turn", async () => {
    const turns = new ActiveTurnRegistry();
    let currentTurnId = "turn-1";
    let launches = 0;
    let canonicalReads = 0;
    let failedCapability = "";
    const changingSource: CanonicalCurrentTurnSource = {
      async currentTurn(threadId) {
        canonicalReads++;
        return { ...(await source.currentTurn(threadId))!, turnId: currentTurnId,
          environmentSourceTurnId: currentTurnId };
      },
    };
    const gateway = new NativeResponsesGateway(changingSource, turns, async registered => {
      launches += 1;
      if (launches === 1) {
        failedCapability = registered.capability;
        throw new Error("selected model family disappeared during preparation");
      }
      registered.channel.markSubmitted();
      registered.channel.markAccepted();
      registered.channel.complete("new explicit turn");
    });
    await expect(gateway.handle(request("turn-1"))).rejects.toThrow("model family disappeared");
    expect(turns.size).toBe(0);
    expect(() => turns.resolve(failedCapability)).toThrow("retired turn capability");
    await expect(gateway.handle(request("turn-1"))).rejects.toThrow("already retired");
    expect(launches).toBe(1);
    expect(canonicalReads).toBe(1);
    currentTurnId = "turn-2";
    const final = await gateway.handle(request(currentTurnId));
    expect(final.type).toBe("final");
    gateway.commit(final);
    expect(turns.size).toBe(1);
    await gateway.close();
    expect(turns.size).toBe(0);
    expect(launches).toBe(2);
    expect(canonicalReads).toBe(2);
  });

  test("retired Native turn replay is denied from metadata before scanning old inputs or querying Desktop history", async () => {
    let nativeReads = 0;
    let launches = 0;
    const currentSource: CanonicalCurrentTurnSource = {
      async currentTurn(threadId) {
        nativeReads++;
        return source.currentTurn(threadId);
      },
    };
    const gateway = new NativeResponsesGateway(currentSource, new ActiveTurnRegistry(), async () => {
      launches++;
      throw new Error("Native original visible history exceeds the safe bound");
    });
    await expect(gateway.handle(request("turn-1"))).rejects.toThrow("safe bound");
    expect(nativeReads).toBe(1);
    const retried = request("turn-1") as { input: unknown[] };
    Object.defineProperty(retried, "input", {
      enumerable: true,
      get() { throw new Error("Retired turn's 73 MB body must not be rescanned"); },
    });
    await expect(gateway.handle(retried)).rejects.toMatchObject({
      code: "tela_native_turn_already_retired",
    });
    expect(nativeReads).toBe(1);
    expect(launches).toBe(1);
  });

  for (const phase of ["submitted", "accepted", "indeterminate", "cancelled"] as const) {
    test(`rejected ${phase} execution revokes only its own authority`, async () => {
      const turns = new ActiveTurnRegistry();
      let capability = "";
      let launches = 0;
      const gateway = new NativeResponsesGateway(source, turns, async registered => {
        launches += 1;
        capability = registered.capability;
        registered.channel.markSubmitted();
        if (phase !== "submitted") registered.channel.markAccepted();
        if (phase === "indeterminate") registered.channel.markIndeterminate(new Error("provider lost"));
        if (phase === "cancelled") registered.channel.cancel(new Error("provider lost"));
        throw new Error("provider lost");
      });
      await expect(gateway.handle(request("turn-1"))).rejects.toThrow("provider lost");
      expect(turns.size).toBe(0);
      expect(() => turns.resolve(capability)).toThrow("retired turn capability");
      await expect(gateway.handle(request("turn-1"))).rejects.toThrow("already retired");
      expect(launches).toBe(1);
    });
  }

  test("a completed answer remains replayable until delivery even if launch cleanup rejects", async () => {
    const turns = new ActiveTurnRegistry();
    const gateway = new NativeResponsesGateway(source, turns, async registered => {
      registered.channel.markSubmitted();
      registered.channel.markAccepted();
      registered.channel.complete("proven answer");
      throw new Error("cleanup failed after completion");
    });
    const final = await gateway.handle(request("turn-1"));
    expect(turns.size).toBe(1);
    expect(await gateway.handle(request("turn-1"))).toEqual(final);
    gateway.commit(final);
    expect(turns.size).toBe(1);
    await gateway.close();
    expect(turns.size).toBe(0);
  });

  test("concurrent root, child and grandchild keep tool authority and same-id results isolated", async () => {
    const agents = [
      { threadId: "root", agentName: "/root", parentThreadId: undefined, tool: "root_tool" },
      { threadId: "child", agentName: "/root/child", parentThreadId: "root", tool: "child_tool" },
      { threadId: "grandchild", agentName: "/root/child/grandchild", parentThreadId: "child", tool: "grandchild_tool" },
    ];
    const nestedSource: CanonicalCurrentTurnSource = {
      async currentTurn(threadId) {
        const agent = agents.find(agent => agent.threadId === threadId);
        if (!agent) return undefined;
        return {
          threadId, turnId: "turn-1", agentName: agent.agentName,
          ...(agent.parentThreadId ? { parentThreadId: agent.parentThreadId } : {}),
          cwd: `/workspace/${threadId}`, workspaceRoots: [`/workspace/${threadId}`],
          sandbox: { kind: "read-only", network: "restricted" },
          proof: "turn-context", environmentSourceTurnId: "turn-1",
        };
      },
    };
    const body = (agent: typeof agents[number], output?: string) => ({
      client_metadata: { "x-codex-turn-metadata": {
        request_kind: "turn", thread_id: agent.threadId, turn_id: "turn-1",
        agent_name: agent.agentName,
        ...(agent.parentThreadId ? { parent_thread_id: agent.parentThreadId } : {}),
      } },
      tools: [{ type: "function", name: agent.tool, parameters: { type: "object" } }],
      input: output === undefined ? [] : [{ type: "function_call_output", call_id: "shared-call", output }],
    });
    const turns = new ActiveTurnRegistry();
    const launches: string[] = [];
    const gateway = new NativeResponsesGateway(nestedSource, turns, async registered => {
      const channel = registered.channel;
      const agent = agents.find(agent => agent.threadId === channel.binding.authority.threadId)!;
      launches.push(agent.threadId);
      channel.markSubmitted();
      channel.markAccepted();
      const foreignTool = agents.find(other => other !== agent)!.tool;
      expect(channel.binding.tools.exact(foreignTool)).toBeUndefined();
      expect(() => channel.requestTool({
        callId: "foreign-call", wireName: foreignTool, mode: "structured", arguments: {},
      })).toThrow();
      const waiting = channel.requestTool({
        callId: "shared-call", wireName: agent.tool, mode: "structured", arguments: {},
      });
      let state = channel.state();
      while (!(state.phase === "tool-result-delivered" && state.nativeResultReady)) {
        state = await channel.waitForStateChange(state.revision);
      }
      channel.releaseNativeToolResultToWeb("shared-call");
      const result = await waiting;
      channel.markWebContinuation();
      channel.complete(`${agent.threadId}:${String(result.content)}`);
    });
    const calls = await Promise.all(agents.map(agent => gateway.handle(body(agent))));
    expect(new Set(calls.map(call => call.delivery.capability)).size).toBe(3);
    calls.forEach((call, index) => {
      expect(call.type).toBe("tool-call");
      if (call.type !== "tool-call") throw new Error("expected tool call");
      if (call.item.type !== "function_call") throw new Error("expected function call");
      expect(call.item.name).toBe(agents[index]!.tool);
      gateway.commit(call);
    });
    // Complete in reverse lineage order; retiring the grandchild cannot retire its ancestors.
    for (const agent of [...agents].reverse()) {
      const final = await gateway.handle(body(agent, `result-${agent.threadId}`));
      expect(final.type).toBe("final");
      if (final.type !== "final") throw new Error("expected final");
      expect(final.answer).toBe(`${agent.threadId}:result-${agent.threadId}`);
      gateway.commit(final);
      await expect(gateway.handle(body(agent))).rejects.toThrow("proven new input");
    }
    await gateway.close();
    expect(turns.size).toBe(0);
    expect(launches.sort()).toEqual(agents.map(agent => agent.threadId).sort());
  });

  test("replays only uncommitted delivery, consumes the matching result, and commits final once", async () => {
    const turns = new ActiveTurnRegistry();
    let launches = 0;
    const gateway = new NativeResponsesGateway(source, turns, async registered => {
      launches += 1;
      registered.channel.markSubmitted();
      registered.channel.markAccepted();
      const waitingResult = registered.channel.requestTool({
        callId: "call-1",
        wireName: "exec_command",
        mode: "structured",
        arguments: { cmd: ["printf", "ok"] },
      });
      let state = registered.channel.state();
      while (!(state.phase === "tool-result-delivered"
        && state.nativeResultReady === true
        && state.outstandingToolCallId === "call-1")) {
        state = await registered.channel.waitForStateChange(state.revision);
      }
      registered.channel.releaseNativeToolResultToWeb("call-1");
      const result = await waitingResult;
      registered.channel.markWebContinuation();
      registered.channel.complete(`final:${String(result.content)}`);
    });

    const first = await gateway.handle(request("turn-1"));
    expect(first.type).toBe("tool-call");
    if (first.type !== "tool-call") throw new Error("expected tool call");
    expect(first.item).toEqual({
      type: "function_call",
      call_id: "call-1",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: ["printf", "ok"] }),
    });
    expect(launches).toBe(1);

    const replay = await gateway.handle(request("turn-1"));
    expect(replay.type).toBe("tool-call");
    if (replay.type !== "tool-call") throw new Error("expected replayed tool call");
    expect(replay.item).toEqual(first.item);
    expect(replay.delivery.capability).toBe(first.delivery.capability);
    expect(launches).toBe(1);

    gateway.commit(first);
    await expect(gateway.handle(request("turn-1")))
      .rejects.toThrow("follow-up request must contain its result");

    const followup = request("turn-1", [
      { type: "function_call_output", call_id: "call-1", output: "ok" },
    ]);
    const final = await gateway.handle(followup);
    expect(final.type).toBe("final");
    if (final.type !== "final") throw new Error("expected final");
    expect(final.answer).toBe("final:ok");

    const finalReplay = await gateway.handle(followup);
    expect(finalReplay).toEqual(final);
    gateway.commit(final);

    await expect(gateway.handle(followup)).rejects.toThrow("proven new input");
    await gateway.close();
    expect(launches).toBe(1);
  });

  test("a compaction-preverified result allows a later Native continuation without replaying its old output", async () => {
    const turns = new ActiveTurnRegistry();
    const gateway = new NativeResponsesGateway(source, turns, async registered => {
      const channel = registered.channel;
      channel.markSubmitted(); channel.markAccepted();
      const waiting = channel.requestTool({ callId: "call-1", wireName: "exec_command",
        mode: "structured", arguments: { cmd: "fixture" } });
      let state = channel.state();
      while (state.nativeResultReady !== true) state = await channel.waitForStateChange(state.revision);
      channel.releaseNativeToolResultToWeb("call-1");
      const result = await waiting;
      channel.markWebContinuation();
      channel.complete(`final:${String(result.content)}`);
    });
    try {
      const first = await gateway.handle(request("turn-1"));
      expect(first.type).toBe("tool-call");
      gateway.commit(first);
      const channel = turns.active("thread-1", "turn-1")!.channel;
      expect(acceptNativeResponsesToolResult(channel, { input: [
        { type: "function_call_output", call_id: "call-1", output: "compacted-ok" },
      ] })).toBe("received");
      let state = channel.state();
      while (state.phase !== "completed") state = await channel.waitForStateChange(state.revision);
      // Compaction replaced the original tool result in Native history after
      // Web had already consumed it and finished the original response.
      const final = await gateway.handle(request("turn-1", [
        { role: "user", content: "Verified compacted continuation summary" },
      ]));
      expect(final.type).toBe("final");
      if (final.type !== "final") throw Error("expected final");
      expect(final.answer).toBe("final:compacted-ok");
      gateway.commit(final);
    } finally { await gateway.close(); }
  });

  test("stale Native turn identity is rejected before a Web turn is launched", async () => {
    let launches = 0;
    const gateway = new NativeResponsesGateway(source, new ActiveTurnRegistry(), async () => {
      launches += 1;
    });

    await expect(gateway.handle(request("turn-stale")))
      .rejects.toThrow("does not name the canonical current turn");
    expect(launches).toBe(0);
  });

  test("the initial Web launch receives the exact bound Native request payload", async () => {
    const body = request("turn-1", [{ type: "message", role: "user", content: "hello" }]);
    let observed: unknown;
    const gateway = new NativeResponsesGateway(source, new ActiveTurnRegistry(), async (registered, nativeRequest) => {
      observed = nativeRequest;
      registered.channel.markSubmitted();
      registered.channel.markAccepted();
      registered.channel.complete("done");
    });

    const outcome = await gateway.handle(body);
    expect(outcome.type).toBe("final");
    expect(observed).toBe(body);
  });
});

test("tool-round progress gap replays once after local transport commit and retains uncommitted retry", async () => {
  const turns = new ActiveTurnRegistry();
  const gateway = new NativeResponsesGateway(source, turns, async registered => {
    registered.channel.markSubmitted(); registered.channel.markAccepted();
    registered.channel.publishProgress("before tool");
    await registered.channel.requestTool({ callId: "progress-call", wireName: "exec_command", mode: "structured", arguments: {} });
  });
  const firstSeen: string[] = [];
  const first = await gateway.handle(request("turn-1"), { onProgress: summary => { firstSeen.push(summary); } });
  expect(firstSeen).toEqual(["before tool"]);
  gateway.commit(first);
  const channel = turns.resolve(first.delivery.capability);
  channel.publishProgress("between rounds");
  // A failed/aborted response has not committed its progress cursor.
  const retrySeen: string[] = [];
  const followup = request("turn-1", [{ type: "function_call_output", call_id: "progress-call", output: "ok" }]);
  const pending = gateway.handle(followup, { onProgress: summary => { retrySeen.push(summary); } });
  await Promise.resolve(); await Promise.resolve();
  let state = channel.state();
  while (!state.nativeResultReady) state = await channel.waitForStateChange(state.revision);
  channel.releaseNativeToolResultToWeb("progress-call");
  channel.markWebContinuation(); channel.complete("done");
  const final = await pending;
  expect(retrySeen).toEqual(["between rounds"]);
  const repeated: string[] = [];
  const replay = await gateway.handle(followup, { onProgress: summary => { repeated.push(summary); } });
  expect(repeated).toEqual(["between rounds"]);
  expect(replay.delivery.progressCursor).toBe(final.delivery.progressCursor);
  gateway.commit(final);
  expect(turns.size).toBe(1);
  await gateway.close();
  expect(turns.size).toBe(0);
});
