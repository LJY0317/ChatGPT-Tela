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
