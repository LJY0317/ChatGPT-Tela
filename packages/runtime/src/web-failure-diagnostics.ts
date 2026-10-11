/** Classify only owned failure boundaries; exception prose and identifiers never leave this adapter. */
export function webExecutionFailureFields(error: unknown, signal?: AbortSignal) {
  const exact: Readonly<Record<string, string>> = {
    "retained ChatGPT conversation no longer contains its committed answer": "retained_answer_mismatch",
    "Native turn terminated": "native_terminated",
    "Native lifecycle observation disconnected": "native_observer_disconnected",
    "Native turn no longer active": "native_inactive",
    "ChatGPT Tela development runtime stopped": "runtime_stopped",
    "Web provider event belongs to a different turn": "event_identity_mismatch",
    "Web provider accepted a turn with the wrong causal identity": "accepted_identity_mismatch",
    "Web provider armed the wrong tool continuation boundary": "tool_boundary_mismatch",
    "ChatGPT conversation changed during the active Web turn": "conversation_changed",
    "ChatGPT accepted user identity changed during the active Web turn": "accepted_user_changed",
    "ChatGPT assistant parent does not prove the accepted request identity": "assistant_parent_unproven",
    "ChatGPT renderer rekey does not prove the accepted request identity": "renderer_rekey_unproven",
    "consequential action requires proven state; observed probable": "observation_probable",
    "consequential action requires proven state; observed ambiguous": "observation_ambiguous",
  };
  const kind = (value: unknown) => {
    if (!(value instanceof Error)) return "non_error";
    if (Object.hasOwn(exact, value.message)) return exact[value.message]!;
    if (value.name === "AbortError") return "aborted";
    if (value.name === "TimeoutError") return "deadline";
    if (value.message.startsWith("unexpected Web continuation from turn phase ")) return "continuation_phase_mismatch";
    return "unclassified";
  };
  return { reason_class: kind(error), owner_aborted: signal?.aborted === true,
    abort_reason_class: signal?.aborted ? kind(signal.reason) : "none" };
}
