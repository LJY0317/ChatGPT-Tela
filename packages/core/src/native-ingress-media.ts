import { decodeNativeInlineEvidence, nativeEvidenceRef, type NativeInlineHistoryAsset } from "./evidence";

/** Short-lived evidence supplied by a public Native turn/start request and bound only
 * after the same Native app-server acknowledges its exact thread/turn identity. */
export interface NativeIngressTurnMedia {
  readonly threadId: string;
  readonly turnId: string;
  readonly assets: readonly NativeInlineHistoryAsset[];
  readonly unavailable: number;
}

export interface NativeIngressPendingMedia {
  readonly threadId: string;
  readonly assets: readonly {
    readonly part: number;
    readonly mimeType: string;
    readonly bytes: Uint8Array;
    readonly sha256: string;
  }[];
  readonly unavailable: number;
}

const MAX_UNIQUE_IMAGES = 8;
const MAX_IMAGE_REFERENCES = 128;
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;
const MAX_OWNED_TURNS = 8;
const MAX_AGE_MS = 10 * 60 * 1000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/**
 * Read only explicit inline image bytes in this already-authorized public Native
 * turn/start payload. Never dereference local paths, opaque file IDs or remote URLs.
 * Even unsupported sources are counted so a Web turn cannot silently ignore them.
 */
export function prepareNativeIngressTurnMedia(value: unknown): NativeIngressPendingMedia | undefined {
  const params = record(value);
  if (typeof params?.threadId !== "string" || !Array.isArray(params.input)) return undefined;
  const assets: NativeIngressPendingMedia["assets"][number][] = [];
  const unique = new Map<string, Uint8Array>();
  let uniqueBytes = 0;
  let unavailable = 0;
  for (const [index, raw] of params.input.entries()) {
    const part = record(raw);
    if (!part || !["image", "localImage", "input_image"].includes(String(part.type))) continue;
    const data = typeof part.url === "string" ? part.url
      : typeof part.image_url === "string" ? part.image_url : undefined;
    if (!data?.startsWith("data:")) { unavailable++; continue; }
    try {
      const decoded = decodeNativeInlineEvidence(data);
      if (!decoded.mimeType.startsWith("image/")) { unavailable++; continue; }
      const key = `${decoded.mimeType}:${decoded.sha256}`;
      const existing = unique.get(key);
      if (assets.length >= MAX_IMAGE_REFERENCES
        || (!existing && (unique.size >= MAX_UNIQUE_IMAGES
          || uniqueBytes + decoded.bytes.byteLength > MAX_IMAGE_BYTES))) {
        unavailable++; continue;
      }
      if (!existing) {
        unique.set(key, decoded.bytes);
        uniqueBytes += decoded.bytes.byteLength;
      }
      assets.push(Object.freeze({ part: index, ...decoded, bytes: existing ?? decoded.bytes }));
    } catch { unavailable++; }
  }
  if (!assets.length && !unavailable) return undefined;
  return Object.freeze({
    threadId: params.threadId,
    assets: Object.freeze(assets),
    unavailable,
  });
}

/**
 * This is an evidence transport cache, never execution authority. An authenticated
 * Native turn/read current-turn claim must separately prove threadId/turnId before
 * consumers may use a snapshot. It has no timer, disk write, network or filesystem
 * read. Close/account invalidation destroys the bytes; expired entries fail closed.
 */
export class NativeIngressMediaRegistry {
  readonly #items = new Map<string, { readonly savedAt: number; readonly media: NativeIngressTurnMedia }>();
  readonly #clock: () => number;
  #generation = 0;

  constructor(clock: () => number = Date.now) { this.#clock = clock; }
  get generation(): number { return this.#generation; }

  #prune(): void {
    const now = this.#clock();
    for (const [key, entry] of this.#items) {
      if (now - entry.savedAt > MAX_AGE_MS) this.#items.delete(key);
    }
  }

  accept(pending: NativeIngressPendingMedia | undefined, turnId: unknown,
    acknowledgedThreadId?: unknown, expectedGeneration = this.#generation): void {
    if (!pending) return;
    if (expectedGeneration !== this.#generation) return;
    if (typeof turnId !== "string" || !turnId.trim()
      || (acknowledgedThreadId !== undefined && acknowledgedThreadId !== pending.threadId)) return;
    this.#prune();
    const key = JSON.stringify([pending.threadId, turnId]);
    if (!this.#items.has(key) && this.#items.size >= MAX_OWNED_TURNS) {
      // Reject rather than evict an active, exact-turn owner.
      throw new Error("Native inline media turn capacity exhausted");
    }
    const assets = pending.assets.map(asset => Object.freeze({
      evidence: nativeEvidenceRef({
        threadId: pending.threadId,
        itemKey: `turn:${turnId}`,
        partKey: String(asset.part),
        kind: "image", origin: "current-user", source: "native_request",
        sha256: asset.sha256, bytes: asset.bytes.byteLength,
      }),
      mimeType: asset.mimeType,
      bytes: asset.bytes,
    }));
    this.#items.set(key, {
      savedAt: this.#clock(),
      media: Object.freeze({
        threadId: pending.threadId, turnId,
        assets: Object.freeze(assets), unavailable: pending.unavailable,
      }),
    });
  }

  current(threadId: string, turnId: string): NativeIngressTurnMedia | undefined {
    this.#prune();
    return this.#items.get(JSON.stringify([threadId, turnId]))?.media;
  }

  retire(threadId: string, turnId: string): void {
    this.#items.delete(JSON.stringify([threadId, turnId]));
  }

  retireThread(threadId: string): void {
    for (const [key, item] of this.#items) {
      if (item.media.threadId === threadId) this.#items.delete(key);
    }
  }

  clear(): void { this.#generation++; this.#items.clear(); }
}
