import { expect, test } from "bun:test";
import { runDelegationHook } from "./delegation-hook";

const closed = { hook_event_name: "PostToolUse", tool_name: "multi_agent_v1close_agent", tool_input: { target: "child" } };
test("the close hook requests only existing retention reconciliation, without a model turn or receipt claim", async () => {
  const calls: unknown[] = [];
  const input = { client: { async manageDelegation(request: any) { calls.push(request); return {}; } } };
  expect(await runDelegationHook(JSON.stringify(closed), input)).toBe(true);
  expect(calls).toEqual([{ action: "reconcile" }]);
  expect(await runDelegationHook(JSON.stringify({ ...closed, tool_name: "wait_agent" }), input)).toBe(false);
  expect(await runDelegationHook(JSON.stringify({ ...closed, hook_event_name: "SubagentStop" }), input)).toBe(false);
  expect(await runDelegationHook(JSON.stringify({ ...closed, tool_input: {} }), input)).toBe(false);
  expect(calls).toHaveLength(1);
});

test("invalid input or unavailable Tela never makes the Native close operation fail", async () => {
  expect(await runDelegationHook("not json")).toBe(false);
  expect(await runDelegationHook(JSON.stringify(closed), { client: { async manageDelegation() { throw Error("unavailable"); } } })).toBe(false);
});
