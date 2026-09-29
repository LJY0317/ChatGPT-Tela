import { createBrowserSurfaceCapability } from "./index";

/**
 * Product-neutral page execution seam for an owned browser surface.
 * `functionSource` is trusted ChatGPT Tela code that evaluates to a unary function; implementations invoke
 * it with `argument` inside the page. DOM selectors and product semantics stay in provider packages.
 */
export interface BrowserPageAutomation {
  evaluate<Argument, Result>(
    functionSource: string,
    argument: Argument,
    signal?: AbortSignal,
  ): Promise<Result>;

  /**
   * Send one real primary-button pointer click at viewport CSS-pixel coordinates.
   * Product adapters use this only after proving an exact semantic target in-page, and callers
   * must never retry this consequential input automatically after an error or abort.
   */
  pointerClick(point: { readonly x: number; readonly y: number }, signal?: AbortSignal): Promise<void>;

  /**
   * Type text into the currently focused editable surface through trusted browser keyboard input.
   * Product adapters use this for UI that reacts to real typing (for example mention/autocomplete menus).
   */
  typeFocusedEditable(text: string, signal?: AbortSignal): Promise<void>;

  /** Send one trusted non-text keyboard key to the currently focused ChatGPT control. */
  pressKey(keyCode: string, signal?: AbortSignal): Promise<void>;

  /**
   * Clear the currently focused editable surface through trusted browser keyboard input.
   * Implementations map the primary modifier to Command on macOS and Control elsewhere.
   */
  clearFocusedEditable(signal?: AbortSignal): Promise<void>;

  /**
   * Install memory-backed files on one exact native file input without creating temporary files.
   * Product adapters remain responsible for choosing/proving the semantic input and for observing
   * that the site accepted the resulting attachments before any Send action.
   */
  setFileInputFiles?(
    selector: string,
    files: readonly BrowserMemoryFile[],
    signal?: AbortSignal,
  ): Promise<void>;

  /**
   * Activate one exact trusted UI target while intercepting the native file chooser, then install
   * memory-backed files on the exact file input that opened that chooser. Implementations must
   * suppress the OS dialog, must not persist temporary files, and must fail closed if no unique
   * chooser/input boundary is observed.
   */
  setFileChooserFiles?(
    triggerPoint: { readonly x: number; readonly y: number },
    files: readonly BrowserMemoryFile[],
    signal?: AbortSignal,
  ): Promise<void>;

  /** Monotonic renderer-local DOM mutation revision. Reading it also ensures the event source exists. */
  mutationRevision(signal?: AbortSignal): Promise<number>;

  /**
   * Resolve when the DOM mutation revision becomes greater than `afterRevision`.
   * Implementations must perform the revision check and event wait atomically in the renderer so a
   * mutation between caller observation and waiter registration cannot be lost.
   */
  waitForDomMutation(afterRevision: number, signal?: AbortSignal): Promise<number>;
}

export interface BrowserMemoryFile {
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export const BROWSER_PAGE_AUTOMATION = createBrowserSurfaceCapability<BrowserPageAutomation>(
  "chatgpt-tela.browser.page-automation.v1",
);
