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
  "not_found",
  "type_error",
  "http_rejected",
  "unknown",
] as const;

export type DiagnosticFailureClass = typeof DIAGNOSTIC_FAILURE_CLASSES[number];

function directFailureClass(error: unknown): DiagnosticFailureClass {
  try {
    if (!error || typeof error !== "object") return "unknown";
    const item = error as { readonly name?: unknown; readonly code?: unknown; readonly message?: unknown };
    if (item.name === "TypeError") return "type_error";
    if (item.code === "ENOENT") return "not_found";
    if (item.code === "tela_service_http_error") return "http_rejected";
    if (item.name === "AbortError") return "aborted";
    if (item.name === "TimeoutError" || item.code === "ETIMEDOUT") return "timeout";
    if (item.code === "ENOSPC") return "storage_capacity";
    if (item.code === "EACCES" || item.code === "EPERM") return "permission_rejected";
    if (typeof item.code === "string"
      && ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ENETUNREACH"].includes(item.code)) {
      return "transport_failure";
    }
    if (item.code === "native_auto_handoff_unavailable") return "unavailable";
    const message = typeof item.message === "string" ? item.message.slice(0, 4096) : "";
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

/** Inspect a bounded causal chain; no messages, arbitrary codes or stacks cross this boundary. */
export function diagnosticFailureFields(error: unknown): Readonly<{
  reason_class: DiagnosticFailureClass; cause_depth: number; error_inspection_complete: boolean; http_status?: number;
}> {
  const seen = new Set<object>(); let value = error, depth = 0;
  let httpStatus: number | undefined;
  try {
    for (; depth < 4 && value && typeof value === "object"; depth++) {
      if (seen.has(value)) return { reason_class: "unknown", cause_depth: depth, error_inspection_complete: false };
      seen.add(value);
      const item = value as { code?: unknown; httpStatus?: unknown; cause?: unknown };
      if (item.code === "tela_service_http_error" && Number.isInteger(item.httpStatus)
        && Number(item.httpStatus) >= 400 && Number(item.httpStatus) <= 599) httpStatus = Number(item.httpStatus);
      const reason = directFailureClass(value);
      if (reason !== "unknown") return { reason_class: reason, cause_depth: depth, error_inspection_complete: true,
        ...(httpStatus === undefined ? {} : { http_status: httpStatus }) };
      value = item.cause;
    }
    return { reason_class: "unknown", cause_depth: depth, error_inspection_complete: value == null };
  } catch { return { reason_class: "unknown", cause_depth: depth, error_inspection_complete: false }; }
}
export function diagnosticFailureClass(error: unknown): DiagnosticFailureClass {
  return diagnosticFailureFields(error).reason_class;
}
