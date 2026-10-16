/** Closed reasons only; browser text never becomes a recovery classification. */
export const WEB_SUBMISSION_PROOF_REASONS = [
  "author_root_missing", "ambiguous_author_root", "author_payload_empty",
  "author_payload_budget", "author_payload_unavailable", "new_author_unavailable",
] as const;
export type WebSubmissionProofReason = typeof WEB_SUBMISSION_PROOF_REASONS[number];

export function webSubmissionFailureReason(error: unknown): WebSubmissionProofReason | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { code?: unknown; reason?: unknown };
  return candidate.code === "tela_web_submission_unproven"
    && typeof candidate.reason === "string"
    && (WEB_SUBMISSION_PROOF_REASONS as readonly string[]).includes(candidate.reason)
    ? candidate.reason as WebSubmissionProofReason : undefined;
}

/** An activated send with unknown acceptance. Never permission to resend. */
export class WebSubmissionUnproven extends Error {
  readonly code = "tela_web_submission_unproven";
  readonly retryable = false;
  constructor(readonly reason: WebSubmissionProofReason) {
    super("Web submission outcome is uncertain: local acceptance proof timed out; do not resend this operation");
    this.name = "WebSubmissionUnproven";
  }
}
