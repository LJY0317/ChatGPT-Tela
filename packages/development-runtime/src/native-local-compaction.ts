import { diagnosticDurationMs, diagnosticFingerprint, emitDiagnosticEvent, withDiagnosticContext } from "@chatgpt-tela/core";
import { createHash, randomUUID } from "node:crypto";
import {
  bindNativeCompactionRequest, historicalTurnAuthority,
  NativeHistoryBootstrapRequired, type CanonicalCurrentTurnSource,
} from "@chatgpt-tela/codex";
import { nativeCompactionSummaryResponse } from "@chatgpt-tela/responses";
import {
  type ChatGptWebEffort, type WebPhysicalContext, type WebTurnMedia } from "@chatgpt-tela/chatgpt";
import { bindNativePhysicalEvidence, nativeRequestBrowserModelRoute, projectNativeRequestContext } from "./native-request-planner";
import {
  nativeOpaqueCompaction, resolveNativeContextContinuity, type NativeContinuitySources,
} from "./native-context-continuity";
import { boundedWebCheckpointSource } from "./web-checkpoint-source";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
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
  const operations = new Map<string, { digest: string; id: string; result: Promise<string>; settled: boolean }>();
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
    try {
      const browserModel = nativeRequestBrowserModelRoute(body);
      if (!browserModel) return undefined;
      const { claim, evidence: activeOwner } = await bindNativeCompactionRequest(body, input.source);
      const key = JSON.stringify([claim.threadId, claim.turnId]);
      const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
      let operation = operations.get(key);
      if (operation && operation.digest !== digest) throw new Error("Compaction source changed during one operation");
      if (!operation) {
        if (operations.size >= capacity) {
          const oldest = [...operations.entries()].find(([, entry]) => entry.settled);
          if (!oldest) throw new Error("Compaction operation capacity exhausted");
          operations.delete(oldest[0]);
        }
        const id = randomUUID();
        const startedAt = Date.now();
        const result = withDiagnosticContext({ operation_fingerprint: diagnosticFingerprint(id), scope_fingerprint: diagnosticFingerprint(claim.threadId) }, async () => {
          const watch = await input.source.watchTurn?.(claim.threadId, claim.turnId);
          try {
          watch?.signal.throwIfAborted();
          const opaque = nativeOpaqueCompaction(body);
          const continuity = await resolveNativeContextContinuity({
            threadId: claim.threadId, currentTurnId: claim.turnId,
            authority: historicalTurnAuthority(activeOwner),
            opaque, effort: browserModel.effort, options: input,
            ...(watch ? { preparation: {
              signal: watch.signal, onProgress: (_summary: string) => {},
            } } : {}),
          });
          if (activeOwner.ingressMedia && activeOwner.ingressMedia.turnId !== claim.turnId) {
            throw new Error("Native ingress media belongs to a different current turn");
          }
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
          const bounded = boundedWebCheckpointSource(physicalContext, projection.media, browserModel.effort);
          if (!bounded) {
            // No partial source or rolling truncation: this compaction can only
            // run once a source-bound readable checkpoint is available.
            throw new NativeHistoryBootstrapRequired();
          }
          const summary = await input.summarize({
            ...(watch ? { signal: watch.signal } : {}),
            nativeTaskId: claim.threadId, sourceRevisionId: projection.headId, browserModel,
            physicalContext: bounded,
            ...(projection.media.length ? { media: projection.media } : {}),
          });
          watch?.signal.throwIfAborted();
          if (!summary.trim() || Buffer.byteLength(summary, "utf8") > 32 * 1024) throw new Error("Invalid Native compaction summary");
          emitDiagnosticEvent("chatgpt_tela_work", "compaction_completed", { result_bytes: Buffer.byteLength(summary), duration_ms: diagnosticDurationMs(startedAt) });
          return summary;
          } finally { await watch?.close(); }
        });
        operation = { digest, id, result, settled: false };
        operations.set(key, operation);
        const saved = operation;
        void result.finally(() => { saved.settled = true; }).catch(() => {});
      }
      const summary = await operation.result;
      // Every waiter proves ownership at delivery, including coalesced and cached retries.
      await bindNativeCompactionRequest(body, input.source);
      return nativeCompactionSummaryResponse({
        summary, operationId: operation.id, model: body.model as string,
        stream: body.stream === true,
      });
    } catch (error) {
      emitDiagnosticEvent("chatgpt_tela_work", "compaction_rejected");
      if (error instanceof NativeHistoryBootstrapRequired) {
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
