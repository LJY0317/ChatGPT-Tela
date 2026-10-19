import { expect, test } from "bun:test";
import { CheckpointPreparationBudget } from "./checkpoint-preparation-budget";

const policy = { maxModelCalls: 2, maxInputTokens: 100, maxElapsedMs: 50 };
test("cost admission uses calls, input and monotonic elapsed time independently", () => {
  let now = 100;
  const budget = new CheckpointPreparationBudget(100, policy, () => now);
  expect(() => budget.admitPlan(3, 1)).toThrow();
  expect(() => budget.admitPlan(1, 101)).toThrow();
  budget.admitPlan(2, 100);
  budget.beforeClaim(60); budget.recordInvocation(60);
  expect(() => budget.beforeClaim(41)).toThrow();
  budget.beforeClaim(40); now = 150;
  expect(() => budget.beforeClaim(40)).toThrow();
  // Completed data remains reusable after deadline with no new invocation.
  budget.admitPlan(0, 0);
});
test("zero budget permits reuse and rejects every new call", () => {
  const budget = new CheckpointPreparationBudget(100, { maxModelCalls: 0, maxInputTokens: 0, maxElapsedMs: 0 });
  budget.admitPlan(0, 0);
  expect(() => budget.beforeClaim(0)).toThrow();
});
test("invalid and incomplete policies never become an unlimited budget", () => {
  for (const candidate of [ { ...policy, maxModelCalls: Infinity }, { ...policy, maxElapsedMs: -1 },
    { maxModelCalls: 1 }, { ...policy, maxInputTokens: NaN } ]) {
    expect(() => new CheckpointPreparationBudget(100, candidate as typeof policy)).toThrow();
  }
});

test("all phases share one budget and rewrapping never charges twice", async () => {
  const budget = new CheckpointPreparationBudget(10000, { maxModelCalls: 2, maxInputTokens: 100000, maxElapsedMs: 1000 });
  let calls = 0, entered = 0;
  const original: import("./native-request-planner").NativeRequestCheckpointProducer = async request => {
    calls++; return { nativeTaskId: request.nativeTaskId, sourceRevisionId: request.sourceRevisionId, content: "derived" };
  };
  const request = { nativeTaskId: "task", sourceRevisionId: "revision", physicalContext: {
    mode: "full" as const, headRevisionId: "revision", logicalTokens: 1, transferTokens: 1,
    segments: [{ type: "revision" as const, kind: "user" as const, revisionId: "revision", content: "source" }],
  } };
  await budget.producer(budget.producer(original), () => { entered++; })(request);
  expect(calls).toBe(1); expect(entered).toBe(1); expect(budget.modelCalls).toBe(1);
  expect(() => budget.admitPlan(2, 1)).toThrow();
  await budget.producer(original)(request);
  expect(() => budget.producer(original)(request)).toThrow();
  expect(calls).toBe(2); expect(budget.modelCalls).toBe(2);
});

test("default preparation owns only one model call instead of a hidden multi-stage allowance", () => {
 const budget=new CheckpointPreparationBudget(100);
 expect(budget.policy.maxModelCalls).toBe(1);
 budget.beforeClaim(50);budget.recordInvocation(50);
 expect(()=>budget.beforeClaim(1)).toThrow();
});
