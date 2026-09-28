import {
  encodeNativeToolInvocation,
  extractNativeToolResults,
  type NativeTurnBinding,
  type NativeResponsesToolCallItem,
} from "@chatgpt-tela/codex";
import type { RuntimeTurnChannel } from "./turn-channel";

/**
 * Wait for the next Web/MCP-requested tool call and encode it for the exact bound Native turn.
 * The descriptor lookup comes from the current-turn inventory, never from the wire name alone.
 */
export async function nextNativeResponsesToolCall(
  channel: RuntimeTurnChannel,
  signal?: AbortSignal,
): Promise<NativeResponsesToolCallItem> {
  const invocation = await channel.nextNativeTool(signal);
  const tool = channel.binding.tools.exact(invocation.wireName);
  if (!tool) throw new Error("runtime queued a tool that is absent from the bound Native inventory");
  return encodeNativeToolInvocation(tool, invocation);
}

/**
 * Deliver exactly one Native result into the currently outstanding runtime call.
 * A later Native request may replay older result items, so only the outstanding call id is accepted;
 * zero or multiple matching results fail closed instead of guessing by position.
 */
export function acceptNativeResponsesToolResult(
  channel: RuntimeTurnChannel,
  body: unknown,
): void {
  const outstanding = channel.outstandingToolCallId;
  if (!outstanding) throw new Error("turn has no outstanding Native tool call");
  const matches = extractNativeToolResults(body).filter(result => result.callId === outstanding);
  if (matches.length === 0) throw new Error("Native request does not contain the outstanding tool result");
  if (matches.length > 1) throw new Error("Native request repeats the outstanding tool result");
  channel.deliverNativeToolResult(matches[0]!);
}

/**
 * Apply a canonically rebound follow-up request for the same Native turn. Identity is checked before
 * consuming the outstanding result; the newly advertised tool inventory replaces the old projection
 * only after that result is delivered.
 */
export function acceptBoundNativeRoundRequest(
  channel: RuntimeTurnChannel,
  binding: NativeTurnBinding,
  body: unknown,
): void {
  const current = channel.binding.authority;
  if (binding.authority.threadId !== current.threadId || binding.authority.turnId !== current.turnId) {
    throw new Error("Native round binding does not belong to the active turn");
  }
  acceptNativeResponsesToolResult(channel, body);
  channel.refreshBinding(binding);
}
