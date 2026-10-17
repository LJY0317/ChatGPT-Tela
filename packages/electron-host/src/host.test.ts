import { describe, expect, test } from "bun:test";
import { resolve, join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { BROWSER_DOCUMENT_LIFETIME, BROWSER_INPUT_OWNERSHIP, BROWSER_INSPECTION_INPUT, BROWSER_PAGE_AUTOMATION, BROWSER_READ_ONLY_PREVIEW } from "@chatgpt-tela/browser-host";
import type { BrowserWindowConstructorOptions } from "electron";
import { createElectronBrowserHost, type ElectronBrowserWindowLike } from "./host";
import { createElectronMainProcessBrowserHost } from "./host";
import type { ElectronWebContentsLike } from "./page-automation";

class FakeWebContents implements ElectronWebContentsLike {
  destroyed = false;
  readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  on(event: string, listener: (...args: unknown[]) => void) { const items = this.listeners.get(event) ?? new Set(); items.add(listener); this.listeners.set(event, items); }
  removeListener(event: string, listener: (...args: unknown[]) => void) { this.listeners.get(event)?.delete(listener); }
  emit(event: string, ...args: unknown[]) { for (const listener of this.listeners.get(event) ?? []) listener(...args); }
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
  test("document lifetime follows main-frame replacement and crash without treating SPA/subframes as replacement", async () => {
    const window = new FakeWindow();
    const host = createElectronBrowserHost({ profileId: "document-fixture", createWindow: () => window });
    const surface = await host.acquire({ taskId: "task", epochId: "epoch" });
    const lifetime = surface.capability(BROWSER_DOCUMENT_LIFETIME)!;
    try {
      const initial = lifetime.current();
      window.webContents.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
      window.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
      expect(initial.signal.aborted).toBe(false);
      expect(lifetime.current().generation).toBe(initial.generation);
      window.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
      expect(initial.signal.aborted).toBe(true);
      const reloaded = lifetime.current();
      expect(reloaded.generation).toBe(initial.generation + 1);
      window.webContents.emit("did-fail-load", {}, -1, "synthetic", "https://example.test/", false);
      expect(reloaded.signal.aborted).toBe(false);
      window.webContents.emit("render-process-gone", {}, { reason: "crashed" });
      expect(reloaded.signal.aborted).toBe(true);
      const crashed = lifetime.current();
      await host.release(surface.leaseId);
      expect(crashed.signal.aborted).toBe(true);
      expect([...window.webContents.listeners.values()].every(items => items.size === 0)).toBe(true);
    } finally { await host.close(); }
  });

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

test("owned renderer event listeners detach with the surface and never consume raw navigation data",async()=>{
  const window=new FakeWindow();
  const listeners=window.webContents.listeners;
  const host=createElectronBrowserHost({profileId:"diagnostic-profile",createWindow:()=>window});
  const lease=await host.acquire({taskId:"task",epochId:"epoch"});expect(listeners.has("did-start-navigation")).toBe(true);
  window.webContents.emit("did-fail-load",{},-105,"private error","https://private/account");
  await host.release(lease.leaseId);expect([...listeners.values()].every(items=>items.size===0)).toBe(true);await host.close();
});

test("user close hides an inspection view without retiring its task document", async () => {
  const window = new FakeWindow();
  let closeListener: ((event: { preventDefault(): void }) => void) | undefined;
  const ownedWindow = Object.assign(window, {
    on(_event: "close", listener: typeof closeListener) { closeListener = listener; },
    removeListener() { closeListener = undefined; }, getTitle: () => "Synthetic chat",
  });
  const host = createElectronBrowserHost({ profileId: "inspection-fixture", createWindow: () => ownedWindow });
  const surface = await host.acquire({ taskId: "task", epochId: "epoch" });
  await host.revealSurface(surface.leaseId);
  let prevented = false;
  closeListener!({ preventDefault() { prevented = true; } });
  expect(prevented).toBe(true); expect(window.destroyed).toBe(false);
  expect(window.events).toEqual(["show", "hide"]);
  expect(host.listSurfaces()[0]?.label).toBe("Synthetic chat");
  expect(surface.capability(BROWSER_DOCUMENT_LIFETIME)!.current().signal.aborted).toBe(false);
  await host.release(surface.leaseId);
  expect(window.destroyed).toBe(true); expect(closeListener).toBeUndefined();
  await host.close();
});

test("closing manual inspection resets viewing and keeps the owned lease alive", async () => {
  const window = new FakeWindow(); let listener: ((event: {preventDefault():void}) => void) | undefined;
  const host = createElectronBrowserHost({profileId:"inspection-reset",createWindow:()=>Object.assign(window, {
    on(_event: "close", fn: typeof listener) {listener=fn;}, removeListener() {listener=undefined;},
  })});
  const surface=await host.acquire({taskId:"task",epochId:"epoch"});
  const { BROWSER_INSPECTION_INPUT } = await import("@chatgpt-tela/browser-host");
  const controls=surface.capability(BROWSER_INSPECTION_INPUT)!; controls.setInteractive(true);
  const ownership=surface.capability(BROWSER_INPUT_OWNERSHIP)!;
  const before=ownership.current(); expect(before.available).toBe(true);
  let blocked=0;
  window.webContents.emit("before-input-event", {preventDefault(){blocked++;}}, {type:"keyDown",key:"Enter"});
  expect(blocked).toBe(0);
  expect(before.signal.aborted).toBe(true);
  listener!({preventDefault(){}});
  window.webContents.emit("before-input-event", {preventDefault(){blocked++;}}, {type:"keyDown",key:"Enter"});
  expect(blocked).toBe(1);
  expect(surface.capability(BROWSER_DOCUMENT_LIFETIME)!.current().signal.aborted).toBe(false);
  await host.release(surface.leaseId);
  expect(()=>controls.setInteractive(true)).toThrow("unavailable");
  expect(ownership.current().available).toBe(false); await host.close();
});

test("Interact reveal and pointer revocation retire only the submission fence, never the document", async () => {
  const window=new FakeWindow();
  const host=createElectronBrowserHost({profileId:"interact-lifecycle",createWindow:()=>window});
  const surface=await host.acquire({taskId:"task",epochId:"epoch"});
  try {
    const { BROWSER_INSPECTION_INPUT }=await import("@chatgpt-tela/browser-host");
    const controls=surface.capability(BROWSER_INSPECTION_INPUT)!;
    const submission=surface.capability(BROWSER_INPUT_OWNERSHIP)!.current();
    const document=surface.capability(BROWSER_DOCUMENT_LIFETIME)!.current();
    await host.revealSurface(surface.leaseId);
    controls.setInteractive(true);
    expect(submission.signal.aborted).toBe(false);
    expect(document.signal.aborted).toBe(false);
    window.webContents.emit("before-mouse-event",{preventDefault(){}},{type:"mouseDown",button:"left"});
    expect(submission.signal.aborted).toBe(true);
    expect(document.signal.aborted).toBe(false);
    expect(host.activeSurfaceCount).toBe(1);
  } finally {await host.close();}
});

test("user-hide observation is tied to one browser lease and never fires on ordinary release", async () => {
  const window = new FakeWindow();
  let closeListener: ((event: { preventDefault(): void }) => void) | undefined;
  const host = createElectronBrowserHost({ profileId: "account-visible",
    createWindow: () => Object.assign(window, {
      on(_event: "close", fn: typeof closeListener) { closeListener = fn; },
      removeListener() { closeListener = undefined; },
    }),
  });
  const surface = await host.acquire({ taskId: "account", epochId: "reveal" });
  const { BROWSER_USER_HIDE } = await import("@chatgpt-tela/browser-host");
  let hides = 0;
  const unsubscribe = surface.capability(BROWSER_USER_HIDE)!.onUserHide(() => { hides++; });
  await surface.reveal();
  closeListener!({ preventDefault() {} });
  expect(hides).toBe(1);
  unsubscribe();
  closeListener!({ preventDefault() {} });
  expect(hides).toBe(1);
  await host.release(surface.leaseId);
  expect(hides).toBe(1);
  expect(closeListener).toBeUndefined();
  await host.close();
});

test("user-hide observation requires a removable exact-window close listener", async () => {
  const window = Object.assign(new FakeWindow(), { on(_event: "close", _listener: (event: { preventDefault(): void }) => void) {} });
  const host = createElectronBrowserHost({ profileId: "close-observer-unavailable", createWindow: () => window });
  const surface = await host.acquire({ taskId: "task", epochId: "epoch" });
  const { BROWSER_USER_HIDE } = await import("@chatgpt-tela/browser-host");
  expect(surface.capability(BROWSER_USER_HIDE)).toBeUndefined();
  await host.release(surface.leaseId);
  await host.close();
});

test("browser lifecycle and input events retain one private surface identity across request reuse", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "tela-surface-evidence-")), file = join(scratch, "events.jsonl");
  const prior = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = file;
  const host = createElectronBrowserHost({ profileId: "PRIVATE_PROFILE", createWindow: () => new FakeWindow() });
  try {
    for (const taskId of ["PRIVATE_FIRST_TASK", "PRIVATE_SECOND_TASK"]) {
      const surface = await host.acquire({ taskId, epochId: "PRIVATE_EPOCH" });
      await surface.reveal();
      await host.release(surface.leaseId);
    }
    const raw = readFileSync(file, "utf8"), events = raw.trim().split("\n").map(line => JSON.parse(line));
    const reveals = events.filter(row => row.stage === "inspection_window_action" && row.action === "reveal");
    const disposals = events.filter(row => row.stage === "inspection_owner_disposed");
    expect(reveals).toHaveLength(2); expect(disposals).toHaveLength(2);
    expect(reveals[0].surface_fingerprint).toMatch(/^[a-f0-9]{24}$/);
    expect(reveals[1].surface_fingerprint).not.toBe(reveals[0].surface_fingerprint);
    expect(disposals.map(row => row.surface_fingerprint)).toEqual(reveals.map(row => row.surface_fingerprint));
    expect(raw).not.toContain("PRIVATE_");
  } finally {
    await host.close();
    if (prior === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = prior;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("renderer stall records whether a human hit-test was pending, without any private event data", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "tela-renderer-stall-")), file = join(scratch, "events.jsonl");
  const prior = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = file;
  const window = new FakeWindow();
  window.webContents.executeJavaScript = async () => new Promise<unknown>(() => {});
  const host = createElectronBrowserHost({ profileId: "SECRET_PROFILE", createWindow: () => window });
  try {
    const surface = await host.acquire({ taskId: "SECRET_TASK", epochId: "SECRET_EPOCH" });
    const inspection = surface.capability(BROWSER_INSPECTION_INPUT)!;
    inspection.setInteractive(true);
    window.webContents.emit("before-mouse-event", { preventDefault() {} },
      { type: "mouseDown", button: "left", x: 10, y: 10 });
    expect(surface.capability(BROWSER_INPUT_OWNERSHIP)?.observationCurrent?.().pending).toBe(true);
    window.webContents.emit("unresponsive");
    inspection.setInteractive(false); // Cancels the intercepted gesture; never replays it.
    window.webContents.emit("responsive");
    const raw = readFileSync(file, "utf8");
    const rows = raw.trim().split("\n").map(line => JSON.parse(line));
    expect(rows.find(row => row.stage === "renderer_unresponsive"))
      .toMatchObject({ input_hit_test_pending: true });
    expect(rows.find(row => row.stage === "renderer_responsive"))
      .toMatchObject({ input_hit_test_pending: false });
    expect(raw).not.toMatch(/SECRET_PROFILE|SECRET_TASK|SECRET_EPOCH/);
    await host.release(surface.leaseId);
  } finally {
    await host.close();
    if (prior === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = prior;
    rmSync(scratch, { recursive: true, force: true });
  }
});
