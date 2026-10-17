import type { NativeHistoryBootstrapRequired } from "@chatgpt-tela/codex";

/** Public recovery projection of the Native-owned lifecycle state. Diagnostics and
 * exception text never determine authority or get copied into the response. */
const RECOVERY = {
  checkpoint_rejected: {code: "tela_native_checkpoint_response_rejected", kind: "explicit_native_handoff", newTurn: true,
    message: "A proven Web context-summary response was unusable and its isolated operation was released. This Native turn will not resend it. Continue in a newly authorized Native turn or provide a verified handoff. Completed checkpoint stages and original history are preserved; no task answer or tool execution was committed by this request." },
  source_budget: {code: "tela_native_context_checkpoint_required", kind: "explicit_native_handoff", newTurn: true,
    message: "The original history requires more checkpoint preparation than the configured Web budget permits. No summary model call is automatically added and no evidence was truncated. If an existing completed compatible checkpoint is unavailable, for a verified paginated Native conversation: finish this failed turn, switch to Native in the SAME conversation, submit exactly NATIVE_WEB_HANDOFF_PROMPT (available in the Tela source documentation) as a separate user-requested, read-only handoff, wait for its final JSON summary and limitations, then select Web in the immediately following new turn. Unindexed/Legacy history cannot use this indexed handoff path; continue Native. Historical facts and files still require currently authorized source readback. This failed request committed no Web answer or task tool action." },
  checkpoint_interrupted: {code: "tela_native_checkpoint_reconciliation_required", kind: "reconcile_checkpoint", newTurn: true,
    message: "A Web context-summary submission has an uncertain outcome and was not resent. Reconcile the owned checkpoint operation or provide an explicitly authorized verified handoff before a new Native turn continues. Original history is preserved; no task answer or tool execution was committed by this request." },
  unindexed_history: {code: "tela_native_history_indexed_source_required", kind: "continue_on_native", newTurn: false,
    message: "This Native conversation uses unindexed history that cannot be safely replayed for Web. Continue on Native; a new handoff turn alone cannot establish an indexed source. Web continuation requires a supported independently verified checkpoint or a new public bounded history contract. Original history is preserved, and this request committed no Web answer or tool action." },
  source_unavailable: {code: "tela_native_history_checkpoint_required", kind: "explicit_native_handoff", newTurn: true,
    message: "This Native conversation needs a verified readable checkpoint or an explicit authorized handoff before Web can continue. Original history was preserved, not silently truncated. No Web answer or tool execution was committed by this request." },
  checkpoint_closed: {code: "tela_native_checkpoint_operation_closed", kind: "explicit_native_handoff", newTurn: true,
    message: "Web context preparation ended after its isolated operation was released locally without a usable result. Continue with a new explicitly authorized Native turn using the preserved checkpoints. This retired turn will not resend. Remote outcome remains unknown; original history and completed checkpoint stages are preserved. No task answer or tool execution was committed by this request." },
} as const satisfies Record<NativeHistoryBootstrapRequired["recoveryReason"], {
  readonly code: string;
  readonly kind: "continue_on_native" | "explicit_native_handoff" | "reconcile_checkpoint";
  readonly newTurn: boolean;
  readonly message: string;
}>;

export function nativeHistoryRecovery(error: unknown) {
  if (!error || typeof error !== "object"
    || (error as {code?: unknown}).code !== "native_history_bootstrap_required") return undefined;
  const reason = (error as {recoveryReason?: unknown}).recoveryReason;
  const decision = typeof reason === "string" && Object.hasOwn(RECOVERY, reason)
    ? RECOVERY[reason as keyof typeof RECOVERY] : RECOVERY.source_unavailable;
  return {
    type: "invalid_request_error" as const,
    code: decision.code,
    retryable: false as const,
    recovery: {
      kind: decision.kind,
      requires_user_action: true as const,
      requires_new_native_turn: decision.newTurn,
      original_history_preserved: true as const,
    },
    message: decision.message,
  };
}
