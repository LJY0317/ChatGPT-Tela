/** Closed observation reasons; these never authorize a consequential action or resend. */
export const WEB_OBSERVATION_REASONS = [
  "conversation_changed",
  "request_changed",
  "lineage_conflict",
  "response_wait_timeout",
] as const;
export type WebObservationReason = typeof WEB_OBSERVATION_REASONS[number];

export const WEB_OBSERVATION_DIAGNOSTIC_REASONS = [
  "accepted_identity_unobserved",
  "assistant_already_complete",
  "assistant_already_failed",
  "assistant_descendants_multiple",
  "assistant_lineages_multiple",
  "composer_connector_retained",
  "composer_draft_not_settled",
  "composer_existing_draft",
  "composer_multiple",
  "composer_readback_deadline",
  "composer_readback_unproven",
  "composer_readiness_deadline",
  "composer_unavailable",
  "context_assistant_descendants_multiple",
  "context_assistant_lineages_multiple",
  "context_attachment_receipt_unverified",
  "context_user_turns_multiple",
  "send_control_identity_changed",
  "send_control_unavailable",
  "submission_user_turns_multiple",
  "tool_result_assistant_descendants_multiple",
  "tool_result_assistant_lineages_multiple",
  "unknown",
] as const;
export type WebObservationDiagnosticReason = typeof WEB_OBSERVATION_DIAGNOSTIC_REASONS[number];
export type WebObservationDiagnosticMetadata = Readonly<{
  state: "probable" | "ambiguous";
  evidenceCount: number;
}>;
export type WebObservationDiagnostic = WebObservationDiagnosticMetadata & Readonly<{
  reason: WebObservationDiagnosticReason;
}>;

export function webObservationFailureReason(error: unknown): WebObservationReason | undefined {
  try {
    if (!error || typeof error !== "object") return;
    const value = error as { code?: unknown; reason?: unknown; diagnostic?: unknown };
    return value.code === "tela_web_observation_unproven"
      && value.diagnostic === undefined
      && typeof value.reason === "string"
      && (WEB_OBSERVATION_REASONS as readonly string[]).includes(value.reason)
      ? value.reason as WebObservationReason : undefined;
  } catch { return; }
}

export function webObservationDiagnostic(error: unknown): WebObservationDiagnostic | undefined {
  try {
    if (!error || typeof error !== "object") return;
    const value = error as { code?: unknown; reason?: unknown; diagnostic?: unknown };
    if (value.code !== "tela_web_observation_unproven" || !value.diagnostic || typeof value.diagnostic !== "object") return;
    const metadata = value.diagnostic as { state?: unknown; evidenceCount?: unknown };
    if ((metadata.state !== "probable" && metadata.state !== "ambiguous")
      || !Number.isSafeInteger(metadata.evidenceCount) || (metadata.evidenceCount as number) < 0) return;
    const reason = typeof value.reason === "string"
      && (WEB_OBSERVATION_DIAGNOSTIC_REASONS as readonly string[]).includes(value.reason)
      ? value.reason as WebObservationDiagnosticReason : "unknown";
    return { state: metadata.state, evidenceCount: metadata.evidenceCount as number,
      reason };
  } catch { return; }
}

export class WebObservationUnproven extends Error {
  readonly code = "tela_web_observation_unproven";
  readonly retryable = false;
  readonly diagnostic?: WebObservationDiagnosticMetadata;
  constructor(
    readonly reason: WebObservationReason | WebObservationDiagnosticReason,
    message = "Accepted Web response ownership could not be verified",
    diagnostic?: WebObservationDiagnosticMetadata,
  ) {
    super(message); this.name = "WebObservationUnproven";
    if (diagnostic) this.diagnostic = Object.freeze({ ...diagnostic });
  }
}
