import { describe, expect, test } from "bun:test";
import type { NativeGatewayOutcome } from "@chatgpt-tela/runtime";
import {
  encodeNativeResponsesOutcome,
  nativeResponsesSsePlan,
} from "./protocol";

const toolOutcome: NativeGatewayOutcome = {
  type: "tool-call",
  item: {
    type: "function_call",
    call_id: "call-1",
    name: "search",
    namespace: "github",
    arguments: JSON.stringify({ query: "ChatGPT Tela" }),
  },
  delivery: { capability: "turn_secret", callId: "call-1" },
};

describe("Native Responses protocol encoding", () => {
  test("uses stable response and item identities across replay", () => {
    const first = encodeNativeResponsesOutcome({
      outcome: toolOutcome,
      model: "chatgpt-tela-test-model",
      createdAt: 123,
    });
    const replay = encodeNativeResponsesOutcome({
      outcome: toolOutcome,
      model: "chatgpt-tela-test-model",
      createdAt: 456,
    });

    expect(replay.responseId).toBe(first.responseId);
    expect(replay.outputItemId).toBe(first.outputItemId);
    expect(first.outputItem).toEqual({
      type: "function_call",
      id: first.outputItemId,
      call_id: "call-1",
      name: "search",
      namespace: "github",
      arguments: JSON.stringify({ query: "ChatGPT Tela" }),
      status: "completed",
    });
  });

  test("tool streaming commits only after the exact call identity is exposed", () => {
    const encoded = encodeNativeResponsesOutcome({
      outcome: toolOutcome,
      model: "chatgpt-tela-test-model",
      createdAt: 123,
    });
    const plan = nativeResponsesSsePlan(toolOutcome, encoded);

    expect(plan.commitAfterFrame).toBe(1);
    expect(plan.frames[0]).toContain("event: response.created");
    expect(plan.frames[0]).not.toContain("call-1");
    expect(plan.frames[1]).toContain("event: response.output_item.added");
    expect(plan.frames[1]).toContain("call-1");
    expect(plan.frames.at(-1)).toBe("data: [DONE]\n\n");
  });

  test("final streaming exposes text before committing at response.completed", () => {
    const outcome: NativeGatewayOutcome = {
      type: "final",
      answer: "finished",
      delivery: { capability: "turn_secret" },
    };
    const encoded = encodeNativeResponsesOutcome({
      outcome,
      model: "chatgpt-tela-test-model",
      createdAt: 123,
    });
    const plan = nativeResponsesSsePlan(outcome, encoded);

    expect(plan.frames[plan.commitAfterFrame]).toContain("event: response.completed");
    expect(plan.frames.join("")).toContain('"delta":"finished"');
    expect(plan.frames.at(-1)).toBe("data: [DONE]\n\n");
  });
});
