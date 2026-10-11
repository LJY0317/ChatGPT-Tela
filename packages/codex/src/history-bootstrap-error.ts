/**
 * Typed, content-free recovery boundary shared by Native owner proof and
 * historical continuation. Never treat an unsafe Legacy paging limit as a
 * reason to replay or export an original Native conversation.
 */
export class NativeHistoryBootstrapRequired extends Error {
  readonly code = "native_history_bootstrap_required" as const;
  readonly recoveryReason: "source_unavailable" | "unindexed_history";

  constructor(recoveryReason: "source_unavailable" | "unindexed_history" = "source_unavailable") {
    super(recoveryReason === "unindexed_history"
      ? "Native indexed current-turn proof unavailable; unindexed history was not paged"
      : "Native readable history requires a verified checkpoint or explicit handoff; no previous evidence was omitted");
    this.name = "NativeHistoryBootstrapRequired";
    this.recoveryReason = recoveryReason;
  }
}
