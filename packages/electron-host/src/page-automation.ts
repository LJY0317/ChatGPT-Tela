import { randomBytes } from "node:crypto";
import type { BrowserMemoryFile, BrowserPageAutomation } from "@chatgpt-tela/browser-host";

export interface ElectronWebContentsLike {
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  sendInputEvent?(event:
    | {
        readonly type: "mouseMove" | "mouseDown" | "mouseUp";
        readonly x: number;
        readonly y: number;
        readonly button?: "left";
        readonly clickCount?: number;
      }
    | {
        readonly type: "keyDown" | "keyUp" | "char";
        readonly keyCode: string;
        readonly modifiers?: readonly string[];
      }): void;
  capturePage?(): Promise<{
    toJPEG(quality: number): Uint8Array;
  }>;
  isDestroyed(): boolean;
}

const MUTATION_CLOCK_KEY = "__chatgpt_tela_dom_mutation_clock_v1__";
const MAX_MEMORY_FILE_BYTES = 20 * 1024 * 1024;
const MAX_MEMORY_FILE_COUNT = 10;

const SET_FILE_INPUT_FILES = String.raw`function (argument) {
  const marker = "chatgpt-tela-memory-file-input-v1"; void marker;
  const inputs = [...document.querySelectorAll(argument.selector)]
    .filter(element => element instanceof HTMLInputElement && element.type === "file");
  if (inputs.length !== 1) throw new Error("browser memory file input is not uniquely addressable");
  if (typeof DataTransfer !== "function" || typeof File !== "function") {
    throw new Error("browser does not expose memory-backed file primitives");
  }
  const transfer = new DataTransfer();
  for (const item of argument.files) {
    const binary = atob(item.base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    transfer.items.add(new File([bytes], item.name, { type: item.mimeType, lastModified: 0 }));
  }
  const input = inputs[0];
  input.files = transfer.files;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  return {
    count: input.files?.length ?? 0,
    names: input.files ? [...input.files].map(file => file.name) : [],
  };
}`;

function abortError(): DOMException {
  return new DOMException("browser page operation aborted", "AbortError");
}

function assertActive(webContents: ElectronWebContentsLike): void {
  if (webContents.isDestroyed()) throw new Error("Electron WebContents is destroyed");
}

function argumentExpression(value: unknown): string {
  if (value === undefined) return "undefined";
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error("browser page evaluate argument must be JSON-serializable", { cause: error });
  }
  if (serialized === undefined) {
    throw new Error("browser page evaluate argument must be JSON-serializable");
  }
  return `JSON.parse(${JSON.stringify(serialized)})`;
}

function withAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  onAbort?: () => void,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    onAbort?.();
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      onAbort?.();
      reject(abortError());
    };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      value => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function mutationClockBootstrap(): string {
  const key = JSON.stringify(MUTATION_CLOCK_KEY);
  return String.raw`(() => {
    const key = ${key};
    let state = globalThis[key];
    if (!state) {
      let revision = 0;
      const waiters = new Map();
      const observer = new MutationObserver(() => {
        revision += 1;
        const ready = [...waiters.values()];
        waiters.clear();
        for (const resolve of ready) resolve(revision);
      });
      observer.observe(document.documentElement || document, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      state = {
        get revision() { return revision; },
        wait(afterRevision, id) {
          if (revision > afterRevision) return Promise.resolve(revision);
          return new Promise(resolve => waiters.set(id, resolve));
        },
        cancel(id) {
          const resolve = waiters.get(id);
          if (!resolve) return false;
          waiters.delete(id);
          resolve(revision);
          return true;
        },
      };
      Object.defineProperty(globalThis, key, {
        value: state,
        configurable: false,
        enumerable: false,
        writable: false,
      });
    }
    return state;
  })()`;
}

/**
 * Electron implementation of ChatGPT Tela's generic page-automation capability.
 *
 * DOM mutation waits use one renderer-local MutationObserver and monotonic revision. The revision
 * check and waiter registration happen in the same renderer task, so no polling and no lost wakeup
 * exists between semantic observation and the next relevant DOM change.
 */
export class ElectronWebContentsPageAutomation implements BrowserPageAutomation {
  constructor(readonly webContents: ElectronWebContentsLike) {}

  async evaluate<Argument, Result>(
    functionSource: string,
    argument: Argument,
    signal?: AbortSignal,
  ): Promise<Result> {
    if (!functionSource.trim()) throw new Error("browser page function source must be non-empty");
    assertActive(this.webContents);
    if (signal?.aborted) throw abortError();
    const code = `Promise.resolve((${functionSource})(${argumentExpression(argument)}))`;
    const operation = this.webContents.executeJavaScript(code, false) as Promise<Result>;
    // Electron cannot cancel an executeJavaScript call that is already inside the renderer. ChatGPT Tela's
    // consequential Web actions are nevertheless never retried automatically after an abort/error.
    return withAbort(operation, signal);
  }

  async pointerClick(
    point: { readonly x: number; readonly y: number },
    signal?: AbortSignal,
  ): Promise<void> {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0) {
      throw new Error("browser pointer coordinates must be finite non-negative numbers");
    }
    assertActive(this.webContents);
    if (signal?.aborted) throw abortError();
    const sendInputEvent = this.webContents.sendInputEvent?.bind(this.webContents);
    if (!sendInputEvent) {
      throw new Error("Electron WebContents does not expose trusted pointer input");
    }
    const x = Math.round(point.x);
    const y = Math.round(point.y);
    sendInputEvent({ type: "mouseMove", x, y });
    sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  }

  async clearFocusedEditable(signal?: AbortSignal): Promise<void> {
    assertActive(this.webContents);
    if (signal?.aborted) throw abortError();
    const sendInputEvent = this.webContents.sendInputEvent?.bind(this.webContents);
    if (!sendInputEvent) {
      throw new Error("Electron WebContents does not expose trusted keyboard input");
    }
    const primaryModifier = process.platform === "darwin" ? "meta" : "control";
    sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: [primaryModifier] });
    sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: [primaryModifier] });
    sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
    sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
  }

  async setFileInputFiles(
    selector: string,
    files: readonly BrowserMemoryFile[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (!selector.trim() || selector.length > 2_048 || selector.includes("\u0000")) {
      throw new Error("browser memory file selector is invalid");
    }
    if (files.length < 1 || files.length > MAX_MEMORY_FILE_COUNT) {
      throw new Error("browser memory file count is invalid");
    }
    let totalBytes = 0;
    const serialized = files.map(file => {
      if (!file.name || file.name.length > 240 || /[\\/\u0000\r\n]/.test(file.name)) {
        throw new Error("browser memory file name is invalid");
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,126}\/[A-Za-z0-9][A-Za-z0-9.+_-]{0,126}$/.test(file.mimeType)) {
        throw new Error("browser memory file MIME type is invalid");
      }
      if (!(file.bytes instanceof Uint8Array) || file.bytes.byteLength < 1 || file.bytes.byteLength > MAX_MEMORY_FILE_BYTES) {
        throw new Error("browser memory file size is invalid");
      }
      totalBytes += file.bytes.byteLength;
      if (totalBytes > MAX_MEMORY_FILE_BYTES) throw new Error("browser memory file payload is too large");
      return Object.freeze({
        name: file.name,
        mimeType: file.mimeType,
        base64: Buffer.from(file.bytes).toString("base64"),
      });
    });
    const result = await this.evaluate<
      { readonly selector: string; readonly files: readonly { name: string; mimeType: string; base64: string }[] },
      { readonly count: number; readonly names: readonly string[] }
    >(SET_FILE_INPUT_FILES, { selector, files: serialized }, signal);
    if (result.count !== files.length
      || result.names.length !== files.length
      || result.names.some((name, index) => name !== files[index]?.name)) {
      throw new Error("browser memory file input readback did not match the requested files");
    }
  }

  async typeFocusedEditable(text: string, signal?: AbortSignal): Promise<void> {
    if (!text || text.length > 512 || /[\u0000\r\n]/.test(text)) {
      throw new Error("trusted browser typing requires 1-512 visible single-line characters");
    }
    assertActive(this.webContents);
    if (signal?.aborted) throw abortError();
    const sendInputEvent = this.webContents.sendInputEvent?.bind(this.webContents);
    if (!sendInputEvent) {
      throw new Error("Electron WebContents does not expose trusted keyboard input");
    }
    for (const character of text) {
      if (signal?.aborted) throw abortError();
      sendInputEvent({ type: "keyDown", keyCode: character });
      sendInputEvent({ type: "char", keyCode: character });
      sendInputEvent({ type: "keyUp", keyCode: character });
      await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    }
  }

  async pressKey(keyCode: string, signal?: AbortSignal): Promise<void> {
    if (!/^[A-Za-z0-9@ _+\-]{1,32}$/.test(keyCode)
      && !["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Enter", "Escape", "Tab", "Backspace"].includes(keyCode)) {
      throw new Error("trusted browser key is invalid");
    }
    assertActive(this.webContents);
    if (signal?.aborted) throw abortError();
    const sendInputEvent = this.webContents.sendInputEvent?.bind(this.webContents);
    if (!sendInputEvent) throw new Error("Electron WebContents does not expose trusted keyboard input");
    sendInputEvent({ type: "keyDown", keyCode });
    sendInputEvent({ type: "keyUp", keyCode });
  }

  async mutationRevision(signal?: AbortSignal): Promise<number> {
    assertActive(this.webContents);
    if (signal?.aborted) throw abortError();
    const code = `(() => { const state = ${mutationClockBootstrap()}; return state.revision; })()`;
    const revision = await withAbort(
      this.webContents.executeJavaScript(code, false) as Promise<unknown>,
      signal,
    );
    if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
      throw new Error("Electron DOM mutation clock returned an invalid revision");
    }
    return revision as number;
  }

  async waitForDomMutation(afterRevision: number, signal?: AbortSignal): Promise<number> {
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) {
      throw new Error("DOM mutation afterRevision must be a non-negative safe integer");
    }
    assertActive(this.webContents);
    if (signal?.aborted) throw abortError();
    const waitId = `wait_${randomBytes(18).toString("base64url")}`;
    const waitIdLiteral = JSON.stringify(waitId);
    const code = `(() => { const state = ${mutationClockBootstrap()}; return state.wait(${afterRevision}, ${waitIdLiteral}); })()`;
    const cleanup = () => {
      if (this.webContents.isDestroyed()) return;
      const cleanupCode = `(() => { const state = globalThis[${JSON.stringify(MUTATION_CLOCK_KEY)}]; return state ? state.cancel(${waitIdLiteral}) : false; })()`;
      void this.webContents.executeJavaScript(cleanupCode, false).catch(() => {});
    };
    const revision = await withAbort(
      this.webContents.executeJavaScript(code, false) as Promise<unknown>,
      signal,
      cleanup,
    );
    if (!Number.isSafeInteger(revision) || (revision as number) < afterRevision) {
      throw new Error("Electron DOM mutation wait returned an invalid revision");
    }
    return revision as number;
  }
}
