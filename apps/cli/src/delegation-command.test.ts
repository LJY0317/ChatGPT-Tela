import { expect, test } from "bun:test";
import { runDelegationCommand } from "./delegation-command";

test("source and packaged delegation command binds the Native parent and exact selected profile", async () => {
  const requests: unknown[] = [];
  const input = { environment: { CODEX_THREAD_ID: "parent" }, client: { async manageDelegation(value: any) { requests.push(value); return { accepted: true }; } } };
  await runDelegationCommand(["retain-delegation", "--thread", "child", "--slot", "2"], input);
  await runDelegationCommand(["acknowledge-result", "--thread", "child", "--turn", "turn", "--item", "final", "--slot", "2"], input);
  await runDelegationCommand(["acknowledge-result", "--thread", "child", "--turn", "turn", "--outcome", "interrupted"], input);
  await runDelegationCommand(["reconcile-delegations", "--slot", "2"], input);
  expect(requests).toEqual([
    { action: "enroll", slot: 2, parentThreadId: "parent", threadId: "child" },
    { action: "acknowledge", slot: 2, parentThreadId: "parent", threadId: "child", turnId: "turn", outcome: "answer", itemId: "final" },
    { action: "acknowledge", slot: 1, parentThreadId: "parent", threadId: "child", turnId: "turn", outcome: "interrupted" },
    { action: "reconcile", slot: 2 },
  ]);
});

test("invalid Native context or result cannot invoke or start a service", async () => {
  let calls = 0;
  const input = { environment: {}, client: { async manageDelegation() { calls++; } } };
  await expect(runDelegationCommand(["retain-delegation", "--thread", "child"], input)).rejects.toThrow("coordinating Native");
  await expect(runDelegationCommand(["acknowledge-result"], { ...input, environment: { CODEX_THREAD_ID: "parent" } })).rejects.toThrow("requires --thread");
  await expect(runDelegationCommand(["acknowledge-result", "--thread", "child", "--turn", "turn", "--outcome", "failed", "--item", "final"], { ...input, environment: { CODEX_THREAD_ID: "parent" } })).rejects.toThrow("Use --item");
  expect(calls).toBe(0);
});
