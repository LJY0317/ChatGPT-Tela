import { describe, expect, test } from "bun:test";
import { ControlledBrowserHost } from "@chatgpt-tela/browser-host";
import { RetainedBrowserEpochRegistry } from "./web-epoch-session";

describe("retained browser epoch registry", () => {
  test("defaults to ten total profile surfaces and retires the least recently completed epoch", async () => {
    const closed: string[] = [];
    const host = new ControlledBrowserHost(async ({taskId}) => ({
      async navigate() {}, async reveal() {}, async hide() {}, async close() { closed.push(taskId); },
    }));
    const registry = new RetainedBrowserEpochRegistry(host);
    try {
      // Non-task surfaces share the profile budget but this registry does not own their retirement.
      await host.acquire({taskId: "checkpoint", epochId: "ephemeral"});
      for (let i = 0; i < 9; i++) {
        await registry.acquire(`task-${i}`, "epoch");
        await registry.complete(`task-${i}`, "epoch");
      }
      await registry.acquire("task-0", "epoch");
      await registry.complete("task-0", "epoch");
      await registry.acquire("new", "epoch");
      expect(host.activeSurfaceCount).toBe(10);
      expect(closed).toEqual(["task-1"]);
      await registry.complete("new", "epoch");
      expect((await registry.acquire("task-0", "epoch")).reused).toBe(true);
    } finally { registry.dispose(); await host.close(); }
  });

  test("soft pressure protects undelivered answers and busy work without denying independent creation", async () => {
    const closed: string[] = [];
    const host = new ControlledBrowserHost(async ({taskId}) => ({
      async navigate() {}, async reveal() {}, async hide() {}, async close() { closed.push(taskId); },
    }));
    const registry = new RetainedBrowserEpochRegistry(host, {surfaceTarget: 1});
    try {
      await registry.acquire("undelivered", "epoch");
      await registry.fail("undelivered", "epoch", true);
      await registry.acquire("busy", "epoch");
      await registry.acquire("new", "epoch");
      expect(host.activeSurfaceCount).toBe(3);
      expect(registry.retention()).toEqual({ total: 3, target: 1, active: 2,
        undelivered: 1, closing: 0, otherOwners: 0, reclaimable: 0 });
      expect(closed).toEqual([]);
      await registry.complete("new", "epoch");
      expect(closed).toEqual(["new"]);
      expect(host.activeSurfaceCount).toBe(2);
      expect(registry.retention()).toMatchObject({ total: 2, active: 1, undelivered: 1 });
    } finally { registry.dispose(); await host.close(); }
  });

  test("a capacity cleanup failure never fails a new or already completed task", async () => {
    let oldCloses = 0;
    const host = new ControlledBrowserHost(async ({taskId}) => ({
      async navigate() {}, async reveal() {}, async hide() {}, async close() {
        if (taskId === "old") { oldCloses++; throw Error("platform close failed"); }
      },
    }));
    const registry = new RetainedBrowserEpochRegistry(host, {surfaceTarget: 1});
    try {
      await registry.acquire("old", "epoch");
      await registry.complete("old", "epoch");
      await registry.acquire("new", "epoch");
      let committed = false;
      await registry.complete("new", "epoch", () => { committed = true; });
      expect(committed).toBe(true);
      expect(oldCloses).toBe(1);
      expect(registry.retention()).toMatchObject({ closing: 1, reclaimable: 0 });
      await expect(registry.acquire("old", "epoch")).rejects.toThrow("retirement is unresolved");
    } finally { registry.dispose(); await expect(host.close()).rejects.toThrow("failed to close"); }
  });

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

  test("expiry protects an unsettled Native task without repeatedly scheduling an elapsed deadline", async () => {
    let now = 1_000, nativeActive = false;
    const closed: string[] = [];
    const host = new ControlledBrowserHost(async ({ taskId }) => ({
      async navigate() {}, async reveal() {}, async hide() {}, async close() { closed.push(taskId); },
    }));
    const registry = new RetainedBrowserEpochRegistry(host, {
      now: () => now, isTaskActive: taskId => taskId === "native" && nativeActive,
    });
    const originalTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    try {
      await registry.acquire("native", "epoch");
      await registry.complete("native", "epoch");
      nativeActive = true;
      now += 7 * 24 * 60 * 60 * 1000;
      globalThis.setTimeout = ((fn: () => void, ms: number) => {
        delays.push(ms); return originalTimeout(fn, ms);
      }) as typeof setTimeout;
      await registry.retireExpired();
      expect(closed).toEqual([]);
      expect(registry.retention()).toMatchObject({ active: 1, reclaimable: 0 });
      expect(delays).toEqual([]);
      nativeActive = false;
      await registry.retireExpired();
      expect(closed).toEqual(["native"]);
      expect(registry.size).toBe(0);
    } finally { globalThis.setTimeout = originalTimeout; registry.dispose(); await host.close(); }
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
    await expect(host.close()).rejects.toThrow("failed to close");
  });
  test("bounded idle retirement invalidates the matching anchor before close and never evicts busy tasks", async () => {
    const events: string[] = [];
    const host = new ControlledBrowserHost(async ({ taskId }) => ({
      async navigate() {}, async reveal() {}, async hide() {},
      async close() { events.push(`close:${taskId}`); },
    }));
    const registry = new RetainedBrowserEpochRegistry(host, {surfaceTarget: 2,
      onRetire(taskId) { events.push(`invalidate:${taskId}`); },
    });
    try {
      await registry.acquire("busy", "epoch");
      await registry.acquire("old", "epoch");
      await registry.complete("old", "epoch");
      await registry.acquire("new", "epoch");
      await registry.complete("new", "epoch", () => events.push("commit:new"));
      expect(events).toEqual(["invalidate:old", "close:old", "commit:new"]);
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
