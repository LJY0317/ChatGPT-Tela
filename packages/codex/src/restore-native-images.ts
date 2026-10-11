import { defineNativeTurnAuthority, emitDiagnosticEvent, type NativeTurnAuthority } from "@chatgpt-tela/core";
import {
  bindResolvedNativeHistoryImages,
  type NativeCompactionHistoryProjection,
} from "./compaction-history";
import { resolveNativeHistoricalImages } from "./local-image-resolver";

/**
 * One optional recovery adapter for both ordinary turns and Native local compaction.
 * Source history is already bound to the exact active thread/turn before entering here.
 */
export async function restoreNativeHistoricalImages(
  source: NativeCompactionHistoryProjection,
  authority: NativeTurnAuthority,
  signal?: AbortSignal,
): Promise<NativeCompactionHistoryProjection> {
  signal?.throwIfAborted();
  if (source.threadId !== authority.threadId || source.currentTurnId !== authority.turnId) {
    throw new Error("Native historical media source belongs to another current turn");
  }
  const candidates = source.localImageCandidates ?? [];
  if (candidates.length === 0) return source;
  const priorFiles = new Set(source.inlineAssets.map(asset => `${asset.mimeType}:${asset.evidence.sha256}`));
  const freeSlots = 8 - priorFiles.size;
  if (freeSlots <= 0) return source;
  const result = await resolveNativeHistoricalImages({
    authority, candidates, maxUniqueFiles: freeSlots, ...(signal ? { signal } : {}),
  });
  signal?.throwIfAborted();
  const restored = bindResolvedNativeHistoryImages(source, result.assets);
  const counts = Object.fromEntries(
    [...new Set(result.unavailable.map(item => item.reason))]
      .map(reason => [reason, result.unavailable.filter(item => item.reason === reason).length]),
  );
  emitDiagnosticEvent("chatgpt_tela_work", "native_media_resolution", {
    candidate_count: candidates.length,
    resolved_count: result.assets.length,
    unique_file_count: result.uniqueFiles,
    unique_bytes: result.uniqueBytes,
    reason_counts: JSON.stringify(counts),
  });
  return restored;
}

export function historicalTurnAuthority(evidence: {
  readonly threadId: string;
  readonly turnId: string;
  readonly cwd: string;
  readonly workspaceRoots: readonly string[];
  readonly sandbox: NativeTurnAuthority["sandbox"];
}): NativeTurnAuthority {
  return defineNativeTurnAuthority(evidence);
}
