import { expect, test } from "bun:test";
import { chatGptWebCheckpointSourceTokenLimit, type WebPhysicalContext } from "@chatgpt-tela/chatgpt";
import { boundedWebCheckpointSource } from "./web-checkpoint-source";

function context(tokens: number): WebPhysicalContext {
  return {
    mode: "full", headRevisionId: "source", activeRequestRevisionId: "source",
    logicalTokens: tokens, transferTokens: tokens,
    segments: [{ type: "revision", revisionId: "source", kind: "user", content: "Original evidence" }],
  };
}

test("the shared checkpoint-source budget keeps summarizer input plus output headroom below the Web limit", () => {
  const limit = chatGptWebCheckpointSourceTokenLimit("medium");
  const atLimit = boundedWebCheckpointSource(context(limit), [], "medium");
  expect(atLimit?.transferTokens).toBe(limit);
  expect(boundedWebCheckpointSource(context(limit + 1), [], "medium")).toBeUndefined();
  expect(boundedWebCheckpointSource(context(0), [], "medium")?.transferTokens).toBe(0);
  expect(boundedWebCheckpointSource(context(Number.MAX_SAFE_INTEGER), [], "medium")).toBeUndefined();
});
