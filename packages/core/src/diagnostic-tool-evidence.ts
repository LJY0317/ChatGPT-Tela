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
  const safeNumber = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const safeString = (value: unknown) => typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(value) ? value : null;
  const projectChatHttp = (start: StructuralDiagnosticEvent, uniqueParent: boolean) => {
    const parentRequestFingerprint = fp(start.request_fingerprint);
    if (!parentRequestFingerprint) return Object.freeze({
      correlation: "parent_request_not_observed" as const, parentRequestFingerprint: null,
      capabilityCall: null, httpResponse: null, modelReceipt: "not_observed" as const,
    });
    if (!uniqueParent) return Object.freeze({
      correlation: "parent_request_ambiguous" as const, parentRequestFingerprint,
      capabilityCall: null, httpResponse: null, modelReceipt: "not_observed" as const,
    });
    const scope = fp(start.scope_fingerprint);
    const childRows = events.filter(row => row.event === "chatgpt_tela_chat"
      && ["capability_call_start", "capability_call_complete", "capability_call_failed"].includes(row.stage)
      && fp(row.parent_fingerprint) === parentRequestFingerprint && fp(row.scope_fingerprint) === scope);
    const childRequests = new Set(childRows.map(row => fp(row.request_fingerprint)).filter(Boolean));
    if (childRows.length === 0) return Object.freeze({
      correlation: "chat_http_not_observed" as const, parentRequestFingerprint,
      capabilityCall: null, httpResponse: null, modelReceipt: "not_observed" as const,
    });
    if (childRows.some(row => !fp(row.request_fingerprint)) || childRequests.size !== 1) return Object.freeze({
      correlation: "chat_request_ambiguous" as const, parentRequestFingerprint,
      capabilityCall: null, httpResponse: null, modelReceipt: "not_observed" as const,
    });

    const requestFingerprint = [...childRequests][0]!;
    const capabilityRows = childRows.filter(row => fp(row.request_fingerprint) === requestFingerprint);
    const capabilityStarts = capabilityRows.filter(row => row.stage === "capability_call_start");
    const capabilityCompletes = capabilityRows.filter(row => row.stage === "capability_call_complete");
    const capabilityFailures = capabilityRows.filter(row => row.stage === "capability_call_failed");
    const identityFields = ["capability_input_fingerprint", "workspace_fingerprint", "operation_fingerprint"] as const;
    const identityConsistent = identityFields.every(field =>
      new Set(capabilityRows.map(row => fp(row[field])).filter(Boolean)).size <= 1);
    const lifecycleConsistent = identityConsistent && capabilityStarts.length <= 1
      && capabilityCompletes.length <= 1 && capabilityFailures.length <= 1
      && !(capabilityCompletes.length && capabilityFailures.length);
    const capabilityTerminal = capabilityCompletes[0] ?? capabilityFailures[0];
    const capabilityState = !lifecycleConsistent ? "ambiguous" as const
      : capabilityStarts.length === 1 && capabilityCompletes.length === 1 ? "completed" as const
      : capabilityStarts.length === 1 && capabilityFailures.length === 1 ? "failed" as const
      : capabilityStarts.length === 1 ? "started_without_settlement_observed" as const
      : capabilityTerminal ? "terminal_without_start_observed" as const : "not_observed" as const;

    const httpRows = events.filter(row => row.event === "chatgpt_tela_http"
      && fp(row.request_fingerprint) === requestFingerprint
      && fp(row.parent_fingerprint) === parentRequestFingerprint && fp(row.scope_fingerprint) === scope);
    const responseFinished = httpRows.filter(row => row.stage === "http_response_finished");
    const transportClosed = httpRows.filter(row => row.stage === "http_transport_closed");
    const transportErrors = httpRows.filter(row => row.stage === "http_transport_error");
    const requestFailures = httpRows.filter(row => row.stage === "http_request_failed");
    const responseErrors = httpRows.filter(row => row.stage === "http_response_error");
    const terminalHttpCount = responseFinished.length + transportClosed.length + transportErrors.length + requestFailures.length;
    const httpConsistent = [responseFinished, transportClosed, transportErrors, requestFailures]
      .every(rows => rows.length <= 1) && terminalHttpCount <= 1;
    const httpTerminal = responseFinished[0] ?? transportClosed[0] ?? transportErrors[0] ?? requestFailures[0];
    const httpState = !httpConsistent ? "ambiguous" as const
      : responseFinished.length === 1 ? "response_finished" as const
      : transportClosed.length === 1 ? "closed_before_finish" as const
      : transportErrors.length === 1 ? "transport_error" as const
      : requestFailures.length === 1 ? "request_failed" as const : "not_observed" as const;
    const responseMetadata = httpTerminal ?? responseErrors.at(-1);
    const completed = capabilityCompletes[0];
    return Object.freeze({
      correlation: "unique_parent_request" as const,
      parentRequestFingerprint,
      capabilityCall: Object.freeze({
        state: capabilityState,
        requestFingerprint,
        inputFingerprint: fp(capabilityStarts[0]?.capability_input_fingerprint)
          ?? fp(capabilityTerminal?.capability_input_fingerprint) ?? null,
        workspaceFingerprint: fp(capabilityStarts[0]?.workspace_fingerprint)
          ?? fp(capabilityTerminal?.workspace_fingerprint) ?? null,
        operationFingerprint: fp(capabilityStarts[0]?.operation_fingerprint)
          ?? fp(capabilityTerminal?.operation_fingerprint) ?? null,
        startedAt: capabilityStarts[0]?.ts ?? null,
        settledAt: capabilityTerminal?.ts ?? null,
        reasonClass: safeString(capabilityTerminal?.reason_class),
        phase: safeString(capabilityTerminal?.phase),
        result: completed ? Object.freeze({
          kind: safeString(completed.result_kind), bytes: safeNumber(completed.result_bytes),
          present: typeof completed.result_present === "boolean" ? completed.result_present : null,
          empty: typeof completed.result_empty === "boolean" ? completed.result_empty : null,
          isError: typeof completed.result_is_error === "boolean" ? completed.result_is_error : null,
        }) : null,
      }),
      httpResponse: Object.freeze({
        state: httpState,
        requestFingerprint,
        at: httpTerminal?.ts ?? null,
        status: safeNumber(responseMetadata?.status),
        durationMs: safeNumber(responseMetadata?.duration_ms),
        socketWriteCount: safeNumber(responseMetadata?.socket_write_count),
        socketWriteBytes: safeNumber(responseMetadata?.socket_write_bytes),
        delivery: responseFinished[0]?.delivery === "socket_write_only" ? "socket_write_only" as const : null,
        reasonClass: safeString(httpTerminal?.reason_class),
      }),
      modelReceipt: "not_observed" as const,
    });
  };
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
    const parentRequestFingerprint = fp(start.request_fingerprint);
    const parentRows = parentRequestFingerprint ? events.filter(row => row.event === "chatgpt_tela_mcp"
      && row.stage === "mcp_rpc_received" && fp(row.request_fingerprint) === parentRequestFingerprint) : [];
    const uniqueParent = unique && parentRows.length === 1 && parentRows[0] === start;
    return Object.freeze({
      at: start.ts, scopeFingerprint: scope, connectionFingerprint: connection ?? null, rpcFingerprint: rpc,
      correlation: unique ? "unique_connection_rpc" as const : "ambiguous_or_missing" as const,
      kind: ["chat_call", "chat_inventory", "codex_call", "codex_inventory"].includes(String(start.kind))
        ? start.kind : "other",
      callback: unique ? (session.failed.some(row => row.stage === "tool_failed") ? "threw"
        : session.failed.some(row => row.stage === "tool_error") ? "returned_error"
        : session.settled.length === 1 ? "settled"
        : session.started.length === 1 ? "started_without_settlement_observed" : "not_observed") : "unattributed",
      callbackStartedAt: unique ? session.started[0]?.ts ?? null : null,
      callbackSettledAt: unique ? session.settled[0]?.ts ?? null : null,
      transport: emitted?.delivery === "transport_send_returned" ? "send_returned" : "not_observed",
      errorResult: emitted?.error_result ?? null,
      errorCode: typeof emitted?.error_code === "number" ? emitted.error_code : null,
      ...(start.kind === "chat_call" ? { chatHttp: projectChatHttp(start, uniqueParent) } : {}),
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
