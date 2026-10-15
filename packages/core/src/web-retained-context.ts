/** Closed, payload-free reasons. No browser text or upstream exception is retained. */
export const WEB_RETAINED_CONTEXT_REASONS = [
  "anchor_missing", "lineage_not_unique", "assistant_identity_changed",
  "committed_semantic_unavailable", "observed_body_missing", "observed_body_incomplete",
  "observed_body_version_unsupported", "answer_unavailable", "semantic_digest_mismatch",
] as const;
export type WebRetainedContextReason = typeof WEB_RETAINED_CONTEXT_REASONS[number];

export function isWebRetainedContextReason(value: unknown): value is WebRetainedContextReason {
  return typeof value === "string" && (WEB_RETAINED_CONTEXT_REASONS as readonly string[]).includes(value);
}

export function webRetainedContextFailureReason(error: unknown): WebRetainedContextReason | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { code?: unknown; reason?: unknown };
  return candidate.code === "tela_web_retained_context_unproven" && isWebRetainedContextReason(candidate.reason)
    ? candidate.reason : undefined;
}

/** A context failure, never authorization to resend or to trust presentation text. */
export class WebRetainedContextUnproven extends Error {
  readonly code = "tela_web_retained_context_unproven";
  readonly retryable = false;
  constructor(readonly reason: WebRetainedContextReason) {
    super("retained ChatGPT conversation cannot prove its committed answer");
    this.name = "WebRetainedContextUnproven";
  }
}
