import { expect, test } from "bun:test";
import { NativeToolInventory, defineNativeTurnAuthority } from "@chatgpt-tela/core";
import type { NativeTurnBinding } from "@chatgpt-tela/codex";
import {
  ActiveTurnRegistry,
  turnCapabilityRoute,
} from "./registry";

function binding(): NativeTurnBinding {
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
      toolObservations: [],
    },
    authority,
    tools: NativeToolInventory.fromObservations("thread-1", "turn-1", []),
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

test("active turn registry issues opaque single-owner capabilities", () => {
  const registry = new ActiveTurnRegistry();
  const registered = registry.register(binding());

  expect(registered.capability).toMatch(/^turn_[A-Za-z0-9_-]{40,}$/);
  expect(registry.resolve(registered.capability)).toBe(registered.channel);
  expect(() => registry.register(binding())).toThrow("already has an active runtime owner");

  registry.retire(registered.capability);
  expect(registry.size).toBe(0);
  expect(registry.isRetired("thread-1", "turn-1")).toBe(true);
  expect(registry.isRetired("thread-1", "another-turn")).toBe(false);
  expect(registry.isRetired("another-thread", "turn-1")).toBe(false);
  expect(() => registry.resolve(registered.capability)).toThrow("unknown or retired");
  try {
    registry.register(binding());
    throw new Error("Retired turn was incorrectly re-registered");
  } catch (error) {
    expect(error).toMatchObject({code: "tela_native_turn_already_retired"});
  }
});

test("registry shutdown cancels and retires every active turn", async () => {
  const registry = new ActiveTurnRegistry();
  const registered = registry.register(binding());
  registered.channel.markSubmitted();
  registered.channel.markAccepted();
  const final = registered.channel.waitForFinal();

  registry.cancelAll(new Error("shutdown"));

  expect(registry.size).toBe(0);
  await expect(final).rejects.toThrow("shutdown");
  expect(() => registry.resolve(registered.capability)).toThrow("unknown or retired");
  expect(() => registry.register(binding())).toThrow("already retired");
});

test("product registries may namespace opaque capabilities for cross-process routing", () => {
  const registry = new ActiveTurnRegistry({ routeId: "Ab12Cd34" });
  const registered = registry.register(binding());

  expect(registered.capability).toMatch(/^turnr_Ab12Cd34_[A-Za-z0-9_-]{40,}$/);
  expect(turnCapabilityRoute(registered.capability)).toBe("Ab12Cd34");
  expect(turnCapabilityRoute("turn_legacyOpaqueCapability0123456789012345678901234567890123456789"))
    .toBeUndefined();
  expect(() => new ActiveTurnRegistry({ routeId: "bad-route" })).toThrow("8-32 ASCII alphanumeric");
});

test("response cycle rotation revokes the old capability and retains Native-wide tool call deduplication", async () => {
  const registry = new ActiveTurnRegistry(), original = binding();
  const bound = { ...original, tools: NativeToolInventory.fromObservations("thread-1", "turn-1", [
    { source: "fixture", tools: [{ wireName: "fixture_tool", name: "fixture_tool", description: "Synthetic fixture tool", kind: "function", inputSchema: { type: "object" } }] },
  ]) };
  const first = registry.register(bound), channel = first.channel;
  channel.markSubmitted(); channel.markAccepted();
  const invocation = { callId: "used-call", wireName: "fixture_tool", mode: "structured" as const, arguments: {} };
  const pending = channel.requestTool(invocation);
  channel.markNativeToolDelivered("used-call");
  channel.deliverNativeToolResult({ callId: "used-call", content: "synthetic result", isError: false });
  channel.releaseNativeToolResultToWeb("used-call"); await pending;
  channel.markWebContinuation(); channel.complete("done");
  const next = registry.nextCycle(first.capability, bound);
  expect(() => registry.resolve(first.capability)).toThrow("retired turn capability");
  expect(next.capability).not.toBe(first.capability);
  next.channel.markSubmitted(); next.channel.markAccepted();
  expect(() => next.channel.requestTool(invocation)).toThrow("already used");
  registry.cancelAll();
});
