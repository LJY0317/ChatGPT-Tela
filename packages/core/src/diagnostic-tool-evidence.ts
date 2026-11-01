import { createHmac, randomBytes } from "node:crypto";
import type { NativeToolCatalogEntry } from "./tools";
import type { DiagnosticScalar } from "./diagnostic-events";
import type { StructuralDiagnosticEvent } from "./diagnostic-store";

/** One scan of already-sanitized diagnostic-store events. MCP openai/session is
 * not proof of a Native turn or browser conversation's identity. */
export function inspectMcpSessionCalls(events: readonly StructuralDiagnosticEvent[]) {
  type Group = { received: StructuralDiagnosticEvent[]; emitted: StructuralDiagnosticEvent[];
    started: StructuralDiagnosticEvent[]; settled: StructuralDiagnosticEvent[]; failed: StructuralDiagnosticEvent[] };
  const groups = () => ({ received: [], emitted: [], started: [], settled: [], failed: [] } as Group);
  const byConnection = new Map<string, Group>(), bySession = new Map<string, Group>();
  const starts: StructuralDiagnosticEvent[] = [];
  const fp = (value: unknown) => typeof value === "string" && /^[a-f0-9]{24}$/.test(value) ? value : undefined;
  for (const row of events) {
    if (row.event !== "chatgpt_tela_mcp") continue;
    const connection = fp(row.connection_fingerprint), scope = fp(row.scope_fingerprint), rpc = fp(row.rpc_fingerprint);
    if (connection && rpc) {
      const key = connection + ":" + rpc, group = byConnection.get(key) ?? groups();
      byConnection.set(key, group);
      if (row.stage === "mcp_rpc_received") group.received.push(row);
      if (row.stage === "mcp_rpc_emitted") group.emitted.push(row);
    }
    if (!scope || !rpc) continue;
    const key = scope + ":" + rpc, group = bySession.get(key) ?? groups();
    bySession.set(key, group);
    if (row.stage === "mcp_rpc_received") {
      group.received.push(row);
      if (row.method_class === "tools_call") starts.push(row);
    }
    if (row.stage === "tool_started") group.started.push(row);
    if (row.stage === "tool_settled") group.settled.push(row);
    if (row.stage === "tool_failed" || row.stage === "tool_error") group.failed.push(row);
  }
  return starts.map(start => {
    const scope = fp(start.scope_fingerprint)!;
    const connection = fp(start.connection_fingerprint), rpc = fp(start.rpc_fingerprint)!;
    const transport = connection ? byConnection.get(connection + ":" + rpc) : undefined;
    const session = bySession.get(scope + ":" + rpc)!;
    // Callbacks lack connection identity; a reused scope+RPC cannot be assigned
    // to either request, even when connection+RPC uniquely identifies its send.
    const unique = transport?.received.length === 1 && transport.received[0] === start
      && transport.emitted.length <= 1 && session.received.length === 1
      && session.received[0] === start && session.started.length <= 1
      && session.settled.length <= 1 && session.failed.length <= 1;
    const emitted = unique ? transport?.emitted[0] : undefined;
    return Object.freeze({
      at: start.ts, scopeFingerprint: scope, connectionFingerprint: connection ?? null, rpcFingerprint: rpc,
      correlation: unique ? "unique_connection_rpc" as const : "ambiguous_or_missing" as const,
      kind: ["chat_call", "chat_inventory", "codex_call", "codex_inventory"].includes(String(start.kind))
        ? start.kind : "other",
      callback: unique ? (session.failed.some(row => row.stage === "tool_failed") ? "threw"
        : session.failed.some(row => row.stage === "tool_error") ? "returned_error"
        : session.settled.length === 1 ? "settled" : "not_observed") : "unattributed",
      transport: emitted?.delivery === "transport_send_returned" ? "send_returned" : "not_observed",
      errorResult: emitted?.error_result ?? null,
      errorCode: typeof emitted?.error_code === "number" ? emitted.error_code : null,
      modelReceipt: "not_observed" as const,
      nativeTurnAttribution: "not_proven" as const,
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
