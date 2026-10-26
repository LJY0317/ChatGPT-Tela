/** Stable, text-free classification shared by Web observation and failure projection. */
export type WebProviderFailureReason = "fetch_failed" | "message_stream_failed" | "message_too_long"
  | "unusual_activity" | "other_provider_error" | "detail_unavailable";

export function webProviderFailureReason(detail: string | undefined): WebProviderFailureReason {
  const normalized = detail?.trim().toLowerCase();
  return normalized === "failed to fetch" ? "fetch_failed"
    : normalized?.includes("message stream") ? "message_stream_failed"
      : normalized && /message\s+you\s+submitted\s+was\s+too\s+long/.test(normalized) ? "message_too_long"
        : normalized?.includes("our systems have detected unusual activity coming from your system") ? "unusual_activity"
          : normalized ? "other_provider_error" : "detail_unavailable";
}

/** A provider-declared failure after submission; never permission to resend. */
export class WebProviderResponseFailed extends Error {
  readonly code = "tela_web_provider_response_failed";
  readonly retryable = false;
  readonly reasonClass: WebProviderFailureReason;
  constructor(detail?: string, reasonClass = webProviderFailureReason(detail)) {
    super(detail ? `Web turn failed: ${detail}` : "The accepted Web response failed");
    this.name = "WebProviderResponseFailed";
    this.reasonClass = reasonClass;
  }
}
