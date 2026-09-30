import { describe, expect, test } from "bun:test";
import type { CanonicalCurrentTurnSource } from "@chatgpt-tela/codex";
import { ActiveTurnRegistry } from "./registry";
import { NativeResponsesGateway } from "./native-gateway";

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
      await expect(gateway.handle(body(agent))).rejects.toThrow("already retired");
    }
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

    await expect(gateway.handle(followup)).rejects.toThrow("already retired");
    expect(launches).toBe(1);
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
