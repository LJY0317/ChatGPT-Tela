/** A failure to prove an already accepted Web response, never permission to resend. */
export type WebObservationReason = "conversation_changed" | "request_changed" | "lineage_conflict" | "response_wait_timeout";
export function webObservationFailureReason(error: unknown): WebObservationReason | undefined {
  if (!error || typeof error !== "object") return;
  const value = error as { code?: unknown; reason?: unknown };
  return value.code === "tela_web_observation_unproven"
    && typeof value.reason === "string"
    && ["conversation_changed", "request_changed", "lineage_conflict", "response_wait_timeout"].includes(value.reason)
    ? value.reason as WebObservationReason : undefined;
}
export class WebObservationUnproven extends Error {
  readonly code = "tela_web_observation_unproven";
  readonly retryable = false;
  constructor(readonly reason: WebObservationReason, message = "Accepted Web response ownership could not be verified") {
    super(message); this.name = "WebObservationUnproven";
  }
}
