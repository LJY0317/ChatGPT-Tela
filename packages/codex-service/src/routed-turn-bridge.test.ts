import { describe, expect, test } from "bun:test";
import type { NativeToolInvocation } from "@chatgpt-tela/core";
import type { RemoteTurnBridge } from "@chatgpt-tela/mcp";
import { RoutedCodexTurnBridge } from "./routed-turn-bridge";

function child(label: string, events: string[]): RemoteTurnBridge {
  return {
    async inventory(capability, query = "") {
      events.push(`${label}:inventory:${capability}:${query}`);
      return [{ wireName: "dynamic-shell-name", name: "dynamic-shell-name", kind: "function",
        description: "runtime observed tool", observedFrom: [label] }];
    },
    async invoke(capability: string, invocation: NativeToolInvocation) {
      events.push(`${label}:invoke:${capability}:${invocation.callId}`);
      return { callId: invocation.callId, content: `${label}-ok`, isError: false };
    },
    async close() {},
  };
}

describe("Tela Codex routed turn bridge", () => {
  test("maintenance records unresolved Native tool operations and fences new admissions", async () => {
    const router = new RoutedCodexTurnBridge();
    let finish!: (value: { callId: string; content: string; isError: boolean }) => void;
    const deferred = new Promise<{ callId: string; content: string; isError: boolean }>(resolve => { finish = resolve; });
    const bridge: RemoteTurnBridge = {
      async inventory() { return []; },
      invoke: async () => deferred,
      async close() {},
    };
    router.mount("ProfileA1", bridge);
    const token = `turnr_ProfileA1_${"a".repeat(43)}`;
    const invoking = router.invoke(token, { callId: "call", wireName: "runtime-dynamic-tool",
      mode: "structured", arguments: {} });
    expect(router.activeOperationCount).toBe(1);
    router.closeAdmission();
    await expect(router.inventory(token)).rejects.toThrow("admission is closed");
    await expect(router.invoke(token, { callId: "new", wireName: "runtime-dynamic-tool",
      mode: "structured", arguments: {} })).rejects.toThrow("admission is closed");
    expect(router.activeOperationCount).toBe(1);
    finish({ callId: "call", content: "fixture", isError: false });
    expect(await invoking).toMatchObject({ callId: "call" });
    expect(router.activeOperationCount).toBe(0);
    router.reopenAdmission();
    expect(await router.inventory(token)).toEqual([]);
  });

  test("routes opaque capabilities to only the owning profile without assuming Native tool names", async () => {
    const events: string[] = [];
    const router = new RoutedCodexTurnBridge();
    const unmountA = router.mount("ProfileA1", child("a", events));
    router.mount("ProfileB2", child("b", events));
    const capabilityA = `turnr_ProfileA1_${"a".repeat(43)}`;
    const capabilityB = `turnr_ProfileB2_${"b".repeat(43)}`;
    expect((await router.inventory(capabilityA, "shell"))[0]?.wireName).toBe("dynamic-shell-name");
    expect((await router.invoke(capabilityB, { callId: "call-1", wireName: "future-tool-name",
      mode: "structured", arguments: {} })).content).toBe("b-ok");
    unmountA();
    await expect(Promise.resolve().then(() => router.inventory(capabilityA))).rejects.toThrow("inactive Tela Codex");
  });
});
