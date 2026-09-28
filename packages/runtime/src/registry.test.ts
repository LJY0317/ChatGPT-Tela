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
  expect(() => registry.resolve(registered.capability)).toThrow("unknown or retired");
  expect(() => registry.register(binding())).toThrow("already retired");
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
