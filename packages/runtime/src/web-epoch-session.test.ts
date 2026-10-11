import { describe, expect, test } from "bun:test";
import { ControlledBrowserHost } from "@chatgpt-tela/browser-host";
import { RetainedBrowserEpochRegistry } from "./web-epoch-session";

describe("retained browser epoch registry", () => {
  test("bounded idle retirement invalidates the matching anchor before close and never evicts busy tasks", async () => {
    const events: string[] = [];
    const host = new ControlledBrowserHost(async ({ taskId }) => ({
      async navigate() {}, async reveal() {}, async hide() {},
      async close() { events.push(`close:${taskId}`); },
    }));
    const registry = new RetainedBrowserEpochRegistry(host, {maxIdleEpochs: 1,
      onRetire(taskId) { events.push(`invalidate:${taskId}`); },
    });
    try {
      await registry.acquire("busy", "epoch");
      await registry.acquire("old", "epoch");
      await registry.complete("old", "epoch");
      await registry.acquire("new", "epoch");
      await registry.complete("new", "epoch", () => events.push("commit:new"));
      expect(events).toEqual(["commit:new", "invalidate:old", "close:old"]);
      expect(registry.size).toBe(2);
      const recreated = await registry.acquire("old", "epoch");
      expect(recreated.reused).toBe(false);
      await registry.fail("old", "epoch");
      expect(events).not.toContain("close:busy");
      await expect(registry.retire("busy")).rejects.toThrow("busy");
    } finally { await host.close(); }
  });

  test("one task cannot open competing epochs while creation is pending", async () => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const host = new ControlledBrowserHost(async ({ taskId }) => {
      if (taskId === "task") await ready;
      return { async navigate() {}, async reveal() {}, async hide() {}, async close() {} };
    });
    const registry = new RetainedBrowserEpochRegistry(host);
    const first = registry.acquire("task", "first");
    const competing = registry.acquire("task", "second").then(
      () => "accepted", () => "rejected",
    );
    const peer = await registry.acquire("peer", "first");
    expect(peer.reused).toBe(false);
    release();
    try {
      await first;
      expect(await competing).toBe("rejected");
      expect(host.activeSurfaceCount).toBe(2);
    } finally { await host.close(); }
  });

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
    await registry.complete("task-1", "epoch-1");

    const second = await registry.acquire("task-1", "epoch-1");
    expect(second.reused).toBe(true);
    expect(second.surface.leaseId).toBe(first.surface.leaseId);
    await registry.complete("task-1", "epoch-1");

    const rolled = await registry.acquire("task-1", "epoch-2");
    expect(rolled.reused).toBe(false);
    expect(rolled.surface.leaseId).not.toBe(first.surface.leaseId);
    expect(events).toEqual(["close:1:task-1:epoch-1"]);
    await registry.complete("task-1", "epoch-2");
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
