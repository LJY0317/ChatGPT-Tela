import { describe, expect, test } from "bun:test";
import {
  NativeToolInventory,
  type NativeToolDescriptor,
  defineNativeTurnAuthority,
  diagnosticFingerprint,
  observeDiagnosticEvents,
  type NativeToolResult,
} from "@chatgpt-tela/core";
import type { NativeTurnBinding } from "@chatgpt-tela/codex";
import {
  ActiveTurnRegistry,
  acceptNativeResponsesToolResult,
  nextNativeResponsesToolCall,
} from "@chatgpt-tela/runtime";
import { McpTurnBridge } from "./turn-bridge";

function binding(additional: readonly NativeToolDescriptor[] = [], turnId = "turn-1"): NativeTurnBinding {
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
      turnId,
      requestKind: "turn",
      toolObservations: [{ source: "fixture", tools }],
    },
    authority: defineNativeTurnAuthority({
      threadId: "thread-1",
      turnId,
      cwd: "/workspace",
      workspaceRoots: ["/workspace"],
      sandbox: { kind: "read-only", network: "restricted" },
    }),
    tools: NativeToolInventory.fromObservations("thread-1", turnId, [
      { source: "fixture", tools },
    ]),
    canonicalEvidence: {
      threadId: "thread-1",
      turnId,
      cwd: "/workspace",
      workspaceRoots: ["/workspace"],
      sandbox: { kind: "read-only", network: "restricted" },
      proof: "turn-context",
      environmentSourceTurnId: turnId,
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
  const events: Parameters<Parameters<typeof observeDiagnosticEvents>[0]>[0][] = [];
  const stop = observeDiagnosticEvents(event => { events.push(event); });
  try {
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
  const nativeCall = await nextNativeResponsesToolCall(registered.channel);
  expect(nativeCall).toMatchObject({ type: "function_call", name: "update_goal", arguments: JSON.stringify({ status: "complete" }) });
  const body = JSON.stringify({ goal: { status: "complete", objective: "PRIVATE_OBJECTIVE" } });
  acceptNativeResponsesToolResult(registered.channel, { input: [{ type: "function_call_output", call_id: nativeCall.call_id, output: body }] });
  registered.channel.releaseNativeToolResultToWeb(nativeCall.call_id);
  expect(await result).toMatchObject({ callId: "native-complete", content: body, isError: false });
  expect(events.find(event => event.stage === "native_tool_inventory_queried")).toMatchObject({ goal_only: true, count: 1 });
  const returned = events.find(event => event.stage === "native_tool_bridge_invoke_returned");
  expect(returned).toMatchObject({ goal_only: true, goal_tool: true, is_error: false,
    kind: "string", body_present: true, body_bytes: Buffer.byteLength(body), status: "complete",
    operation_fingerprint: diagnosticFingerprint(nativeCall.call_id) });
  const started = events.find(event => event.stage === "native_tool_bridge_invoke_started" && event.goal_tool === true);
  expect(started).toMatchObject({ action: "update", status: "complete",
    parent_fingerprint: diagnosticFingerprint("native-complete"),
    operation_fingerprint: diagnosticFingerprint(nativeCall.call_id) });
  expect(returned?.logical_fingerprint).toBe(started?.logical_fingerprint);
  expect(events.find(event => event.stage === "native_tool_result_received")?.operation_fingerprint)
    .toBe(returned?.operation_fingerprint);
  expect(JSON.stringify(events)).not.toMatch(/PRIVATE_OBJECTIVE|native-complete|update_goal|plugin_get_goal/);
  expect(JSON.stringify(events)).not.toContain(control);
  registered.channel.markWebContinuation();
  registered.channel.complete("finished");
  const next = turns.nextCycle(registered.capability, bound);
  expect(() => bridge.inventory(control)).toThrow("unknown or retired");
  const nextControl = turns.goalControl(next.capability)!;
  turns.retire(next.capability);
  expect(() => bridge.inventory(nextControl)).toThrow("unknown or retired");
  } finally { stop?.(); }
});

test("bridge distinguishes empty, opaque and structured error returns without changing their values", async () => {
  const events: Parameters<Parameters<typeof observeDiagnosticEvents>[0]>[0][] = [];
  const stop = observeDiagnosticEvents(event => { if (event.stage.startsWith("native_tool_bridge_")) events.push(event); });
  const turns = new ActiveTurnRegistry(), registered = turns.register(binding());
  const bridge = new McpTurnBridge(turns);
  try {
    const circular: Record<string, unknown> = {}; circular.self = circular;
    const cases = [
      { content: "", isError: false, expected: { kind: "string", body_present: false, body_bytes: 0 } },
      { content: "비공개 결과", isError: false, expected: { kind: "string", body_present: true, body_bytes: Buffer.byteLength("비공개 결과") } },
      { content: { private: "PRIVATE_BODY" }, isError: true, expected: { kind: "object", body_present: true, body_size_known: true } },
      { content: null, isError: false, expected: { kind: "null", body_present: false } },
      { content: undefined, isError: false, expected: { kind: "undefined", body_present: false, body_size_known: false } },
      { content: circular, isError: false, expected: { kind: "object", body_present: true, body_size_known: false } },
    ];
    let calls = 0;
    for (const [index, fixture] of cases.entries()) {
      const result: NativeToolResult = { callId: `fixture-${index}`, content: fixture.content, isError: fixture.isError };
      registered.channel.requestTool = async () => { calls++; return result; };
      expect(await bridge.invoke(registered.capability, { callId: result.callId, wireName: "exec_command", mode: "structured", arguments: {} })).toBe(result);
      expect(events.at(-1)).toMatchObject({ stage: "native_tool_bridge_invoke_returned", goal_only: false, goal_tool: false,
        is_error: fixture.isError, ...fixture.expected });
    }
    expect(calls).toBe(cases.length);
    expect(events.filter(event => event.stage === "native_tool_bridge_invoke_failed")).toHaveLength(0);
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE_BODY|비공개 결과|exec_command|fixture-/);
  } finally { stop?.(); }
});

test("diagnostic projection and sink failures preserve success and original synchronous/asynchronous errors", async () => {
  const events: Parameters<Parameters<typeof observeDiagnosticEvents>[0]>[0][] = [];
  const stop = observeDiagnosticEvents(event => { events.push(event); throw Error("PRIVATE_SINK"); });
  const turns = new ActiveTurnRegistry(), registered = turns.register(binding());
  const bridge = new McpTurnBridge(turns);
  const invocation = { callId: "fixture-call", wireName: "exec_command", mode: "structured" as const, arguments: {} };
  try {
    const result = { callId: invocation.callId, get content(): unknown { throw Error("PRIVATE_PROJECTION"); }, isError: false };
    registered.channel.requestTool = async () => result;
    expect(await bridge.invoke(registered.capability, invocation)).toBe(result);
    // Invalid diagnostic correlation must not prevent the original request either.
    expect(await bridge.invoke(registered.capability, { ...invocation, callId: "" })).toBe(result);
    expect(bridge.inventory(registered.capability)).toHaveLength(1);
    const failure = new Error("PRIVATE_FAILURE");
    for (const synchronous of [true, false]) {
      registered.channel.requestTool = () => { if (synchronous) throw failure; return Promise.reject(failure); };
      let caught: unknown;
      try { await bridge.invoke(registered.capability, invocation); } catch (error) { caught = error; }
      expect(caught).toBe(failure);
    }
    expect(events.filter(event => event.stage === "native_tool_bridge_invoke_failed")).toHaveLength(2);
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE_/);
  } finally { stop?.(); }
});

test("turns without original Goal controls do not advertise a completion capability", () => {
  const turns = new ActiveTurnRegistry(), registered = turns.register(binding());
  expect(turns.goalControl(registered.capability)).toBeUndefined();
});

 test("repeated Goal caller IDs in later turns cannot collide with historical Native results", async () => {
  const turns = new ActiveTurnRegistry(), bridge = new McpTurnBridge(turns);
  let previousId: string | undefined;
  for (const turnId of ["first-turn", "second-turn"]) {
    const registered = turns.register(binding([{ wireName: "get_goal", name: "get_goal", kind: "function", description: "Read goal" }], turnId));
    registered.channel.markSubmitted(); registered.channel.markAccepted();
    const waiting = bridge.invoke(turns.goalControl(registered.capability)!, { callId: "goal-1", wireName: "get_goal", mode: "structured", arguments: {} });
    const nativeCall = await nextNativeResponsesToolCall(registered.channel);
    expect(nativeCall.call_id).not.toBe(previousId);
    acceptNativeResponsesToolResult(registered.channel, { input: [
      ...(previousId ? [{ type: "function_call_output", call_id: previousId, output: "historical" }] : []),
      { type: "function_call_output", call_id: nativeCall.call_id, output: "current" },
    ] });
    registered.channel.releaseNativeToolResultToWeb(nativeCall.call_id);
    expect(await waiting).toMatchObject({ callId: "goal-1", content: "current" });
    registered.channel.markWebContinuation(); registered.channel.complete("done");
    turns.retire(registered.capability); previousId = nativeCall.call_id;
  }
});
