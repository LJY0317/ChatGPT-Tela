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
   * Clear the currently focused editable surface through trusted browser keyboard input.
   * Implementations map the primary modifier to Command on macOS and Control elsewhere.
   */
  clearFocusedEditable(signal?: AbortSignal): Promise<void>;

  /** Monotonic renderer-local DOM mutation revision. Reading it also ensures the event source exists. */
  mutationRevision(signal?: AbortSignal): Promise<number>;

  /**
   * Resolve when the DOM mutation revision becomes greater than `afterRevision`.
   * Implementations must perform the revision check and event wait atomically in the renderer so a
   * mutation between caller observation and waiter registration cannot be lost.
   */
  waitForDomMutation(afterRevision: number, signal?: AbortSignal): Promise<number>;
}

export const BROWSER_PAGE_AUTOMATION = createBrowserSurfaceCapability<BrowserPageAutomation>(
  "chatgpt-tela.browser.page-automation.v1",
);
