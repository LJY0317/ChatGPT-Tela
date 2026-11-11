import { classifyWebPreparationFailure } from "./web-preparation-diagnostics";
import { CheckpointPreparationBudget, type CheckpointPreparationPolicy } from "./checkpoint-preparation-budget";
import { createHash } from "node:crypto";
import {
  NativeHistoryBootstrapRequired,
  decodeTelaCompactionSummary,
  restoreNativeHistoricalImages,
  type NativeCompactionHistoryProjection,
  type NativeHistoricalImageCandidate,
  type NativeReadableHistoryAnchor,
  type NativeVisibleHistorySnapshot,
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
import type { NativeRequestCheckpointProducer } from "./native-request-planner";
import type { NativeVisiblePrefixStageJournal } from "./native-visible-prefix-checkpoint";

/** The public adapter may initially return a bounded source without resolved local media. */
export type NativeHistorySource = Pick<NativeCompactionHistoryProjection,
  "threadId" | "currentTurnId" | "compactionItemId" | "content"> & {
  readonly compactionTurnId?: string;
  readonly inlineAssets?: readonly NativeInlineHistoryAsset[];
  readonly references?: readonly NativeEvidenceReference[];
  readonly localImageCandidates?: readonly NativeHistoricalImageCandidate[];
};

export interface NativeContinuitySources {
  readonly checkpointPreparationPolicy?: CheckpointPreparationPolicy;
  /** Public indexed history with explicit unread originals, independent of UI compaction markers. */
  readonly visiblePrefix?: {
    readonly read: (threadId: string, turnId: string, signal?: AbortSignal, bodyBudgetBytes?: number) => Promise<NativeVisibleHistorySnapshot>;
    readonly accountNamespace: string;
    readonly journal: NativeVisiblePrefixStageJournal;
  };
  readonly compactionHistory?: (threadId: string, turnId: string) => Promise<NativeHistorySource>;
  readonly compactionAnchor?: (threadId: string, turnId: string, signal?: AbortSignal) =>
    Promise<NativeReadableHistoryAnchor>;
  readonly historyCheckpointCache?: ContextCheckpointCache;
  readonly checkpointProducer?: NativeRequestCheckpointProducer;
}

/** This is provider-facing context provenance, NOT Native task/permission authority. */
export type NativeContinuityMode =
  | "current-input" | "retained" | "readable-checkpoint"
  | "bounded-source" | "produced-checkpoint"
  | "visible-prefix";

export interface NativeContinuityDecision {
  readonly mode: NativeContinuityMode;
  readonly visibleHistory?: string;
  readonly inlineHistoryAssets: readonly NativeInlineHistoryAsset[];
  readonly historyReferences?: readonly NativeEvidenceReference[];
  readonly checkpointReused: boolean;
  readonly checkpointProduced: boolean;
}

export type NativeRetainedHistory = Pick<NativeContinuityDecision,
  "inlineHistoryAssets" | "historyReferences"> & { readonly visibleHistory: string };

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
    ? input.map(record).filter(item => item?.type === "compaction"
      && decodeTelaCompactionSummary(item.encrypted_content) === undefined) : [];
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
    checkpointReused: mode === "retained" || mode === "readable-checkpoint",
    checkpointProduced: mode === "produced-checkpoint",
  });
}

/**
 * One cold/hot continuity decision for a Native-owned turn. The order is
 * deliberate: proven retained Web state, verified source checkpoint, then
 * indexed Native-visible history with explicit unread originals when readback exists. Unavailable
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
  /** Only set when this original Native owner exposes authenticated body readback. */
  readonly historyBodyBudgetBytes?: number;
  /** Validated by the caller against active retained lineage, route and Web epoch pressure. */
  readonly retainedHistory?: NativeRetainedHistory;
  readonly effort?: ChatGptWebEffort;
  readonly browserModel?: { readonly familyKey: string; readonly effort: ChatGptWebEffort };
  readonly options: NativeContinuitySources;
  readonly preparationBudget?: CheckpointPreparationBudget;
  readonly preparation?: Parameters<NativeRequestCheckpointProducer>[1];
}): Promise<NativeContinuityDecision> {
  const { threadId, currentTurnId, opaque, preparation } = input;
  const preparationBudget = input.preparationBudget ?? new CheckpointPreparationBudget(
    chatGptWebCheckpointSourceTokenLimit(input.effort ?? "medium"), input.options.checkpointPreparationPolicy);
  const options = { ...input.options, ...(input.options.checkpointProducer
    ? { checkpointProducer: preparationBudget.producer(input.options.checkpointProducer) } : {}) };
  const signal = preparation?.signal;
  const probe = async <T>(phase: "anchor" | "history" | "visible_prefix", read: () => Promise<T>): Promise<T> => {
    try {
      const result = await read();
      emitDiagnosticEvent("chatgpt_tela_codex", "native_context_source_probed", {
        phase, outcome: result === undefined ? "absent" : "available",
      });
      return result;
    }
    catch (error) {
      if (error instanceof NativeHistoryBootstrapRequired) {
        emitDiagnosticEvent("chatgpt_tela_codex", "native_context_source_rejected", {
          phase, reason_class: error.recoveryReason === "unindexed_history"
            ? "history_mode_unindexed" : "history_bootstrap_required",
        });
      } else {
        // A source probe can be optional; preserve its failed boundary without
        // turning it into a terminal task failure or retaining exception prose.
        emitDiagnosticEvent("chatgpt_tela_codex", "native_context_source_probe_failed", {
          phase, reason_class: classifyWebPreparationFailure(error),
        });
      }
      throw error;
    }
  };
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
  if (input.retainedHistory) return resolved("retained", input.retainedHistory.visibleHistory,
    input.retainedHistory.inlineHistoryAssets, input.retainedHistory.historyReferences);

  const cache = options.historyCheckpointCache;
  emitDiagnosticEvent("chatgpt_tela_codex", "native_context_recovery_sources", {
    cache_available: !!cache,
    visible_prefix_available: !!options.visiblePrefix,
    anchor_available: !!options.compactionAnchor, history_available: !!options.compactionHistory,
  });
  // The installed path uses this explicit source contract. A UI compaction
  // marker is not guaranteed to exist, so it cannot be the bootstrap authority.
  if (options.visiblePrefix) {
    const sourceAdapter = options.visiblePrefix;
    const source = await probe("visible_prefix", () => sourceAdapter.read(threadId, currentTurnId, signal, input.historyBodyBudgetBytes));
    if (source.threadId !== threadId || source.currentTurnId !== currentTurnId) {
      throw new Error("Native visible prefix belongs to a different current turn");
    }
    // Source acquisition is not a second compaction engine. The working planner
    // keeps complete recent turns, current work and an explicit unread-original
    // manifest. A partial archive is never promoted to a whole-history summary.
    return resolved("visible-prefix", source.content, source.inlineAssets, source.references);
  }

  let anchor: NativeReadableHistoryAnchor | undefined;
  let anchorLimit: NativeHistoryBootstrapRequired | undefined;
  if (options.compactionAnchor && cache) {
    try { anchor = await probe("anchor", () => options.compactionAnchor!(threadId, currentTurnId, signal)); }
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
  if (anchorLimit) throw anchorLimit;
  if (!options.compactionHistory) {
    // A verified readable checkpoint needs no replay provider.
    // Without either, opaque Native state is not model-visible text.
    throw new NativeHistoryBootstrapRequired();
  }

  let history: NativeHistorySource;
  try { history = await probe("history", () => options.compactionHistory!(threadId, currentTurnId)); }
  catch (error) {
    if (!(error instanceof NativeHistoryBootstrapRequired)) throw error;
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
  // provider-side trimming; return the ordinary typed recovery requirement.
  if (input.effort
    && Math.ceil(Buffer.byteLength(history.content, "utf8") / 4)
      > chatGptWebCheckpointSourceTokenLimit(input.effort)) {
    emitDiagnosticEvent("chatgpt_tela_codex", "native_context_source_rejected", {
      phase: "history_budget", reason_class: "source_exceeds_web_budget",
      source_estimate: Math.ceil(Buffer.byteLength(history.content, "utf8") / 4),
      input_budget: chatGptWebCheckpointSourceTokenLimit(input.effort),
    });
    throw new NativeHistoryBootstrapRequired();
  }
  return resolved("bounded-source", history.content,
    history.inlineAssets ?? [], history.references);
}
