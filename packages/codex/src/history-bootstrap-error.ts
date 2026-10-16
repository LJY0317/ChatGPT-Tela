/**
 * Typed, content-free recovery boundary shared by Native owner proof and
 * historical continuation. Never treat an unsafe Legacy paging limit as a
 * reason to replay or export an original Native conversation.
 */
export class NativeHistoryBootstrapRequired extends Error {
  readonly code = "native_history_bootstrap_required" as const;
  readonly recoveryReason: "source_unavailable" | "unindexed_history" | "checkpoint_interrupted" | "checkpoint_rejected" | "source_budget";

  constructor(recoveryReason: NativeHistoryBootstrapRequired["recoveryReason"] = "source_unavailable", options?: ErrorOptions) {
    super(recoveryReason === "checkpoint_rejected"
      ? "A proven Web context checkpoint response was unusable; a new Native turn or verified handoff is required"
      : recoveryReason === "checkpoint_interrupted"
      ? "A Web context checkpoint has an uncertain submitted outcome and requires reconciliation"
      : recoveryReason === "unindexed_history"
      ? "Native indexed current-turn proof unavailable; unindexed history was not paged"
      : recoveryReason === "source_budget"
      ? "Native readable context requires a verified checkpoint or explicit handoff because its source exceeds the bounded Web input; no previous evidence was omitted"
      : "Native readable history requires a verified checkpoint or explicit handoff; no previous evidence was omitted", options);
    this.name = "NativeHistoryBootstrapRequired";
    this.recoveryReason = recoveryReason;
  }
}
