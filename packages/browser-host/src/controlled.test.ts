import { describe, expect, test } from "bun:test";
import { createBrowserSurfaceCapability } from "./index";
import { ControlledBrowserHost, type BrowserSurfaceController } from "./controlled";

describe("controlled browser host", () => {
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
