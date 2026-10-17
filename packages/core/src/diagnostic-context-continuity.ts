import { summarizeTurnDiagnostics } from "./diagnostic-turn-summary";
import { structuralDiagnosticEvent, type StructuralDiagnosticEvent } from "./diagnostic-store";

const FP = /^[a-f0-9]{24}$/;
const MODES = new Set(["full", "checkpoint-delta", "retained-delta"]);
const fp = (v: unknown): string | undefined => typeof v === "string" && FP.test(v) ? v : undefined;
const count = (v: unknown): number | undefined => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;

/** On-demand, bounded evidence projection. Never reads history, private artifacts, or sends a model call. */
export function summarizeContextContinuity(input: { events: readonly StructuralDiagnosticEvent[]; scope?: string; atMs: number }) {
  if (!Number.isFinite(input.atMs) || (input.scope !== undefined && !FP.test(input.scope))) throw Error("invalid context report selection");
  const rows = input.events.slice(-4096).flatMap(row => {
    const safe = structuralDiagnosticEvent(row); return safe && safe.environment !== "test" && Date.parse(safe.ts) <= input.atMs ? [safe] : [];
  }).sort((a, b) => a.ts.localeCompare(b.ts));
  const requests = new Map<string, Set<string>>();
  const operations = new Map<string, Set<string>>();
  for (const row of rows) {
    const scope = fp(row.scope_fingerprint), turn = fp(row.turn_fingerprint), request = fp(row.request_fingerprint);
    if (!scope || !turn) continue;
    if (request) { const owners = requests.get(request) ?? new Set<string>(); owners.add(`${scope}:${turn}`); requests.set(request, owners); }
    const operation = fp(row.operation_fingerprint);
    if (operation) { const owners=operations.get(operation)??new Set<string>(); owners.add(`${scope}:${turn}`);operations.set(operation,owners); }
  }
  const turns = new Map<string, any>();
  const attributedRows = new Map<string, StructuralDiagnosticEvent[]>();
  const priorSettled = new Map<string, any>();
  const stages = new Map<string, Set<string>>();
  const pendingPlans = new Map<string, any>();
  let unattributedOperationEvents=0,conflictingLinks=0;
  let unattributedEvents = 0, omittedTurns = 0, planLimitReached = false, disconnectLimitReached = false;
  for (const row of rows) {
    const directScope = fp(row.scope_fingerprint), directTurn = fp(row.turn_fingerprint);
    const linked = fp(row.request_fingerprint) ? requests.get(String(row.request_fingerprint)) : undefined;
    const operationLinked = fp(row.operation_fingerprint) ? operations.get(String(row.operation_fingerprint)) : undefined;
    const requestOwner = linked?.size===1?[...linked][0]:undefined;
    const operationOwner = operationLinked?.size===1?[...operationLinked][0]:undefined;
    if(requestOwner&&operationOwner&&requestOwner!==operationOwner)conflictingLinks++;
    const inferred = requestOwner&&operationOwner&&requestOwner!==operationOwner ? undefined : requestOwner??operationOwner;
    const key = directScope && directTurn ? `${directScope}:${directTurn}` : inferred;
    if (!key) { if(fp(row.operation_fingerprint)&&/^(mcp_native_result_projected|tool_settled)$/.test(row.stage))unattributedOperationEvents++; if (/checkpoint|web_turn_plan|http_transport_closed/.test(row.stage)) unattributedEvents++; continue; }
    const [scope, turn] = key.split(":");
    if (input.scope && scope !== input.scope) continue;
    let state = turns.get(key);
    if (!state) {
      if (turns.size >= 64) { omittedTurns++; continue; }
      state = { scopeFingerprint: scope, turnFingerprint: turn, firstObservedAt: row.ts, lastObservedAt: row.ts,
        checkpoint: { started: 0, completed: 0, reused: 0, failed: 0, locallyClosed: 0, observedModelDurationMs: 0 },
        plans: [], disconnects: [], responseObservers: 0, outcome: "not_observed", semanticRecall: "not_evaluated" };
      turns.set(key, state);
    }
    const attributed=attributedRows.get(key)??[];attributed.push(row);attributedRows.set(key,attributed);
    state.lastObservedAt = row.ts;
    if (row.stage === "native_cycle_observation_started" || row.stage === "native_steering_cycle_started") state.outcome="not_observed";
    if (row.stage === "native_response_observer_started") state.responseObservers++;
    if (row.stage === "native_visible_prefix_checkpoint_started") {
      state.checkpoint.firstStartedAt ??= row.ts;
      state.checkpoint.sourceBytes = count(row.source_bytes);
      state.checkpoint.fragments = count(row.fragment_count);
      state.checkpoint.sourceFingerprint = fp(row.source_fingerprint);
    }
    if (row.stage === "native_checkpoint_model_started") {
      const identity = fp(row.stage_fingerprint);
      const seen = stages.get(key) ?? new Set<string>();
      if (!identity || !seen.has(identity)) { state.checkpoint.started++; if (identity) seen.add(identity); }
      stages.set(key, seen);
      state.checkpoint.lastPhase = row.phase === "fragment" || row.phase === "merge" ? row.phase : "unknown";
      state.checkpoint.lastStageIndex = count(row.stage_index);
    }
    if (row.stage === "native_visible_prefix_stage_settled") {
      if (row.outcome === "completed") state.checkpoint.completed++;
      if (row.outcome === "reused") state.checkpoint.reused++;
      state.checkpoint.observedModelDurationMs += count(row.duration_ms) ?? 0;
    }
    if (row.stage === "native_checkpoint_model_failed") state.checkpoint.failed++;
    if (row.stage === "native_checkpoint_stage_closed") state.checkpoint.locallyClosed++;
    if (row.stage === "http_transport_closed" && state.disconnects.length >= 16) disconnectLimitReached = true;
    if (row.stage === "web_turn_plan" && state.plans.length >= 128) planLimitReached = true;
    if (row.stage === "http_transport_closed" && state.disconnects.length < 16) state.disconnects.push({
      at: row.ts, idleSinceLocalWriteMs: count(row.last_socket_write_age_ms), localWriteCount: count(row.socket_write_count),
      localWriteBytes: count(row.socket_write_bytes), delivery: "socket_write_only",
    });
    if (row.stage === "web_turn_plan" && state.plans.length < 128) {
      const previous = priorSettled.get(scope!);
      const mode = MODES.has(String(row.context_mode)) ? row.context_mode : "unknown";
      const surface = fp(row.surface_fingerprint), epoch = fp(row.epoch_fingerprint), base = fp(row.base_revision_fingerprint);
      const retainedInputHead = fp(row.retained_input_head_fingerprint);
      const generation = count(row.document_generation);
      const comparable = previous?.surfaceFingerprint && previous?.epochFingerprint && previous?.headRevisionFingerprint
        && previous.documentGeneration !== undefined && surface && epoch && base && retainedInputHead && generation !== undefined;
      const link = mode !== "retained-delta" ? "reconstructed" : !comparable ? "incomplete_evidence"
        : surface === previous.surfaceFingerprint && epoch === previous.epochFingerprint
          && generation === previous.documentGeneration && retainedInputHead === previous.headRevisionFingerprint
          ? "verified_local_link" : "unmatched_local_link";
      const plan = { at: row.ts, mode, retentionLink: link, surfaceFingerprint: surface, epochFingerprint: epoch,
        documentGeneration: generation, headRevisionFingerprint: fp(row.head_revision_fingerprint),
        baseRevisionFingerprint: base, checkpointFingerprint: fp(row.checkpoint_fingerprint), checkpointCount: count(row.checkpoint_count),
        retainedInputHeadFingerprint: retainedInputHead,
        physicalRevisionCount: count(row.physical_revision_count),
        logicalTokenEstimate: count(row.logical_estimate), transferTokenEstimate: count(row.transfer_estimate),
        logicalRevisionCount: count(row.logical_revision_count),
        requestCheckpointReused: typeof row.request_checkpoint_reused === "boolean" ? row.request_checkpoint_reused : undefined,
        requestCheckpointProduced: typeof row.request_checkpoint_produced === "boolean" ? row.request_checkpoint_produced : undefined,
        checkpointCandidateCount: count(row.checkpoint_candidate_count),
        seedCost: {
          targetEstimate: count(row.fresh_seed_target),
          exceedsTarget: typeof row.fresh_seed_exceeds_target === "boolean" ? row.fresh_seed_exceeds_target : undefined,
          exceedsRollover: typeof row.fresh_seed_exceeds_rollover === "boolean" ? row.fresh_seed_exceeds_rollover : undefined,
          priorSettlementPresent: typeof row.prior_settlement_present === "boolean" ? row.prior_settlement_present : undefined,
          authorityBytes: count(row.seed_authority_bytes), userBytes: count(row.seed_user_bytes),
          checkpointBytes: count(row.seed_checkpoint_bytes), protectedToolBytes: count(row.seed_protected_tool_bytes), otherBytes: count(row.seed_other_bytes),
        },
        projectionOmittedAssistant: count(row.projection_omitted_assistant),
        projectionOmittedToolResults: count(row.projection_omitted_tool_results),
        projectionTruncatedAssistant: count(row.projection_truncated_assistant),
        projectionTruncatedToolResults: count(row.projection_truncated_tool_results),
        activeRequestInline: typeof row.active_request_inline === "boolean" ? row.active_request_inline : undefined,
        checkpointReusedFromPriorSettledPlan: previous?.checkpointFingerprint && fp(row.checkpoint_fingerprint)
          ? previous.checkpointFingerprint === row.checkpoint_fingerprint : undefined,
        preparationElapsedMs: state.checkpoint.firstStartedAt ? Math.max(0, Date.parse(row.ts) - Date.parse(state.checkpoint.firstStartedAt)) : undefined,
        settlement: "not_observed" };
      state.plans.push(plan);
      if (fp(row.operation_fingerprint)) pendingPlans.set(`${key}:${row.operation_fingerprint}`, plan);
    }
    if (row.stage === "web_context_settled" && row.status === "completed") {
      const plan = pendingPlans.get(`${key}:${row.operation_fingerprint}`);
      if (plan?.headRevisionFingerprint && plan.headRevisionFingerprint === fp(row.head_revision_fingerprint)
        && plan.surfaceFingerprint === fp(row.surface_fingerprint) && plan.epochFingerprint === fp(row.epoch_fingerprint)
        && plan.documentGeneration !== undefined && plan.documentGeneration === count(row.document_generation)) {
        plan.settlement = "locally_committed"; priorSettled.set(scope!, plan);
      }
    }
    if (row.stage === "native_outcome_committed" && row.outcome === "final") state.outcome = "local_final_committed";
    if (row.stage === "native_turn_retired" && state.outcome !== "local_final_committed") state.outcome = "retired_without_observed_final";
  }
  for (const [key,state] of turns) {
    const observations=attributedRows.get(key)??[];
    state.summary=summarizeTurnDiagnostics(observations);
    const latestPlan=state.plans.at(-1);
    state.summary.context.retentionLink=latestPlan?.retentionLink??"incomplete_evidence";
    state.summary.context.seedCost=latestPlan?.seedCost;
    if (latestPlan?.seedCost.exceedsRollover === true) state.summary.warnings.push("fresh_seed_exceeds_rollover");
    state.summary.context.projection=latestPlan?{
      omittedAssistant:latestPlan.projectionOmittedAssistant,omittedToolResults:latestPlan.projectionOmittedToolResults,
      truncatedAssistant:latestPlan.projectionTruncatedAssistant,truncatedToolResults:latestPlan.projectionTruncatedToolResults,
    }:undefined;
    state.cycleReceipts=observations.filter(row=>row.stage==="native_cycle_summary"&&row.contract_version===1).slice(-16).map(row=>({
      at:row.ts,state:row.state,firstFailure:row.first_reason_class??row.reason_class,localFinalCommitted:row.local_final_committed===true,complete:row.summary_complete===true,
      coverage:"process_local_observation",observedEvents:count(row.observed_event_count),durationMs:count(row.duration_ms),
      webSends:count(row.web_send_count),accepted:count(row.web_accept_count),causal:row.causal_receipt===true,
      toolQueued:count(row.tool_queued_count),toolResults:count(row.tool_result_count),toolReleased:count(row.tool_release_count),
      summaryAttempts:count(row.summary_attempt_count),summaryReuse:count(row.summary_reuse_count),checkpointReused:row.request_checkpoint_reused,
      mode:MODES.has(String(row.context_mode))?row.context_mode:"unknown",
      logicalEstimate:count(row.logical_estimate),transferEstimate:count(row.transfer_estimate),
      composerBytes:row.composer_measured===true?count(row.composer_wire_bytes):undefined,
      protocolBytes:row.protocol_measured===true?count(row.protocol_wire_bytes):undefined,
      contextBytes:row.composer_measured===true?count(row.context_wire_bytes):undefined,
    }));
    const latestBegin=observations.filter(e=>e.stage==="native_cycle_observation_started"||e.stage==="native_steering_cycle_started").at(-1)?.ts;
    const finalReceipt=state.cycleReceipts.some((r:any)=>r.localFinalCommitted&&r.state==="completed"&&(!latestBegin||r.at>=latestBegin));
    state.completionEvidence=state.outcome==="local_final_committed"?"raw_final_event":finalReceipt?"cycle_receipt":"not_observed";
    if(finalReceipt)state.outcome="local_final_committed";
  }
  return { contractVersion: 2, privacy: "structural-only", generatedAt: new Date(input.atMs).toISOString(),
    tokenAccounting: "local_estimates_only", semanticRecall: "not_evaluated", turns: [...turns.values()],
    evidenceLimits: { eventLimitReached: input.events.length > 4096, turnLimitReached: omittedTurns > 0, planLimitReached, disconnectLimitReached, unattributedEvents,
      ambiguousRequests: [...requests.values()].filter(v => v.size > 1).length, ambiguousOperations:[...operations.values()].filter(v=>v.size>1).length,unattributedOperationEvents,conflictingLinks },
    limitations: ["Fingerprints correlate evidence, not authenticated account identity.",
      "Missing, clipped or rotated evidence is unknown, not success or context loss.",
      "Reconstruction and repeated file reads do not by themselves prove semantic forgetting.",
      "Token estimates and local continuity links do not prove model recall, exact coverage quality, billed usage or host display."] };
}
