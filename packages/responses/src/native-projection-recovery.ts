/** No input types, identifiers, agent text or upstream exception prose cross this boundary. */
export function nativeProjectionRecovery(error: unknown) {
  if (!error || typeof error !== "object"
    || (error as { code?: unknown }).code !== "native_projection_unsupported") return undefined;
  return {
    type: "invalid_request_error",
    code: "tela_native_projection_unsupported",
    retryable: false,
    message: "Tela cannot safely transfer this Native context to Web. Continue on Native until this content is supported. Repeating the Web request or opening a new Web turn alone will not repair the context.",
    recovery: { kind: "continue_on_native", requires_user_action: true,
      requires_new_native_turn: true, original_history_preserved: true },
  } as const;
}
