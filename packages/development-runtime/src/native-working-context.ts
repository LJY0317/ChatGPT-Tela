import { createHash } from "node:crypto";
import {
  chatGptCheckpointInputTokens, chatGptCheckpointPolicyFingerprint,
  type ChatGptWebEffort, type WebPhysicalContext,
} from "@chatgpt-tela/chatgpt";
import { NativeHistoryBootstrapRequired } from "@chatgpt-tela/codex";
import { emitDiagnosticEvent, planPhysicalContext } from "@chatgpt-tela/core";
import { derivedContextCheckpoint, type CachedContextCheckpoint, type ContextCheckpointCache } from "./context-cache";
import type { CheckpointPreparationBudget } from "./checkpoint-preparation-budget";
import type {
  NativeRequestCheckpointProducer, NativeRequestContextProjection, ProjectedNativeRevision,
} from "./native-request-planner";
import {
  produceNativePrefixCheckpoint, type NativeRequestPrefixSnapshot,
  type NativeVisiblePrefixStageJournal,
} from "./native-visible-prefix-checkpoint";
import type { WebWorkingContextPolicy } from "./web-working-context-policy";

function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function tokens(value: string): number { return Math.ceil(Buffer.byteLength(value, "utf8") / 4); }

/** Exact source identity excludes changing Native turn/correlation metadata. */
export function nativeRequestPrefixSnapshot(threadId: string, currentTurnId: string,
  physicalContext: WebPhysicalContext): NativeRequestPrefixSnapshot {
  const content = JSON.stringify({ type: "tela_native_request_prefix_v1", items: physicalContext.segments });
  const digest = sha(content);
  return Object.freeze({ kind: "native-request-prefix", threadId, currentTurnId,
    digest, contentDigest: digest, content, sourceItemCount: physicalContext.segments.length,
    inlineAssets: [], references: physicalContext.segments.flatMap(segment =>
      segment.type === "revision" ? segment.evidence ?? [] : []), localImageCandidates: [] });
}

/** A maintained checkpoint is only compatible with its account, Native task, Web route and policy. */
export function nativeWorkingCheckpointScope(account: string, taskId: string,
  model: { readonly familyKey: string; readonly effort: ChatGptWebEffort }): string {
  if (!account.trim() || !taskId.trim() || !model.familyKey.trim()) throw Error("Invalid Web checkpoint scope");
  return sha(JSON.stringify([account, taskId, model.familyKey, model.effort, chatGptCheckpointPolicyFingerprint()]));
}

/** Never seal the most recent user request or its tool/assistant chain. */
export function workingCheckpointAnchor(projection: NativeRequestContextProjection): ProjectedNativeRevision | undefined {
  let latestUser = -1;
  for (let index = projection.revisions.length - 1; index >= 0; index--) {
    if (projection.revisions[index]!.revision.kind === "user") { latestUser = index; break; }
  }
  const boundary = latestUser >= 0 ? latestUser : projection.revisions.length - 1;
  return boundary > 0 ? projection.revisions[boundary - 1] : undefined;
}

/** Preserve current higher-priority Native instructions verbatim outside lossy historical prose. */
export function exactCurrentInstructions(projection: NativeRequestContextProjection): WebPhysicalContext["segments"] {
  return Object.freeze(projection.revisions.filter(item =>
    item.revision.kind === "system" || item.revision.kind === "developer")
    .map(item => Object.freeze({ type: "revision" as const, revisionId: item.revision.id,
      kind: item.revision.kind, content: item.content })));
}

export function withExactCurrentInstructions(context: WebPhysicalContext,
  projection: NativeRequestContextProjection): WebPhysicalContext {
  if (context.mode !== "checkpoint-delta") return context;
  // A checkpoint may precede a later system/developer revision. The physical
  // suffix already includes that *same* exact revision, so injecting it again
  // duplicates authority and pays for the same instruction twice. Do not
  // deduplicate by matching prose: two distinct Native revisions remain two
  // independent instructions even when their text is identical.
  const included = new Map<string, { readonly kind: string; readonly content: string }>();
  for (const segment of context.segments) {
    if (segment.type === "revision") {
      included.set(segment.revisionId, segment);
    }
  }
  const instructions = exactCurrentInstructions(projection).filter(item => {
    if (item.type !== "revision") throw new Error("Exact Native instruction is not a revision");
    const present = included.get(item.revisionId);
    if (!present) return true;
    if (present.kind !== item.kind || present.content !== item.content) {
      throw new Error("Web checkpoint suffix conflicts with exact Native instruction ownership");
    }
    return false;
  });
  if (!instructions.length) return context;
  return Object.freeze({ ...context,
    transferTokens: context.transferTokens + instructions.reduce((n, item) => n + tokens(item.content), 0),
    segments: Object.freeze([...instructions, ...context.segments]),
  });
}

/** Compaction and task transport use the same selected working set, not the full archive. */
export function nativeWorkingPhysicalContext(projection: NativeRequestContextProjection,
  selected?: CachedContextCheckpoint): WebPhysicalContext {
  const index = selected
    ? projection.revisions.findIndex(item => item.revision.id === selected.checkpoint.revisionId)
    : -1;
  if (selected && index < 0) throw Error("Web checkpoint is not on the current Native branch");
  const suffix = projection.revisions.slice(index + 1);
  const segments: WebPhysicalContext["segments"] = Object.freeze([
    ...(selected ? exactCurrentInstructions(projection) : []),
    ...(selected ? [{ type: "checkpoint" as const, checkpointId: selected.checkpoint.id,
      sourceRevisionId: selected.checkpoint.revisionId, content: selected.content }] : []),
    ...suffix.map(item => Object.freeze({ type: "revision" as const,
      revisionId: item.revision.id, kind: item.revision.kind, content: item.content })),
  ]);
  const transferTokens = segments.reduce((sum, item) => sum + tokens(item.content), 0);
  return Object.freeze({
    // A summarizer requires a complete source *working bundle* in one operation.
    // Its embedded checkpoint is explicitly lossy; this is not whole-archive coverage.
    mode: "full",
    headRevisionId: projection.headId, activeRequestRevisionId: projection.headId,
    logicalTokens: projection.revisions.reduce((sum, item) => sum + item.revision.estimatedTokens, 0),
    transferTokens, segments,
  });
}

export interface WorkingCheckpointSources {
  readonly cache?: ContextCheckpointCache;
  readonly visiblePrefix?: { readonly accountNamespace: string; readonly journal: NativeVisiblePrefixStageJournal };
  readonly producer?: NativeRequestCheckpointProducer;
  readonly browserModel?: { readonly familyKey: string; readonly effort: ChatGptWebEffort };
  readonly policy: WebWorkingContextPolicy;
  readonly preparationBudget: CheckpointPreparationBudget;
}

export interface WorkingCheckpointDecision {
  readonly checkpoint?: CachedContextCheckpoint;
  readonly produced: boolean;
  readonly reused: boolean;
  readonly pendingSuffixTokens: number;
}

/**
 * One on-demand working-set selection for both ordinary requests and Native compaction.
 * Complete original history is never the recurring maintenance input: the old summary
 * and only its sealed canonical successor form the next source. Cache loss rehydrates
 * already-published checkpoints from the SAME durable stage journal, without inference.
 */
export async function selectNativeWorkingCheckpoint(input: WorkingCheckpointSources & {
  readonly projection: NativeRequestContextProjection;
  readonly currentTurnId: string;
  readonly signal?: AbortSignal;
  readonly preparation?: Parameters<NativeRequestCheckpointProducer>[1];
  readonly forceMaintenance?: boolean;
  /** Native compaction already owns one summary operation; select maintained state without producing another. */
  readonly allowMaintenance?: boolean;
}): Promise<WorkingCheckpointDecision> {
  const { projection } = input;
  const anchor = workingCheckpointAnchor(projection);
  const anchorIndex = anchor ? projection.revisions.findIndex(item => item.revision.id === anchor.revision.id) : -1;
  const scope = input.visiblePrefix && input.browserModel
    ? nativeWorkingCheckpointScope(input.visiblePrefix.accountNamespace, projection.nativeTaskId, input.browserModel)
    : undefined;
  const candidates: CachedContextCheckpoint[] = [];
  if (input.cache) {
    try { candidates.push(...await input.cache.list(projection.nativeTaskId)); }
    catch { /* Derived cache loss is not authority loss. */ }
  }
  if (scope && input.visiblePrefix?.journal.publishedCheckpoints) {
    for (const item of await input.visiblePrefix.journal.publishedCheckpoints(scope)) {
      candidates.push(derivedContextCheckpoint({
        revisionId: item.revisionId, content: item.content, estimatedTokens: item.estimatedTokens,
        scopeFingerprint: scope,
      }));
    }
  }
  const active = new Map(projection.revisions.map((item, index) => [item.revision.id, index]));
  let selected: CachedContextCheckpoint | undefined;
  let selectedIndex = -1;
  for (const candidate of candidates) {
    if (scope ? candidate.scopeFingerprint !== scope : candidate.scopeFingerprint !== undefined) continue;
    const index = active.get(candidate.checkpoint.revisionId) ?? -1;
    if (index < 0 || index > anchorIndex || index < selectedIndex) continue;
    // A checkpoint is usable only when its canonical ancestor is still on the active path.
    const plan = planPhysicalContext({ lineage: projection.lineage, headId: projection.headId,
      checkpoint: candidate.checkpoint });
    if (plan.status !== "ready" || plan.mode !== "checkpoint-delta") continue;
    selected = candidate; selectedIndex = index;
  }
  const pendingSuffixTokens = projection.revisions.slice(selectedIndex + 1)
    .reduce((sum, item) => sum + item.revision.estimatedTokens, 0);
  const sealedTokens = anchorIndex < 0 ? 0 : projection.revisions.slice(selectedIndex + 1, anchorIndex + 1)
    .reduce((sum, item) => sum + item.revision.estimatedTokens, 0);
  const activeTokens = projection.revisions.slice(anchorIndex + 1)
    .reduce((sum, item) => sum + item.revision.estimatedTokens, 0);
  const summaryTokens = selected?.checkpoint.estimatedTokens ?? 0;
  const currentInstructionsTokens = exactCurrentInstructions(projection)
    .reduce((sum, item) => sum + tokens(item.content), 0);
  const prospectiveSeed = summaryTokens + pendingSuffixTokens + (selected ? currentInstructionsTokens : 0);
  const shouldAdvance = anchorIndex >= 0 && (
    sealedTokens > input.policy.suffixTargetTokens
    || (!selected && prospectiveSeed > input.policy.firstMessageTargetTokens)
    || (input.forceMaintenance === true && sealedTokens > 0
      && prospectiveSeed > input.policy.firstMessageTargetTokens)
  );
  if (!shouldAdvance || input.allowMaintenance === false
    || !input.cache || !input.producer || !input.visiblePrefix || !input.browserModel) {
    return Object.freeze({ ...(selected ? { checkpoint: selected } : {}),
      produced: false, reused: selected !== undefined, pendingSuffixTokens });
  }
  // Instructions are currently authoritative, not a sealed task summary. Summarizing
  // them just to satisfy a fresh soft target would silently remove priority semantics.
  if (projection.revisions.slice(selectedIndex + 1, anchorIndex + 1)
    .every(item => item.revision.kind === "system" || item.revision.kind === "developer")) {
    return Object.freeze({ ...(selected ? { checkpoint: selected } : {}),
      produced: false, reused: selected !== undefined, pendingSuffixTokens });
  }
  const sealed = projection.revisions.slice(selectedIndex + 1, anchorIndex + 1);
  // Inline media is not presently supported in durable fragment summaries. Never
  // replace it with a textual hint and claim original evidence was carried over.
  if (projection.media.some(item => sealed.some(entry => entry.revision.id === item.revisionId))) {
    throw new NativeHistoryBootstrapRequired("source_budget");
  }
  const segments: WebPhysicalContext["segments"] = Object.freeze([
    ...(selected ? [{ type: "checkpoint" as const, checkpointId: selected.checkpoint.id,
      sourceRevisionId: selected.checkpoint.revisionId, content: selected.content }] : []),
    ...sealed.map(item => Object.freeze({
      type: "revision" as const, revisionId: item.revision.id, kind: item.revision.kind,
      content: item.content, ...(item.evidence?.length ? { evidence: item.evidence } : {}),
    })),
  ]);
  const physical: WebPhysicalContext = Object.freeze({
    mode: "full", headRevisionId: anchor!.revision.id, activeRequestRevisionId: anchor!.revision.id,
    logicalTokens: sealedTokens + summaryTokens, transferTokens: sealedTokens + summaryTokens, segments,
  });
  const source = nativeRequestPrefixSnapshot(projection.nativeTaskId, input.currentTurnId, physical);
  // The steady-state maintenance operation is ONE fitted summary input. A large
  // previously unmaintained/cold source follows the existing explicit recovery path.
  if (chatGptCheckpointInputTokens(physical) > input.policy.checkpointSourceTokens) {
    if (selected) throw new NativeHistoryBootstrapRequired("source_budget");
    return Object.freeze({ produced: false, reused: false, pendingSuffixTokens });
  }
  input.signal?.throwIfAborted();
  const previousCalls = input.preparationBudget.modelCalls;
  const content = await produceNativePrefixCheckpoint({
    source, accountNamespace: input.visiblePrefix.accountNamespace,
    journal: input.visiblePrefix.journal, producer: input.producer,
    browserModel: input.browserModel, effort: input.browserModel.effort,
    preparationBudget: input.preparationBudget,
    confirmSource: async () => { input.signal?.throwIfAborted(); return source; },
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.preparation ? { preparation: input.preparation } : {}),
  });
  input.signal?.throwIfAborted();
  if (tokens(content) > input.policy.checkpointTargetTokens + 256) {
    // A provider-generated summary cannot silently expand the rolling working set.
    throw new NativeHistoryBootstrapRequired("source_budget");
  }
  const parsed = JSON.parse(content) as Record<string, unknown>;
  const published = {
    scopeFingerprint: scope!, revisionId: anchor!.revision.id,
    sourceRootDigest: source.digest, stageKey: parsed.completedStageKey as string,
    content, estimatedTokens: tokens(content),
  };
  // The stage journal already contains a completed summary. Atomically publish its
  // matching source-bound pointer BEFORE updating the disposable cache.
  if (input.visiblePrefix.journal.publishCheckpoint) {
    await input.visiblePrefix.journal.publishCheckpoint(published);
  }
  const checkpoint = derivedContextCheckpoint({
    revisionId: published.revisionId, content, estimatedTokens: published.estimatedTokens,
    ...(scope ? { scopeFingerprint: scope } : {}),
  });
  try {
    await input.cache.put({ nativeTaskId: projection.nativeTaskId,
      revisionId: published.revisionId, content, estimatedTokens: published.estimatedTokens,
      ...(scope ? { scopeFingerprint: scope } : {}) });
  } catch {
    if (!input.visiblePrefix.journal.publishCheckpoint) throw Error("Web checkpoint cache could not publish its completed summary");
  }
  emitDiagnosticEvent("chatgpt_tela_codex", "native_working_checkpoint_advanced", {
    summary_estimate: published.estimatedTokens, sealed_suffix_estimate: sealedTokens,
    newly_invoked_stages: input.preparationBudget.modelCalls - previousCalls,
    completed_reuse: previousCalls === input.preparationBudget.modelCalls,
  });
  return Object.freeze({ checkpoint,
    produced: input.preparationBudget.modelCalls > previousCalls,
    reused: input.preparationBudget.modelCalls === previousCalls,
    pendingSuffixTokens: activeTokens });
}
