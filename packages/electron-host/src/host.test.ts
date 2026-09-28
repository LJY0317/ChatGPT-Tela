import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { BROWSER_PAGE_AUTOMATION, BROWSER_READ_ONLY_PREVIEW } from "@chatgpt-tela/browser-host";
import type { BrowserWindowConstructorOptions } from "electron";
import { createElectronBrowserHost, type ElectronBrowserWindowLike } from "./host";
import { createElectronMainProcessBrowserHost } from "./host";
import type { ElectronWebContentsLike } from "./page-automation";

class FakeWebContents implements ElectronWebContentsLike {
  destroyed = false;
  executeJavaScript(): Promise<unknown> { return Promise.resolve(0); }
  sendInputEvent(): void {}
  async capturePage() {
    return { toJPEG: () => new Uint8Array([1, 2, 3, 4]) };
  }
  isDestroyed(): boolean { return this.destroyed; }
}

class FakeWindow implements ElectronBrowserWindowLike {
  readonly webContents = new FakeWebContents();
  readonly events: string[] = [];
  destroyed = false;

  async loadURL(url: string): Promise<void> { this.events.push(`load:${url}`); }
  show(): void { this.events.push("show"); }
  hide(): void { this.events.push("hide"); }
  isDestroyed(): boolean { return this.destroyed; }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.webContents.destroyed = true;
    this.events.push("destroy");
  }
}

class FailingLoadWindow extends FakeWindow {
  override async loadURL(url: string): Promise<void> {
    this.events.push(`load:${url}`);
    throw new Error("fixture navigation failure");
  }
}

describe("Electron browser host", () => {
  test("uses one persistent partition and hardened renderer preferences per profile", async () => {
    const options: BrowserWindowConstructorOptions[] = [];
    const windows: FakeWindow[] = [];
    const host = createElectronBrowserHost({
      profileId: "profile-1",
      initialUrl: "https://chatgpt.com/",
      createWindow(input) {
        options.push(input);
        const window = new FakeWindow();
        windows.push(window);
        return window;
      },
    });

    const first = await host.acquire({ taskId: "task-1", epochId: "epoch-1" });
    const second = await host.acquire({ taskId: "task-2", epochId: "epoch-1" });
    expect(options).toHaveLength(2);
    expect(options[0]?.show).toBe(false);
    expect(options[0]?.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    });
    expect(options[0]?.webPreferences?.partition).toMatch(/^persist:chatgpt-tela-/);
    expect(options[1]?.webPreferences?.partition).toBe(options[0]?.webPreferences?.partition);
    expect(windows[0]?.events).toEqual(["load:https://chatgpt.com/"]);

    expect(first.capability(BROWSER_PAGE_AUTOMATION)).toBeDefined();
    const observed = host.singleActiveCapability(BROWSER_READ_ONLY_PREVIEW);
    expect(observed.activeSurfaceCount).toBe(2);
    expect(observed.capability).toBeUndefined();
    await first.reveal();
    await first.hide();
    await first.navigate("https://chatgpt.com/c/example");
    await expect(first.navigate("file:///tmp/not-allowed")).rejects.toThrow("protocol is not allowed");
    await host.release(first.leaseId);
    expect(windows[0]?.events).toEqual([
      "load:https://chatgpt.com/",
      "show",
      "hide",
      "load:https://chatgpt.com/c/example",
      "destroy",
    ]);

    await host.release(second.leaseId);
    await host.close();
  });

  test("captures one active hidden surface without revealing or focusing it", async () => {
    const windows: FakeWindow[] = [];
    const host = createElectronBrowserHost({
      profileId: "preview-profile",
      initialUrl: "https://chatgpt.com/",
      createWindow() {
        const window = new FakeWindow();
        windows.push(window);
        return window;
      },
    });
    const lease = await host.acquire({ taskId: "task", epochId: "epoch" });
    const before = [...windows[0]!.events];
    const observed = host.singleActiveCapability(BROWSER_READ_ONLY_PREVIEW);
    expect(observed.activeSurfaceCount).toBe(1);
    expect(await observed.capability?.captureJpeg()).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(windows[0]!.events).toEqual(before);
    await host.release(lease.leaseId);
    await host.close();
  });

  test("invalid initial navigation is rejected before creating a window", () => {
    let created = 0;
    expect(() => createElectronBrowserHost({
      profileId: "profile-1",
      initialUrl: "javascript:alert(1)",
      createWindow() {
        created += 1;
        return new FakeWindow();
      },
    })).toThrow("protocol is not allowed");
    expect(created).toBe(0);
  });

  test("initial navigation failure destroys the unleased window before propagating", async () => {
    const windows: FailingLoadWindow[] = [];
    const host = createElectronBrowserHost({
      profileId: "profile-navigation-failure",
      initialUrl: "https://chatgpt.com/",
      createWindow() {
        const window = new FailingLoadWindow();
        windows.push(window);
        return window;
      },
    });

    await expect(host.acquire({ taskId: "task-1", epochId: "epoch-1" }))
      .rejects.toThrow("fixture navigation failure");
    expect(windows).toHaveLength(1);
    expect(windows[0]?.events).toEqual(["load:https://chatgpt.com/", "destroy"]);
    await host.close();
  });

  test("main-process helper waits for Electron readiness before creating surfaces", async () => {
    const events: string[] = [];
    const createdOptions: BrowserWindowConstructorOptions[] = [];
    const paths: Array<[string, string]> = [];
    class RuntimeWindow extends FakeWindow {
      constructor(options: BrowserWindowConstructorOptions) {
        super();
        createdOptions.push(options);
        events.push("window-created");
      }
    }

    const userDataDir = resolve("/tmp/chatgpt-tela-electron-host-test");
    const host = await createElectronMainProcessBrowserHost({
      profileId: "profile-main",
      userDataDir,
      initialUrl: "https://chatgpt.com/",
      async loadRuntime() {
        return {
          app: {
            setPath(name, path) {
              paths.push([name, path]);
              events.push("user-data-set");
            },
            async whenReady() { events.push("app-ready"); },
          },
          BrowserWindow: RuntimeWindow,
        };
      },
    });
    expect(events).toEqual(["user-data-set", "app-ready"]);
    expect(paths).toEqual([["userData", userDataDir]]);

    const lease = await host.acquire({ taskId: "task", epochId: "epoch" });
    expect(events).toEqual(["user-data-set", "app-ready", "window-created"]);
    expect(createdOptions[0]?.webPreferences?.partition).toMatch(/^persist:chatgpt-tela-/);
    await host.release(lease.leaseId);
    await host.close();
  });

  test("isolated userData requires a runtime that can set it", async () => {
    await expect(createElectronMainProcessBrowserHost({
      profileId: "profile-main",
      userDataDir: "/tmp/chatgpt-tela-electron-host-test",
      async loadRuntime() {
        return {
          app: { async whenReady() {} },
          BrowserWindow: FakeWindow as unknown as new (options: BrowserWindowConstructorOptions) => FakeWindow,
        };
      },
    })).rejects.toThrow("cannot configure an isolated userData directory");
  });

  test("an already-ready Electron app may reuse only the exact preconfigured userData path", async () => {
    const existing = resolve("/tmp/chatgpt-tela-preconfigured-user-data");
    const runtime = {
      app: {
        setPath() { throw new Error("late setPath should not run"); },
        getPath() { return existing; },
        isReady() { return true; },
        async whenReady() {},
      },
      BrowserWindow: class extends FakeWindow {},
    };
    const host = await createElectronMainProcessBrowserHost({
      profileId: "ready-profile",
      userDataDir: existing,
      loadRuntime: async () => runtime,
    });
    await host.close();

    await expect(createElectronMainProcessBrowserHost({
      profileId: "wrong-ready-profile",
      userDataDir: "/tmp/chatgpt-tela-different-user-data",
      loadRuntime: async () => runtime,
    })).rejects.toThrow("must be configured before app readiness");
  });
});
