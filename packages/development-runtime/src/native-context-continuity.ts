import { createHash } from "node:crypto";
import {
  NativeHistoryBootstrapRequired,
  restoreNativeHistoricalImages,
  automaticNativeHandoffText,
  type AutomaticNativeHandoff,
  type NativeCompactionHistoryProjection,
  type NativeHistoricalImageCandidate,
  type NativeReadableHistoryAnchor,
  type NativeWebHandoff,
} from "@chatgpt-tela/codex";
import type {
  NativeEvidenceReference,
  NativeInlineHistoryAsset,
  NativeTurnAuthority,
} from "@chatgpt-tela/core";
import { emitDiagnosticEvent } from "@chatgpt-tela/core";
import { chatGptWebCheckpointSourceTokenLimit, type ChatGptWebEffort } from "@chatgpt-tela/chatgpt";
import type { ContextCheckpointCache } from "./context-cache";
import { readNativeHistoryCheckpoint, maybeProduceNativeHistoryCheckpoint } from "./native-history-checkpoint";
import { manualHandoffText, recentManualHandoff, storeManualHandoff } from "./native-manual-handoff-cache";
import { recentAutomaticNativeHandoff, storeAutomaticNativeHandoff } from "./native-automatic-handoff-cache";
import type { NativeRequestCheckpointProducer } from "./native-request-planner";

/** The public adapter may initially return a bounded source without resolved local media. */
export type NativeHistorySource = Pick<NativeCompactionHistoryProjection,
  "threadId" | "currentTurnId" | "compactionItemId" | "content"> & {
  readonly compactionTurnId?: string;
  readonly inlineAssets?: readonly NativeInlineHistoryAsset[];
  readonly references?: readonly NativeEvidenceReference[];
  readonly localImageCandidates?: readonly NativeHistoricalImageCandidate[];
};

export interface NativeContinuitySources {
  readonly compactionHistory?: (threadId: string, turnId: string) => Promise<NativeHistorySource>;
  readonly compactionAnchor?: (threadId: string, turnId: string, signal?: AbortSignal) =>
    Promise<NativeReadableHistoryAnchor>;
  readonly nativeWebHandoff?: (threadId: string, turnId: string, signal?: AbortSignal) =>
    Promise<NativeWebHandoff | undefined>;
  readonly verifyNativeWebHandoff?: (
    threadId: string, currentTurnId: string, handoffTurnId: string,
    answerDigest: string, signal?: AbortSignal,
  ) => Promise<NativeWebHandoff | undefined>;
  /** Research-only injection seam, NOT wired by the product. A Web selection
   * alone does NOT authorize a Native fork or extra model call. The installed
   * public engine lacks effective historical model/provider attestation and
   * true pre-execution tool-free fork enforcement. No production caller may
   * supply this until both are proven by the canonical Native owner. */
  readonly automaticNativeHandoff?: (
    threadId: string, currentTurnId: string, opaqueFingerprint: string, signal?: AbortSignal,
  ) => Promise<AutomaticNativeHandoff>;
  readonly verifyAutomaticNativeHandoff?: (
    threadId: string, currentTurnId: string, sourceTurnId: string, signal?: AbortSignal,
  ) => Promise<boolean>;
  /** TEST FIXTURES ONLY: allow a fake Native fork to exercise this otherwise
   * dormant research path. Production must not set this. Without this flag
   * neither injected auto callbacks nor cached auto summaries are consulted.
   * This flag does not attest real Native provenance or enforce no-tools. */
  readonly unsafePermitModelToolsInIsolatedSyntheticFixture?: true;
  readonly historyCheckpointCache?: ContextCheckpointCache;
  readonly checkpointProducer?: NativeRequestCheckpointProducer;
}

/** This is provider-facing context provenance, NOT Native task/permission authority. */
export type NativeContinuityMode =
  | "current-input" | "retained" | "readable-checkpoint" | "cached-handoff"
  | "explicit-handoff" | "bounded-source" | "produced-checkpoint"
  | "automatic-handoff" | "cached-automatic-handoff";

export interface NativeContinuityDecision {
  readonly mode: NativeContinuityMode;
  readonly visibleHistory?: string;
  readonly inlineHistoryAssets: readonly NativeInlineHistoryAsset[];
  readonly historyReferences?: readonly NativeEvidenceReference[];
  readonly checkpointReused: boolean;
  readonly checkpointProduced: boolean;
  readonly manualHandoff: boolean;
}

export interface NativeOpaqueCompaction {
  readonly count: number;
  readonly fingerprint?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** The hash is a local invalidation token, not permission to decode encrypted state. */
export function nativeOpaqueCompaction(value: unknown): NativeOpaqueCompaction {
  const input = record(value)?.input;
  const opaque = Array.isArray(input)
    ? input.map(record).filter(item => item?.type === "compaction") : [];
  return Object.freeze({
    count: opaque.length,
    ...(opaque.length === 1 ? {
      fingerprint: createHash("sha256").update(JSON.stringify(opaque[0])).digest("hex"),
    } : {}),
  });
}

function resolved(mode: NativeContinuityMode, visibleHistory?: string,
  inlineHistoryAssets: readonly NativeInlineHistoryAsset[] = [],
  historyReferences?: readonly NativeEvidenceReference[]): NativeContinuityDecision {
  return Object.freeze({
    mode,
    ...(visibleHistory !== undefined ? { visibleHistory } : {}),
    inlineHistoryAssets,
    ...(historyReferences !== undefined ? { historyReferences } : {}),
    checkpointReused: mode === "retained" || mode === "readable-checkpoint"
      || mode === "cached-handoff" || mode === "cached-automatic-handoff",
    checkpointProduced: mode === "produced-checkpoint",
    manualHandoff: mode === "explicit-handoff",
  });
}

/**
 * One cold/hot continuity decision for a Native-owned turn. The order is
 * deliberate: proven retained Web state, verified source checkpoint, explicit
 * user handoff, finally a complete bounded Native-visible source. Unavailable
 * original evidence is never silently converted to a complete history.
 *
 * Local readable `context_compaction + user summary` is already on the Native
 * canonical input, so it never passes through this opaque-history resolver.
 * No model is started merely because a user changed models; the optional
 * checkpoint producer runs only for an already readable, complete source.
 */
export async function resolveNativeContextContinuity(input: {
  readonly threadId: string;
  readonly currentTurnId: string;
  readonly authority: NativeTurnAuthority;
  readonly opaque: NativeOpaqueCompaction;
  /** Validated by the caller against active retained lineage, route and Web epoch pressure. */
  readonly retainedHistory?: string;
  readonly effort?: ChatGptWebEffort;
  readonly options: NativeContinuitySources;
  readonly preparation?: Parameters<NativeRequestCheckpointProducer>[1];
}): Promise<NativeContinuityDecision> {
  const { threadId, currentTurnId, opaque, options, preparation } = input;
  const signal = preparation?.signal;
  signal?.throwIfAborted();
  // Only the canonical in-process Native turn authority may select a Web
  // projection. The duplicate IDs are adapter inputs, NOT a second source
  // of ownership. Check before retained-history reuse, cache reads, public
  // history RPCs or any optional checkpoint/model producer.
  if (input.authority?.source !== "native-current-turn"
    || input.authority.threadId !== threadId
    || input.authority.turnId !== currentTurnId) {
    throw new Error("Native continuity source does not match canonical current-turn authority");
  }
  if (opaque.count === 0) return resolved("current-input");
  if (opaque.count !== 1) throw new Error("Native compaction history has ambiguous encrypted checkpoints");
  if (input.retainedHistory !== undefined) return resolved("retained", input.retainedHistory);

  const cache = options.historyCheckpointCache;
  const fingerprint = opaque.fingerprint;
  let automaticDisabledRecorded = false;
  const automatic = async (mayProduce: boolean): Promise<NativeContinuityDecision | undefined> => {
    // An accidental future callback wiring must never silently activate a
    // secondary Native model or trust a previously derived auto summary.
    // The product neither supplies this fixture flag nor installs the
    // experimental callbacks, regardless of source/cached checkpoint state.
    if (options.unsafePermitModelToolsInIsolatedSyntheticFixture !== true) {
      if (!automaticDisabledRecorded
        && (options.automaticNativeHandoff || options.verifyAutomaticNativeHandoff)) {
        automaticDisabledRecorded = true;
        emitDiagnosticEvent("chatgpt_tela_codex", "native_auto_handoff_rejected", {
          phase: "continuity_resolver", reason_class: "production_disabled",
        });
      }
      return undefined;
    }
    if (!cache || !fingerprint || !options.verifyAutomaticNativeHandoff) return undefined;
    const cached = await recentAutomaticNativeHandoff(cache, threadId, fingerprint);
    if (cached && await options.verifyAutomaticNativeHandoff(
      threadId, currentTurnId, cached.sourceTurnId, signal,
    )) {
      signal?.throwIfAborted();
      return resolved("cached-automatic-handoff", automaticNativeHandoffText({
        ...cached, currentTurnId,
      }));
    }
    if (!mayProduce || !options.automaticNativeHandoff) return undefined;
    const result = await options.automaticNativeHandoff(
      threadId, currentTurnId, fingerprint, signal,
    );
    signal?.throwIfAborted();
    if (result.threadId !== threadId || result.currentTurnId !== currentTurnId
      || !result.sourceTurnId || !await options.verifyAutomaticNativeHandoff(
        threadId, currentTurnId, result.sourceTurnId, signal,
      )) {
      throw new NativeHistoryBootstrapRequired();
    }
    const text = automaticNativeHandoffText(result);
    await storeAutomaticNativeHandoff(cache, result, fingerprint);
    signal?.throwIfAborted();
    return resolved("automatic-handoff", text);
  };
  let manualAttempted = false;
  const manual = async (): Promise<NativeContinuityDecision | undefined> => {
    if (manualAttempted) return undefined;
    manualAttempted = true;
    if (fingerprint && cache && options.verifyNativeWebHandoff) {
      const hint = await recentManualHandoff(cache, threadId, fingerprint);
      if (hint) {
        const verified = await options.verifyNativeWebHandoff(
          threadId, currentTurnId, hint.handoffTurnId, hint.answerDigest, signal,
        );
        signal?.throwIfAborted();
        if (verified && verified.threadId === threadId
          && verified.currentTurnId === currentTurnId
          && verified.handoffTurnId === hint.handoffTurnId
          && verified.handoffItemId === hint.handoffItemId
          && verified.answerDigest === hint.answerDigest
          && verified.summary === hint.summary
          && verified.limitations === hint.limitations) {
          return resolved("cached-handoff", manualHandoffText(verified));
        }
      }
    }
    const handoff = await options.nativeWebHandoff?.(threadId, currentTurnId, signal);
    if (!handoff) return undefined;
    if (handoff.threadId !== threadId || handoff.currentTurnId !== currentTurnId
      || !handoff.handoffTurnId || !handoff.handoffItemId
      || !/^[a-f0-9]{64}$/.test(handoff.answerDigest)
      || !handoff.summary.trim() || !handoff.limitations.trim()) {
      throw new Error("Native manual handoff is not owned by the exact active turn");
    }
    signal?.throwIfAborted();
    // Fresh handoffs are candidates, not current Native source proof.
    // Recheck the same bounded public final answer independently before
    // Web can use it or persist any derived checkpoint.
    if (!options.verifyNativeWebHandoff) {
      throw new NativeHistoryBootstrapRequired();
    }
    const verified = await options.verifyNativeWebHandoff(
      threadId, currentTurnId, handoff.handoffTurnId, handoff.answerDigest, signal,
    );
    signal?.throwIfAborted();
    if (!verified || verified.threadId !== threadId
      || verified.currentTurnId !== currentTurnId
      || verified.handoffTurnId !== handoff.handoffTurnId
      || verified.handoffItemId !== handoff.handoffItemId
      || verified.answerDigest !== handoff.answerDigest
      || verified.summary !== handoff.summary
      || verified.limitations !== handoff.limitations) {
      throw new NativeHistoryBootstrapRequired();
    }
    const text = manualHandoffText(verified);
    if (cache && fingerprint) {
      await storeManualHandoff(cache, verified, fingerprint);
      signal?.throwIfAborted();
    }
    return resolved("explicit-handoff", text);
  };

  // If no original-source checkpoint even has a candidate key, a user-authored
  // public handoff is cheaper and safer than a giant Legacy full-item probe.
  if (cache && options.nativeWebHandoff) {
    const candidates = await cache.list(threadId);
    if (!candidates.some(candidate => candidate.checkpoint.revisionId
      .startsWith("native_visible_history_v1_"))) {
      const early = await manual();
      if (early) return early;
    }
  }
  // Automatic summaries created from prior Web selections are source-bound
  // cached context, never new Native tool authority. Reuse before probing
  // old giant Legacy pages; a new Native model call is NOT done here.
  const cachedAutomatic = await automatic(false);
  if (cachedAutomatic) return cachedAutomatic;

  let anchor: NativeReadableHistoryAnchor | undefined;
  let anchorLimit: NativeHistoryBootstrapRequired | undefined;
  if (options.compactionAnchor && cache) {
    try { anchor = await options.compactionAnchor(threadId, currentTurnId, signal); }
    catch (error) {
      if (!(error instanceof NativeHistoryBootstrapRequired)) throw error;
      anchorLimit = error;
    }
  }
  signal?.throwIfAborted();
  if (anchor && (anchor.threadId !== threadId || anchor.currentTurnId !== currentTurnId
    || !anchor.compactionItemId.trim() || !anchor.compactionTurnId.trim())) {
    throw new Error("Native history checkpoint anchor belongs to a different turn");
  }
  if (anchor && cache) {
    const checkpoint = await readNativeHistoryCheckpoint(cache, anchor);
    if (checkpoint) return resolved("readable-checkpoint", checkpoint);
  }
  const handoff = await manual();
  if (handoff) return handoff;
  if (anchorLimit) {
    try {
      const generated = await automatic(true);
      if (generated) return generated;
    } catch { /* Keep the original source-unavailable error contract. */ }
    throw anchorLimit;
  }
  if (!options.compactionHistory) {
    // A verified readable handoff or checkpoint needs no replay provider.
    // Without either, opaque Native state is not model-visible text.
    try {
      const generated = await automatic(true);
      if (generated) return generated;
    } catch { /* A failed opaque bootstrap remains a typed user recovery error. */ }
    throw new NativeHistoryBootstrapRequired();
  }

  let history: NativeHistorySource;
  try { history = await options.compactionHistory(threadId, currentTurnId); }
  catch (error) {
    if (!(error instanceof NativeHistoryBootstrapRequired)) throw error;
    try {
      const generated = await automatic(true);
      if (generated) return generated;
    } catch { /* Unavailable fork never authorizes partial original evidence. */ }
    throw error;
  }
  signal?.throwIfAborted();
  if (history.threadId !== threadId || history.currentTurnId !== currentTurnId
    || !history.compactionItemId.trim()
    || (anchor && (history.compactionItemId !== anchor.compactionItemId
      || history.compactionTurnId !== anchor.compactionTurnId))) {
    throw new Error("Native compaction history belongs to a different turn");
  }
  if (history.localImageCandidates?.length && history.references) {
    history = await restoreNativeHistoricalImages({
      ...history, inlineAssets: history.inlineAssets ?? [],
      references: history.references,
      localImageCandidates: history.localImageCandidates,
    }, input.authority, signal);
  }
  signal?.throwIfAborted();
  if (anchor && cache && options.checkpointProducer && input.effort) {
    const checkpoint = await maybeProduceNativeHistoryCheckpoint({
      anchor,
      history: {
        ...history, inlineAssets: history.inlineAssets ?? [],
        references: history.references ?? [],
        localImageCandidates: history.localImageCandidates ?? [],
      },
      cache,
      producer: options.checkpointProducer, effort: input.effort,
      confirmAnchor: () => options.compactionAnchor!(threadId, currentTurnId, signal),
      ...(signal ? { signal } : {}),
      ...(preparation ? { preparation } : {}),
    });
    if (checkpoint) return resolved("produced-checkpoint", checkpoint);
  }
  // A fully readable Native source can still be too large to enter the Web
  // physical window. Do not lose the exact suffix/limitations through
  // provider-side trimming: first attempt the isolated Native handoff and
  // otherwise return the ordinary typed recovery requirement.
  if (input.effort
    && Math.ceil(Buffer.byteLength(history.content, "utf8") / 4)
      > chatGptWebCheckpointSourceTokenLimit(input.effort)) {
    try {
      const generated = await automatic(true);
      if (generated) return generated;
    } catch { /* Native model or its public isolation was unavailable. */ }
    throw new NativeHistoryBootstrapRequired();
  }
  return resolved("bounded-source", history.content,
    history.inlineAssets ?? [], history.references);
}
