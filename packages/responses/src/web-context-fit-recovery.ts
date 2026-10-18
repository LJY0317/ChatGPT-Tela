import { webContextFitFailureReason } from "@chatgpt-tela/core";

export function webContextFitRecovery(error: unknown) {
  const reason = webContextFitFailureReason(error);
  if (!reason) return undefined;
  return {
    type: "invalid_request_error", code: "tela_web_context_fit_failed", retryable: false,
    message: reason === "invalid_physical_limits"
      ? "Tela could not validate the Web context limits. Continue on Native until the Web configuration is repaired."
      : "The current Native context cannot fit this Web request. Continue on Native or prepare a verified bounded handoff; reconnecting this failed turn cannot repair it.",
    recovery: { kind: "continue_on_native", requires_user_action: true,
      requires_new_native_turn: true, requires_new_conversation: false,
      original_history_preserved: true, reason },
  } as const;
}
