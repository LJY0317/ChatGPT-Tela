/** Fixed categories for Tela-owned preparation errors. Never return exception prose or identifiers. */
export function classifyWebPreparationFailure(error: unknown): string {
  if (!(error instanceof Error)) return "unclassified";
  if ((error as Error & { readonly code?: unknown }).code === "native_projection_unsupported") {
    return "request_projection_unsupported";
  }
  // Own typed cold-history recovery before matching message prose. A future
  // wording change must not turn a real historical bootstrap failure into
  // an unclassified 409-like incident in routine telemetry.
  if ((error as Error & { readonly code?: unknown }).code === "native_history_bootstrap_required") {
    if ((error as Error & { readonly recoveryReason?: unknown }).recoveryReason === "unindexed_history") {
      return "history_mode_unindexed";
    }
    return "history_bootstrap_required";
  }
  const exact: Readonly<Record<string, string>> = {
    "Native compaction history includes unsupported user content": "history_user_format_unsupported",
    "Native compaction history contains unsupported evidence": "history_evidence_unsupported",
    "Native compaction history exceeds the readable projection limit": "history_projection_limit",
    "Native readable history requires a verified checkpoint or explicit handoff; no previous evidence was omitted": "history_bootstrap_required",
    "Native public paginated history is unavailable; full history was not fetched": "history_paging_unavailable",
    "Native compaction history requires a complete active thread snapshot": "history_snapshot_incomplete",
    "Native compaction history does not belong to the current turn": "history_owner_unproven",
    "Native compaction history has no readable prefix before a checkpoint": "history_checkpoint_missing",
    "Native compaction history has ambiguous encrypted checkpoints": "history_checkpoint_ambiguous",
    "Native Web attachment source is not proven inline bytes": "request_media_source_unavailable",
    "Native Web attachment MIME is unsupported": "request_media_format_unsupported",
    "Native Web attachment bytes do not match declared media type": "request_media_integrity_invalid",
    "Native Web attachment contains invalid or oversized inline bytes": "request_media_integrity_invalid",
    "Native Web attachment is empty or exceeds the byte limit": "request_media_limit",
    "Web evidence attachment count exceeds adapter limit": "request_media_limit",
    "Web evidence reference count exceeds adapter limit": "request_media_limit",
    "Web evidence total upload bytes exceed adapter limit": "request_media_limit",
    "Web media lacks exact Native evidence and physical revision ownership": "request_media_owner_unproven",
    "Web media bytes, MIME, and Native digest did not match": "request_media_integrity_invalid",
    "Native inline historical assets require a matching visible history projection": "history_media_owner_unproven",
    "Native inline historical assets require matching structured history evidence": "history_media_owner_unproven",
    "Native ingress media belongs to a different thread": "request_media_owner_unproven",
    "Native ingress media belongs to a different current turn": "request_media_owner_unproven",
    "Native current turn contains media unavailable for Web upload": "request_media_source_unavailable",
    "Native ingress media has no current user revision": "request_media_projection_lost",
    "Native ingress media is not a verified current user image": "request_media_integrity_invalid",
    "Web physical context discarded verified Native evidence during fitting": "request_media_projection_lost",
    "native task already has an unsettled Web context plan": "context_plan_unsettled",
    "Native lifecycle notifications unavailable": "native_lifecycle_unavailable",
    "ChatGPT Web model requires one supported reasoning effort from the Native request": "model_effort_unsupported",
  };
  if (Object.hasOwn(exact, error.message)) return exact[error.message]!;
  if (/^Native (?:input_image|input_file|image|file) content is not supported by the development Web planner yet$/.test(error.message)) return "request_attachment_unsupported";
  if (error.name === "AbortError") return "aborted";
  if (error.name === "TimeoutError") return "deadline";
  return "unclassified";
}
