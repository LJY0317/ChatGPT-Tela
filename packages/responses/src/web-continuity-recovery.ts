import { webRetainedContextFailureReason } from "@chatgpt-tela/core";

/** Shared by HTTP and already-started SSE. Never expose an adapter exception. */
export function webContinuityRecovery(error: unknown) {
  const reason = webRetainedContextFailureReason(error);
  if (!reason) return undefined;
  return {
    code: "tela_web_retained_context_unproven" as const,
    reason,
    retryable: false as const,
    recovery: { kind: "verify_retained_context" as const, requires_user_action: true as const,
      requires_new_native_turn: true as const, original_history_preserved: true as const },
    message: "The existing Web conversation could not prove its retained answer. Repeating this turn cannot recover it. Continue only with a new authorized Native turn and a verified context checkpoint. Original history is preserved.",
  };
}
