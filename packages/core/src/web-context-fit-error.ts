/** Closed, payload-free preparation failures. Classification never grants replay authority. */
export const WEB_CONTEXT_FIT_REASONS = [
  "newest_revision_oversize", "checkpoint_required", "physical_window_exceeded", "invalid_physical_limits", "composer_window_exceeded",
] as const;
export type WebContextFitReason = typeof WEB_CONTEXT_FIT_REASONS[number];
export function webContextFitFailureReason(error: unknown): WebContextFitReason | undefined {
  if (!error || typeof error !== "object") return;
  const value = error as { code?: unknown; reason?: unknown };
  return value.code === "web_context_fit_failed" && WEB_CONTEXT_FIT_REASONS.some(reason => reason === value.reason)
    ? value.reason as WebContextFitReason : undefined;
}
export class WebContextFitFailed extends Error {
  readonly code = "web_context_fit_failed";
  constructor(readonly reason: WebContextFitReason,
    readonly estimates: Readonly<{ required?: number; budget?: number }> = {}) {
    super("Tela could not fit the current Native context into a Web request.");
    this.name = "WebContextFitFailed";
  }
}
