import { describe, expect, test } from "bun:test";
import {
  CONTEXT_HISTORY_TOOL,
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
import { startCodexBridgeMcpHttpServer } from "./http-server";
import { connectCodexTurnBridge } from "./remote-turn-bridge";

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


test("selected history reads use the original source without Native work inventory or tool rounds", async () => {
  const turns = new ActiveTurnRegistry({ routeId: "ReadOnly1" });
  const calls: unknown[] = [];
  const owner = turns.register({ ...binding(), async readHistoryPage(selection) {
    calls.push(selection);
    return { data: [
      { turnId: "past", item: { id: "user", type: "userMessage", content: [
        { type: "inputText", text: "prior request" },
        { type: "localImage", path: "/private/image.png" },
      ] } },
      { turnId: "past", item: { id: "answer", type: "agentMessage", text: "prior answer" } },
      { turnId: "past", item: { id: "reason", type: "reasoning", encryptedContent: "private-reasoning" } },
    ], nextCursor: "next-page" };
  } });
  const control = turns.historyControl(owner.capability, ["past"], new AbortController().signal)!;
  expect(control).toStartWith("turnr_ReadOnly1_");
  const bridge = new McpTurnBridge(turns);
  const invoke = (token: string, arguments_: Record<string, unknown>) => bridge.invoke(token, {
    callId: "read", wireName: CONTEXT_HISTORY_TOOL.wireName, mode: "structured", arguments: arguments_,
  });
  expect(() => bridge.inventory(control)).toThrow("unknown or retired");
  expect(() => bridge.invoke(control, { callId: "work", wireName: "exec_command", mode: "structured", arguments: {} }))
    .toThrow("unknown or retired");
  await expect(invoke(owner.capability, { turn_id: "past" })).rejects.toThrow("outside the selected");
  await expect(invoke(control, { turn_id: "foreign" })).rejects.toThrow("outside the selected");
  expect(() => invoke(control, { turn_id: "past", thread_id: "foreign" })).toThrow("invalid history");
  const server = await startCodexBridgeMcpHttpServer({ turns });
  const remote = await connectCodexTurnBridge({ endpoint: server.endpointUrl, bearerToken: server.bearerToken! });
  let result: NativeToolResult;
  try {
    result = await remote.invoke(control, { callId: "read", wireName: CONTEXT_HISTORY_TOOL.wireName,
      mode: "structured", arguments: { turn_id: "past", cursor: { type: "item", itemId: "before" } } });
  } finally { await remote.close(); await server.stop(); }
  expect(calls).toEqual([{ turnId: "past", limit: 4, cursor: { type: "item", itemId: "before" } }]);
  const readback = JSON.parse(result.content as string);
  expect({ ...result, content: readback }).toMatchObject({ callId: "read", isError: false, content: {
    type: "native_history_page", role: "historical-evidence", continuation: { cursor: "next-page" },
  } });
  expect(JSON.parse(readback.text)).toMatchObject({ data: expect.any(Array) });
  const text = JSON.stringify(result);
  expect(text).toContain("prior answer");
  expect(text).toContain("not_transferred");
  expect(text).not.toContain("/private/image.png");
  expect(text).not.toContain("private-reasoning");
  expect(owner.channel.state().toolRoundCount).toBe(0);
  expect(owner.channel.releasedToolResultBytes).toBe(Buffer.byteLength(result.content as string));
  turns.retire(owner.capability);
  await expect(invoke(control, { turn_id: "past" })).rejects.toThrow("outside the selected");
});

test("late original-history reads cannot cross a response-cycle boundary", async () => {
  const turns = new ActiveTurnRegistry();
  let release!: () => void, reads = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const bound = { ...binding(), async readHistoryPage() {
    reads++; await pending;
    return { data: [{ turnId: "past", item: { id: "old", type: "agentMessage", text: "old result" } }], nextCursor: null };
  } };
  const owner = turns.register(bound);
  const signal = new AbortController();
  const control = turns.historyControl(owner.capability, ["past"], signal.signal)!;
  const reading = turns.readHistoryPage(control, { turnId: "past" });
  owner.channel.markSubmitted(); owner.channel.markAccepted(); owner.channel.complete("done");
  turns.nextCycle(owner.capability, bound);
  release();
  await expect(reading).rejects.toThrow("no longer active");
  expect(reads).toBe(1);
  const next = turns.active("thread-1", "turn-1")!;
  const aborted = turns.historyControl(next.capability, ["past"], signal.signal)!;
  signal.abort();
  await expect(turns.readHistoryPage(aborted, { turnId: "past" })).rejects.toThrow();
  expect(reads).toBe(1);
  turns.cancelAll();
});
