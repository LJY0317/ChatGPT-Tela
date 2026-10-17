import { diagnosticDurationMs, diagnosticFingerprint, diagnosticFailureClass, emitDiagnosticEvent, withDiagnosticContext } from "@chatgpt-tela/core";
import { createHash, randomUUID } from "node:crypto";
import {
  bindNativeCompactionRequest, historicalTurnAuthority,
  NativeHistoryBootstrapRequired, NativeBindingError, type NativeBindingReason, type CanonicalCurrentTurnSource,
} from "@chatgpt-tela/codex";
import { nativeCompactionSummaryResponse } from "@chatgpt-tela/responses";
import {
  chatGptCheckpointInputTokens, chatGptWebCheckpointSourceTokenLimit, type ChatGptWebEffort, type WebPhysicalContext, type WebTurnMedia } from "@chatgpt-tela/chatgpt";
import { bindNativePhysicalEvidence, nativeRequestContentSource, nativeRequestBrowserModelRoute, projectNativeRequestContext } from "./native-request-planner";
import {
  nativeOpaqueCompaction, resolveNativeContextContinuity, type NativeContinuitySources,
} from "./native-context-continuity";
import { boundedWebCheckpointSource } from "./web-checkpoint-source";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

type CompactionPhase = "route" | "binding" | "identity" | "admission" | "watch" | "continuity"
  | "projection" | "source_fit" | "summary" | "summary_validation" | "release" | "delivery";
type CompactionReason = NativeBindingReason | "stage_failed" | "source_changed" | "capacity_exhausted"
  | "readable_checkpoint_required" | "owner_cancelled" | "invalid_summary";
class CompactionFailure extends Error {
  constructor(readonly phase: CompactionPhase, readonly reason: CompactionReason, cause?: unknown) {
    super("Native local compaction failed", { cause });
  }
}
function failure(error: unknown, phase: CompactionPhase): CompactionFailure {
  if (error instanceof CompactionFailure) return error;
  return new CompactionFailure(phase, error instanceof NativeHistoryBootstrapRequired
    ? "readable_checkpoint_required" : error instanceof NativeBindingError ? error.reason : "stage_failed", error);
}
/** Canonical JSON source, independent of key ordering and delivery/correlation metadata. */
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, (_key, item) => {
    const object = record(item);
    return object ? Object.fromEntries(Object.keys(object).sort().map(key => [key, object[key]])) : item;
  })).digest("hex");
}

/** Only handles authenticated tool-free Native local compaction, never remote opaque compaction. */
export function createNativeLocalCompactionRouter(input: NativeContinuitySources & {
  readonly source: CanonicalCurrentTurnSource;
  readonly summarize: (request: {
    readonly signal?: AbortSignal;
    readonly nativeTaskId: string;
    readonly sourceRevisionId: string;
    readonly physicalContext: WebPhysicalContext;
    readonly media?: readonly WebTurnMedia[];
    readonly browserModel: { readonly familyKey: string; readonly effort: ChatGptWebEffort };
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
    if (metadata?.request_kind !== "compaction"
      || (Array.isArray(body.input) && body.input.some(value => record(value)?.type === "compaction_trigger"))) return undefined;
    let phase: CompactionPhase = "route";
    let state: "new" | "coalesced" | "cached" = "new";
    let operationId: string | undefined;
    let scope: string | undefined;
    let sourceMatches: boolean | undefined;
    let wireMatches: boolean | undefined;
    try {
      const browserModel = nativeRequestBrowserModelRoute(body);
      if (!browserModel) return undefined;
      phase = "binding";
      const { claim, evidence: activeOwner } = await bindNativeCompactionRequest(body, input.source);
      scope = diagnosticFingerprint(claim.threadId);
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
        const id = randomUUID(); operationId = id;
        const startedAt = Date.now();
        const result = withDiagnosticContext({ operation_fingerprint: diagnosticFingerprint(id), scope_fingerprint: diagnosticFingerprint(claim.threadId) }, async () => {
          let operationPhase: CompactionPhase = "watch";
          let watch: Awaited<ReturnType<NonNullable<typeof input.source.watchTurn>>>;
          let primaryFailure = false;
          let summary: string;
          try {
            watch = await input.source.watchTurn?.(claim.threadId, claim.turnId);
            if (watch?.signal.aborted) throw new CompactionFailure(operationPhase, "owner_cancelled");
            operationPhase = "continuity";
            const opaque = nativeOpaqueCompaction(body);
            const continuity = await resolveNativeContextContinuity({
              threadId: claim.threadId, currentTurnId: claim.turnId,
              authority: historicalTurnAuthority(activeOwner),
              opaque, effort: browserModel.effort, browserModel, options: {
                ...input,
                checkpointProducer: async (request, preparation) => ({
                  nativeTaskId: request.nativeTaskId, sourceRevisionId: request.sourceRevisionId,
                  content: await input.summarize({ ...request, browserModel,
                    ...(preparation ? { signal: preparation.signal } : {}) }),
                }),
              },
              ...(watch ? { preparation: {
                signal: watch.signal, onProgress: (_summary: string) => {},
              } } : {}),
            });
            if (activeOwner.ingressMedia && activeOwner.ingressMedia.turnId !== claim.turnId) {
              throw new Error("Native ingress media belongs to a different current turn");
            }
            operationPhase = "projection";
            const projection = projectNativeRequestContext(claim.threadId, body, continuity.visibleHistory,
              continuity.inlineHistoryAssets, continuity.historyReferences, activeOwner.ingressMedia,
              activeOwner.nativeGoal, activeOwner.nativeGoalState);
            const tokens = projection.revisions.reduce((sum, item) => sum + item.revision.estimatedTokens, 0);
            emitDiagnosticEvent("chatgpt_tela_work", "compaction_started", { logical_estimate: tokens, revision_count: projection.revisions.length });
            const physicalContext: WebPhysicalContext = bindNativePhysicalEvidence(projection, {
              headRevisionId: projection.headId, activeRequestRevisionId: projection.headId,
              mode: "full", logicalTokens: tokens,
              transferTokens: tokens,
              segments: projection.revisions.map(item => ({
                type: "revision" as const, revisionId: item.revision.id, kind: item.revision.kind, content: item.content,
              })),
            });
            // Refuse an unprovable or oversized source before producing any model summary.
            operationPhase = "source_fit";
            const bounded = boundedWebCheckpointSource(physicalContext, projection.media, browserModel.effort);
            emitDiagnosticEvent("chatgpt_tela_work", "compaction_source_observed", {
              logical_estimate: tokens, revision_count: projection.revisions.length,
              transfer_estimate: Math.max(physicalContext.transferTokens, chatGptCheckpointInputTokens(physicalContext, projection.media)),
              source_limit: chatGptWebCheckpointSourceTokenLimit(browserModel.effort), source_fits: !!bounded,
            });
            if (!bounded) {
              // No partial source or rolling truncation: this compaction can only
              // run once a source-bound readable checkpoint is available.
              throw new NativeHistoryBootstrapRequired();
            }
            operationPhase = "summary";
            summary = await input.summarize({
              ...(watch ? { signal: watch.signal } : {}),
              nativeTaskId: claim.threadId, sourceRevisionId: projection.headId, browserModel,
              physicalContext: bounded,
              ...(projection.media.length ? { media: projection.media } : {}),
            });
            if (watch?.signal.aborted) throw new CompactionFailure(operationPhase, "owner_cancelled");
            operationPhase = "summary_validation";
            if (!summary.trim() || Buffer.byteLength(summary, "utf8") > 32 * 1024) throw new CompactionFailure(operationPhase, "invalid_summary");
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
        state, operation_fingerprint: diagnosticFingerprint(operation.id), scope_fingerprint: scope,
        ...(sourceMatches === undefined ? {} : { source_matches: sourceMatches, wire_matches: wireMatches! }),
      });
      const summary = await operation.result;
      phase = "delivery";
      // Every waiter proves ownership at delivery, including coalesced and cached retries.
      await bindNativeCompactionRequest(body, input.source);
      return nativeCompactionSummaryResponse({
        summary, operationId: operation.id, model: body.model as string,
        stream: body.stream === true,
      });
    } catch (error) {
      const rejected = failure(error, phase);
      const status = rejected.reason === "readable_checkpoint_required" ? 422 : 400;
      emitDiagnosticEvent("chatgpt_tela_work", "compaction_rejected", {
        phase: rejected.phase, reason_class: rejected.reason, status, state,
        kind: diagnosticFailureClass(rejected.cause),
        ...(operationId ? { operation_fingerprint: diagnosticFingerprint(operationId) } : {}),
        ...(scope ? { scope_fingerprint: scope } : {}),
        ...(sourceMatches === undefined ? {} : { source_matches: sourceMatches, wire_matches: wireMatches! }),
      });
      if (status === 422) {
        return Response.json({ error: {
          type: "invalid_request_error",
          code: "tela_compaction_requires_readable_checkpoint",
          message: "Native readable history exceeds the bounded Web compaction input. A verified checkpoint or explicit handoff is needed; no historical evidence was removed.",
        } }, { status: 422 });
      }
      return Response.json({ error: { type: "invalid_request_error", code: "tela_local_compaction_rejected",
        message: "Web compaction could not verify the current conversation and its readable source. Native history was not changed by this request." } }, { status: 400 });
    }
  };
}
