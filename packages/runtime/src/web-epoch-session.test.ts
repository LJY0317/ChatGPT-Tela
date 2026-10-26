import { describe, expect, test } from "bun:test";
import { ControlledBrowserHost } from "@chatgpt-tela/browser-host";
import { RetainedBrowserEpochRegistry } from "./web-epoch-session";

describe("retained browser epoch registry", () => {
  test("expires only idle surfaces seven days after actual completion, preserving busy work", async () => {
    let now = 1_000;
    const events: string[] = [];
    const host = new ControlledBrowserHost(async ({ taskId }) => ({
      async navigate() {}, async reveal() {}, async hide() {},
      async close() { events.push(`close:${taskId}`); },
    }));
    const registry = new RetainedBrowserEpochRegistry(host, {
      now: () => now, onRetire(taskId) { events.push(`retire:${taskId}`); },
    });
    const week = 7 * 24 * 60 * 60 * 1000;
    try {
      const old = await registry.acquire("old", "epoch");
      await registry.complete("old", "epoch");
      await registry.acquire("busy", "epoch");
      now += week - 1;
      await registry.retireExpired();
      expect(registry.size).toBe(2);
      const reused = await registry.acquire("old", "epoch");
      expect(reused.reused).toBe(true);
      expect(reused.surface.leaseId).toBe(old.surface.leaseId);
      now += 2;
      await registry.retireExpired();
      expect(events).toEqual([]);
      await registry.complete("old", "epoch");
      now += week;
      await registry.retireExpired();
      expect(events).toEqual(["retire:old", "close:old"]);
      expect(registry.size).toBe(1);
      expect((await registry.acquire("old", "epoch")).reused).toBe(false);
      expect(events).not.toContain("close:busy");
    } finally { registry.dispose(); await host.close(); }
  });

  test("one-shot deadline fires while the service is alive and disposal cancels it", async () => {
    const events: string[] = [];
    const host = new ControlledBrowserHost(async ({ taskId }) => ({
      async navigate() {}, async reveal() {}, async hide() {}, async close() { events.push(taskId); },
    }));
    const originalTimeout = globalThis.setTimeout;
    const originalClear = globalThis.clearTimeout;
    let scheduled: (() => void) | undefined;
    let active = false;
    const delays: number[] = [];
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      active = true; scheduled = fn; delays.push(ms);
      return { unref() {} } as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = (() => { active = false; }) as typeof clearTimeout;
    let now = 10;
    const registry = new RetainedBrowserEpochRegistry(host, { now: () => now });
    try {
      await registry.acquire("idle", "epoch");
      await registry.complete("idle", "epoch");
      expect(delays).toEqual([7 * 24 * 60 * 60 * 1000]);
      expect(active).toBe(true);
      now += 7 * 24 * 60 * 60 * 1000;
      active = false;
      scheduled!();
      for (let i = 0; i < 5 && registry.size; i++) await Promise.resolve();
      expect(events).toEqual(["idle"]);
      expect(registry.size).toBe(0);
      registry.dispose();
      expect(active).toBe(false);
    } finally {
      registry.dispose();
      globalThis.setTimeout = originalTimeout;
      globalThis.clearTimeout = originalClear;
      await host.close();
    }
  });
  test("failed physical retirement blocks reuse and new epochs until ownership is reconciled", async () => {
    let closes = 0, creates = 0;
    const host = new ControlledBrowserHost(async () => { creates++; return {
      async navigate() {}, async reveal() {}, async hide() {}, async close() { closes++; throw Error("close unproven"); },
    }; });
    const registry = new RetainedBrowserEpochRegistry(host);
    await registry.acquire("task", "old");
    await expect(registry.fail("task", "old")).rejects.toThrow("close unproven");
    for (const epoch of ["old", "new"]) await expect(registry.acquire("task", epoch)).rejects.toThrow("retirement is unresolved");
    await expect(registry.fail("task", "old")).rejects.toThrow("retirement is unresolved");
    expect(closes).toBe(1); expect(creates).toBe(1); expect(registry.size).toBe(1);
    await host.close();
  });
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


test("delivery timeout preserves a viewable surface, but never reuses its uncertain context", async () => {
  let now = 1000, closes = 0;
  const host = new ControlledBrowserHost(async () => ({
    async navigate() {}, async reveal() {}, async hide() {}, async close() { closes++; },
  }));
  const registry = new RetainedBrowserEpochRegistry(host, { now: () => now });
  try {
    const original = await registry.acquire("task", "epoch");
    await registry.complete("task", "epoch");
    await registry.acquire("task", "epoch");
    await registry.fail("task", "epoch", true);
    expect(closes).toBe(0);
    expect(registry.size).toBe(1);
    const next = await registry.acquire("task", "epoch");
    expect(next.reused).toBe(false);
    expect(next.surface.leaseId).not.toBe(original.surface.leaseId);
    expect(closes).toBe(1);
    await registry.fail("task", "epoch", true);
    now += 7 * 24 * 60 * 60 * 1000;
    await registry.retireExpired();
    expect(closes).toBe(2);
    expect(registry.size).toBe(0);
  } finally { registry.dispose(); await host.close(); }
});
