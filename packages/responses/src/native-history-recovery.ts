/** A Native-owned recovery decision, safe to expose even after streaming has
 * already begun. Never copy an upstream/adapter exception message into it. */
export function nativeHistoryRecovery(error: unknown): {
  readonly type: "invalid_request_error";
  readonly code: "tela_native_checkpoint_response_rejected" | "tela_native_history_indexed_source_required" | "tela_native_history_checkpoint_required" | "tela_native_checkpoint_reconciliation_required" | "tela_native_context_checkpoint_required";
  readonly retryable: false;
  readonly recovery: {
    readonly kind: "continue_on_native" | "explicit_native_handoff" | "reconcile_checkpoint";
    readonly requires_user_action: true;
    readonly requires_new_native_turn: boolean;
    readonly original_history_preserved: true;
  };
  readonly message: string;
} | undefined {
  if (!error || typeof error !== "object"
    || (error as { code?: unknown }).code !== "native_history_bootstrap_required") {
    return undefined;
  }
  const rejected = (error as { recoveryReason?: unknown }).recoveryReason === "checkpoint_rejected";
  const unindexed = (error as { recoveryReason?: unknown }).recoveryReason === "unindexed_history";
  const interrupted = (error as { recoveryReason?: unknown }).recoveryReason === "checkpoint_interrupted";
  const sourceBudget = (error as { recoveryReason?: unknown }).recoveryReason === "source_budget";
  return {
    type: "invalid_request_error" as const,
    code: rejected ? "tela_native_checkpoint_response_rejected" : sourceBudget ? "tela_native_context_checkpoint_required"
      : interrupted ? "tela_native_checkpoint_reconciliation_required"
      : unindexed ? "tela_native_history_indexed_source_required"
      : "tela_native_history_checkpoint_required",
    retryable: false,
    recovery: {
      kind: interrupted ? "reconcile_checkpoint" : unindexed ? "continue_on_native" : "explicit_native_handoff",
      requires_user_action: true,
      requires_new_native_turn: !unindexed,
      original_history_preserved: true,
    },
    message: rejected
      ? "A proven Web context-summary response was unusable and its isolated operation was released. This Native turn will not resend it. Continue in a newly authorized Native turn or provide a verified handoff. Completed checkpoint stages and original history are preserved; no task answer or tool execution was committed by this request."
      : sourceBudget
      ? "This conversation's readable context exceeds the Web checkpoint input budget. Continue on Native or provide an explicitly authorized verified checkpoint or handoff. Original history is preserved; no Web answer or tool execution was committed by this request."
      : interrupted
      ? "A Web context-summary submission has an uncertain outcome and was not resent. Reconcile the owned checkpoint operation or provide an explicitly authorized verified handoff before a new Native turn continues. Original history is preserved; no task answer or tool execution was committed by this request."
      : unindexed
      ? "This Native conversation uses unindexed history that cannot be safely replayed for Web. Continue on Native; a new handoff turn alone cannot establish an indexed source. Web continuation requires a supported independently verified checkpoint or a new public bounded history contract. Original history is preserved, and this request committed no Web answer or tool action."
      : "This Native conversation needs a verified readable checkpoint or an explicit authorized handoff before Web can continue. Original history was preserved, not silently truncated. No Web answer or tool execution was committed by this request.",
  };
}
