import { describe, expect, test } from "bun:test";
import {
  NativeToolInventory,
  defineNativeTurnAuthority,
} from "@chatgpt-tela/core";
import type { NativeTurnBinding } from "@chatgpt-tela/codex";
import {
  ActiveTurnRegistry,
  acceptNativeResponsesToolResult,
  nextNativeResponsesToolCall,
} from "@chatgpt-tela/runtime";
import { McpTurnBridge } from "./turn-bridge";

function binding(): NativeTurnBinding {
  const tools = [{
    wireName: "exec_command",
    name: "exec_command",
    description: "Execute a command",
    kind: "function" as const,
    inputSchema: { type: "object" },
  }];
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
