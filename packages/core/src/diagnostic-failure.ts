/**
 * Closed, payload-free diagnostic failure classification.
 *
 * A thrown message may contain command text, absolute paths or private user
 * content. Only test it against a short set of product-owned markers; never
 * emit the message, stack, arbitrary error code or object properties.
 * Unknown is evidence of missing classification, NOT a reason to serialize.
 */
export const DIAGNOSTIC_FAILURE_CLASSES = [
  "aborted",
  "capacity_exhausted",
  "history_unindexed",
  "input_rejected",
  "owner_unavailable",
  "permission_rejected",
  "request_conflict",
  "storage_capacity",
  "storage_failure",
  "timeout",
  "transport_failure",
  "unavailable",
  "unknown",
] as const;

export type DiagnosticFailureClass = typeof DIAGNOSTIC_FAILURE_CLASSES[number];

export function diagnosticFailureClass(error: unknown): DiagnosticFailureClass {
  try {
    if (!error || typeof error !== "object") return "unknown";
    const item = error as { readonly name?: unknown; readonly code?: unknown; readonly message?: unknown };
    if (item.name === "AbortError") return "aborted";
    if (item.name === "TimeoutError" || item.code === "ETIMEDOUT") return "timeout";
    if (item.code === "ENOSPC") return "storage_capacity";
    if (item.code === "EACCES" || item.code === "EPERM") return "permission_rejected";
    if (typeof item.code === "string"
      && ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ENETUNREACH"].includes(item.code)) {
      return "transport_failure";
    }
    if (item.code === "native_auto_handoff_unavailable") return "unavailable";
    const message = typeof item.message === "string" ? item.message : "";
    if (message.includes("process operation registry is at capacity")
      || message.includes("process session identity capacity exhausted")) return "capacity_exhausted";
    if (message.includes("process operation store exceeds its byte limit")) return "storage_capacity";
    if (message.includes("Native indexed current-turn proof unavailable; unindexed history was not paged")
      || message.includes("Native public paginated current-turn proof is unavailable")) return "history_unindexed";
    if (message.includes("process operation request does not match")
      || message.includes("process operation belongs to another workspace")) return "request_conflict";
    if (message.includes("process operation request identity is unavailable")
      || message.includes("unresolved execution")) return "owner_unavailable";
    if (message.includes("command is empty or too large")
      || message.includes("yieldTime must be an integer")) return "input_rejected";
  } catch {
    // Exception proxies/accessors must not make the diagnostic path a new
    // reason for the primary request to fail.
  }
  return "unknown";
}
