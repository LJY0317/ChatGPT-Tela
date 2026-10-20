import { describe, expect, test } from "bun:test";
import {
  NativeToolInventory,
  type NativeToolDescriptor,
  defineNativeTurnAuthority,
} from "@chatgpt-tela/core";
import type { NativeTurnBinding } from "@chatgpt-tela/codex";
import {
  ActiveTurnRegistry,
  acceptNativeResponsesToolResult,
  nextNativeResponsesToolCall,
} from "@chatgpt-tela/runtime";
import { McpTurnBridge } from "./turn-bridge";

function binding(additional: readonly NativeToolDescriptor[] = []): NativeTurnBinding {
  const tools = [{
    wireName: "exec_command",
    name: "exec_command",
    description: "Execute a command",
    kind: "function" as const,
    inputSchema: { type: "object" },
  }, ...additional];
  return {
    claim: {
      threadId: "thread-1",
      turnId: "turn-1",
      requestKind: "turn",
      toolObservations: [{ source: "fixture", tools }],
    },
    authority: defineNativeTurnAuthority({
      threadId: "thread-1",
      turnId: "turn-1",
      cwd: "/workspace",
      workspaceRoots: ["/workspace"],
      sandbox: { kind: "read-only", network: "restricted" },
    }),
    tools: NativeToolInventory.fromObservations("thread-1", "turn-1", [
      { source: "fixture", tools },
    ]),
    canonicalEvidence: {
      threadId: "thread-1",
      turnId: "turn-1",
      cwd: "/workspace",
      workspaceRoots: ["/workspace"],
      sandbox: { kind: "read-only", network: "restricted" },
      proof: "turn-context",
      environmentSourceTurnId: "turn-1",
    },
  };
}

describe("internal MCP turn bridge", () => {
  test("projects the exact active-turn inventory and relays one call through Native Responses", async () => {
    const turns = new ActiveTurnRegistry();
    const registered = turns.register(binding());
    const bridge = new McpTurnBridge(turns);
    registered.channel.markSubmitted();
    registered.channel.markAccepted();

    expect(bridge.inventory(registered.capability, "command").map(tool => tool.wireName))
      .toEqual(["exec_command"]);

    const waitingMcp = bridge.invoke(registered.capability, {
      callId: "call-1",
      wireName: "exec_command",
      mode: "structured",
      arguments: { cmd: ["printf", "ok"] },
    });
    expect(await nextNativeResponsesToolCall(registered.channel)).toEqual({
      type: "function_call",
      call_id: "call-1",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: ["printf", "ok"] }),
    });

    acceptNativeResponsesToolResult(registered.channel, {
      input: [{ type: "function_call_output", call_id: "call-1", output: "ok" }],
    });
    registered.channel.releaseNativeToolResultToWeb("call-1");
    expect(await waitingMcp).toEqual({ callId: "call-1", content: "ok", isError: false });
  });

  test("retired capabilities cannot access another turn by readable identity", () => {
    const turns = new ActiveTurnRegistry();
    const registered = turns.register(binding());
    const bridge = new McpTurnBridge(turns);
    turns.retire(registered.capability);

    expect(() => bridge.inventory(registered.capability)).toThrow("unknown or retired");
    expect(() => bridge.inventory("thread-1")).toThrow("unknown or retired");
  });
});

test("Goal-only capability reuses Native tool delivery and expires with its response cycle", async () => {
  const turns = new ActiveTurnRegistry({ routeId: "GoalRoute" });
  const bound = binding([
    { wireName: "update_goal", name: "update_goal", namespace: "functions", kind: "function",
      description: "Update the current Native Goal", inputSchema: { type: "object", properties: { status: { enum: ["complete"] } }, required: ["status"], additionalProperties: false } },
    { wireName: "plugin_get_goal", name: "get_goal", namespace: "plugin", kind: "function", description: "Unrelated tool" },
  ]);
  const registered = turns.register(bound), bridge = new McpTurnBridge(turns);
  const control = turns.goalControl(registered.capability)!;
  expect(control).not.toBe(registered.capability);
  expect(turns.goalControl(registered.capability)).toBe(control);
  expect(bridge.inventory(control).map(tool => tool.wireName)).toEqual(["update_goal"]);
  expect(() => turns.resolve(control)).toThrow("unknown or retired");
  expect(() => bridge.invoke(control, { callId: "no-work", wireName: "exec_command", mode: "structured", arguments: {} }))
    .toThrow("cannot invoke Native work tools");
  registered.channel.markSubmitted(); registered.channel.markAccepted();
  const result = bridge.invoke(control, { callId: "native-complete", wireName: "update_goal", mode: "structured", arguments: { status: "complete" } });
  expect(await nextNativeResponsesToolCall(registered.channel)).toMatchObject({
    type: "function_call", name: "update_goal", arguments: JSON.stringify({ status: "complete" }),
  });
  acceptNativeResponsesToolResult(registered.channel, { input: [{ type: "function_call_output", call_id: "native-complete", output: "native-goal-result" }] });
  registered.channel.releaseNativeToolResultToWeb("native-complete");
  expect(await result).toMatchObject({ content: "native-goal-result", isError: false });
  registered.channel.markWebContinuation();
  registered.channel.complete("finished");
  const next = turns.nextCycle(registered.capability, bound);
  expect(() => bridge.inventory(control)).toThrow("unknown or retired");
  const nextControl = turns.goalControl(next.capability)!;
  turns.retire(next.capability);
  expect(() => bridge.inventory(nextControl)).toThrow("unknown or retired");
});

test("turns without original Goal controls do not advertise a completion capability", () => {
  const turns = new ActiveTurnRegistry(), registered = turns.register(binding());
  expect(turns.goalControl(registered.capability)).toBeUndefined();
});
