import { createHash } from "node:crypto";
import {
  type NativeCompactionHistoryProjection,
  type NativeReadableHistoryAnchor,
} from "@chatgpt-tela/codex";
import {
  webEvidenceFilename,
  type ChatGptWebEffort, type WebPhysicalContext, type WebTurnMedia,
} from "@chatgpt-tela/chatgpt";
import type { ContextCheckpointCache } from "./context-cache";
import type { NativeRequestCheckpointProducer } from "./native-request-planner";
import { boundedWebCheckpointSource } from "./web-checkpoint-source";

const HISTORY_CHECKPOINT_TYPE = "tela_native_readable_history_checkpoint_v1";
const MAX_SUMMARY_BYTES = 32 * 1024;
const MIN_SOURCE_TOKENS = 24_000;

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
function tokens(content: string): number {
  return Math.ceil(Buffer.byteLength(content, "utf8") / 4);
}
function markerRevisionId(anchor: NativeReadableHistoryAnchor): string {
  const { threadId, compactionTurnId, compactionItemId } = anchor;
  if (![threadId, compactionTurnId, compactionItemId]
    .every(item => typeof item === "string" && item.length > 0 && item.length <= 512)) {
    throw new Error("Native history checkpoint anchor is invalid");
  }
  return "native_visible_history_v1_" + digest(JSON.stringify([
    threadId, compactionTurnId, compactionItemId,
  ]));
}

/**
 * The persistent checkpoint contains a verified *model-derived summary*, not
 * an authoritative transcript or a grant to read historical evidence.
 * Use the existing integrity-checked per-task cache; caller must additionally
 * scope it to a proven Web account before any reads or writes.
 */
export async function readNativeHistoryCheckpoint(
  cache: ContextCheckpointCache, anchor: NativeReadableHistoryAnchor,
): Promise<string | undefined> {
  const key = markerRevisionId(anchor);
  const candidates = await cache.list(anchor.threadId);
  for (const stored of [...candidates].reverse()) {
    if (stored.checkpoint.revisionId !== key) continue;
    let data: unknown;
    try { data = JSON.parse(stored.content); } catch { continue; }
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    const value = data as Record<string, unknown>;
    if (value.type !== HISTORY_CHECKPOINT_TYPE || value.sourceAnchor !== key
      || value.coverage !== "original-visible-prefix-before-native-compaction"
      || value.evidence !== "summary-only-requires-native-readback"
      || typeof value.sourceDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceDigest)
      || typeof value.summary !== "string" || !value.summary.trim()
      || Buffer.byteLength(value.summary, "utf8") > MAX_SUMMARY_BYTES
      || stored.checkpoint.estimatedTokens !== tokens(stored.content)) continue;
    return stored.content;
  }
  return undefined;
}

/**
 * Proactively create one checkpoint when the first complete source fits a
 * bounded tool-free Web model call and is large enough to merit caching.
 * The producer authenticates the exact source envelope; Native marker must
 * be observed again before the checkpoint can be committed.
 */
export async function maybeProduceNativeHistoryCheckpoint(input: {
  readonly anchor: NativeReadableHistoryAnchor;
  readonly history: NativeCompactionHistoryProjection;
  readonly cache: ContextCheckpointCache;
  readonly producer: NativeRequestCheckpointProducer;
  readonly effort: ChatGptWebEffort;
  readonly confirmAnchor: () => Promise<NativeReadableHistoryAnchor>;
  readonly signal?: AbortSignal;
  readonly preparation?: Parameters<NativeRequestCheckpointProducer>[1];
}): Promise<string | undefined> {
  const { anchor, history } = input;
  if (history.threadId !== anchor.threadId || history.currentTurnId !== anchor.currentTurnId
    || history.compactionItemId !== anchor.compactionItemId
    || history.compactionTurnId !== anchor.compactionTurnId) {
    throw new Error("Native history source does not match proven compaction anchor");
  }
  const source = JSON.parse(history.content) as Record<string, unknown>;
  if (!source || source.type !== "tela_native_visible_history_v1"
    || source.compactionItemId !== anchor.compactionItemId || !Array.isArray(source.items)) {
    throw new Error("Native history checkpoint requires an exact visible source");
  }
  const count = tokens(history.content);
  if (count < MIN_SOURCE_TOKENS) return undefined;
  const sourceRevisionId = "native_visible_source_" + digest(history.content);
  const media: WebTurnMedia[] = (history.inlineAssets ?? []).map(asset => Object.freeze({
    revisionId: sourceRevisionId,
    evidence: asset.evidence,
    file: Object.freeze({
      name: webEvidenceFilename(asset.evidence.sha256 ?? "", asset.mimeType),
      mimeType: asset.mimeType, bytes: asset.bytes,
    }),
  }));
  const physicalContext: WebPhysicalContext = Object.freeze({
    mode: "full" as const,
    headRevisionId: sourceRevisionId,
    activeRequestRevisionId: sourceRevisionId,
    logicalTokens: count, transferTokens: count,
    segments: Object.freeze([Object.freeze({
      type: "revision" as const, kind: "assistant" as const,
      revisionId: sourceRevisionId, content: history.content,
      ...(history.references?.length ? { evidence: history.references } : {}),
    })]),
  });
  const bounded = boundedWebCheckpointSource(physicalContext, media, input.effort);
  if (!bounded) return undefined;
  input.signal?.throwIfAborted();
  const produced = await input.producer(Object.freeze({
    nativeTaskId: anchor.threadId, sourceRevisionId,
    physicalContext: bounded,
    ...(media.length ? { media } : {}),
  }), input.preparation);
  input.signal?.throwIfAborted();
  if (produced.nativeTaskId !== anchor.threadId
    || produced.sourceRevisionId !== sourceRevisionId
    || typeof produced.content !== "string" || !produced.content.trim()
    || Buffer.byteLength(produced.content.trim(), "utf8") > MAX_SUMMARY_BYTES) {
    throw new Error("Native history checkpoint producer returned unbound or oversized content");
  }
  const confirmed = await input.confirmAnchor();
  input.signal?.throwIfAborted();
  if (markerRevisionId(confirmed) !== markerRevisionId(anchor)
    || confirmed.currentTurnId !== anchor.currentTurnId) {
    throw new Error("Native history compaction marker changed during checkpoint production");
  }
  const content = JSON.stringify({
    type: HISTORY_CHECKPOINT_TYPE,
    sourceAnchor: markerRevisionId(anchor),
    sourceDigest: digest(history.content),
    coverage: "original-visible-prefix-before-native-compaction",
    evidence: "summary-only-requires-native-readback",
    semantics: "This is a lossy, derived Web transport summary of visible Native history, not the Native encrypted compaction state or proof of individual historical facts. Past tool calls must never be reexecuted from this summary. Verify original Native evidence through an authorized public source before consequential actions.",
    summary: produced.content.trim(),
  });
  const stored = await input.cache.put({
    nativeTaskId: anchor.threadId, revisionId: markerRevisionId(anchor),
    content, estimatedTokens: tokens(content),
  });
  if (stored.content !== content || stored.checkpoint.revisionId !== markerRevisionId(anchor)) {
    throw new Error("Native history checkpoint cache failed to preserve its source binding");
  }
  return content;
}
