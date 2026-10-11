export type NetworkFailureKind = "dns" | "timeout" | "tls" | "connection_refused" | "unreachable" | "connection_reset" | "cancelled" | "unknown";

/** Inspect a bounded cause/aggregate graph. Never copy messages, hosts, URLs or credentials. */
export function classifyNetworkFailure(error: unknown): NetworkFailureKind {
  const pending: unknown[] = [error];
  const visited = new Set<unknown>();
  let fallback: NetworkFailureKind = "unknown";
  for (let count = 0; pending.length && count < 16; count++) {
    const value = pending.shift();
    if (!value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    const item = value as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown };
    const code = typeof item.code === "string" ? item.code : "";
    if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_FAIL") return "dns";
    if (["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_SSL_PROTOCOL_ERROR"].includes(code)) return "tls";
    const kind: NetworkFailureKind = code === "ETIMEDOUT" || ["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(code) || item.name === "TimeoutError" ? "timeout"
      : code === "ECONNREFUSED" || code === "ConnectionRefused" ? "connection_refused"
      : code === "ENETUNREACH" || code === "EHOSTUNREACH" ? "unreachable"
      : code === "ECONNRESET" || code === "EPIPE" || code === "UND_ERR_SOCKET" ? "connection_reset"
      : item.name === "AbortError" || code === "ABORT_ERR" ? "cancelled" : "unknown";
    if (fallback === "unknown" && kind !== "unknown") fallback = kind;
    if (item.cause !== undefined) pending.push(item.cause);
    if (Array.isArray(item.errors)) pending.push(...item.errors.slice(0, 4));
  }
  return fallback;
}
