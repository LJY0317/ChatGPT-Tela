import { WebProviderResponseFailed } from "@chatgpt-tela/core";
import { webContextFitRecovery } from "./web-context-fit-recovery";
import { nativeHandoffRecovery } from "./native-handoff-recovery";
import { nativeHistoryRecovery } from "./native-history-recovery";
import { webContinuityRecovery } from "./web-continuity-recovery";
import { nativeProjectionRecovery } from "./native-projection-recovery";

const TERMINAL_FAILURES = {
  tela_native_turn_already_retired: {
    message: "This Native turn is already retired. Repeating it cannot resume the interrupted operation. Continue with a new, explicitly authorized Native turn, reusing verified context and reconciling any uncertain operation first.",
    recovery: { kind: "authorized_native_continuation", requires_user_action: true,
      requires_new_native_turn: true, requires_new_conversation: false,
      reuse_verified_context_first: true, prior_execution_settled: "unknown" },
  },
  tela_web_provider_response_failed: {
    message: "ChatGPT에서 응답이 중단됐습니다. 원래 요청은 아직 완료되지 않았습니다.",
    recovery: { kind: "reconcile_accepted_web_turn", requires_user_action: true,
      requires_new_native_turn: true, requires_new_conversation: false,
      original_history_preserved: true, reuse_verified_context_first: true, prior_execution_settled: "unknown" },
  },
  tela_native_response_cycle_conflict: {
    message: "This completed response cycle has no proven new input. Do not retry it; continue with a new authorized turn and verified context.",
  },
  tela_native_tool_result_missing: {
    message: "The delivered Native tool call has no matching result in this continuation. Reconcile the original tool outcome before continuing.",
  },
} as const;

/** One public failure projection for HTTP, late SSE failure and retired replays. */
export function nativeFailure(error: unknown) {
  const fit = webContextFitRecovery(error), handoff = nativeHandoffRecovery(error), projection = nativeProjectionRecovery(error);
  const recovery = fit ?? handoff ?? projection ?? webContinuityRecovery(error) ?? nativeHistoryRecovery(error);
  if (recovery) return { error: recovery, recoveryReason: fit ? "physical_context_fit_failed"
    : recovery.code === "tela_web_observation_unproven" ? "web_observation_unproven"
    : recovery.code === "tela_native_context_checkpoint_required" ? "source_exceeds_web_budget"
    : recovery.code === "tela_web_submission_unproven" ? "web_submission_unproven"
    : recovery.code === "tela_web_retained_context_unproven" ? "retained_context_unproven"
    : handoff ? "handoff_proof_unavailable" : projection ? "request_projection_unsupported"
    : recovery.recovery.kind === "continue_on_native" ? "history_mode_unindexed" : "history_bootstrap_required" };
  const code = error !== null && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (typeof code === "string" && Object.hasOwn(TERMINAL_FAILURES, code)) return {
    error: { type: "invalid_request_error", code, retryable: false,
      ...TERMINAL_FAILURES[code as keyof typeof TERMINAL_FAILURES],
      ...(error instanceof WebProviderResponseFailed ? { reason_class: error.reasonClass,
        ...(error.reasonClass === "unusual_activity" ? { message: "ChatGPT에서 활동 제한 안내와 함께 응답이 중단됐습니다. 원래 요청은 아직 완료되지 않았습니다." } : {}) } : {}) },
  };
  return { error: { type: "invalid_request_error", retryable: false,
    ...(code === "tela_web_model_unavailable" ? { code } : {}),
    message: error instanceof Error ? error.message : String(error) } };
}
