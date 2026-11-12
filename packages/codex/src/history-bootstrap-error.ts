/**
 * Typed, content-free recovery boundary shared by Native owner proof and
 * historical continuation. Never treat an unsafe Legacy paging limit as a
 * reason to replay or export an original Native conversation.
 */
const RECOVERY_MESSAGES = {
  source_unavailable: "Native readable history is unavailable to this request; readable supplied context or a compatible verified checkpoint is required",
  unindexed_history: "Native indexed current-turn proof unavailable; unindexed history was not paged",
  checkpoint_interrupted: "A Web context checkpoint has an uncertain submitted outcome and requires reconciliation",
  checkpoint_closed: "The isolated Web checkpoint operation was released locally without a result; a new authorized request is required",
  checkpoint_rejected: "A proven Web context checkpoint response was unusable; a new request with readable context is required",
  source_budget: "Native readable context exceeds the bounded Web input; fitted readable context or a compatible verified checkpoint is required",
} as const;

export class NativeHistoryBootstrapRequired extends Error {
  readonly code = "native_history_bootstrap_required" as const;
  readonly recoveryReason: keyof typeof RECOVERY_MESSAGES;

  static normalizeRecoveryReason(value: unknown): keyof typeof RECOVERY_MESSAGES {
    return typeof value === "string" && Object.hasOwn(RECOVERY_MESSAGES, value)
      ? value as keyof typeof RECOVERY_MESSAGES : "source_unavailable";
  }

  constructor(recoveryReason: NativeHistoryBootstrapRequired["recoveryReason"] = "source_unavailable", options?: ErrorOptions) {
    super(RECOVERY_MESSAGES[recoveryReason], options);
    this.name = "NativeHistoryBootstrapRequired";
    this.recoveryReason = recoveryReason;
  }
}
