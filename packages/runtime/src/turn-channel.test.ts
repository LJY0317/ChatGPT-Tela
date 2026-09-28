import { describe, expect, test } from "bun:test";
import {
  NativeToolInventory,
  defineNativeTurnAuthority,
  type NativeToolDescriptor,
} from "@chatgpt-tela/core";
import type { NativeTurnBinding } from "@chatgpt-tela/codex";
import { RuntimeTurnChannel } from "./turn-channel";

function tool(
  wireName: string,
  kind: NativeToolDescriptor["kind"] = "function",
): NativeToolDescriptor {
  return {
    wireName,
    name: wireName,
    description: wireName,
    kind,
    inputSchema: { type: "object" },
  };
}

function binding(tools: readonly NativeToolDescriptor[] = [tool("exec_command")]): NativeTurnBinding {
  const authority = defineNativeTurnAuthority({
    threadId: "thread-1",
    turnId: "turn-1",
    cwd: "/workspace",
    workspaceRoots: ["/workspace"],
    sandbox: { kind: "read-only", network: "restricted" },
  });
  return {
    claim: {
      threadId: "thread-1",
      turnId: "turn-1",
      requestKind: "turn",
      toolObservations: [{ source: "fixture", tools }],
    },
    authority,
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

describe("runtime turn channel", () => {
  test("carries one causal tool round through same-turn continuation to final", async () => {
    const channel = new RuntimeTurnChannel(binding());
    channel.markSubmitted();
    channel.markAccepted();

    const waitingNative = channel.nextNativeTool();
    const waitingWeb = channel.requestTool({
      callId: "call-1",
      wireName: "exec_command",
      mode: "structured",
      arguments: { cmd: ["printf", "ok"] },
    });

    expect(await waitingNative).toEqual({
      callId: "call-1",
      wireName: "exec_command",
      mode: "structured",
      arguments: { cmd: ["printf", "ok"] },
    });
    expect(channel.phase).toBe("tool-wait");

    channel.deliverNativeToolResult({
      callId: "call-1",
      content: "ok",
      isError: false,
    });
    channel.releaseNativeToolResultToWeb("call-1");
    expect(await waitingWeb).toEqual({ callId: "call-1", content: "ok", isError: false });
    expect(channel.phase).toBe("tool-result-delivered");
    expect(() => channel.complete("too early")).toThrow("continuation is proven");

    channel.markWebContinuation();
    channel.complete("done");
    expect(await channel.waitForFinal()).toBe("done");
    expect(channel.phase).toBe("completed");
    expect(channel.toolRoundCount).toBe(1);
  });

  test("does not permit an accepted turn to be submitted again", () => {
    const channel = new RuntimeTurnChannel(binding());
    channel.markSubmitted();
    channel.markAccepted();
    expect(() => channel.markSubmitted()).toThrow("invalid turn transition");
  });

  test("enforces the exact advertised tool semantics", () => {
    const channel = new RuntimeTurnChannel(binding([
      tool("apply_patch", "freeform"),
      tool("future_tool", "other"),
    ]));
    channel.markSubmitted();
    channel.markAccepted();

    expect(() => channel.requestTool({
      callId: "call-1",
      wireName: "apply_patch",
      mode: "structured",
      arguments: { input: "patch" },
    })).toThrow("requires raw input");
    expect(() => channel.requestTool({
      callId: "call-2",
      wireName: "future_tool",
      mode: "structured",
      arguments: {},
    })).toThrow("semantics are not yet executable");
    expect(channel.phase).toBe("accepted");
  });

  test("a used call id cannot be replayed into the same turn", async () => {
    const channel = new RuntimeTurnChannel(binding());
    channel.markSubmitted();
    channel.markAccepted();
    const result = channel.requestTool({
      callId: "call-1",
      wireName: "exec_command",
      mode: "structured",
      arguments: {},
    });
    channel.deliverNativeToolResult({ callId: "call-1", content: "ok", isError: false });
    channel.releaseNativeToolResultToWeb("call-1");
    await result;
    channel.markWebContinuation();

    expect(() => channel.requestTool({
      callId: "call-1",
      wireName: "exec_command",
      mode: "structured",
      arguments: {},
    })).toThrow("already used");
  });

  test("committed Native tool delivery is not emitted again while its result is pending", async () => {
    const channel = new RuntimeTurnChannel(binding());
    channel.markSubmitted();
    channel.markAccepted();
    const waitingWeb = channel.requestTool({
      callId: "call-1",
      wireName: "exec_command",
      mode: "structured",
      arguments: {},
    });

    expect((await channel.nextNativeTool()).callId).toBe("call-1");
    channel.markNativeToolDelivered("call-1");
    expect(channel.outstandingNativeDelivery).toBe("delivered");
    const controller = new AbortController();
    const next = channel.nextNativeTool(controller.signal);
    controller.abort();
    await expect(next).rejects.toMatchObject({ name: "AbortError" });

    channel.deliverNativeToolResult({ callId: "call-1", content: "ok", isError: false });
    channel.releaseNativeToolResultToWeb("call-1");
    await waitingWeb;
  });

  test("state changes are event-driven and include the exact outstanding tool boundary", async () => {
    const channel = new RuntimeTurnChannel(binding());
    channel.markSubmitted();
    channel.markAccepted();
    const revision = channel.stateRevision;
    const waiting = channel.waitForStateChange(revision);

    const result = channel.requestTool({
      callId: "call-1",
      wireName: "exec_command",
      mode: "structured",
      arguments: {},
    });
    expect(await waiting).toEqual({
      revision: revision + 1,
      phase: "tool-wait",
      toolRoundCount: 1,
      outstandingToolCallId: "call-1",
      outstandingNativeDelivery: "queued",
      nativeResultReady: false,
    });

    const deliveryRevision = channel.stateRevision;
    channel.markNativeToolDelivered("call-1");
    expect(channel.state()).toEqual({
      revision: deliveryRevision + 1,
      phase: "tool-wait",
      toolRoundCount: 1,
      outstandingToolCallId: "call-1",
      outstandingNativeDelivery: "delivered",
      nativeResultReady: false,
    });
    channel.deliverNativeToolResult({ callId: "call-1", content: "ok", isError: false });
    expect(channel.state()).toMatchObject({
      phase: "tool-result-delivered",
      outstandingToolCallId: "call-1",
      nativeResultReady: true,
    });
    channel.releaseNativeToolResultToWeb("call-1");
    await result;
  });

  test("aborting a turn-state wait removes it without changing turn state", async () => {
    const channel = new RuntimeTurnChannel(binding());
    const controller = new AbortController();
    const waiting = channel.waitForStateChange(channel.stateRevision, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(channel.state()).toEqual({ revision: 0, phase: "prepared", toolRoundCount: 0 });
  });
});
