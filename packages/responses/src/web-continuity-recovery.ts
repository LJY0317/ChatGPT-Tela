import { webRetainedContextFailureReason, webSubmissionFailureReason, webObservationFailureReason } from "@chatgpt-tela/core";

/** Shared by HTTP and already-started SSE. Never expose an adapter exception. */
export function webContinuityRecovery(error: unknown) {
  const observationReason = webObservationFailureReason(error);
  if (observationReason) return {
    type: "invalid_request_error" as const, code: "tela_web_observation_unproven" as const,
    reason: observationReason, retryable: false as const,
    recovery: { kind: "reconcile_accepted_web_turn" as const, requires_user_action: true as const,
      requires_new_native_turn: true as const, requires_new_conversation: false as const,
      original_history_preserved: true as const, reuse_verified_context_first: true as const },
    message: observationReason === "response_wait_timeout"
      ? "응답 확인 시간이 초과되었습니다. Tela 제어 센터의 Work → Web activity에 세션이 남아 있으면 Open browser로 확인하세요."
      : "The Web request was accepted, but its response could not be verified as belonging to the original request. Do not resend it automatically. Reconcile the existing operation before continuing in this conversation with a new authorized turn.",
  };
  const submissionReason = webSubmissionFailureReason(error);
  if (submissionReason) return {
    type: "invalid_request_error" as const,
    code: "tela_web_submission_unproven" as const,
    reason: submissionReason,
    retryable: false as const,
    recovery: { kind: "reconcile_web_submission" as const, requires_user_action: true as const,
      requires_new_native_turn: true as const, original_history_preserved: true as const },
    message: submissionReason === "recorded_send_without_result"
      ? "This Web request may already have been sent. Tela has no saved answer to recover. If its browser session is still listed under Tela → Work → Web activity, open it to check the result before sending again."
      : "The Web message may have been accepted, but local verification failed. Do not resend it. Reconcile the existing submission before continuing with a new authorized Native turn. Prepared context and original history are preserved.",
  };
  const reason = webRetainedContextFailureReason(error);
  if (!reason) return undefined;
  return {
    type: "invalid_request_error" as const,
    code: "tela_web_retained_context_unproven" as const,
    reason,
    retryable: false as const,
    recovery: { kind: "verify_retained_context" as const, requires_user_action: true as const,
      requires_new_native_turn: true as const, original_history_preserved: true as const },
    message: "The existing Web conversation could not prove its retained answer. Repeating this turn cannot recover it. Continue only with a new authorized Native turn and a verified context checkpoint. Original history is preserved.",
  };
}
