export interface BrowserSurfaceCapability<T> {
  readonly key: symbol;
  readonly name: string;
  /** Type-only anchor for the capability payload. */
  readonly __type?: T;
}

export function createBrowserSurfaceCapability<T>(name: string): BrowserSurfaceCapability<T> {
  if (!name.trim()) throw new Error("browser surface capability name must be non-empty");
  return Object.freeze({ key: Symbol(name), name });
}

export interface BrowserSurfaceLease {
  readonly leaseId: string;
  readonly taskId: string;
  readonly epochId: string;
  navigate(url: string): Promise<void>;
  reveal(): Promise<void>;
  hide(): Promise<void>;
  capability<T>(capability: BrowserSurfaceCapability<T>): T | undefined;
}

export interface BrowserReadOnlyPreview {
  /** Capture the currently rendered surface without revealing, focusing, or sending input to it. */
  captureJpeg(): Promise<Uint8Array>;
}

export const BROWSER_READ_ONLY_PREVIEW = createBrowserSurfaceCapability<BrowserReadOnlyPreview>(
  "browser-read-only-preview",
);

export const BROWSER_INSPECTION_INPUT = createBrowserSurfaceCapability<{
  setInteractive(interactive: boolean): void;
}>("browser-inspection-input");

/** Host evidence only: unowned mutating input invalidates an operation's causal receipt.
 * Missing support is unknown, never equivalent to an unchanged input boundary.
 */
export const BROWSER_INPUT_OWNERSHIP = createBrowserSurfaceCapability<{
  current(): { readonly revision: number; readonly available: boolean; readonly signal: AbortSignal };
  /** Optional post-acceptance fence. Proven viewing gestures preserve it; unknown input does not. */
  observationCurrent?(): { readonly revision: number; readonly available: boolean; readonly pending: boolean };
}>("browser-input-ownership");

/** A user closing this exact browser window, not a document/navigation or
 * task-completion signal. Only an optional account-management owner uses it. */
export const BROWSER_USER_HIDE = createBrowserSurfaceCapability<{
  onUserHide(observer: () => void): () => void;
}>("browser-user-hide");

/** A snapshot of one main-frame document lifetime, independent of the surface/window lease. */
export interface BrowserDocumentLifetime {
  current(): { readonly generation: number; readonly signal: AbortSignal };
}

export const BROWSER_DOCUMENT_LIFETIME = createBrowserSurfaceCapability<BrowserDocumentLifetime>(
  "browser-document-lifetime",
);

export interface BrowserHost {
  /** All surfaces owned by this profile host, including non-task operations. */
  readonly activeSurfaceCount?: number;
  acquire(input: { taskId: string; epochId: string }): Promise<BrowserSurfaceLease>;
  release(leaseId: string): Promise<void>;
  close(): Promise<void>;
}

export * from "./controlled";
export * from "./page-automation";
export * from "./diagnostics";
