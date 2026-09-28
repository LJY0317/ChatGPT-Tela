import { describe, expect, test } from "bun:test";
import type { GatewayBackendClient } from "./backend-router";
import { BackendUnavailableError, IndependentBackendRouter } from "./backend-router";

function client(service: "chat" | "codex", behavior: "ready" | "throw" | "hang"): GatewayBackendClient {
  return {
    service,
    async status(signal) {
      if (behavior === "throw") throw new Error(`${service}-broken`);
      if (behavior === "hang") {
        await new Promise<void>((_, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      return { contractVersion: 1, service, instanceId: `${service}-1`, state: "ready" };
    },
    async close() {},
  };
}

describe("independent gateway backend routing", () => {
  test("Chat failure does not make Codex unavailable", async () => {
    const router = new IndependentBackendRouter({ timeoutMs: 30 });
    router.mount(client("chat", "throw"));
    router.mount(client("codex", "ready"));
    const statuses = await router.statuses();
    expect(statuses).toEqual([
      { service: "chat", availability: "unavailable", detail: "chat-broken" },
      { service: "codex", availability: "ready", instanceId: "codex-1" },
    ]);
  });

  test("hung Chat status is bounded without delaying a healthy Codex result indefinitely", async () => {
    const router = new IndependentBackendRouter({ timeoutMs: 25 });
    router.mount(client("chat", "hang"));
    router.mount(client("codex", "ready"));
    const started = Date.now();
    const statuses = await router.statuses();
    expect(Date.now() - started).toBeLessThan(500);
    expect(statuses[0]?.availability).toBe("unavailable");
    expect(statuses[1]?.availability).toBe("ready");
  });

  test("an unavailable backend fails only the call routed to that backend", async () => {
    const router = new IndependentBackendRouter();
    router.mount(client("codex", "ready"));
    await expect(router.withBackend("chat", async () => "never"))
      .rejects.toBeInstanceOf(BackendUnavailableError);
    await expect(router.withBackend("codex", async () => "codex-ok")).resolves.toBe("codex-ok");
  });
});
