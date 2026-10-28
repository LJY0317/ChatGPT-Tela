import { diagnosticDurationMs, diagnosticFingerprint, diagnosticFailureClass, emitDiagnosticEvent, withDiagnosticContext } from "@chatgpt-tela/core";
import { createHash, randomUUID } from "node:crypto";
import {
  bindNativeCompactionRequest, historicalTurnAuthority,
  MAX_TELA_COMPACTION_SUMMARY_BYTES,
  NativeHistoryBootstrapRequired, NativeBindingError, type NativeBindingReason, type CanonicalCurrentTurnSource,
} from "@chatgpt-tela/codex";
import { nativeCompactionSummaryResponse } from "@chatgpt-tela/responses";
import {
  chatGptCheckpointInputTokens, chatGptWebCheckpointSourceTokenLimit, type ChatGptWebEffort, type WebPhysicalContext, type WebTurnMedia } from "@chatgpt-tela/chatgpt";
import { bindNativePhysicalEvidence, deferredNativeOriginalsNotice, nativeRequestContentSource, nativeRequestSourceTurnId, nativeRequestBrowserModelRoute, projectNativeRequestContext, type NativeRequestCheckpointProducer, type NativeRequestCheckpointProductionRequest } from "./native-request-planner";
import {
  nativeOpaqueCompaction, resolveNativeContextContinuity, type NativeContinuitySources,
} from "./native-context-continuity";
import { boundedWebCheckpointSource } from "./web-checkpoint-source";
import { CheckpointPreparationBudget, CheckpointPreparationBudgetExceeded } from "./checkpoint-preparation-budget";
import { produceNativePrefixCheckpoint } from "./native-visible-prefix-checkpoint";
import { nativeRequestPrefixSnapshot, nativeCompactionPhysicalContext, selectNativeWorkingCheckpoint } from "./native-working-context";
import { webWorkingContextPolicy } from "./web-working-context-policy";
import type { ContextCheckpointCache } from "./context-cache";
import { prepareDeferredNativeHistory } from "./native-history-seed";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

type CompactionPhase = "route" | "binding" | "identity" | "admission" | "watch" | "continuity"
  | "projection" | "source_fit" | "summary" | "summary_validation" | "release" | "delivery";
type CompactionReason = NativeBindingReason | "stage_failed" | "source_changed" | "capacity_exhausted"
  | "readable_checkpoint_required" | "preparation_budget_exceeded" | "owner_cancelled" | "invalid_summary";
class CompactionFailure extends Error {
  constructor(readonly phase: CompactionPhase, readonly reason: CompactionReason, cause?: unknown) {
    super("Native local compaction failed", { cause });
  }
}
function failure(error: unknown, phase: CompactionPhase): CompactionFailure {
  if (error instanceof CompactionFailure) return error;
  return new CompactionFailure(phase, error instanceof CheckpointPreparationBudgetExceeded
    ? "preparation_budget_exceeded" : error instanceof NativeHistoryBootstrapRequired
    ? "readable_checkpoint_required" : error instanceof NativeBindingError ? error.reason : "stage_failed", error);
}
/** Canonical JSON source, independent of key ordering and delivery/correlation metadata. */
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, (_key, item) => {
    const object = record(item);
    return object ? Object.fromEntries(Object.keys(object).sort().map(key => [key, object[key]])) : item;
  })).digest("hex");
}

/** Shared summarization for Native text and standard Responses compaction-v2 transports. */
export function createNativeLocalCompactionRouter(input: NativeContinuitySources & {
  readonly checkpointCache?: ContextCheckpointCache;
  readonly source: CanonicalCurrentTurnSource;
  /** Settle only an exact pending Native tool result before local history replacement. */
  readonly settlePendingToolResult?: (threadId: string, turnId: string, body: unknown) => void;
  readonly summarize: (request: {
    readonly signal?: AbortSignal;
    readonly nativeTaskId: string;
    readonly sourceRevisionId: string;
    readonly physicalContext: WebPhysicalContext;
    readonly media?: readonly WebTurnMedia[];
    readonly browserModel: { readonly familyKey: string; readonly effort: ChatGptWebEffort };
    readonly persistResult?: NativeRequestCheckpointProductionRequest["persistResult"];
  }) => Promise<string>;
  readonly maxRetainedOperations?: number;
}) {
  const capacity = input.maxRetainedOperations ?? 64;
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("Invalid compaction operation capacity");
  const operations = new Map<string, { digest: string; wireDigest: string; id: string; result: Promise<string>; settled: boolean }>();
  return async (request: Request): Promise<Response | undefined> => {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/responses") return undefined;
    let body: RecordValue | undefined;
    try { body = record(await request.json()); } catch { return undefined; }
    if (!body) return undefined;
    const rawMetadata = record(body.client_metadata)?.["x-codex-turn-metadata"];
    let metadata: RecordValue | undefined;
    try { metadata = typeof rawMetadata === "string" ? record(JSON.parse(rawMetadata)) : record(rawMetadata); }
    catch { return undefined; }
    if (metadata?.request_kind !== "compaction") return undefined;
    const remote = Array.isArray(body.input) && record(body.input.at(-1))?.type === "compaction_trigger";
    if (remote) {
      // Standard Codex v2 includes its tool declarations. They are not execution
      // authority for a summary operation; the existing inert compaction binder
      // and producer receive only original history plus the summary instruction.
      body = { ...body, tools: [], input: [...(body.input as unknown[]).slice(0, -1)
        .filter(item => record(item)?.type !== "additional_tools"), {
        type: "message", role: "user", content: "Summarize this task for continuation. Preserve current work, decisions, constraints, unresolved failures and next steps. Historical details require original-source readback. Summarize only; do not execute tools.",
      }] };
    }
    let phase: CompactionPhase = "route";
    let state: "new" | "coalesced" | "cached" = "new";
    let operationId: string | undefined;
    let scope: string | undefined;
    let turn: string | undefined;
    let sourceMatches: boolean | undefined;
    let wireMatches: boolean | undefined;
    try {
      const browserModel = nativeRequestBrowserModelRoute(body);
      if (!browserModel) return undefined;
      phase = "binding";
      const { claim, evidence: activeOwner } = await bindNativeCompactionRequest(body, input.source);
      scope = diagnosticFingerprint(claim.threadId);
      turn = diagnosticFingerprint(claim.turnId);
      phase = "identity";
      const key = JSON.stringify([claim.threadId, claim.turnId]);
      const sourceDigest = digest({ source: nativeRequestContentSource(body), browserModel,
        lineage: { threadId: claim.threadId, turnId: claim.turnId, parentThreadId: claim.parentThreadId,
          agentName: claim.agentName, subagentKind: claim.subagentKind },
        environment: { cwd: activeOwner.cwd, workspaceRoots: activeOwner.workspaceRoots, sandbox: activeOwner.sandbox,
          environmentSourceTurnId: activeOwner.environmentSourceTurnId, ingressMedia: activeOwner.ingressMedia,
          nativeGoal: activeOwner.nativeGoal, nativeGoalState: activeOwner.nativeGoalState } });
      const wireDigest = digest(body);
      let operation = operations.get(key);
      if (operation) {
        operationId = operation.id; state = operation.settled ? "cached" : "coalesced";
        sourceMatches = operation.digest === sourceDigest; wireMatches = operation.wireDigest === wireDigest;
        if (!sourceMatches) throw new CompactionFailure(phase, "source_changed");
      }
      phase = "admission";
      if (!operation) {
        if (operations.size >= capacity) {
          const oldest = [...operations.entries()].find(([, entry]) => entry.settled);
          if (!oldest) throw new CompactionFailure(phase, "capacity_exhausted");
          operations.delete(oldest[0]);
        }
        // A reused operation has already settled its exact canonical source.
        // Do not deliver its Native tool result again on metadata-only retries.
        input.settlePendingToolResult?.(claim.threadId, claim.turnId, body);
        const id = randomUUID(); operationId = id;
        const startedAt = Date.now();
        const result = withDiagnosticContext({ operation_fingerprint: diagnosticFingerprint(id), scope_fingerprint: scope, turn_fingerprint: turn }, async () => {
          let operationPhase: CompactionPhase = "watch";
          let watch: Awaited<ReturnType<NonNullable<typeof input.source.watchTurn>>>;
          let primaryFailure = false;
          let summary: string;
          try {
            watch = await input.source.watchTurn?.(claim.threadId, claim.turnId);
            if (watch?.signal.aborted) throw new CompactionFailure(operationPhase, "owner_cancelled");
            operationPhase = "continuity";
            const policy = webWorkingContextPolicy(browserModel.effort, input.checkpointPreparationPolicy);
            const preparationBudget = new CheckpointPreparationBudget(
              policy.checkpointSourceTokens, input.checkpointPreparationPolicy);
            const producer: NativeRequestCheckpointProducer = async (request, preparation) => ({
              nativeTaskId: request.nativeTaskId, sourceRevisionId: request.sourceRevisionId,
              content: await input.summarize({ ...request, browserModel,
                ...(preparation ? { signal: preparation.signal } : {}) }),
            });
            const opaque = nativeOpaqueCompaction(body);
            const hasHistoryReadback = !!(input.source.readHistoryPage && input.source.readHistoryIndex);
            const continuity = await resolveNativeContextContinuity({
              threadId: claim.threadId, currentTurnId: claim.turnId,
              authority: historicalTurnAuthority(activeOwner),
              ...(hasHistoryReadback ? { historyBodyBudgetBytes: policy.firstMessageTargetTokens * 4 } : {}),
              opaque, effort: browserModel.effort, browserModel, preparationBudget, options: {
                ...input,
                checkpointProducer: producer,
              },
              ...(watch ? { preparation: {
                signal: watch.signal, onProgress: (_summary: string) => {},
              } } : {}),
            });
            if (activeOwner.ingressMedia && activeOwner.ingressMedia.turnId !== claim.turnId) {
              throw new Error("Native ingress media belongs to a different current turn");
            }
            operationPhase = "projection";
            let projection = projectNativeRequestContext(claim.threadId, body, continuity.visibleHistory,
              continuity.inlineHistoryAssets, continuity.historyReferences, activeOwner.ingressMedia,
              activeOwner.nativeGoal, activeOwner.nativeGoalState);
            if (projection.deferredHistory && !hasHistoryReadback) throw new NativeHistoryBootstrapRequired();
            const tokens = projection.revisions.reduce((sum, item) => sum + item.revision.estimatedTokens, 0);
            emitDiagnosticEvent("chatgpt_tela_work", "compaction_started", { logical_estimate: tokens, revision_count: projection.revisions.length });
            const maintained = projection.deferredHistory ? { checkpoint: undefined, reused: false, produced: false }
              : await selectNativeWorkingCheckpoint({
              projection, currentTurnId: claim.turnId,
              ...(input.checkpointCache ? { cache: input.checkpointCache } : {}),
              ...(input.visiblePrefix ? { visiblePrefix: input.visiblePrefix } : {}),
              producer, browserModel, policy, preparationBudget,
              allowMaintenance: false,
              ...(watch ? { signal: watch.signal,
                preparation: { signal: watch.signal, onProgress: (_message: string) => {} } } : {}),
            });
            let physicalContext: WebPhysicalContext = bindNativePhysicalEvidence(projection,
              nativeCompactionPhysicalContext(projection, maintained.checkpoint));
            // Refuse an unprovable or oversized source before producing any model summary.
            operationPhase = "source_fit";
            let bounded = boundedWebCheckpointSource(physicalContext, projection.media, browserModel.effort);
            if (!bounded && hasHistoryReadback) {
              const wanted = new Set((Array.isArray(body.input) ? body.input : []).flatMap(raw => {
                const id = nativeRequestSourceTurnId(raw);
                return id !== undefined && id !== claim.turnId ? [id] : [];
              }));
              const readable = new Set<string>();
              let cursor: string | undefined;
              while (wanted.size) {
                const page = await input.source.readHistoryIndex!(activeOwner, { ...(cursor ? { cursor } : {}) },
                  watch?.signal ?? new AbortController().signal);
                for (const item of page.data) {
                  if (wanted.delete(item.turnId) && ["completed", "failed", "interrupted"].includes(item.status)
                    && item.turnId !== claim.turnId) readable.add(item.turnId);
                }
                if (!page.nextCursor) break;
                cursor = page.nextCursor;
              }
              projection = projectNativeRequestContext(claim.threadId, body, continuity.visibleHistory,
                continuity.inlineHistoryAssets, continuity.historyReferences, activeOwner.ingressMedia,
                activeOwner.nativeGoal, activeOwner.nativeGoalState, readable);
              const seed = prepareDeferredNativeHistory(projection, policy, policy.checkpointSourceTokens);
              if (seed) {
                physicalContext = bindNativePhysicalEvidence(projection, seed.physicalContext);
                bounded = boundedWebCheckpointSource(physicalContext, projection.media, browserModel.effort);
              }
              emitDiagnosticEvent("chatgpt_tela_work", "compaction_history_source_selected", {
                source_revision_count: projection.revisions.length,
                covered_revision_count: projection.revisions.filter(item => item.historicalTurnId).length,
                item_count: physicalContext.segments.length, source_fits: !!bounded,
                reason_class: seed ? "indexed_originals_deferred" : "exact_source_required",
              });
            }
            emitDiagnosticEvent("chatgpt_tela_work", "compaction_source_observed", {
              logical_estimate: tokens, revision_count: projection.revisions.length,
              transfer_estimate: Math.max(physicalContext.transferTokens, chatGptCheckpointInputTokens(physicalContext, projection.media)),
              source_limit: chatGptWebCheckpointSourceTokenLimit(browserModel.effort), source_fits: !!bounded,
              instruction_estimate: physicalContext.segments.filter(segment => segment.type === "revision"
                && (segment.kind === "system" || segment.kind === "developer"))
                .reduce((sum, segment) => sum + Math.ceil(Buffer.byteLength(segment.content, "utf8") / 4), 0),
              checkpoint_estimate: physicalContext.segments.filter(segment => segment.type === "checkpoint")
                .reduce((sum, segment) => sum + Math.ceil(Buffer.byteLength(segment.content, "utf8") / 4), 0),
              segment_count: physicalContext.segments.length,
              working_checkpoint_reused: maintained.reused,
              working_checkpoint_advanced: maintained.produced,
            });
            if (!bounded && (!input.visiblePrefix || projection.media.length)) throw new NativeHistoryBootstrapRequired();
            operationPhase = "summary";
            if (!bounded) {
              const owner = input.visiblePrefix!;
              // The account-owned stage journal is the same compressor used by
              // ordinary request prefixes. No truncation or second retry ledger.
              const source = nativeRequestPrefixSnapshot(claim.threadId, claim.turnId, physicalContext);
              const checkpoint = record(JSON.parse(await produceNativePrefixCheckpoint({
                source, accountNamespace: owner.accountNamespace, journal: owner.journal,
                producer, effort: browserModel.effort, browserModel, preparationBudget,
                confirmSource: async () => {
                  if (watch?.signal.aborted) throw new CompactionFailure("summary", "owner_cancelled");
                  await bindNativeCompactionRequest(body, input.source);
                  return source;
                },
                ...(watch ? { signal: watch.signal, preparation: {
                  signal: watch.signal, onProgress: (_summary: string) => {},
                } } : {}),
              })));
              if (typeof checkpoint?.summary !== "string") throw new CompactionFailure("summary_validation", "invalid_summary");
              summary = checkpoint.summary;
            } else {
              const result = await preparationBudget.producer(producer)({
                nativeTaskId: claim.threadId, sourceRevisionId: projection.headId,
                physicalContext: bounded, browserModel,
                ...(projection.media.length ? { media: projection.media } : {}),
              }, watch ? { signal: watch.signal, onProgress: (_summary: string) => {} } : undefined);
              summary = result.content;
            }
            if (watch?.signal.aborted) throw new CompactionFailure(operationPhase, "owner_cancelled");
            operationPhase = "summary_validation";
            const deferredHistory = physicalContext.deferredHistory ?? projection.deferredHistory;
            const notice = deferredHistory ? deferredNativeOriginalsNotice(deferredHistory) + "\n" : "";
            if (!summary.trim() || Buffer.byteLength(notice + summary, "utf8") > MAX_TELA_COMPACTION_SUMMARY_BYTES) throw new CompactionFailure(operationPhase, "invalid_summary");
            summary = notice + summary;
          } catch (error) { primaryFailure = true; throw failure(error, operationPhase); }
          finally {
            try { await watch?.close(); }
            catch (error) {
              emitDiagnosticEvent("chatgpt_tela_work", "compaction_release_failed", {
                phase: "release", reason_class: diagnosticFailureClass(error), prior_failure: primaryFailure,
              });
              if (!primaryFailure) throw failure(error, "release");
            }
          }
          emitDiagnosticEvent("chatgpt_tela_work", "compaction_completed", { result_bytes: Buffer.byteLength(summary), duration_ms: diagnosticDurationMs(startedAt) });
          return summary;
        });
        operation = { digest: sourceDigest, wireDigest, id, result, settled: false };
        operations.set(key, operation);
        const saved = operation;
        void result.finally(() => { saved.settled = true; }).catch(() => {});
      }
      emitDiagnosticEvent("chatgpt_tela_work", "compaction_operation_observed", {
        state, operation_fingerprint: diagnosticFingerprint(operation.id), scope_fingerprint: scope, turn_fingerprint: turn,
        ...(sourceMatches === undefined ? {} : { source_matches: sourceMatches, wire_matches: wireMatches! }),
      });
      const summary = await operation.result;
      phase = "delivery";
      // Every waiter proves ownership at delivery, including coalesced and cached retries.
      await bindNativeCompactionRequest(body, input.source);
      return nativeCompactionSummaryResponse({
        summary, operationId: operation.id, model: body.model as string,
        stream: body.stream === true,
        remote,
      });
    } catch (error) {
      const rejected = failure(error, phase);
      const budgetExceeded = rejected.reason === "preparation_budget_exceeded";
      const requiresRecovery = rejected.reason === "readable_checkpoint_required" || budgetExceeded;
      // The current input cannot recover by retrying. Standard remote compaction
      // retries 422 responses; classify these terminal invalid requests as 400.
      const status = 400;
      emitDiagnosticEvent("chatgpt_tela_work", "compaction_rejected", {
        phase: rejected.phase, reason_class: rejected.reason, status, state,
        kind: diagnosticFailureClass(rejected.cause),
        ...(operationId ? { operation_fingerprint: diagnosticFingerprint(operationId) } : {}),
        ...(scope ? { scope_fingerprint: scope } : {}),
        ...(turn ? { turn_fingerprint: turn } : {}),
        ...(sourceMatches === undefined ? {} : { source_matches: sourceMatches, wire_matches: wireMatches! }),
      });
      if (requiresRecovery) {
        return Response.json({ error: {
          type: "invalid_request_error",
          code: budgetExceeded ? "tela_compaction_preparation_budget_exceeded" : "tela_compaction_requires_readable_checkpoint",
          message: budgetExceeded
            ? "Web compaction exceeds the configured preparation budget. Reuse a verified checkpoint or explicit handoff; Native history was not changed."
            : "Native readable history exceeds the bounded Web compaction input. A verified checkpoint or explicit handoff is needed; no historical evidence was removed.",
        } }, { status });
      }
      return Response.json({ error: { type: "invalid_request_error", code: "tela_local_compaction_rejected",
        message: "Web compaction could not verify the current conversation and its readable source. Native history was not changed by this request." } }, { status: 400 });
    }
  };
}
