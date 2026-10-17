import { diagnosticContext, diagnosticFingerprint, emitDiagnosticEvent, withDiagnosticContext } from "@chatgpt-tela/core";
import {
  BROWSER_READ_ONLY_PREVIEW,
  BROWSER_INSPECTION_INPUT,
  BROWSER_INPUT_OWNERSHIP,
  BROWSER_USER_HIDE,
  BROWSER_PAGE_AUTOMATION,
  BROWSER_DOCUMENT_LIFETIME,
  ControlledBrowserHost,
  type BrowserHost,
  type BrowserSurfaceCapability,
} from "@chatgpt-tela/browser-host";
import type { BrowserWindowConstructorOptions } from "electron";
import { isAbsolute, resolve } from "node:path";
import { ElectronWebContentsPageAutomation, type ElectronWebContentsLike } from "./page-automation";
import { InspectionInput } from "./inspection-input";
import { electronProfileIdentity } from "./profile";

export interface ElectronBrowserWindowLike {
  readonly webContents: ElectronWebContentsLike;
  loadURL(url: string): Promise<void>;
  show(): void;
  hide(): void;
  isDestroyed(): boolean;
  destroy(): void;
  getTitle?(): string;
  on?(event: "close", listener: (event: { preventDefault(): void }) => void): void;
  removeListener?(event: "close", listener: (event: { preventDefault(): void }) => void): void;
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
}): ControlledBrowserHost {
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

    const origin = { ...diagnosticContext(), profile_fingerprint: diagnosticFingerprint(input.profileId),
      surface_fingerprint: diagnosticFingerprint(JSON.stringify([input.profileId, taskId, epochId])) };
    const emitter = window.webContents as typeof window.webContents & {
      on?: (event: string, listener: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
    };
    const listeners: [string, (...args: unknown[]) => void][] = [];
    let documentGeneration = 0;
    let documentController = new AbortController();
    const invalidateDocument = () => {
      documentController.abort(new Error("owned browser document was replaced or lost"));
      documentGeneration += 1;
      documentController = new AbortController();
    };
    // Electron's main-frame document events also cover reloads and programmatic loadURL.
    // Same-document history changes and subframe navigation do not replace the document.
    const documentLifetime = emitter.on && emitter.removeListener
      ? Object.freeze({ current: () => {
          if (window.isDestroyed() || window.webContents.isDestroyed()) {
            documentController.abort(new Error("owned browser document is closed"));
          }
          return Object.freeze({ generation: documentGeneration, signal: documentController.signal });
        } })
      : undefined;
    if (documentLifetime) {
      const navigation = (...args: unknown[]) => {
        const details = args[0] as { isMainFrame?: boolean; isSameDocument?: boolean } | undefined;
        if (details?.isMainFrame === false || details?.isSameDocument === true) return;
        invalidateDocument();
      };
      const loadFailure = (...args: unknown[]) => {
        if (args[4] !== false) invalidateDocument();
      };
      for (const [event, listener] of [
        ["did-start-navigation", navigation], ["did-fail-load", loadFailure],
        ["render-process-gone", invalidateDocument], ["destroyed", invalidateDocument],
      ] as const) {
        emitter.on!(event, listener); listeners.push([event, listener]);
      }
    }
    let observed = 0;
    let inputHitTestPending = () => false;
    if (emitter.on && emitter.removeListener) for (const [event, stage] of [
      ["did-start-loading", "navigation_started"], ["did-stop-loading", "navigation_settled"],
      ["did-fail-load", "navigation_failed"], ["render-process-gone", "renderer_crashed"],
      ["unresponsive", "renderer_unresponsive"], ["responsive", "renderer_responsive"],
    ] as const) {
      const listener = (...args: unknown[]) => {
        observed++;
        withDiagnosticContext(origin, () => emitDiagnosticEvent("chatgpt_tela_browser", stage, {
          event_count: observed,
          ...(["unresponsive", "responsive"].includes(event)
            ? { input_hit_test_pending: inputHitTestPending() } : {}),
          ...(event === "did-fail-load" && typeof args[1] === "number" ? { error_code: args[1] } : {}),
        }));
      };
      emitter.on(event, listener); listeners.push([event, listener]);
    }
    const detachDiagnostics = () => { for (const [event, listener] of listeners) emitter.removeListener?.(event, listener); };
    const inspection = withDiagnosticContext(origin, () => new InspectionInput(emitter));
    inputHitTestPending = () => inspection.observationCurrent().pending;
    const automation = new ElectronWebContentsPageAutomation(window.webContents, inspection.send);
    const preview = window.webContents.capturePage
      ? Object.freeze({
          async captureJpeg(): Promise<Uint8Array> {
            if (closed || window.isDestroyed() || window.webContents.isDestroyed()) {
              throw new Error("Electron browser surface is closed");
            }
            const image = await window.webContents.capturePage!();
            const bytes = image.toJPEG(70);
            if (bytes.byteLength > 4 * 1024 * 1024) {
              throw new Error("Electron browser preview exceeded the bounded response size");
            }
            return new Uint8Array(bytes);
          },
        })
      : undefined;
    try {
      if (initialUrl) await window.loadURL(initialUrl);
    } catch (error) {
      inspection.dispose();
      detachDiagnostics();
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }
    let closed = false;
    const recordInspection = (action: string) => withDiagnosticContext(origin, () =>
      emitDiagnosticEvent("chatgpt_tela_browser", "inspection_window_action", {
        action, owned_document_live: !documentController.signal.aborted, document_generation: documentGeneration,
      }));
    // Inspection visibility is independent from the Native-owned document lifetime.
    const hideListeners = new Set<() => void>();
    const hideOnClose = (event: { preventDefault(): void }) => {
      if (!closed) {
        event.preventDefault(); inspection.setInteractive(false); window.hide(); recordInspection("close_to_hide");
        // User gesture only. Callback must never grant task or account
        // authority; the specific lease owner decides whether to retire.
        for (const observer of [...hideListeners]) {
          try { observer(); } catch { /* UI observer cannot affect Electron close lifecycle. */ }
        }
      }
    };
    // A user-close signal is safe to expose only when its exact listener can
    // also be removed on lease retirement. Never advertise an inert observer.
    const observesUserClose = typeof window.on === "function"
      && typeof window.removeListener === "function";
    if (observesUserClose) window.on!("close", hideOnClose);

    return {
      displayName: () => window.getTitle?.() || "",
      async navigate(url: string) {
        if (closed || window.isDestroyed()) throw new Error("Electron browser surface is closed");
        await window.loadURL(supportedNavigation(url).href);
      },
      async reveal() {
        if (closed || window.isDestroyed()) throw new Error("Electron browser surface is closed");
        window.show();
        recordInspection("reveal");
      },
      async hide() {
        if (closed || window.isDestroyed()) throw new Error("Electron browser surface is closed");
        inspection.setInteractive(false);
        window.hide();
        recordInspection("hide");
      },
      async close() {
        if (closed) return;
        closed = true;
        window.removeListener?.("close", hideOnClose);
        hideListeners.clear();
        documentController.abort(new Error("owned browser document is closed"));
        recordInspection("release");
        inspection.dispose();
        detachDiagnostics();
        if (!window.isDestroyed()) window.destroy();
      },
      capability<T>(capability: BrowserSurfaceCapability<T>): T | undefined {
        if (capability === BROWSER_USER_HIDE && observesUserClose) {
          return { onUserHide(observer: () => void) {
            if (closed) throw new Error("browser surface is closed");
            hideListeners.add(observer);
            return () => { hideListeners.delete(observer); };
          } } as T;
        }
        if (capability === BROWSER_INSPECTION_INPUT || capability === BROWSER_INPUT_OWNERSHIP) return inspection as T;
        if (capability === BROWSER_PAGE_AUTOMATION) return automation as T;
        if (capability === BROWSER_DOCUMENT_LIFETIME && documentLifetime) return documentLifetime as T;
        if (capability === BROWSER_READ_ONLY_PREVIEW && preview) return preview as T;
        return undefined;
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
}): Promise<ControlledBrowserHost> {
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
