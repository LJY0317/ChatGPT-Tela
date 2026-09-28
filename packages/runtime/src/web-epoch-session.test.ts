import { describe, expect, test } from "bun:test";
import { ControlledBrowserHost } from "@chatgpt-tela/browser-host";
import { RetainedBrowserEpochRegistry } from "./web-epoch-session";

describe("retained browser epoch registry", () => {
  test("reuses one physical surface across completed turns and rolls it over exactly once", async () => {
    const events: string[] = [];
    let created = 0;
    const host = new ControlledBrowserHost(async ({ taskId, epochId }) => {
      created += 1;
      const id = created;
      return {
        async navigate() {},
        async reveal() {},
        async hide() {},
        async close() { events.push(`close:${id}:${taskId}:${epochId}`); },
      };
    });
    const registry = new RetainedBrowserEpochRegistry(host);

    const first = await registry.acquire("task-1", "epoch-1");
    expect(first.reused).toBe(false);
    registry.complete("task-1", "epoch-1");

    const second = await registry.acquire("task-1", "epoch-1");
    expect(second.reused).toBe(true);
    expect(second.surface.leaseId).toBe(first.surface.leaseId);
    registry.complete("task-1", "epoch-1");

    const rolled = await registry.acquire("task-1", "epoch-2");
    expect(rolled.reused).toBe(false);
    expect(rolled.surface.leaseId).not.toBe(first.surface.leaseId);
    expect(events).toEqual(["close:1:task-1:epoch-1"]);
    registry.complete("task-1", "epoch-2");
    await registry.retire("task-1");
    expect(events).toEqual([
      "close:1:task-1:epoch-1",
      "close:2:task-1:epoch-2",
    ]);
  });

  test("a failed turn destroys uncertain physical state instead of retaining it", async () => {
    let closed = 0;
    const host = new ControlledBrowserHost(async () => ({
      async navigate() {}, async reveal() {}, async hide() {},
      async close() { closed += 1; },
    }));
    const registry = new RetainedBrowserEpochRegistry(host);
    await registry.acquire("task-1", "epoch-1");
    await registry.fail("task-1", "epoch-1");
    expect(registry.size).toBe(0);
    expect(closed).toBe(1);
    const next = await registry.acquire("task-1", "epoch-1");
    expect(next.reused).toBe(false);
  });
});
