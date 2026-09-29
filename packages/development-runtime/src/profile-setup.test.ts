import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import type { BrowserWindowConstructorOptions } from "electron";
import type { ElectronBrowserWindowLike } from "@chatgpt-tela/electron-host";
import type { WebConversationProvider } from "@chatgpt-tela/chatgpt";
import {
  loadElectronProfileSetupConfig,
  startElectronProfileSetupRuntime,
  type ElectronProfileSetupConfig,
} from "./profile-setup";

function setupConfig(root: string): ElectronProfileSetupConfig {
  const normalized = resolve(root);
  return {
    slot: 1,
    profileId: "Profile1-ChatGPT-Tela",
    profileRoot: normalized,
    browserUserDataDir: join(normalized, "Canary-Profile1"),
    accountBindingPath: join(normalized, "account-bindings", "Profile1.json"),
    revealWhenReady: false,
    runContextCanary: false,
  };
}

class FakeWindow implements ElectronBrowserWindowLike {
  readonly events: string[] = [];
  destroyed = false;
  readonly webContents = {
    executeJavaScript: async () => 0,
    isDestroyed: () => this.destroyed,
  };

  async loadURL(url: string): Promise<void> { this.events.push(`load:${url}`); }
  show(): void { this.events.push("show"); }
  hide(): void { this.events.push("hide"); }
  isDestroyed(): boolean { return this.destroyed; }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.events.push("destroy");
  }
}

function provider(state: "proven" | "probable" = "proven"): Pick<WebConversationProvider, "observeCapabilities"> {
  return {
    async observeCapabilities() {
      return state === "proven"
        ? {
            state: "proven" as const,
            value: { observed: new Set(["composer", "send"]) },
            evidence: ["fixture-ready"],
          }
        : {
            state: "probable" as const,
            value: { observed: new Set<string>() },
            evidence: ["fixture-not-ready"],
          };
    },
  };
}

describe("Electron ChatGPT profile setup runtime", () => {
  test("loads only profile identity and browser state from setup environment", () => {
    const profileRoot = resolve("/tmp/chatgpt-tela-profile-setup");
    const config = loadElectronProfileSetupConfig({
      CHATGPT_TELA_PROFILE_SETUP_SLOT: "1",
      CHATGPT_TELA_PROFILE_ROOT: "/tmp/chatgpt-tela-profile-setup",
      CHATGPT_TELA_PROFILE_SETUP_CHATGPT_URL: "https://chatgpt.com/",
    });

    expect(config).toEqual({
      slot: 1,
      profileId: "Profile1-ChatGPT-Tela",
      profileRoot,
      browserUserDataDir: join(profileRoot, "Canary-Profile1"),
      accountBindingPath: join(profileRoot, "account-bindings", "Profile1.json"),
      chatGptUrl: "https://chatgpt.com/",
      revealWhenReady: false,
      runContextCanary: false,
    });
    expect(loadElectronProfileSetupConfig({
      CHATGPT_TELA_PROFILE_SETUP_SLOT: "1",
      CHATGPT_TELA_PROFILE_ROOT: "/tmp/chatgpt-tela-profile-setup",
      CHATGPT_TELA_PROFILE_SETUP_REVEAL: "1",
    }).revealWhenReady).toBe(true);
    expect(loadElectronProfileSetupConfig({
      CHATGPT_TELA_PROFILE_SETUP_SLOT: "1",
      CHATGPT_TELA_PROFILE_ROOT: "/tmp/chatgpt-tela-profile-setup",
      CHATGPT_TELA_PROFILE_SETUP_CONTEXT_CANARY: "1",
    }).runContextCanary).toBe(true);
    expect(() => loadElectronProfileSetupConfig({
      CHATGPT_TELA_PROFILE_SETUP_SLOT: "1",
      CHATGPT_TELA_PROFILE_ROOT: "/tmp/chatgpt-tela-profile-setup",
      CHATGPT_TELA_PROFILE_SETUP_REVEAL: "yes",
    })).toThrow("must be 0 or 1");
    expect(() => loadElectronProfileSetupConfig({})).toThrow("CHATGPT_TELA_PROFILE_SETUP_SLOT");
  });

  test("runs the context attachment canary on one setup-only surface without Native runtime ownership", async () => {
    const windows: FakeWindow[] = [];
    class RuntimeWindow extends FakeWindow {
      constructor(_input: BrowserWindowConstructorOptions) {
        super();
        windows.push(this);
      }
    }
    const runtime = await startElectronProfileSetupRuntime(
      setupConfig("/tmp/chatgpt-tela-profile-setup-context-canary-test"),
      {
        provider: {
          ...provider(),
          async preloadContextAttachment(_surface, request) {
            return {
              state: "proven" as const,
              value: {
                nativeTaskId: request.nativeTaskId,
                webEpochId: request.webEpochId,
                attachmentName: request.attachment.name,
                attachmentSha256: request.attachment.sha256,
                providerOperationId: "fixture-context-preload-turn",
              },
              evidence: ["fixture-context-receipt"],
            };
          },
        },
        electron: {
          async loadRuntime() {
            return {
              app: { setPath() {}, async whenReady() {} },
              BrowserWindow: RuntimeWindow,
            };
          },
        },
      },
    );

    const result = await runtime.probeChatGptContextAttachment();
    expect(result.receiptVerified).toBe(true);
    expect(result.attachmentBytes).toBeGreaterThan(0);
    expect(windows).toHaveLength(1);
    expect(windows[0]?.events).toEqual(["load:https://chatgpt.com/", "destroy"]);
    await runtime.stop();
  });

  test("probes and reveals the same persistent profile without starting Native/MCP runtime state", async () => {
    const events: string[] = [];
    const windows: FakeWindow[] = [];
    const options: BrowserWindowConstructorOptions[] = [];
    class RuntimeWindow extends FakeWindow {
      constructor(input: BrowserWindowConstructorOptions) {
        super();
        options.push(input);
        windows.push(this);
        events.push("window-created");
      }
    }

    const profileRoot = resolve("/tmp/chatgpt-tela-profile-setup-runtime-test");
    const runtime = await startElectronProfileSetupRuntime(setupConfig(profileRoot), {
      provider: provider(),
      electron: {
        async loadRuntime() {
          return {
            app: {
              setPath(name, path) { events.push(`set-path:${name}:${path}`); },
              async whenReady() { events.push("app-ready"); },
            },
            BrowserWindow: RuntimeWindow,
          };
        },
      },
    });

    expect(events).toEqual([
      `set-path:userData:${join(profileRoot, "Canary-Profile1")}`,
      "app-ready",
    ]);
    const readiness = await runtime.probeChatGptReadiness();
    expect([...readiness.observed].sort()).toEqual(["composer", "send"]);
    expect(windows[0]?.events).toEqual(["load:https://chatgpt.com/", "destroy"]);

    const setup = await runtime.openProfileSetupSurface({ reveal: false });
    const setupReadiness = await setup.probeChatGptReadiness();
    expect([...setupReadiness.observed].sort()).toEqual(["composer", "send"]);
    expect(windows[1]?.events).toEqual(["load:https://chatgpt.com/"]);
    await setup.reveal();
    expect(windows[1]?.events).toEqual(["load:https://chatgpt.com/", "show"]);
    expect(options[0]?.webPreferences?.partition).toMatch(/^persist:chatgpt-tela-/);
    expect(options[1]?.webPreferences?.partition).toBe(options[0]?.webPreferences?.partition);

    await runtime.stop();
    await runtime.stop();
    await setup.close();
    expect(windows[1]?.events).toEqual(["load:https://chatgpt.com/", "show", "destroy"]);
  });

  test("an unready probe releases its hidden surface and setup remains available for human repair", async () => {
    const windows: FakeWindow[] = [];
    class RuntimeWindow extends FakeWindow {
      constructor(_input: BrowserWindowConstructorOptions) {
        super();
        windows.push(this);
      }
    }
    const runtime = await startElectronProfileSetupRuntime(setupConfig("/tmp/chatgpt-tela-profile-setup-unready-test"), {
      provider: provider("probable"),
      electron: {
        async loadRuntime() {
          return {
            app: { setPath() {}, async whenReady() {} },
            BrowserWindow: RuntimeWindow,
          };
        },
      },
    });

    await expect(runtime.probeChatGptReadiness()).rejects.toThrow("readiness is not proven: probable");
    expect(windows[0]?.destroyed).toBe(true);
    await runtime.openProfileSetupSurface();
    expect(windows[1]?.events).toEqual(["load:https://chatgpt.com/", "show"]);
    await runtime.stop();
    expect(windows[1]?.destroyed).toBe(true);
  });

  test("setup readiness and manual repair reuse one BrowserWindow on the persistent partition", async () => {
    const windows: FakeWindow[] = [];
    class RuntimeWindow extends FakeWindow {
      constructor(_input: BrowserWindowConstructorOptions) {
        super();
        windows.push(this);
      }
    }
    const runtime = await startElectronProfileSetupRuntime(setupConfig("/tmp/chatgpt-tela-profile-setup-single-surface-test"), {
      provider: provider("probable"),
      electron: {
        async loadRuntime() {
          return {
            app: { setPath() {}, async whenReady() {} },
            BrowserWindow: RuntimeWindow,
          };
        },
      },
    });

    const setup = await runtime.openProfileSetupSurface({ reveal: false });
    await expect(setup.probeChatGptReadiness()).rejects.toThrow("readiness is not proven: probable");
    expect(windows).toHaveLength(1);
    expect(windows[0]?.events).toEqual(["load:https://chatgpt.com/"]);
    await setup.reveal();
    expect(windows).toHaveLength(1);
    expect(windows[0]?.events).toEqual(["load:https://chatgpt.com/", "show"]);
    await runtime.stop();
    expect(windows[0]?.events).toEqual(["load:https://chatgpt.com/", "show", "destroy"]);
  });
});
