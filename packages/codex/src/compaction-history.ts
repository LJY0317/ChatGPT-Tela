import { createHash } from "node:crypto";
import {
  decodeNativeInlineEvidence, nativeEmbeddedResourceDataUrl, nativeSerializedMcpResourcePart,
  nativeToolPartIsEncrypted, nativeEvidenceRef,
  emitDiagnosticEvent,
  type NativeEvidenceKind, type NativeEvidenceReference, type NativeInlineHistoryAsset,
} from "@chatgpt-tela/core";
import { connectCodexAppServerWebSocket, type CodexAppServerRpcFactory } from "./app-server";
import { NativeHistoryBootstrapRequired } from "./history-bootstrap-error";
export { NativeHistoryBootstrapRequired } from "./history-bootstrap-error";

export interface NativeCompactionHistoryProjection {
  readonly threadId: string;
  readonly currentTurnId: string;
  readonly compactionItemId: string;
  readonly compactionTurnId?: string;
  readonly content: string;
  readonly inlineAssets: readonly NativeInlineHistoryAsset[];
  /** Public Native references, including unavailable content, in exact checkpoint order. */
  readonly references: readonly NativeEvidenceReference[];
  /** Ephemeral paths from the exact public snapshot, not file access grants or Web context. */
  readonly localImageCandidates: readonly NativeHistoricalImageCandidate[];
}

/** Exact public Native marker, not the encrypted content of the compaction. */
export interface NativeReadableHistoryAnchor {
  readonly threadId: string;
  readonly currentTurnId: string;
  readonly compactionTurnId: string;
  readonly compactionItemId: string;
}

/** Complete public visible prefix, never an opaque Native compaction replacement. */
export interface NativeVisiblePrefixSnapshot {
  readonly kind: "native-visible-prefix";
  readonly threadId: string;
  readonly currentTurnId: string;
  /** Canonical source and owner identity; distinct from exact transport bytes. */
  readonly digest: string;
  readonly contentDigest: string;
  readonly sourceItemCount: number;
  readonly content: string;
  readonly inlineAssets: readonly NativeInlineHistoryAsset[];
  readonly references: readonly NativeEvidenceReference[];
  readonly localImageCandidates: readonly NativeHistoricalImageCandidate[];
}

export interface NativeHistoricalImageCandidate {
  readonly threadId: string;
  readonly currentTurnId: string;
  readonly sourceTurnId: string;
  readonly itemId: string;
  readonly partIndex: number;
  readonly evidenceId: string;
  readonly path: string;
}

/**
 * Upgrade metadata for proven local bytes without changing historical part identity.
 * Only paths returned by the same authenticated Native snapshot can be upgraded.
 */
export function bindResolvedNativeHistoryImages(
  history: NativeCompactionHistoryProjection,
  resolved: readonly NativeInlineHistoryAsset[],
): NativeCompactionHistoryProjection {
  if (!resolved.length) return history;
  const candidates = new Set(history.localImageCandidates.map(item => item.evidenceId));
  const replacements = new Map<string, NativeEvidenceReference>();
  for (const asset of resolved) {
    const ref = asset.evidence;
    if (!candidates.has(ref.id) || replacements.has(ref.id) || ref.kind !== "image"
      || ref.origin !== "historical-user" || ref.source !== "native_thread_read"
      || ref.availability !== "verified_inline_bytes" || ref.bytes !== asset.bytes.byteLength) {
      throw new Error("Resolved Native media belongs to another history source");
    }
    replacements.set(ref.id, ref);
  }
  const found = new Set<string>();
  const upgrade = (raw: unknown): unknown => {
    if (Array.isArray(raw)) return raw.map(upgrade);
    const value = record(raw);
    if (!value) return raw;
    if (value.type === "nativeEvidenceReference" && typeof value.id === "string") {
      const replacement = replacements.get(value.id);
      if (replacement) {
        if (found.has(value.id) || value.availability !== "unavailable"
          || value.kind !== "image" || value.origin !== "historical-user") {
          throw new Error("Resolved Native media reference is duplicated or already available");
        }
        found.add(value.id);
        return replacement;
      }
      return value;
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, upgrade(entry)]));
  };
  const updated = upgrade(JSON.parse(history.content));
  if (found.size !== replacements.size) throw new Error("Resolved Native media has no historical reference");
  return Object.freeze({
    ...history, content: JSON.stringify(updated),
    references: Object.freeze(history.references.map(ref => replacements.get(ref.id) ?? ref)),
    inlineAssets: Object.freeze([...history.inlineAssets, ...resolved]),
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

const READABLE_ITEM_TYPES = new Set([
  "userMessage", "agentMessage", "commandExecution", "fileChange", "mcpToolCall",
  "dynamicToolCall", "collabAgentToolCall", "webSearch", "plan", "enteredReviewMode", "exitedReviewMode",
  "functionCallOutput", "imageView", "imageGeneration", "hookPrompt", "sleep", "subAgentActivity", "contextCompaction",
]);

/**
 * Public thread/read describes media, but a path/URL/fileId is NOT permission to read it
 * or proof that its contents reached Web. Preserve ordered references without putting those
 * locations or encoded bytes in the portable visible transcript.
 */
function assetMarker(
  threadId: string, turnId: string, itemId: string, part: string,
  kind: NativeEvidenceKind, origin: "historical-user" | "tool-result",
) {
  return nativeEvidenceRef({
    threadId, itemKey: `${turnId}:${itemId}`, partKey: part,
    kind, origin, source: "native_thread_read",
  });
}

const HISTORY_INLINE_UPLOAD_COUNT = 8;
const HISTORY_INLINE_UPLOAD_BYTES = 24 * 1024 * 1024;
const HISTORY_INLINE_REFERENCE_COUNT = 128;
function selectionKey(turnId: string, itemId: string, part: string): string {
  return JSON.stringify([turnId, itemId, part]);
}

/**
 * Use only inline bytes already returned by the authenticated public thread/read snapshot.
 * Newest historical evidence is preferred under the bounded upload budget. Local paths,
 * remote URLs and opaque file IDs never imply a filesystem or network retrieval right.
 */
function selectInlineHistory(
  entries: readonly { readonly turnId: string; readonly item: Record<string, unknown> }[],
  threadId: string,
): { readonly selected: ReadonlyMap<string, NativeEvidenceReference>; readonly assets: readonly NativeInlineHistoryAsset[] } {
  const selected = new Map<string, NativeEvidenceReference>();
  const assets: NativeInlineHistoryAsset[] = [];
  const unique = new Map<string, { readonly mimeType: string; readonly bytes: Uint8Array }>();
  let totalBytes = 0;
  const consider = (
    turnId: string, itemId: string, part: string, kind: "image" | "file",
    origin: "historical-user" | "tool-result", data: unknown,
  ): void => {
    if (assets.length >= HISTORY_INLINE_REFERENCE_COUNT || typeof data !== "string" || !data.startsWith("data:")) return;
    try {
      const decoded = decodeNativeInlineEvidence(data);
      if ((kind === "image") !== decoded.mimeType.startsWith("image/")) return;
      const uniqueKey = `${decoded.mimeType}:${decoded.sha256}`;
      const existing = unique.get(uniqueKey);
      if (!existing && (unique.size >= HISTORY_INLINE_UPLOAD_COUNT
        || totalBytes + decoded.bytes.byteLength > HISTORY_INLINE_UPLOAD_BYTES)) return;
      const evidence = nativeEvidenceRef({
        threadId, itemKey: `${turnId}:${itemId}`, partKey: part,
        kind, origin, source: "native_thread_read",
        sha256: decoded.sha256, bytes: decoded.bytes.byteLength,
      });
      const key = selectionKey(turnId, itemId, part);
      selected.set(key, evidence);
      if (!existing) {
        unique.set(uniqueKey, { mimeType: decoded.mimeType, bytes: decoded.bytes });
        totalBytes += decoded.bytes.byteLength;
      }
      assets.push(Object.freeze({ evidence, mimeType: decoded.mimeType, bytes: existing?.bytes ?? decoded.bytes }));
    } catch {
      // Invalid or unsupported inline history is visibly unavailable; it is not silently uploaded.
    }
  };
  const toolVisit = (
    raw: unknown, turnId: string, itemId: string, part: string, depth: number,
  ): void => {
    if (depth > 24 || assets.length >= HISTORY_INLINE_REFERENCE_COUNT) return;
    if (Array.isArray(raw)) {
      for (let i = raw.length - 1; i >= 0; i--) toolVisit(raw[i], turnId, itemId, `${part}.${i}`, depth + 1);
      return;
    }
    const value = record(raw);
    if (!value) return;
    const type = value.type;
    if ((type === "input_text" || type === "text") && typeof value.text === "string") {
      const serialized = nativeSerializedMcpResourcePart(value.text);
      if (serialized) {
        consider(turnId, itemId, part, "file", "tool-result",
          nativeEmbeddedResourceDataUrl(serialized));
        return;
      }
    }
    if (nativeToolPartIsEncrypted(value)) return;
    if (type === "resource") {
      consider(turnId, itemId, part, "file", "tool-result", nativeEmbeddedResourceDataUrl(value));
      return;
    }
    if (type === "inputImage" || type === "input_image" || type === "image") {
      consider(turnId, itemId, part, "image", "tool-result",
        value.imageUrl ?? value.image_url ?? value.url
        ?? (typeof value.data === "string" && typeof value.mimeType === "string"
          ? `data:${value.mimeType};base64,${value.data}` : undefined));
      return;
    }
    if (type === "file" || type === "inputFile" || type === "input_file") {
      consider(turnId, itemId, part, "file", "tool-result",
        value.fileData ?? value.file_data
        ?? (typeof value.data === "string" && typeof value.mimeType === "string"
          ? `data:${value.mimeType};base64,${value.data}` : undefined));
      return;
    }
    const values = Object.entries(value);
    for (let i = values.length - 1; i >= 0; i--) {
      const [key, entry] = values[i]!;
      toolVisit(entry, turnId, itemId, `${part}.${key}`, depth + 1);
    }
  };
  for (let i = entries.length - 1; i >= 0; i--) {
    const { turnId, item } = entries[i]!;
    if (item.type === "userMessage" && Array.isArray(item.content)) {
      for (let j = item.content.length - 1; j >= 0; j--) {
        const value = record(item.content[j]);
        if (value?.type === "image") consider(
          turnId, item.id as string, String(j), "image", "historical-user", value.url);
      }
    } else {
      toolVisit(item, turnId, item.id as string, "item", 0);
    }
  }
  return { selected, assets };
}

function userContent(
  content: unknown, threadId: string, turnId: string, itemId: string,
  selected: ReadonlyMap<string, NativeEvidenceReference>,
): readonly unknown[] {
  if (!Array.isArray(content)) throw new Error("Native compaction history has malformed user content");
  return content.map((raw, index) => {
    const value = record(raw);
    if (!value || typeof value.type !== "string") {
      return assetMarker(threadId, turnId, itemId, String(index), "unsupported", "historical-user");
    }
    if (value.type === "text") {
      if (typeof value.text !== "string") throw new Error("Native compaction history has malformed user text");
      return { type: "text", text: value.text };
    }
    const verified = selected.get(selectionKey(turnId, itemId, String(index)));
    if (verified) return verified;
    // Native UserInput currently has image/localImage/audio/localAudio/skill/mention. Unknown
    // future parts remain visibly unavailable rather than making the entire thread unusable.
    const kinds: Record<string, string> = {
      image: "image", localImage: "image", audio: "audio", localAudio: "audio",
      skill: "skill-reference", mention: "app-reference",
    };
    return assetMarker(threadId, turnId, itemId, String(index),
      (kinds[value.type] ?? "unsupported") as NativeEvidenceKind, "historical-user");
  });
}

function toolEvidence(
  raw: unknown, threadId: string, turnId: string, itemId: string, part = "item",
  depth = 0, selected: ReadonlyMap<string, NativeEvidenceReference> = new Map(),
): unknown {
  if (depth > 24) throw new Error("Native compaction history contains excessive evidence nesting");
  if (Array.isArray(raw)) {
    return raw.map((value, index) =>
      toolEvidence(value, threadId, turnId, itemId, `${part}.${index}`, depth + 1, selected));
  }
  const value = record(raw);
  if (!value) return raw;
  const type = value.type;
  if ((type === "input_text" || type === "text") && typeof value.text === "string") {
    const serialized = nativeSerializedMcpResourcePart(value.text);
    if (serialized) {
      return selected.get(selectionKey(turnId, itemId, part))
        ?? assetMarker(threadId, turnId, itemId, part, "file", "tool-result");
    }
  }
  if (nativeToolPartIsEncrypted(value)) {
    return assetMarker(threadId, turnId, itemId, part, "unsupported", "tool-result");
  }
  if (type === "inputImage" || type === "input_image" || type === "image"
    || type === "localImage" || type === "imageView" || type === "file"
    || type === "inputFile" || type === "input_file"
    || type === "audio" || type === "localAudio" || type === "input_audio"
    || type === "resource" || type === "resource_link" || type === "blob") {
    return selected.get(selectionKey(turnId, itemId, part)) ?? assetMarker(threadId, turnId, itemId, part,
      type === "audio" || type === "localAudio" || type === "input_audio" ? "audio"
        : type === "resource" || type === "resource_link" || type === "file"
          || type === "inputFile" || type === "input_file" || type === "blob" ? "file" : "image",
      "tool-result");
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key, toolEvidence(entry, threadId, turnId, itemId, `${part}.${key}`, depth + 1, selected),
  ]));
}

/** Stable digest independent of public JSON object member order. */
function canonicalDigestValue(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw.map(canonicalDigestValue);
  const value = record(raw);
  return value ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalDigestValue(value[key])])) : raw;
}

function sanitizeVisibleHistory(
  historical: readonly { readonly turnId: string; readonly item: Record<string, unknown> }[],
  threadId: string, currentTurnId: string,
) {
  const localImageCandidates: NativeHistoricalImageCandidate[] = [];
  for (const { turnId, item } of historical) {
    if (item.type !== "userMessage" || !Array.isArray(item.content)) continue;
    for (const [partIndex, raw] of item.content.entries()) {
      const value = record(raw);
      if (value?.type !== "localImage" || typeof value.path !== "string") continue;
      localImageCandidates.push(Object.freeze({
        threadId, currentTurnId, sourceTurnId: turnId,
        itemId: item.id as string, partIndex,
        evidenceId: assetMarker(threadId, turnId, item.id as string, String(partIndex), "image", "historical-user").id,
        path: value.path,
      }));
    }
  }
  const { selected, assets } = selectInlineHistory(historical, threadId);
  const visible = historical.map(({ turnId, item }) => {
    const visibleItem = item.type === "userMessage"
      ? { type: item.type, id: item.id, content: userContent(item.content, threadId, turnId, item.id as string, selected) }
      : item.type === "imageView"
        ? { type: item.type, id: item.id,
            evidence: assetMarker(threadId, turnId, item.id as string, "imageView", "image", "tool-result") }
        : READABLE_ITEM_TYPES.has(item.type as string)
          ? toolEvidence(item, threadId, turnId, item.id as string, "item", 0, selected)
          : { type: "unsupportedNativeEvidence", id: item.id, originalType: item.type,
              status: "not_transferred", origin: "tool-result" };
    return { turnId, item: visibleItem };
  });
  const references: NativeEvidenceReference[] = [];
  const collect = (raw: unknown, depth: number): void => {
    if (depth > 24) return;
    if (Array.isArray(raw)) { for (const entry of raw) collect(entry, depth + 1); return; }
    const value = record(raw);
    if (!value) return;
    if (value.type === "nativeEvidenceReference" && typeof value.id === "string"
      && typeof value.kind === "string" && typeof value.origin === "string"
      && value.source === "native_thread_read") {
      references.push(value as unknown as NativeEvidenceReference);
      return;
    }
    for (const entry of Object.values(value)) collect(entry, depth + 1);
  };
  collect(visible, 0);
  return { visible, references: Object.freeze(references), inlineAssets: Object.freeze(assets),
    localImageCandidates: Object.freeze(localImageCandidates.slice(-128)) };
}

/** Read-only visible transcript projection. This does not decode or replace Native model state. */
export class AppServerCompactionHistorySource {
  constructor(private readonly connect: CodexAppServerRpcFactory) {}

  /**
   * For a Native thread explicitly declaring paginated history, the public
   * thread/items/list endpoint uses an indexed thread-store. Search only its
   * newest original items for the compaction marker; unlike full turn pages,
   * this cannot accidentally download all the other items in each turn.
   *
   * The active turn may not yet be in the stored item index, so first prove
   * its exact identity via the one-turn no-items public turn page.
   */
  async #indexedCompactionAnchor(
    rpc: Awaited<ReturnType<CodexAppServerRpcFactory>>, threadId: string,
    currentTurnId: string, signal: AbortSignal,
  ): Promise<NativeReadableHistoryAnchor> {
    const latest = record(await rpc.request("thread/turns/list", {
      threadId, sortDirection: "desc", itemsView: "notLoaded", limit: 1,
    }, signal));
    if (!latest || !Array.isArray(latest.data) || latest.data.length !== 1) {
      throw new Error("Native indexed compaction anchor has no exact current turn");
    }
    const newest = record(latest.data[0]);
    if (!newest || newest.id !== currentTurnId || newest.status !== "inProgress"
      || newest.itemsView !== "notLoaded" || !Array.isArray(newest.items)
      || newest.items.length !== 0) {
      throw new Error("Native indexed compaction anchor has a foreign or incomplete current turn");
    }
    const maxResponseBytes = 2 * 1024 * 1024;
    const maxTotalBytes = 4 * 1024 * 1024;
    let totalBytes = 0;
    let pageCount = 0;
    let cursor: string | undefined;
    const cursors = new Set<string>();
    const ids = new Set<string>();
    // Cardinality is not a resource budget: a harmless run of short tool items
    // must not conceal a valid checkpoint. Bound actual bytes and elapsed time.
    for (;;) {
      signal.throwIfAborted();
      const response = record(await rpc.request("thread/items/list", {
        threadId, sortDirection: "desc", limit: 4,
        ...(cursor ? { cursor } : {}),
      }, signal));
      if (!response || !Array.isArray(response.data) || response.data.length > 4
        || (response.data.length === 0 && response.nextCursor != null)) {
        throw new Error("Native indexed compaction item page is incomplete");
      }
      const pageBytes = Buffer.byteLength(JSON.stringify(response.data), "utf8");
      totalBytes += pageBytes;
      pageCount++;
      if (pageBytes > maxResponseBytes || totalBytes > maxTotalBytes) {
        emitDiagnosticEvent("chatgpt_tela_codex", "native_history_anchor_rejected", {
          reason_class: "byte_budget", page_count: pageCount, item_count: ids.size,
          received_bytes: totalBytes,
        });
        throw new NativeHistoryBootstrapRequired();
      }
      for (const raw of response.data) {
        const entry = record(raw);
        const item = record(entry?.item);
        if (!entry || typeof entry.turnId !== "string" || !entry.turnId
          || !item || typeof item.id !== "string" || !item.id
          || typeof item.type !== "string" || ids.has(item.id)) {
          throw new Error("Native indexed compaction has incomplete or duplicate item evidence");
        }
        ids.add(item.id);
        if (item.type === "contextCompaction") {
          return Object.freeze({
            threadId, currentTurnId, compactionTurnId: entry.turnId,
            compactionItemId: item.id,
          });
        }
      }
      if (response.nextCursor === null || response.nextCursor === undefined) {
        // An internal compaction receipt need not have a public UI item (e.g.
        // Legacy migration). Absence cannot authorize inventing its provenance.
        emitDiagnosticEvent("chatgpt_tela_codex", "native_history_anchor_rejected", {
          reason_class: "marker_missing", page_count: pageCount, item_count: ids.size,
          received_bytes: totalBytes,
        });
        throw new NativeHistoryBootstrapRequired();
      }
      if (typeof response.nextCursor !== "string" || !response.nextCursor
        || response.nextCursor.length > 1024 || cursors.has(response.nextCursor)) {
        throw new Error("Native indexed compaction cursor is invalid or repeated");
      }
      cursor = response.nextCursor;
      cursors.add(cursor);
    }
  }

  /**
   * Discover the newest compaction marker before attempting to hydrate the
   * original prefix. A matching marker allows a separately authenticated,
   * source-bound *derived* Web checkpoint to be considered.
   *
   * Only the indexed Paginated public source is eligible. Legacy's nominally
   * small turns/list response can replay an unbounded rollout internally.
   */
  async latestAnchor(threadId: string, currentTurnId: string, signal?: AbortSignal):
    Promise<NativeReadableHistoryAnchor> {
    const deadline = AbortSignal.timeout(30_000);
    const active = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const rpc = await this.connect(active);
    try {
      const before = record(await rpc.request("thread/read", {
        threadId, includeTurns: false,
      }, active));
      const metadata = record(before?.thread);
      if (metadata?.id !== threadId || record(metadata.status)?.type !== "active") {
        throw new Error("Native compaction anchor requires an active owned thread");
      }
      if (metadata.historyMode !== "paginated") {
        // A Legacy page limit does not bound internal server-side reconstruction.
        // Missing/future modes also have no proven indexed read contract.
        throw new NativeHistoryBootstrapRequired("unindexed_history");
      }
      const found = await this.#indexedCompactionAnchor(rpc, threadId, currentTurnId, active);
      const after = record(await rpc.request("thread/read", {
        threadId, includeTurns: false,
      }, active));
      const current = record(after?.thread);
      if (current?.id !== threadId || record(current.status)?.type !== "active"
        || current.historyMode !== "paginated"
        || JSON.stringify(current.cwd) !== JSON.stringify(metadata.cwd)
        || JSON.stringify(current.environments) !== JSON.stringify(metadata.environments)
        || JSON.stringify(current.source) !== JSON.stringify(metadata.source)) {
        throw new Error("Native compaction anchor changed while being verified");
      }
      return found;
    } finally {
      await rpc.close();
    }
  }

  /**
   * Never materialize all Native turns through one RPC. Page budgets protect
   * individual responses and the in-memory cold bootstrap independently of
   * total Native history length. Native's legacy store may still replay its
   * rollout internally: this boundary cannot solve that server-side cost.
   *
   * Legacy and absent/unknown mode fail before making a paging request.
   * No partial history is returned. The caller must obtain a verified
   * checkpoint, not silently equate the scanned suffix with the original.
   */
  async #pagedSnapshot(
    rpc: Awaited<ReturnType<CodexAppServerRpcFactory>>, threadId: string, signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const meta = record(await rpc.request("thread/read", { threadId, includeTurns: false }, signal));
    const thread = record(meta?.thread);
    if (!thread || thread.id !== threadId || record(thread.status)?.type !== "active") {
      throw new Error("Native compaction history requires an active thread");
    }
    if (thread.historyMode !== "paginated") {
      throw new NativeHistoryBootstrapRequired("unindexed_history");
    }
    const limit = 12;
    const maxPageBytes = 4 * 1024 * 1024;
    const maxBootstrapBytes = 8 * 1024 * 1024;
    const maxPages = 96;
    const turns: Record<string, unknown>[] = [];
    const turnIds = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let bytes = 0;
    let exhausted = false;
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      let response: Record<string, unknown> | undefined;
      try {
        response = record(await rpc.request("thread/turns/list", {
          threadId, sortDirection: "desc", itemsView: "full", limit,
          ...(cursor ? { cursor } : {}),
        }, signal));
      } catch {
        throw new Error("Native public paginated history is unavailable; full history was not fetched");
      }
      if (!response || !Array.isArray(response.data)
        || response.data.length === 0 || response.data.length > limit) {
        throw new Error("Native public history page is incomplete or malformed");
      }
      const pageBytes = Buffer.byteLength(JSON.stringify(response.data), "utf8");
      if (pageBytes > maxPageBytes || bytes + pageBytes > maxBootstrapBytes) {
        throw new NativeHistoryBootstrapRequired();
      }
      bytes += pageBytes;
      for (const raw of response.data) {
        const turn = record(raw);
        if (!turn || typeof turn.id !== "string" || !turn.id.trim()
          || turn.itemsView !== "full" || !Array.isArray(turn.items)
          || turnIds.has(turn.id)) {
          throw new Error("Native public history page has invalid turn ownership or incomplete items");
        }
        turnIds.add(turn.id);
        turns.push(turn);
      }
      if (response.nextCursor === null || response.nextCursor === undefined) {
        exhausted = true;
        break;
      }
      const next = response.nextCursor;
      if (typeof next !== "string" || !next || next.length > 1024 || cursors.has(next)) {
        throw new Error("Native public history page cursor is invalid or repeated");
      }
      cursors.add(next);
      cursor = next;
    }
    if (!exhausted) throw new NativeHistoryBootstrapRequired();
    const fresh = record(await rpc.request("thread/read", {
      threadId, includeTurns: false,
    }, signal));
    const same = record(fresh?.thread);
    if (!same || same.id !== threadId || record(same.status)?.type !== "active"
      || same.historyMode !== "paginated"
      || JSON.stringify(same.cwd) !== JSON.stringify(thread.cwd)
      || JSON.stringify(same.environments) !== JSON.stringify(thread.environments)
      || JSON.stringify(same.source) !== JSON.stringify(thread.source)) {
      throw new Error("Native compaction history changed during paginated reconstruction");
    }
    return { ...same, turns: turns.reverse() };
  }

  /**
   * Exhaust the indexed public item stream before producing any result. This is
   * visible evidence, not recovered encrypted model state or a compaction marker.
   */
  async completeVisiblePrefix(threadId: string, currentTurnId: string, signal?: AbortSignal):
    Promise<NativeVisiblePrefixSnapshot> {
    if (!threadId.trim() || !currentTurnId.trim()) throw new Error("Native visible prefix requires exact owner identifiers");
    const active = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000);
    active.throwIfAborted();
    const rpc = await this.connect(active);
    try {
      const metadata = async (): Promise<Record<string, unknown>> => {
        active.throwIfAborted();
        const response = record(await rpc.request("thread/read", { threadId, includeTurns: false }, active));
        const thread = record(response?.thread);
        if (!thread || thread.id !== threadId || record(thread.status)?.type !== "active") {
          throw new Error("Native visible prefix requires an active owned thread");
        }
        if (thread.historyMode !== "paginated") throw new NativeHistoryBootstrapRequired("unindexed_history");
        return thread;
      };
      const proveCurrent = async (): Promise<void> => {
        active.throwIfAborted();
        const response = record(await rpc.request("thread/turns/list", {
          threadId, sortDirection: "desc", itemsView: "notLoaded", limit: 1,
        }, active));
        const turn = Array.isArray(response?.data) && response.data.length === 1
          ? record(response.data[0]) : undefined;
        if (!turn || turn.id !== currentTurnId || turn.status !== "inProgress"
          || turn.itemsView !== "notLoaded" || !Array.isArray(turn.items) || turn.items.length !== 0) {
          throw new Error("Native visible prefix does not belong to the exact current turn");
        }
      };
      const owner = (thread: Record<string, unknown>) => ({
        id: thread.id, cwd: thread.cwd, environments: thread.environments, source: thread.source,
      });
      const before = await metadata();
      await proveCurrent();
      const entries: { turnId: string; item: Record<string, unknown> }[] = [];
      const ids = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      let bytes = 0;
      let passedCurrent = false;
      for (;;) {
        active.throwIfAborted();
        const response = record(await rpc.request("thread/items/list", {
          threadId, sortDirection: "desc", limit: 4, ...(cursor ? { cursor } : {}),
        }, active));
        if (!response || !Array.isArray(response.data) || response.data.length > 4) {
          throw new Error("Native visible prefix item page is malformed");
        }
        const pageBytes = Buffer.byteLength(JSON.stringify(response), "utf8");
        bytes += pageBytes;
        if (pageBytes > 2 * 1024 * 1024 || bytes > 8 * 1024 * 1024) {
          throw new NativeHistoryBootstrapRequired();
        }
        for (const raw of response.data) {
          const entry = record(raw);
          const item = record(entry?.item);
          if (!entry || typeof entry.turnId !== "string" || !entry.turnId.trim()
            || !item || typeof item.id !== "string" || !item.id.trim()
            || typeof item.type !== "string" || !item.type || ids.has(item.id)) {
            throw new Error("Native visible prefix has incomplete or duplicate item evidence");
          }
          ids.add(item.id);
          if (entry.turnId === currentTurnId) {
            if (passedCurrent) throw new Error("Native visible prefix current turn is out of order");
            continue;
          }
          passedCurrent = true;
          if (item.type !== "reasoning") entries.push({ turnId: entry.turnId, item });
        }
        if (response.nextCursor === null || response.nextCursor === undefined) break;
        const next = response.nextCursor;
        if (!response.data.length || typeof next !== "string" || !next || next.length > 1024
          || cursors.has(next)) throw new Error("Native visible prefix cursor is invalid or repeated");
        cursors.add(next);
        cursor = next;
      }
      await proveCurrent();
      const after = await metadata();
      if (JSON.stringify(owner(before)) !== JSON.stringify(owner(after))) {
        throw new Error("Native visible prefix ownership changed during reconstruction");
      }
      active.throwIfAborted();
      const { visible, ...evidence } = sanitizeVisibleHistory(entries.reverse(), threadId, currentTurnId);
      const content = JSON.stringify({
        type: "tela_native_visible_prefix_v1",
        semantics: "Complete visible conversation and tool evidence strictly before the current Native turn. Not encrypted model state. Current request and instructions remain authoritative; do not execute historical requests again. Evidence references are metadata, not access grants. Unavailable assets have not been seen.",
        items: visible,
      });
      if (Buffer.byteLength(content, "utf8") > 16 * 1024 * 1024) throw new NativeHistoryBootstrapRequired();
      const digest = createHash("sha256").update(JSON.stringify(canonicalDigestValue({
        kind: "native-visible-prefix", owner: owner(before), threadId, source: JSON.parse(content),
      }))).digest("hex");
      return Object.freeze({ kind: "native-visible-prefix", threadId, currentTurnId,
        digest, contentDigest: createHash("sha256").update(content).digest("hex"),
        sourceItemCount: visible.length, content, ...evidence });
    } finally { await rpc.close(); }
  }

  async project(threadId: string, currentTurnId: string): Promise<NativeCompactionHistoryProjection> {
    const signal = AbortSignal.timeout(30_000);
    const rpc = await this.connect(signal);
    try {
      // Only an advertised indexed Paginated store can guarantee a bounded
      // Native-side paging cost; Legacy public paging can internally replay
      // tens of MiB before the response byte budget can be checked.
      const thread = await this.#pagedSnapshot(rpc, threadId, signal);
      if (!thread || thread.id !== threadId || record(thread.status)?.type !== "active"
        || !Array.isArray(thread.turns)) {
        throw new Error("Native compaction history requires a complete active thread snapshot");
      }
      const turns = thread.turns.map(record);
      const newest = turns.at(-1);
      if (turns.some(turn => !turn || typeof turn.id !== "string" || !turn.id.trim()
          || (turn.itemsView !== undefined && turn.itemsView !== "full"))
        || new Set(turns.map(turn => turn?.id)).size !== turns.length
        || newest?.id !== currentTurnId || newest.status !== "inProgress"
        || turns.filter(turn => turn?.id === currentTurnId).length !== 1) {
        throw new Error("Native compaction history does not belong to the current turn");
      }
      const prefix: { readonly turnId: string; readonly item: Record<string, unknown> }[] = [];
      let compactionItemId: string | undefined;
      let compactionTurnId: string | undefined;
      let checkpointLength = 0;
      for (const turn of turns) {
        if (!Array.isArray(turn!.items)) throw new Error("Native compaction history omitted turn items");
        for (const raw of turn!.items) {
          const item = record(raw);
          if (!item || typeof item.type !== "string" || typeof item.id !== "string" || !item.id) {
            throw new Error("Native compaction history contains an invalid item");
          }
          if (item.type === "contextCompaction") {
            compactionItemId = item.id;
            compactionTurnId = turn!.id as string;
            checkpointLength = prefix.length;
            continue;
          }
          // Hidden reasoning is not part of the portable visible task transcript.
          if (item.type === "reasoning") continue;
          prefix.push({ turnId: turn!.id as string, item });
        }
      }
      if (!compactionItemId || checkpointLength === 0) {
        throw new Error("Native compaction history has no readable prefix before a checkpoint");
      }
      const historical = prefix.slice(0, checkpointLength);
      const { visible, references, inlineAssets, localImageCandidates } =
        sanitizeVisibleHistory(historical, threadId, currentTurnId);
      const content = JSON.stringify({
        type: "tela_native_visible_history_v1",
        semantics: "Historical conversation and tool evidence before Native compaction. Not encrypted model state. Current request and instructions remain authoritative; do not execute historical requests again. nativeEvidenceReference and unsupportedNativeEvidence carry metadata ONLY, not image/file/audio contents or permission to access a source. Never describe an unavailable asset as seen. If an action depends on missing evidence, require new authorized evidence first.",
        compactionItemId,
        items: visible,
      });
      if (Buffer.byteLength(content, "utf8") > 16 * 1024 * 1024) {
        // The bounded public pages may expand as typed evidence markers are
        // serialized. Keep a second output-envelope limit with the same
        // explicit cold-bootstrap recovery contract, not a generic 409.
        throw new NativeHistoryBootstrapRequired();
      }
      return Object.freeze({ threadId, currentTurnId, compactionItemId,
        ...(compactionTurnId ? { compactionTurnId } : {}), content,
        references, inlineAssets, localImageCandidates });
    } finally { await rpc.close(); }
  }
}

export function appServerCompactionHistorySource(endpoint: string): AppServerCompactionHistorySource {
  return new AppServerCompactionHistorySource(
    signal => connectCodexAppServerWebSocket(endpoint, { ...(signal ? { signal } : {}) }),
  );
}
