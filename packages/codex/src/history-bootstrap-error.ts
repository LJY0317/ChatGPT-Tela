/**
 * Typed, content-free recovery boundary shared by Native owner proof and
 * historical continuation. Never treat an unsafe Legacy paging limit as a
 * reason to replay or export an original Native conversation.
 */
const RECOVERY_MESSAGES = {
  source_unavailable: "Native readable history requires a verified checkpoint or explicit handoff; no previous evidence was omitted",
  unindexed_history: "Native indexed current-turn proof unavailable; unindexed history was not paged",
  checkpoint_interrupted: "A Web context checkpoint has an uncertain submitted outcome and requires reconciliation",
  checkpoint_closed: "The isolated Web checkpoint operation was released locally without a result; a new authorized Native turn is required",
  checkpoint_rejected: "A proven Web context checkpoint response was unusable; a new Native turn or verified handoff is required",
  source_budget: "Native readable context requires a verified checkpoint or explicit handoff because its source exceeds the bounded Web input; no previous evidence was omitted",
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
