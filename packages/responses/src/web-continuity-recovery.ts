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
      ? "응답 확인 시간이 초과되어 대기를 중단했습니다. 기존 대화는 보존했으며, 실제 작업의 완료 여부는 아직 확인되지 않았습니다."
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
    message: "The Web message may have been accepted, but local verification failed. Do not resend it. Reconcile the existing submission before continuing with a new authorized Native turn. Prepared context and original history are preserved.",
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
