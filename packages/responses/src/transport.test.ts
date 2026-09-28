import { describe, expect, test } from "bun:test";
import type { CanonicalCurrentTurnSource } from "@chatgpt-tela/codex";
import {
  ActiveTurnRegistry,
  NativeResponsesGateway,
} from "@chatgpt-tela/runtime";
import { handleNativeResponsesHttp } from "./transport";

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

function body(input: unknown[] = [], stream = true): Record<string, unknown> {
  return {
    model: "chatgpt-tela-test-model",
    stream,
    client_metadata: {
      "x-codex-turn-metadata": {
        request_kind: "turn",
        thread_id: "thread-1",
        turn_id: "turn-1",
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

function post(value: unknown): Request {
  return new Request("http://127.0.0.1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

describe("Native Responses HTTP transport", () => {
  test("cancellation before a tool identity frame keeps delivery replayable; reading it commits fail-closed", async () => {
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
      registered.channel.complete(`done:${String(result.content)}`);
    });

    const first = await handleNativeResponsesHttp(post(body()), gateway, { now: () => 123_000 });
    expect(first.headers.get("content-type")).toContain("text/event-stream");
    const firstReader = first.body!.getReader();
    const firstFrame = new TextDecoder().decode((await firstReader.read()).value);
    expect(firstFrame).toContain("response.created");
    await firstReader.cancel();
    expect(turns.active("thread-1", "turn-1")?.channel.outstandingNativeDelivery).toBe("queued");

    const replay = await handleNativeResponsesHttp(post(body()), gateway, { now: () => 123_000 });
    const replayText = await replay.text();
    expect(replayText).toContain('"call_id":"call-1"');
    expect(replayText).toContain("data: [DONE]");
    expect(turns.active("thread-1", "turn-1")?.channel.outstandingNativeDelivery).toBe("delivered");
    expect(launches).toBe(1);

    const missing = await handleNativeResponsesHttp(post(body()), gateway);
    expect(missing.status).toBe(409);
    expect(await missing.text()).toContain("follow-up request must contain its result");

    const followup = body([
      { type: "function_call_output", call_id: "call-1", output: "ok" },
    ]);
    const final = await handleNativeResponsesHttp(post(followup), gateway, { now: () => 124_000 });
    const finalText = await final.text();
    expect(finalText).toContain('"delta":"done:ok"');
    expect(finalText).toContain("response.completed");
    expect(turns.size).toBe(0);
  });

  test("non-stream mode returns a standard completed response object", async () => {
    const turns = new ActiveTurnRegistry();
    const gateway = new NativeResponsesGateway(source, turns, async registered => {
      registered.channel.markSubmitted();
      registered.channel.markAccepted();
      registered.channel.complete("hello");
    });

    const response = await handleNativeResponsesHttp(post(body([], false)), gateway, { now: () => 125_000 });
    expect(response.headers.get("content-type")).toContain("application/json");
    const json = await response.json() as Record<string, unknown>;
    expect(json.status).toBe("completed");
    expect(json.created_at).toBe(125);
    expect(json.output).toEqual([{
      type: "message",
      id: expect.stringMatching(/^msg_/),
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "hello", annotations: [] }],
    }]);
    expect(turns.size).toBe(0);
  });

  test("rejects malformed transport input before starting runtime work", async () => {
    let launches = 0;
    const gateway = new NativeResponsesGateway(source, new ActiveTurnRegistry(), async () => {
      launches += 1;
    });

    const malformed = await handleNativeResponsesHttp(new Request("http://127.0.0.1/responses", {
      method: "POST",
      body: "{not-json",
    }), gateway);
    expect(malformed.status).toBe(400);

    const missingModel = await handleNativeResponsesHttp(post({ stream: true }), gateway);
    expect(missingModel.status).toBe(400);
    expect(launches).toBe(0);
  });
});
