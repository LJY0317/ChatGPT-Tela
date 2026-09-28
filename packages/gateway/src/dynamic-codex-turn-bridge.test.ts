import { describe, expect, test } from "bun:test";
import type { ServiceRuntimeDescriptor } from "@chatgpt-tela/service-protocol";
import { DynamicCodexTurnBridge } from "./dynamic-codex-turn-bridge";

describe("dynamic Codex turn bridge", () => {
  test("Gateway remains constructible with Codex absent and resolves the backend only per tool request", async () => {
    let descriptor: ServiceRuntimeDescriptor | undefined;
    const bridge = new DynamicCodexTurnBridge(() => descriptor);
    await expect(bridge.inventory("turnr_missing_opaque")).rejects.toThrow("unavailable");
    descriptor = {
      version: 1,
      service: "chat",
      instanceId: "wrong-service",
      installId: "install-1",
      pid: 1,
      endpoint: "http://127.0.0.1:1/",
      bearerToken: "x".repeat(48),
      startedAt: "2026-09-27T00:00:00.000Z",
    };
    await expect(bridge.inventory("turnr_wrong_opaque")).rejects.toThrow("not codex");
  });
});
