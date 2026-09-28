import { describe, expect, test } from "bun:test";
import {
  NativeToolInventory,
  defineNativeTurnAuthority,
  type NativeToolDescriptor,
} from "@chatgpt-tela/core";
import type { NativeTurnBinding } from "@chatgpt-tela/codex";
import { RuntimeTurnChannel } from "./turn-channel";
import {
  acceptBoundNativeRoundRequest,
  acceptNativeResponsesToolResult,
  nextNativeResponsesToolCall,
} from "./native-round";

function binding(tools: readonly NativeToolDescriptor[] = [{
    wireName: "github__search",
    name: "search",
    namespace: "github",
    description: "search",
    kind: "function" as const,
    inputSchema: { type: "object" },
  }]): NativeTurnBinding {
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

describe("Native Responses tool round", () => {
  test("encodes the exact outstanding call and accepts only its matching later result", async () => {
    const channel = new RuntimeTurnChannel(binding());
    channel.markSubmitted();
    channel.markAccepted();
    const waitingWeb = channel.requestTool({
      callId: "call-1",
      wireName: "github__search",
      mode: "structured",
      arguments: { query: "ChatGPT Tela" },
    });

    expect(await nextNativeResponsesToolCall(channel)).toEqual({
      type: "function_call",
      call_id: "call-1",
      name: "search",
      namespace: "github",
      arguments: JSON.stringify({ query: "ChatGPT Tela" }),
    });

    acceptNativeResponsesToolResult(channel, {
      input: [
        { type: "function_call_output", call_id: "old-call", output: "old" },
        { type: "function_call_output", call_id: "call-1", output: "result" },
      ],
    });
    channel.releaseNativeToolResultToWeb("call-1");
    expect(await waitingWeb).toEqual({ callId: "call-1", content: "result", isError: false });
  });

  test("fails closed when the outstanding result is missing or duplicated", async () => {
    const channel = new RuntimeTurnChannel(binding());
    channel.markSubmitted();
    channel.markAccepted();
    void channel.requestTool({
      callId: "call-1",
      wireName: "github__search",
      mode: "structured",
      arguments: {},
    });

    expect(() => acceptNativeResponsesToolResult(channel, {
      input: [{ type: "function_call_output", call_id: "different", output: "no" }],
    })).toThrow("does not contain");
    expect(() => acceptNativeResponsesToolResult(channel, {
      input: [
        { type: "function_call_output", call_id: "call-1", output: "one" },
        { type: "function_call_output", call_id: "call-1", output: "two" },
      ],
    })).toThrow("repeats");
  });

  test("a canonically rebound tool_search result refreshes the same turn inventory", async () => {
    const discovery: NativeToolDescriptor = {
      wireName: "tool_search",
      name: "tool_search",
      description: "discover tools",
      kind: "discovery",
      inputSchema: { type: "object" },
    };
    const deferred: NativeToolDescriptor = {
      wireName: "github__search",
      name: "search",
      namespace: "github",
      description: "search",
      kind: "function",
      inputSchema: { type: "object" },
    };
    const channel = new RuntimeTurnChannel(binding([discovery]));
    channel.markSubmitted();
    channel.markAccepted();
    const waitingSearch = channel.requestTool({
      callId: "search-1",
      wireName: "tool_search",
      mode: "structured",
      arguments: { query: "github" },
    });

    expect(await nextNativeResponsesToolCall(channel)).toEqual({
      type: "tool_search_call",
      call_id: "search-1",
      arguments: { query: "github" },
    });

    acceptBoundNativeRoundRequest(channel, binding([discovery, deferred]), {
      input: [{
        type: "tool_search_output",
        call_id: "search-1",
        status: "completed",
        tools: [{
          type: "namespace",
          name: "github",
          tools: [{ type: "function", name: "search", description: "search" }],
        }],
      }],
    });
    channel.releaseNativeToolResultToWeb("search-1");
    expect((await waitingSearch).isError).toBe(false);
    expect(channel.binding.tools.exact("github__search")?.namespace).toBe("github");

    channel.markWebContinuation();
    const waitingDeferred = channel.requestTool({
      callId: "call-2",
      wireName: "github__search",
      mode: "structured",
      arguments: { query: "ChatGPT Tela" },
    });
    expect(channel.outstandingToolCallId).toBe("call-2");
    channel.deliverNativeToolResult({ callId: "call-2", content: "ok", isError: false });
    channel.releaseNativeToolResultToWeb("call-2");
    expect((await waitingDeferred).content).toBe("ok");
  });
});
