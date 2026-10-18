/** Failed handoff may follow a real tool execution; this never authorizes re-execution. */
export function nativeHandoffRecovery(error: unknown) {
  if (!error || typeof error !== "object"
    || (error as {code?: unknown}).code !== "native_web_handoff_unproven") return undefined;
  return {
    type: "invalid_request_error", code: "tela_native_handoff_reconciliation_required", retryable: false,
    message: "Web continuation could not be proven after a Native tool result. Check whether the existing result completed its effect, then continue the same user goal with another available tool or method. A retired turn cannot be resumed.",
    recovery: {kind: "reconcile_tool_handoff", requires_user_action: true,
      requires_new_native_turn: true, original_history_preserved: true, prior_execution_settled: "unknown"},
  } as const;
}
