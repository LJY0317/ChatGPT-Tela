export type NetworkFailureKind = "dns" | "timeout" | "tls" | "connection_refused" | "unreachable" | "connection_reset" | "cancelled" | "unknown";

const CODES: Readonly<Record<string, readonly [NetworkFailureKind, string, string]>> = {
  ENOTFOUND: ["dns", "dns_not_found", "connect"], EAI_AGAIN: ["dns", "dns_temporary", "connect"], EAI_FAIL: ["dns", "dns_failed", "connect"],
  ETIMEDOUT: ["timeout", "socket_timeout", "unknown"],
  UND_ERR_CONNECT_TIMEOUT: ["timeout", "connect_timeout", "connect"],
  UND_ERR_HEADERS_TIMEOUT: ["timeout", "headers_timeout", "headers"],
  UND_ERR_BODY_TIMEOUT: ["timeout", "body_timeout", "body"],
  ECONNREFUSED: ["connection_refused", "connection_refused", "connect"], ConnectionRefused: ["connection_refused", "connection_refused", "connect"],
  ENETUNREACH: ["unreachable", "network_unreachable", "connect"], EHOSTUNREACH: ["unreachable", "host_unreachable", "connect"],
  ECONNRESET: ["connection_reset", "connection_reset", "transport"], EPIPE: ["connection_reset", "broken_pipe", "transport"],
  UND_ERR_SOCKET: ["connection_reset", "socket_closed", "transport"], ABORT_ERR: ["cancelled", "aborted", "unknown"],
};
const TLS_CODES = new Set(["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_SSL_PROTOCOL_ERROR"]);

/** One bounded cause/aggregate traversal; only fixed categories leave this boundary. */
export function networkFailureDiagnostics(error: unknown) {
  const pending: { value: unknown; depth: number }[] = [{ value: error, depth: 0 }];
  const visited = new Set<unknown>();
  let selected: readonly [NetworkFailureKind, string, string] = ["unknown", "unclassified", "unknown"];
  let causeDepth = 0, complete = true, priority = false;
  try {
    while (pending.length && visited.size < 16) {
      const { value, depth } = pending.shift()!;
      if (!value || typeof value !== "object" || visited.has(value)) continue;
      visited.add(value);
      const item = value as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown };
      const code = typeof item.code === "string" ? item.code : "";
      const known = Object.hasOwn(CODES, code) ? CODES[code] : undefined;
      const detail: readonly [NetworkFailureKind, string, string] = TLS_CODES.has(code) ? ["tls", "tls_validation", "connect"]
        : known ?? (item.name === "TimeoutError" ? ["timeout", "deadline", "unknown"]
          : item.name === "AbortError" ? ["cancelled", "aborted", "unknown"] : ["unknown", "unclassified", "unknown"]);
      const preferred = detail[0] === "dns" || detail[0] === "tls";
      if ((!priority && preferred) || selected[0] === "unknown"
        || (!priority && detail[0] === selected[0] && selected[2] === "unknown" && detail[2] !== "unknown")) {
        selected = detail; causeDepth = depth; priority = preferred;
      }
      if (item.cause !== undefined) pending.push({ value: item.cause, depth: depth + 1 });
      if (Array.isArray(item.errors)) for (const cause of item.errors.slice(0,4)) pending.push({ value: cause, depth: depth + 1 });
    }
  } catch { complete = false; }
  return { network_kind: selected[0], failure_class: selected[1], phase: selected[2], cause_depth: causeDepth,
    inspected_nodes: visited.size, error_inspection_complete: complete && pending.length === 0 };
}

export function classifyNetworkFailure(error: unknown): NetworkFailureKind {
  return networkFailureDiagnostics(error).network_kind;
}
