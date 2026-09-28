import {
  BROWSER_PAGE_AUTOMATION,
  ControlledBrowserHost,
  type BrowserHost,
  type BrowserSurfaceCapability,
} from "@chatgpt-tela/browser-host";
import type { BrowserWindowConstructorOptions } from "electron";
import { isAbsolute, resolve } from "node:path";
import { ElectronWebContentsPageAutomation, type ElectronWebContentsLike } from "./page-automation";
import { electronProfileIdentity } from "./profile";

export interface ElectronBrowserWindowLike {
  readonly webContents: ElectronWebContentsLike;
  loadURL(url: string): Promise<void>;
  show(): void;
  hide(): void;
  isDestroyed(): boolean;
  destroy(): void;
}

export type ElectronWindowFactory = (
  options: BrowserWindowConstructorOptions,
) => ElectronBrowserWindowLike | Promise<ElectronBrowserWindowLike>;

export interface ElectronMainRuntimeLike {
  readonly app: {
    setPath?(name: "userData", path: string): void;
    getPath?(name: "userData"): string;
    isReady?(): boolean;
    whenReady(): Promise<void>;
  };
  readonly BrowserWindow: new (options: BrowserWindowConstructorOptions) => ElectronBrowserWindowLike;
}

function supportedNavigation(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new Error("browser navigation URL is invalid", { cause: error });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`browser navigation protocol is not allowed: ${parsed.protocol}`);
  }
  return parsed;
}

/**
 * Build ChatGPT Tela's Electron-backed BrowserHost without coupling core/runtime to Electron APIs.
 *
 * Each acquired task/epoch gets a fresh BrowserWindow, while a stable profile id maps to one
 * persistent Electron partition so login/cookies survive surface teardown. Remote pages run with
 * Node integration disabled, context isolation enabled, and the Chromium sandbox enabled.
 */
export function createElectronBrowserHost(input: {
  readonly profileId: string;
  readonly createWindow: ElectronWindowFactory;
  readonly initialUrl?: string;
  readonly window?: Readonly<Pick<BrowserWindowConstructorOptions,
    "width" | "height" | "minWidth" | "minHeight" | "title">>;
}): BrowserHost {
  const profile = electronProfileIdentity(input.profileId);
  const initialUrl = input.initialUrl ? supportedNavigation(input.initialUrl).href : undefined;

  return new ControlledBrowserHost(async ({ taskId, epochId }) => {
    const window = await input.createWindow({
      show: false,
      width: input.window?.width ?? 1200,
      height: input.window?.height ?? 900,
      ...(input.window?.minWidth !== undefined ? { minWidth: input.window.minWidth } : {}),
      ...(input.window?.minHeight !== undefined ? { minHeight: input.window.minHeight } : {}),
      title: input.window?.title ?? "ChatGPT Tela",
      webPreferences: {
        partition: profile.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      throw new Error("Electron window factory returned a destroyed surface");
    }

    const automation = new ElectronWebContentsPageAutomation(window.webContents);
    try {
      if (initialUrl) await window.loadURL(initialUrl);
    } catch (error) {
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }
    let closed = false;

    return {
      async navigate(url: string) {
        if (closed || window.isDestroyed()) throw new Error("Electron browser surface is closed");
        await window.loadURL(supportedNavigation(url).href);
      },
      async reveal() {
        if (closed || window.isDestroyed()) throw new Error("Electron browser surface is closed");
        window.show();
      },
      async hide() {
        if (closed || window.isDestroyed()) throw new Error("Electron browser surface is closed");
        window.hide();
      },
      async close() {
        if (closed) return;
        closed = true;
        if (!window.isDestroyed()) window.destroy();
      },
      capability<T>(capability: BrowserSurfaceCapability<T>): T | undefined {
        return capability === BROWSER_PAGE_AUTOMATION ? automation as T : undefined;
      },
      taskId,
      epochId,
    };
  });
}

async function loadElectronMainRuntime(): Promise<ElectronMainRuntimeLike> {
  const runtime = await import("electron");
  if (!runtime.app || typeof runtime.app.whenReady !== "function"
    || typeof runtime.BrowserWindow !== "function") {
    throw new Error("ChatGPT Tela Electron host must be created from an Electron main process");
  }
  return runtime as unknown as ElectronMainRuntimeLike;
}

function normalizedUserDataDir(value: string): string {
  if (value.includes("\u0000")) throw new Error("Electron userData directory contains a NUL byte");
  const path = resolve(value);
  if (!isAbsolute(path)) throw new Error("Electron userData directory must resolve to an absolute path");
  return path;
}

/** Create the production BrowserWindow-backed host from an Electron main process. */
export async function createElectronMainProcessBrowserHost(input: {
  readonly profileId: string;
  readonly userDataDir?: string;
  readonly initialUrl?: string;
  readonly window?: Readonly<Pick<BrowserWindowConstructorOptions,
    "width" | "height" | "minWidth" | "minHeight" | "title">>;
  /** Test seam only; production callers use Electron's main-process module. */
  readonly loadRuntime?: () => Promise<ElectronMainRuntimeLike>;
}): Promise<BrowserHost> {
  const runtime = await (input.loadRuntime ?? loadElectronMainRuntime)();
  if (input.userDataDir) {
    if (!runtime.app.setPath) {
      throw new Error("Electron runtime cannot configure an isolated userData directory");
    }
    const userDataDir = normalizedUserDataDir(input.userDataDir);
    if (runtime.app.isReady?.()) {
      const current = runtime.app.getPath?.("userData");
      if (!current || resolve(current) !== userDataDir) {
        throw new Error("Electron userData must be configured before app readiness");
      }
    } else {
      runtime.app.setPath("userData", userDataDir);
    }
  }
  await runtime.app.whenReady();
  return createElectronBrowserHost({
    profileId: input.profileId,
    ...(input.initialUrl ? { initialUrl: input.initialUrl } : {}),
    ...(input.window ? { window: input.window } : {}),
    createWindow: options => new runtime.BrowserWindow(options),
  });
}
