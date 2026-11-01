import { createHmac, randomBytes } from "node:crypto";
import type { NativeToolCatalogEntry } from "./tools";
import type { DiagnosticScalar } from "./diagnostic-events";
import { structuralDiagnosticEvent, type StructuralDiagnosticEvent } from "./diagnostic-store";

/** Per-call MCP evidence for a caller-supplied, host-observed session fingerprint.
 * An MCP session is never inferred from a Native thread or browser URL. */
export function inspectMcpSessionCalls(events: readonly StructuralDiagnosticEvent[], scopeFingerprint: string) {
  if (!/^[a-f0-9]{24}$/.test(scopeFingerprint)) throw new Error("invalid MCP scope fingerprint");
  const rows = events.flatMap(value => {
    const row = structuralDiagnosticEvent(value);
    return row?.event === "chatgpt_tela_mcp" ? [row] : [];
  });
  const received = rows.filter(row => row.stage === "mcp_rpc_received"
    && row.scope_fingerprint === scopeFingerprint && row.method_class === "tools_call");
  return received.map(start => {
    const connection = start.connection_fingerprint;
    const rpc = start.rpc_fingerprint;
    const samePair = rows.filter(row => row.connection_fingerprint === connection
      && row.rpc_fingerprint === rpc);
    const starts = samePair.filter(row => row.stage === "mcp_rpc_received");
    const emissions = samePair.filter(row => row.stage === "mcp_rpc_emitted");
    // SDK tool callbacks carry openai/session and requestId but not the HTTP
    // transport's generated connection fingerprint. Only join a callback when
    // the session+RPC pair identifies exactly one HTTP request.
    const sessionPair = rows.filter(row => row.scope_fingerprint === scopeFingerprint
      && row.rpc_fingerprint === rpc);
    const scopedStarts = sessionPair.filter(row => row.stage === "mcp_rpc_received");
    const settled = sessionPair.filter(row => row.stage === "tool_settled");
    const callbacks = sessionPair.filter(row => row.stage === "tool_started");
    const failures = sessionPair.filter(row => row.stage === "tool_failed" || row.stage === "tool_error");
    const unique = typeof connection === "string" && /^[a-f0-9]{24}$/.test(connection)
      && typeof rpc === "string" && /^[a-f0-9]{24}$/.test(rpc)
      && starts.length === 1 && starts[0] === start && emissions.length <= 1
      && scopedStarts.length === 1 && callbacks.length <= 1 && settled.length <= 1
      && failures.length <= 1;
    const emitted = unique ? emissions[0] : undefined;
    return Object.freeze({
      scopeFingerprint, connectionFingerprint: connection ?? null, rpcFingerprint: rpc ?? null,
      correlation: unique ? "unique_connection_rpc" as const : "ambiguous_or_missing" as const,
      kind: start.kind ?? "other",
      callback: unique ? (failures.some(row => row.stage === "tool_failed") ? "threw"
        : failures.some(row => row.stage === "tool_error") ? "returned_error"
        : settled.length === 1 ? "settled" : "not_observed") : "unattributed",
      transport: emitted?.delivery === "transport_send_returned" ? "send_returned" : "not_observed",
      errorResult: emitted?.error_result ?? null,
      errorCode: typeof emitted?.error_code === "number" ? emitted.error_code : null,
      modelReceipt: "not_observed" as const,
    });
  });
}

const key = randomBytes(32);
/** Contract-only, salted fingerprints. Never hash invocation arguments or result bodies. */
export function diagnosticToolContract(tool: NativeToolCatalogEntry): Readonly<Record<string, DiagnosticScalar>> {
  try {
    let nodes = 0, bytes = 0;
    const normalize = (value: unknown, depth = 0): unknown => {
      if (++nodes > 512 || depth > 12) throw Error("diagnostic contract budget");
      if (typeof value === "string") { bytes += Buffer.byteLength(value); if (bytes > 65536) throw Error("diagnostic contract budget"); return value; }
      if (value == null || typeof value === "boolean" || typeof value === "number") return value;
      if (Array.isArray(value)) { if (value.length > 128) throw Error("diagnostic contract budget"); return value.map(entry => normalize(entry, depth + 1)); }
      if (typeof value === "object") {
        const keys = Object.keys(value).sort(); if (keys.length > 128) throw Error("diagnostic contract budget");
        return keys.map(name => [normalize(name, depth + 1), normalize((value as Record<string, unknown>)[name], depth + 1)]);
      }
      throw Error("unsupported diagnostic contract");
    };
    if (tool.wireName.length > 16384) throw Error("diagnostic identity budget");
    const fingerprint = (text: string) => createHmac("sha256", key).update(text).digest("hex").slice(0, 24);
    return { tool_fingerprint: fingerprint(tool.wireName), schema_fingerprint: fingerprint(JSON.stringify(normalize(tool.inputSchema ?? null))),
      kind: tool.kind, namespace_present: Boolean(tool.namespace), contract_observed: true };
  } catch { return { contract_observed: false }; }
}
