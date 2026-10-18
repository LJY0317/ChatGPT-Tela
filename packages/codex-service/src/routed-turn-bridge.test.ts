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
