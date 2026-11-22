import { expect, test } from "bun:test";
import { runDelegationCommand } from "./delegation-command";

test("same-chat follow-up forwards one coordinator-owned assignment to the service", async () => {
  const requests: unknown[] = [];
  const input = { environment: { CODEX_THREAD_ID: "parent" }, readPrompt: async () => "Continue analysis",
    client: { async manageDelegation() { return {}; }, async submitWebFollowUp(value: unknown) {
      requests.push(value); return { status: "accepted" };
    } } };
  expect(await runDelegationCommand(["follow-up-web-delegation", "--thread", "child", "--slot", "2"], input))
    .toEqual({ sourceThreadId: "parent", slot: 2, status: "accepted" });
  await runDelegationCommand(["follow-up-web-delegation", "--thread", "child", "--slot", "2", "--wait"], input);
  expect(requests).toEqual([
    { slot: 2, coordinatorThreadId: "parent", threadId: "child", prompt: "Continue analysis" },
    { slot: 2, coordinatorThreadId: "parent", threadId: "child", prompt: "Continue analysis", wait: true },
  ]);
  await expect(runDelegationCommand(["follow-up-web-delegation", "--thread", "child", "--slot", "2"],
    { ...input, environment: {} })).rejects.toThrow("coordinating Native chat");
  await expect(runDelegationCommand(["follow-up-web-delegation", "--thread", "child", "--slot", "2"],
    { ...input, readPrompt: async () => " " })).rejects.toThrow("standard input");
});

test("source and packaged delegation command binds the Native parent and exact selected profile", async () => {
  const requests: unknown[] = [];
  const input = { environment: { CODEX_THREAD_ID: "parent" }, client: { async manageDelegation(value: any) { requests.push(value); return { accepted: true }; } } };
  await runDelegationCommand(["retain-delegation", "--thread", "child", "--slot", "2"], input);
  await runDelegationCommand(["list-delegations", "--slot", "2"], input);
  await runDelegationCommand(["read-delegation-result", "--thread", "child", "--slot", "2", "--previous-before", "follow-up"], input);
  await runDelegationCommand(["read-delegation-result", "--thread", "child", "--slot", "2", "--turn", "exact-follow-up"], input);
  await runDelegationCommand(["acknowledge-result", "--thread", "child", "--turn", "turn", "--item", "final", "--slot", "2"], input);
  await runDelegationCommand(["acknowledge-result", "--thread", "child", "--turn", "turn", "--outcome", "interrupted"], input);
  await runDelegationCommand(["reconcile-delegations", "--slot", "2"], input);
  await runDelegationCommand(["retain-delegation", "--standalone", "--thread", "independent", "--slot", "1"], input);
  await runDelegationCommand(["read-delegation-result", "--standalone", "--thread", "independent", "--slot", "1"], input);
  expect(requests).toEqual([
    { action: "enroll", slot: 2, parentThreadId: "parent", threadId: "child" },
    { action: "list-tracked", slot: 2, parentThreadId: "parent" },
    { action: "read-result", slot: 2, parentThreadId: "parent", threadId: "child", previousBefore: "follow-up" },
    { action: "read-result", slot: 2, parentThreadId: "parent", threadId: "child", expectedTurnId: "exact-follow-up" },
    { action: "acknowledge", slot: 2, parentThreadId: "parent", threadId: "child", turnId: "turn", outcome: "answer", itemId: "final" },
    { action: "acknowledge", slot: 1, parentThreadId: "parent", threadId: "child", turnId: "turn", outcome: "interrupted" },
    { action: "reconcile", slot: 2 },
    { action: "enroll", standalone: true, threadId: "independent", slot: 1 },
    { action: "read-result", standalone: true, threadId: "independent", slot: 1 },
  ]);
});

test("invalid Native context or result cannot invoke or start a service", async () => {
  let calls = 0;
  const input = { environment: {}, client: { async manageDelegation() { calls++; } } };
  await expect(runDelegationCommand(["retain-delegation", "--thread", "child"], input)).rejects.toThrow("coordinating Native");
  await expect(runDelegationCommand(["retain-delegation", "--standalone", "--thread", "child"], input)).rejects.toThrow("explicit --slot");
  await expect(runDelegationCommand(["acknowledge-result"], { ...input, environment: { CODEX_THREAD_ID: "parent" } })).rejects.toThrow("requires --thread");
  await expect(runDelegationCommand(["acknowledge-result", "--thread", "child", "--turn", "turn", "--outcome", "failed", "--item", "final"], { ...input, environment: { CODEX_THREAD_ID: "parent" } })).rejects.toThrow("Use --item");
  await expect(runDelegationCommand(["list-delegations"], input)).rejects.toThrow("coordinating Native");
  expect(calls).toBe(0);
});


test("lifecycle reconciliation covers enrolled profiles without an unavailable Desktop PID", async () => {
  const requests: unknown[] = [];
  const input = { client: { async manageDelegation(value: any) { requests.push(value); return {}; } } };
  await runDelegationCommand(["reconcile-delegations", "--all"], input);
  expect(requests).toEqual([{ action: "reconcile" }]);
  await expect(runDelegationCommand(["reconcile-delegations", "--all", "--slot", "2"], input)).rejects.toThrow("--all");
  await expect(runDelegationCommand(["retain-delegation", "--all"], input)).rejects.toThrow("--all");
});
