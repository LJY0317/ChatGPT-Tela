import { describe, expect, test } from "bun:test";
import { createBrowserSurfaceCapability } from "./index";
import { ControlledBrowserHost, safeSurfaceLabel, type BrowserSurfaceController } from "./controlled";

describe("controlled browser host", () => {
  test("reserves ownership before asynchronous controller creation", async () => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    let created = 0;
    let factoryLeaseId: string | undefined;
    const host = new ControlledBrowserHost(async input => {
      factoryLeaseId = input.leaseId;
      created += 1;
      await ready;
      return { async navigate() {}, async reveal() {}, async hide() {}, async close() {} };
    });
    const first = host.acquire({ taskId: "task", epochId: "epoch" });
    const duplicate = host.acquire({ taskId: "task", epochId: "epoch" }).then(
      () => "accepted", () => "rejected",
    );
    release();
    try {
      const lease = await first;
      expect(factoryLeaseId).toBe(lease.leaseId);
      expect(await duplicate).toBe("rejected");
      expect(created).toBe(1);
    } finally { await host.close(); }
  });

  test("shutdown drains a controller created after shutdown begins", async () => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    let closed = 0;
    const host = new ControlledBrowserHost(async () => {
      await ready;
      return { async navigate() {}, async reveal() {}, async hide() {},
        async close() { closed += 1; } };
    });
    const acquisition = host.acquire({ taskId: "task", epochId: "epoch" }).then(
      () => "accepted", () => "rejected",
    );
    const closing = host.close();
    release();
    await closing;
    expect(await acquisition).toBe("rejected");
    expect(closed).toBe(1);
    expect(host.activeSurfaceCount).toBe(0);
    await host.close();
    expect(closed).toBe(1);
  });

  test("owns one surface per task epoch and releases it through one lifecycle", async () => {
    const events: string[] = [];
    const fixtureCapability = createBrowserSurfaceCapability<{ value: string }>("fixture");
    const host = new ControlledBrowserHost(async ({ taskId, epochId }) => ({
      async navigate(url) { events.push(`navigate:${taskId}:${epochId}:${url}`); },
      async reveal() { events.push("reveal"); },
      async hide() { events.push("hide"); },
      async close() { events.push("close"); },
      capability(capability) {
        return capability === fixtureCapability ? { value: "available" } as never : undefined;
      },
    }));

    const lease = await host.acquire({ taskId: "task-1", epochId: "epoch-1" });
    expect(host.activeSurfaceCount).toBe(1);
    await expect(host.acquire({ taskId: "task-1", epochId: "epoch-1" }))
      .rejects.toThrow("already has an active owner");
    await lease.navigate("https://chatgpt.com/");
    await lease.reveal();
    await lease.hide();
    expect(lease.capability(fixtureCapability)).toEqual({ value: "available" });
    await host.release(lease.leaseId);

    expect(host.activeSurfaceCount).toBe(0);
    expect(events).toEqual([
      "navigate:task-1:epoch-1:https://chatgpt.com/",
      "reveal",
      "hide",
      "close",
    ]);
    await expect(host.release(lease.leaseId)).rejects.toThrow("already released");
  });

  test("shutdown closes all remaining controllers once and becomes terminal", async () => {
    let closed = 0;
    const controller = (): BrowserSurfaceController => ({
      async navigate() {},
      async reveal() {},
      async hide() {},
      async close() { closed += 1; },
    });
    const host = new ControlledBrowserHost(async () => controller());
    await host.acquire({ taskId: "task-1", epochId: "epoch-1" });
    await host.acquire({ taskId: "task-2", epochId: "epoch-1" });

    await host.close();
    await host.close();
    expect(closed).toBe(2);
    expect(host.activeSurfaceCount).toBe(0);
    await expect(host.acquire({ taskId: "task-3", epochId: "epoch-1" }))
      .rejects.toThrow("browser host is closed");
  });
});

test("explicit surface selection never falls back to a different live generation", async () => {
  const preview = createBrowserSurfaceCapability<{ value: string }>("selection-fixture");
  const shown: string[] = [];
  const host = new ControlledBrowserHost(async ({ taskId }) => ({
    displayName: () => taskId,
    async navigate() {}, async hide() {}, async close() {},
    async reveal() { shown.push(taskId); },
    capability: capability => capability === preview ? { value: taskId } as never : undefined,
  }));
  const a = await host.acquire({ taskId: "A", epochId: "1" });
  const b = await host.acquire({ taskId: "B", epochId: "1" });
  expect(host.listSurfaces().map(row => row.label)).toEqual(["A", "B"]);
  expect(host.selectedSurfaceLease(b.leaseId)).toBe(b);
  expect(host.singleActiveCapability(preview).capability).toBeUndefined();
  expect(host.selectedCapability(b.leaseId, preview)?.value).toBe("B");
  await host.revealSurface(b.leaseId); expect(shown).toEqual(["B"]);
  await host.release(b.leaseId);
  const replacement = await host.acquire({ taskId: "B", epochId: "2" });
  expect(replacement.leaseId).not.toBe(b.leaseId);
  expect(() => host.selectedCapability(b.leaseId, preview)).toThrow("no longer owned");
  expect(() => host.selectedSurfaceLease(b.leaseId)).toThrow("no longer owned");
  await expect(host.revealSurface(b.leaseId)).rejects.toThrow("no longer owned");
  expect(host.selectedCapability(a.leaseId, preview)?.value).toBe("A");
  await host.close();
});


test("surface inventory follows lease and title events without observing the page", async () => {
  let title = "$chatgpt-tela <chatgpt_tela_transport_contract> private context";
  let titleChanged: (() => void) | undefined;
  let notifications = 0;
  const host = new ControlledBrowserHost(async () => ({
    displayName: () => title,
    onLabelChange(listener) { titleChanged = listener; return () => { titleChanged = undefined; }; },
    async navigate() {}, async reveal() {}, async hide() {}, async close() {},
  }));
  const detach = host.onSurfacesChanged(() => { notifications++; });
  const lease = await host.acquire({ taskId: "inventory", epochId: "one" });
  expect(host.listSurfaces()).toEqual([{ id: lease.leaseId, label: "Web session 1", taskId: "inventory" }]);
  title = "A useful task"; titleChanged!();
  expect(host.listSurfaces()[0]?.label).toBe(title);
  expect(host.surfaceRevision).toBe(2);
  await host.release(lease.leaseId);
  expect(titleChanged).toBeUndefined();
  expect(host.listSurfaces()).toEqual([]);
  expect(notifications).toBe(3);
  detach(); await host.close();
  expect(notifications).toBe(3);
  expect(safeSurfaceLabel("Act as the model backend for private task", 1)).toBe("Web session 2");
});
