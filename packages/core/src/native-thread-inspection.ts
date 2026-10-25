import { diagnosticFingerprint } from "./diagnostic-events";
import { readDiagnosticSources } from "./diagnostic-store";
import { dirname, join } from "node:path";

const incidentRoots = (paths: readonly string[]) => [...new Set(paths.map(path => join(dirname(path), "diagnostics")))];

const THREAD_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TURN_STATUS = new Set(["inProgress", "completed", "failed", "interrupted"]);
const MAX_TURNS = 4;
const MAX_TIMELINE = 24;
const TOOL_EVIDENCE_STAGES = new Set([
  "native_tool_inventory_queried", "native_tool_queued", "native_tool_result_received",
  "native_tool_result_released", "native_tool_result_error", "native_tool_bridge_invoke_started",
  "native_tool_bridge_invoke_returned", "mcp_native_inventory_returned", "mcp_native_result_projected",
  "tool_started", "tool_settled", "tool_failed", "tool_error", "mcp_rpc_received", "mcp_rpc_emitted",
]);
const MCP_TOOL_EVIDENCE_STAGES = new Set([
  "mcp_native_inventory_returned", "tool_started", "tool_settled", "tool_failed", "tool_error",
  "mcp_rpc_received", "mcp_rpc_emitted",
]);
const TURN_OPERATION_STAGES = new Set([
  "native_tool_inventory_queried", "native_tool_queued", "native_tool_result_received",
  "native_tool_result_released", "native_tool_result_error", "native_tool_bridge_invoke_started",
  "native_tool_bridge_invoke_returned",
]);
const CALL_EVIDENCE_STAGES = new Set([
  "native_tool_queued", "native_tool_result_received", "native_tool_result_released",
  "native_tool_result_error", "native_tool_bridge_invoke_started", "native_tool_bridge_invoke_returned",
]);
const SAFE_EVIDENCE_KINDS = new Set([
  "function", "freeform", "discovery", "gateway", "other", "text", "image", "mixed", "empty",
  "tools_list", "rpc_result", "rpc_error", "string", "array", "object", "null", "undefined",
  "number", "boolean",
]);
const SAFE_EVIDENCE_DELIVERY = new Set(["transport_send_returned", "mcp_callback_returned", "mcp_callback_thrown"]);
const SAFE_EVIDENCE_PHASE = new Set(["tools_list", "rpc_result", "rpc_error", "returned_error", "thrown_error", "inventory_result"]);
const SAFE_EVIDENCE_OUTCOME = new Set(["completed", "failed"]);
const SAFE_EVIDENCE_METHOD = new Set(["initialize", "initialized", "tools_list", "tools_call", "ping", "other"]);
const SAFE_EVIDENCE_STATUS = new Set(["active", "complete", "paused", "blocked", "unknown", "absent"]);

type Json = Record<string, unknown>;
type EvidenceValue = string | number | boolean | null;
type EvidenceRow = Json & { readonly ts: string; readonly event: string; readonly stage: string };
type ThreadReader = {
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
};

function object(value: unknown): Json | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Json : undefined;
}

function diagnosticFingerprintField(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{24}$/.test(value) ? value : undefined;
}

function projectToolEvidenceEvent(event: EvidenceRow, turnFingerprint: string, correlation: string) {
  const projected: Record<string, EvidenceValue> = {
    at: event.ts,
    stage: event.stage,
    turnFingerprint,
    correlation,
  };
  const fingerprints = [
    ["rpc_fingerprint", "rpcFingerprint"],
    ["operation_fingerprint", "operationFingerprint"],
    ["connection_fingerprint", "connectionFingerprint"],
  ] as const;
  for (const [source, target] of fingerprints) {
    const value = diagnosticFingerprintField(event[source]);
    if (value) projected[target] = value;
  }
  const numbers = [
    ["count", "count"], ["discovery_count", "discoveryCount"], ["gateway_count", "gatewayCount"],
    ["request_bytes", "requestBytes"], ["result_bytes", "resultBytes"], ["body_bytes", "bodyBytes"],
    ["part_count", "partCount"], ["text_bytes", "textBytes"], ["text_characters", "textCharacters"],
    ["image_bytes", "imageBytes"], ["duration_ms", "durationMs"],
  ] as const;
  for (const [source, target] of numbers) {
    const value = event[source];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) projected[target] = value;
  }
  const booleans = [
    ["query_empty", "queryEmpty"], ["goal_only", "goalOnly"], ["text_measurement_complete", "textMeasurementComplete"],
    ["body_present", "bodyPresent"], ["body_size_known", "bodySizeKnown"], ["is_error", "isError"],
    ["error_result_reported", "errorResultReported"], ["error_result", "errorResult"], ["abort_observed", "abortObserved"],
  ] as const;
  for (const [source, target] of booleans) {
    const value = event[source];
    if (typeof value === "boolean") projected[target] = value;
  }
  if (typeof event.kind === "string" && SAFE_EVIDENCE_KINDS.has(event.kind)) projected.kind = event.kind;
  if (typeof event.delivery === "string" && SAFE_EVIDENCE_DELIVERY.has(event.delivery)) projected.delivery = event.delivery;
  if (typeof event.phase === "string" && SAFE_EVIDENCE_PHASE.has(event.phase)) projected.phase = event.phase;
  if (typeof event.outcome === "string" && SAFE_EVIDENCE_OUTCOME.has(event.outcome)) projected.outcome = event.outcome;
  if (typeof event.method_class === "string" && SAFE_EVIDENCE_METHOD.has(event.method_class)) projected.methodClass = event.method_class;
  if (typeof event.status === "string" && SAFE_EVIDENCE_STATUS.has(event.status)) projected.status = event.status;
  return Object.freeze(projected);
}

function correlateMcpRpc(rpcFingerprint: string | undefined, allEvents: readonly EvidenceRow[]) {
  if (!rpcFingerprint) return { status: "rpc_fingerprint_missing" as const, events: [] as EvidenceRow[] };
  const nativeOwners = new Set(allEvents.filter(event => TURN_OPERATION_STAGES.has(event.stage)
    && event.rpc_fingerprint === rpcFingerprint
    && diagnosticFingerprintField(event.scope_fingerprint)
    && diagnosticFingerprintField(event.turn_fingerprint))
    .map(event => `${event.scope_fingerprint}:${event.turn_fingerprint}`));
  if (nativeOwners.size > 1) return { status: "rpc_fingerprint_reused_across_turns" as const, events: [] as EvidenceRow[] };
  const rows = allEvents.filter(event => event.event === "chatgpt_tela_mcp"
    && MCP_TOOL_EVIDENCE_STAGES.has(event.stage) && event.rpc_fingerprint === rpcFingerprint);
  if (rows.length === 0) return { status: "mcp_rpc_events_not_observed" as const, events: rows };
  const connections = new Set(rows.map(event => diagnosticFingerprintField(event.connection_fingerprint)).filter(Boolean));
  const singletons = ["mcp_rpc_received", "mcp_rpc_emitted", "tool_started", "tool_settled", "mcp_native_inventory_returned"];
  const repeatedStage = singletons.some(stage => rows.filter(event => event.stage === stage).length > 1);
  if (connections.size > 1 || repeatedStage) {
    return { status: "rpc_fingerprint_ambiguous_in_available_events" as const, events: [] as EvidenceRow[] };
  }
  return { status: "rpc_fingerprint_unambiguous_in_available_events" as const, events: rows };
}

function projectTurnToolEvidence(input: {
  readonly threadFingerprint: string;
  readonly turnFingerprint: string;
  readonly allEvents: readonly EvidenceRow[];
  readonly limited: boolean;
}) {
  const exactTurnEvents = input.allEvents.filter(event => event.scope_fingerprint === input.threadFingerprint
    && event.turn_fingerprint === input.turnFingerprint && TOOL_EVIDENCE_STAGES.has(event.stage));
  const inventoryRows = exactTurnEvents.filter(event => event.stage === "native_tool_inventory_queried");
  const inventoryRequests = inventoryRows.map(event => {
    const rpcFingerprint = diagnosticFingerprintField(event.rpc_fingerprint);
    const correlation = correlateMcpRpc(rpcFingerprint, input.allEvents);
    return Object.freeze({
      at: event.ts,
      turnFingerprint: input.turnFingerprint,
      rpcFingerprint: rpcFingerprint ?? null,
      queryEmpty: typeof event.query_empty === "boolean" ? event.query_empty : null,
      itemCount: typeof event.count === "number" && Number.isSafeInteger(event.count) && event.count >= 0 ? event.count : null,
      goalOnly: typeof event.goal_only === "boolean" ? event.goal_only : null,
      mcpCorrelation: correlation.status,
      mcpEvents: correlation.events.map(row => projectToolEvidenceEvent(
        row, input.turnFingerprint, correlation.status)),
      modelReceipt: "not_proven_by_server_side_diagnostics" as const,
    });
  });

  const callRows = exactTurnEvents.filter(event => CALL_EVIDENCE_STAGES.has(event.stage)
    && diagnosticFingerprintField(event.operation_fingerprint));
  const groupedCalls = new Map<string, EvidenceRow[]>();
  for (const event of callRows) {
    const operationFingerprint = diagnosticFingerprintField(event.operation_fingerprint)!;
    const rpcFingerprint = diagnosticFingerprintField(event.rpc_fingerprint);
    const key = JSON.stringify([operationFingerprint, rpcFingerprint ?? null]);
    const rows = groupedCalls.get(key) ?? [];
    rows.push(event);
    groupedCalls.set(key, rows);
  }
  const calls = [...groupedCalls.entries()].map(([key, rows]) => {
    const [operationFingerprint, rawRpcFingerprint] = JSON.parse(key) as [string, string | null];
    const rpcFingerprint = rawRpcFingerprint ?? undefined;
    const returned = rows.filter(event => event.stage === "native_tool_bridge_invoke_returned").at(-1);
    const correlation = correlateMcpRpc(rpcFingerprint, input.allEvents);
    const owners = new Set(input.allEvents.filter(event => event.stage === "native_tool_bridge_invoke_started"
      || event.stage === "native_tool_bridge_invoke_returned")
      .filter(event => event.operation_fingerprint === operationFingerprint && event.rpc_fingerprint === rpcFingerprint
        && diagnosticFingerprintField(event.scope_fingerprint) && diagnosticFingerprintField(event.turn_fingerprint))
      .map(event => `${event.scope_fingerprint}:${event.turn_fingerprint}`));
    const projections = input.allEvents.filter(event => event.stage === "mcp_native_result_projected"
      && event.operation_fingerprint === operationFingerprint && event.rpc_fingerprint === rpcFingerprint);
    const projectionStatus = !rpcFingerprint ? "rpc_fingerprint_missing"
      : owners.size !== 1 || !owners.has(`${input.threadFingerprint}:${input.turnFingerprint}`)
        ? "operation_rpc_pair_ambiguous_across_turns"
        : projections.length === 1 ? "operation_and_rpc_fingerprint_matched"
          : projections.length === 0 ? "projection_not_observed_for_operation_rpc"
            : "multiple_projections_for_operation_rpc";
    const projection = projectionStatus === "operation_and_rpc_fingerprint_matched" ? projections[0] : undefined;
    return Object.freeze({
      operationFingerprint,
      rpcFingerprint: rpcFingerprint ?? null,
      startedAt: rows.find(event => event.stage === "native_tool_bridge_invoke_started")?.ts ?? null,
      returnedAt: returned?.ts ?? null,
      result: returned ? projectToolEvidenceEvent(returned, input.turnFingerprint, "exact_turn_and_operation_fingerprint") : null,
      resultProjectionCorrelation: projectionStatus,
      resultProjection: projection
        ? projectToolEvidenceEvent(projection, input.turnFingerprint, projectionStatus) : null,
      mcpCorrelation: correlation.status,
      mcpEvents: correlation.events.map(row => projectToolEvidenceEvent(
        row, input.turnFingerprint, correlation.status)),
      nativeEvents: rows.map(row => projectToolEvidenceEvent(
        row, input.turnFingerprint, "exact_turn_and_operation_fingerprint")),
      modelReceipt: "not_proven_by_server_side_diagnostics" as const,
    });
  });
  return Object.freeze({
    turnFingerprint: input.turnFingerprint,
    inventoryObservation: inventoryRows.length > 0 ? "observed" as const : "not_observed_in_available_diagnostic_window" as const,
    inventoryRequests,
    calls,
    coverage: Object.freeze({
      turnScopedEventsMatched: exactTurnEvents.length,
      inventoryRequestsMatched: inventoryRows.length,
      callsMatched: groupedCalls.size,
      limited: input.limited,
      modelReceiptObserved: false,
    }),
    limitation: "A local MCP transport send receipt proves the server send returned; it does not prove model receipt or interpretation.",
  });
}

/** The only entry for reading an exact, owner-selected Native conversation.
 * All reads use public metadata and bounded structural diagnostics; never
 * includeTurns=true, raw message bodies, UI actions, or turn starts. */
export async function inspectNativeThread(input: {
  readonly rpc: ThreadReader;
  readonly threadId: string;
  readonly slot: number;
  readonly diagnosticPaths: readonly string[];
  readonly minutes?: number;
  readonly nowMs?: number;
}) {
  const { threadId, slot, rpc } = input;
  if (!THREAD_ID.test(threadId)) throw new Error("thread inspect requires an exact Native UUID");
  if (!Number.isSafeInteger(slot) || slot < 1 || slot > 99) throw new Error("invalid profile slot");
  const minutes = input.minutes ?? 30;
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 120) {
    throw new Error("--minutes must be an integer from 1 to 120");
  }
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) throw new Error("invalid observation time");

  const metadata = object(await rpc.request("thread/read", {
    threadId, includeTurns: false,
  }, AbortSignal.timeout(10_000)));
  const thread = object(metadata?.thread);
  if (!thread || thread.id !== threadId) {
    throw new Error("the requested Native conversation is not owned by this profile");
  }
  // Supported Native builds expose thread/read.status as either a public
  // discriminated object or the same finite string enum. Keep exact owner,
  // history, turn-metadata and status validation unchanged across both.
  const state = typeof thread.status === "string"
    ? thread.status : object(thread.status)?.type;
  if (!["active", "idle", "notLoaded"].includes(String(state))) {
    throw new Error("Native conversation status is not proven");
  }
  const historyMode = thread.historyMode;
  if (historyMode !== "paginated" && historyMode !== "legacy") {
    throw new Error("Native history indexing capability is unknown");
  }
  const updatedAt = typeof thread.updatedAt === "number"
    && Number.isSafeInteger(thread.updatedAt) && thread.updatedAt > 0
    ? new Date(thread.updatedAt * 1000).toISOString()
    : null;

  let recentTurns: readonly { id: string; status: string }[] = [];
  if (historyMode === "paginated") {
    const page = object(await rpc.request("thread/turns/list", {
      threadId, sortDirection: "desc", itemsView: "notLoaded", limit: MAX_TURNS,
    }, AbortSignal.timeout(10_000)));
    const rows = page?.data;
    if (!Array.isArray(rows) || rows.length > MAX_TURNS
      || Buffer.byteLength(JSON.stringify(page), "utf8") > 8 * 1024) {
      throw new Error("Native latest-turn metadata is not bounded");
    }
    recentTurns = Object.freeze(rows.map(value => {
      const row = object(value);
      if (!row || typeof row.id !== "string" || !THREAD_ID.test(row.id)
        || !TURN_STATUS.has(String(row.status)) || row.itemsView !== "notLoaded"
        || !Array.isArray(row.items) || row.items.length !== 0) {
        throw new Error("Native latest-turn metadata does not match the public contract");
      }
      return Object.freeze({ id: row.id, status: row.status as string });
    }));
  }

  const fingerprint = diagnosticFingerprint(threadId);
  const logs = readDiagnosticSources(input.diagnosticPaths, {
    fromMs: nowMs - minutes * 60_000,
    toMs: nowMs,
  }, incidentRoots(input.diagnosticPaths));
  const correlated = logs.events.filter(event => event.scope_fingerprint === fingerprint
    && (event.event === "chatgpt_tela_work" || event.event === "chatgpt_tela_codex"));
  const last = (stage: string) => correlated.filter(event => event.stage === stage).at(-1);
  const lastPlan = last("web_turn_plan");
  const lastObserved = correlated.at(-1);
  // Public turn identity, not the selected browser tab, chooses the diagnostic
  // stream. Historical finals for other turns must never settle this turn.
  const activeTurn = recentTurns[0];
  const activeTurnFingerprint = activeTurn ? diagnosticFingerprint(activeTurn.id) : undefined;
  const activeEvents = activeTurnFingerprint
    ? correlated.filter(event => event.turn_fingerprint === activeTurnFingerprint) : [];
  const boundaryStages = new Set([
    "native_response_observer_started", "web_turn_plan", "web_send_activation_started",
    "web_turn_identity_pending", "web_turn_identity_accepted", "web_public_progress_extraction",
    "native_outcome_committed", "native_response_body_closed", "native_turn_retired",
    "native_execution_failed", "web_turn_failed",
  ]);
  const boundaries = activeEvents.filter(event => boundaryStages.has(event.stage));
  const latestOperation = [...boundaries].reverse().find(event =>
    typeof event.operation_fingerprint === "string")?.operation_fingerprint;
  const requestEvents = latestOperation
    ? activeEvents.filter(event => event.operation_fingerprint === latestOperation)
    : activeEvents;
  const stages = [...new Set(requestEvents.filter(event => boundaryStages.has(event.stage)).map(event => event.stage))];
  const pending = requestEvents.filter(event => event.stage === "approval_wait_transition").at(-1);
  const pendingStillObserved = activeTurn?.status === "inProgress" && pending?.phase === "pending";
  const webAnswerReceived = requestEvents.some(event => event.stage === "web_answer_received");
  const nativeFinalItemObserved = requestEvents.some(event => event.stage === "native_public_item_observed"
    && event.kind === "agent_message" && event.phase === "final_answer");
  const activeRequestBoundary = activeTurn ? {
    turnFingerprint: activeTurnFingerprint,
    turnStatus: activeTurn.status,
    operationFingerprint: latestOperation ?? null,
    observedAt: requestEvents.at(-1)?.ts ?? null,
    observedStages: stages,
    accepted: stages.includes("web_turn_identity_accepted"),
    browserFinalObserved: requestEvents.some(event =>
      event.stage === "web_turn_completed" || event.stage === "web_turn_final_observed"),
    webAnswerReceived,
    nativeFinalItemObserved,
    nativeFinalCommitted: requestEvents.some(event =>
      event.stage === "native_outcome_committed" && event.outcome === "final"),
    nativeResponseDrained: requestEvents.some(event =>
      event.stage === "native_response_body_closed" && event.reason_class === "drained"),
    proof: "turn_scoped_local_events_only" as const,
  } : null;
  const coverage = {
    sourcesRead: logs.coverage.filter(item => item.state === "read").length,
    sourcesUnavailable: logs.coverage.filter(item => item.state !== "read").length,
    incidentsRead: logs.incidentsRead,
    incidentsUnavailable: logs.incidentsUnavailable,
    limited: logs.incidentsUnavailable > 0 || logs.byteLimitReached || logs.sourceLimitReached || logs.coverage.some(item =>
      item.truncated || item.eventLimitReached),
    eventsMatched: correlated.length,
  };
  const lastWebPlan = lastPlan ? {
    observedAt: lastPlan.ts,
    ...(typeof lastPlan.transfer_estimate === "number" ? { transferEstimate: lastPlan.transfer_estimate } : {}),
    ...(typeof lastPlan.retained_surface === "boolean" ? { retainedSurface: lastPlan.retained_surface } : {}),
    ...(typeof lastPlan.retained_delta === "boolean" ? { retainedDelta: lastPlan.retained_delta } : {}),
  } : null;
  const approvalWaitEvidence = pendingStillObserved ? {
    lastObservedAt: pending.ts,
    waitingSeconds: Math.max(0, Math.floor((nowMs - Date.parse(pending.ts)) / 1000)),
    stillPendingInAvailableEvents: true,
    /** A past log is not a live browser proof; never grant/replay from it. */
    currentlyVisible: "not_verified",
  } : null;

  return Object.freeze({
    contractVersion: 1,
    privacy: "read-only-metadata-and-structural-diagnostics",
    threadId, slot, identityVerified: true,
    native: { state, historyMode, updatedAt, recentTurns },
    diagnostics: {
      windowMinutes: minutes,
      fingerprint,
      coverage,
      lastObservedAt: lastObserved?.ts ?? null,
      lastWebPlan,
      activeRequestBoundary,
      approvalWaitEvidence,
      recentEvents: correlated.slice(-MAX_TIMELINE).map(event => ({
        at: event.ts, stage: event.stage,
        ...(typeof event.turn_phase === "string" ? { turnPhase: event.turn_phase } : {}),
        ...(typeof event.reason_class === "string" ? { reasonClass: event.reason_class } : {}),
        ...(typeof event.phase === "string" ? { phase: event.phase } : {}),
      })),
    },
    continuation: {
      classification: approvalWaitEvidence ? "approval_wait_observed"
        : recentTurns[0]?.status === "inProgress" ? "in_progress_without_verified_approval"
        : "no_active_turn_verified",
      nextAction: approvalWaitEvidence ? "inspect_current_owned_approval"
        : "inspect_latest_turn_and_resume_only_if_explicitly_authorized",
      canAutomaticallyReplayAcceptedTurn: false,
    },
  });
}

/**
 * Read-only evidence for a known Native UUID even when its owning profile is
 * stopped, orphaned, or the current Codex metadata schema cannot be proven.
 * This is deliberately NOT a Native thread inspection, an ownership lease,
 * a live browser observation, or permission to resume/replay/approve.
 */
export function inspectNativeThreadHistoricalEvidence(input: {
  readonly threadId: string;
  readonly turnId?: string;
  readonly diagnosticPaths: readonly string[];
  readonly minutes?: number;
  readonly nowMs?: number;
}) {
  if (!THREAD_ID.test(input.threadId)) throw new Error("historical evidence requires an exact Native UUID");
  if (input.turnId !== undefined && !THREAD_ID.test(input.turnId)) {
    throw new Error("historical evidence turn filter requires an exact Native UUID");
  }
  const minutes = input.minutes ?? 30;
  // Unlike live Native inspection, this bounded local-log query may need
  // to span a long approval wait after the original profile has retired.
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 360) {
    throw new Error("--minutes must be an integer from 1 to 360");
  }
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) throw new Error("invalid observation time");
  const fingerprint = diagnosticFingerprint(input.threadId);
  const logs = readDiagnosticSources(input.diagnosticPaths, {
    fromMs: nowMs - minutes * 60_000, toMs: nowMs,
  }, incidentRoots(input.diagnosticPaths));
  const allEvents = logs.events as readonly EvidenceRow[];
  const turnFingerprint = input.turnId ? diagnosticFingerprint(input.turnId) : undefined;
  const events = logs.events.filter(event => event.scope_fingerprint === fingerprint
    && (turnFingerprint === undefined || event.turn_fingerprint === turnFingerprint)
    && ["chatgpt_tela_work", "chatgpt_tela_codex", "chatgpt_tela_browser"].includes(event.event));
  const toolDeliveryEvidence = turnFingerprint ? projectTurnToolEvidence({
    threadFingerprint: fingerprint,
    turnFingerprint,
    allEvents,
    limited: logs.incidentsUnavailable > 0 || logs.byteLimitReached || logs.sourceLimitReached || logs.coverage.some(item => item.truncated || item.eventLimitReached),
  }) : undefined;
  const last = (stage: string) => events.filter(event => event.stage === stage).at(-1);
  const pending = events.filter(event => event.stage === "approval_wait_transition"
    && event.phase === "pending").at(-1);
  const lastApproval = last("approval_wait_transition");
  const expiry = last("approval_wait_expired");
  const stop = last("web_owned_stop");
  const lastNativeFailure = events.filter(event =>
    ["native_execution_failed", "web_turn_identity_rejected"].includes(event.stage)).at(-1);
  const lastTerminal = events.filter(event =>
    ["native_execution_failed", "native_turn_retired", "native_outcome_committed", "web_turn_failed"]
      .includes(event.stage)).at(-1);
  const pendingObserved = pending !== undefined && !events.some(event =>
    event.stage === "approval_wait_transition"
      && ["card_cleared", "task_progress"].includes(String(event.phase))
      && Date.parse(event.ts) > Date.parse(pending.ts));
  const terminalAfterPending = Boolean(pending && lastTerminal
    && Date.parse(lastTerminal.ts) >= Date.parse(pending.ts));
  const firstPendingAt = pending?.ts ?? null;
  const observedUntil = events.at(-1)?.ts ?? null;
  // Correlation is deliberately time- and thread-scoped, not an assertion of
  // causation or an authoritative Native turn identity. The original accepted
  // operation may already have produced effects; no retry may follow from it.
  const rejected = last("web_turn_identity_rejected");
  const rejectionAt = rejected ? Date.parse(rejected.ts) : Number.NaN;
  const preceding = (stage: string, withinMs: number) => events.filter(event =>
    event.stage === stage && Number.isFinite(rejectionAt)
    && Date.parse(event.ts) <= rejectionAt
    && rejectionAt - Date.parse(event.ts) <= withinMs).at(-1);
  const rendererPause = preceding("renderer_unresponsive", 30_000);
  const revoked = preceding("inspection_ownership_revoked", 10_000);
  const classified = preceding("inspection_input_classified", 10_000);
  const nativeFailureFollowingRejection = events.some(event => event.stage === "native_execution_failed"
    && Number.isFinite(rejectionAt) && Date.parse(event.ts) >= rejectionAt
    && Date.parse(event.ts) - rejectionAt <= 30_000);
  const ownershipFailureEvidence = rejected
    ? Object.freeze({
      classification: "response_ownership_rejected" as const,
      rejectedAt: rejected.ts,
      reasonClass: rejected.reason_class === "accepted_user_changed"
        ? "accepted_user_changed" as const : "other_or_unclassified" as const,
      precedingRendererUnresponsiveAt: rendererPause?.ts ?? null,
      precedingInputOwnershipRevokedAt: revoked?.ts ?? null,
      inputClassifierObservedAt: classified?.ts ?? null,
      // Not-manual-consent does not prove a user edited or sent anything.
      observedManualConsent: typeof classified?.manual_consent === "boolean"
        ? classified.manual_consent : null,
      nativeFailureFollowingRejection,
      proofLevel: "same-thread-temporal-correlation-only" as const,
      exactInputOriginVerified: false as const,
      causalLinkProven: false as const,
      canReplayAcceptedRequest: false as const,
    }) : null;
  return Object.freeze({
    contractVersion: 1 as const,
    privacy: "allowlisted-structural-events-only" as const,
    threadId: input.threadId,
    scopeFingerprint: fingerprint,
    identityVerified: false as const,
    nativeOwner: "not_checked" as const,
    browserCardCurrentlyVisible: "not_verified" as const,
    contentRead: false as const,
    mutating: false as const,
    coverage: {
      sourcesRead: logs.coverage.filter(item => item.state === "read").length,
      sourcesUnavailable: logs.coverage.filter(item => item.state !== "read").length,
      limited: logs.incidentsUnavailable > 0 || logs.byteLimitReached || logs.sourceLimitReached || logs.coverage.some(item => item.truncated || item.eventLimitReached),
      eventsMatched: events.length,
      incidentsRead: logs.incidentsRead,
      incidentsUnavailable: logs.incidentsUnavailable,
    },
    lastObservedAt: observedUntil,
    approval: {
      lastPendingObservedAt: firstPendingAt,
      lastTransition: lastApproval?.phase ?? "not_observed",
      noClearanceRecordedAfterPending: pendingObserved,
      nativeEndedAfterPending: terminalAfterPending,
      // A time gap in logs never proves continuous pending or live browser state.
      observedGapSeconds: pending && observedUntil
        ? Math.max(0, Math.floor((Date.parse(observedUntil) - Date.parse(pending.ts)) / 1000)) : null,
    },
    lastNativeOutcome: lastTerminal
      ? { at: lastTerminal.ts, stage: lastTerminal.stage,
        ...(typeof lastTerminal.reason_class === "string" ? { reasonClass: lastTerminal.reason_class } : {}) }
      : null,
    lastNativeFailure: lastNativeFailure
      ? { at: lastNativeFailure.ts, stage: lastNativeFailure.stage,
        ...(typeof lastNativeFailure.reason_class === "string" ? { reasonClass: lastNativeFailure.reason_class } : {}) }
      : null,
    approvalTerminationEvidence: expiry || stop ? {
      expiryObservedAt: expiry?.ts ?? null,
      browserStopObservedAt: stop?.ts ?? null,
      browserStopStatus: stop && ["stopped", "stop_sent", "unavailable", "ownership_changed", "unconfirmed"].includes(String(stop.status))
        ? stop.status : "not_verified",
      // UI generation controls disappearing does not settle remote tool effects.
      remoteOutcome: "uncertain" as const,
      nativeCompletionProven: false as const,
      canReplayAcceptedRequest: false as const,
      proofLevel: "historical-thread-scoped-events-only" as const,
    } : null,
    ownershipFailureEvidence,
    // Progress updates can push a completed Goal call out of the recent tail.
    // Report actual per-turn returns, without inferring the current Goal state.
    goalControlReturns: events.filter(event => event.stage === "native_tool_bridge_invoke_returned"
      && event.goal_tool === true).slice(-MAX_TIMELINE).map(event => ({
      at: event.ts, turnFingerprint: event.turn_fingerprint ?? null,
      operationFingerprint: event.operation_fingerprint ?? null,
      action: event.action ?? "unknown", status: event.status ?? "unknown",
      isError: event.is_error ?? null, bodyPresent: event.body_present ?? null,
    })),
    ...(toolDeliveryEvidence ? { toolDeliveryEvidence } : {}),
    contextPreparationEvidence: events.filter(event => ["native_context_source_rejected",
      "native_checkpoint_preparation_planned", "compaction_source_observed"].includes(event.stage)),
    recentEvents: events.slice(-MAX_TIMELINE).map(event => ({
      at: event.ts, stage: event.stage,
      ...(typeof event.reason_class === "string" ? { reasonClass: event.reason_class } : {}),
      ...(typeof event.phase === "string" ? { phase: event.phase } : {}),
      ...(typeof event.manual_consent === "boolean" ? { manualConsent: event.manual_consent } : {}),
    })),
    continuation: {
      canAutomaticallyReplayAcceptedTurn: false as const,
      nextAction: "verify_current_native_and_browser_owner_before_action" as const,
    },
  });
}
