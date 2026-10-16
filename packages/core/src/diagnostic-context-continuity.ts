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
  for (const row of rows) {
    const scope = fp(row.scope_fingerprint), turn = fp(row.turn_fingerprint), request = fp(row.request_fingerprint);
    if (!scope || !turn || !request) continue;
    const owners = requests.get(request) ?? new Set<string>(); owners.add(`${scope}:${turn}`); requests.set(request, owners);
  }
  const turns = new Map<string, any>();
  const priorSettled = new Map<string, any>();
  const stages = new Map<string, Set<string>>();
  const pendingPlans = new Map<string, any>();
  let unattributedEvents = 0, omittedTurns = 0, planLimitReached = false, disconnectLimitReached = false;
  for (const row of rows) {
    const directScope = fp(row.scope_fingerprint), directTurn = fp(row.turn_fingerprint);
    const linked = fp(row.request_fingerprint) ? requests.get(String(row.request_fingerprint)) : undefined;
    const key = directScope && directTurn ? `${directScope}:${directTurn}` : linked?.size === 1 ? [...linked][0] : undefined;
    if (!key) { if (/checkpoint|web_turn_plan|http_transport_closed/.test(row.stage)) unattributedEvents++; continue; }
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
    state.lastObservedAt = row.ts;
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
  return { privacy: "structural-only", generatedAt: new Date(input.atMs).toISOString(),
    tokenAccounting: "local_estimates_only", semanticRecall: "not_evaluated", turns: [...turns.values()],
    evidenceLimits: { eventLimitReached: input.events.length > 4096, turnLimitReached: omittedTurns > 0, planLimitReached, disconnectLimitReached, unattributedEvents,
      ambiguousRequests: [...requests.values()].filter(v => v.size > 1).length },
    limitations: ["Fingerprints correlate evidence, not authenticated account identity.",
      "Missing, clipped or rotated evidence is unknown, not success or context loss.",
      "Reconstruction and repeated file reads do not by themselves prove semantic forgetting.",
      "Token estimates and local continuity links do not prove model recall, exact coverage quality, billed usage or host display."] };
}
