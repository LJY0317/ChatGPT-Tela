import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  NATIVE_EVIDENCE_MAX_BYTES, nativeEvidenceRef,
  type NativeInlineHistoryAsset, type NativeTurnAuthority,
} from "@chatgpt-tela/core";
import type { NativeHistoricalImageCandidate } from "./compaction-history";

export type NativeImageUnavailableReason =
  | "owner_mismatch" | "native_authority_unavailable" | "outside_workspace"
  | "unsafe_path" | "missing_file" | "permission_denied" | "unsupported_format"
  | "oversized" | "source_changed" | "cancelled";

export interface NativeHistoricalImageResolverResult {
  readonly assets: readonly NativeInlineHistoryAsset[];
  /** Reason only, never the path or a private file name. */
  readonly unavailable: readonly { readonly evidenceId: string; readonly reason: NativeImageUnavailableReason }[];
  readonly uniqueFiles: number;
  readonly uniqueBytes: number;
}

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== "" && !suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix);
}

function classifyFile(error: unknown): NativeImageUnavailableReason {
  const code = error !== null && typeof error === "object"
    ? (error as { code?: unknown }).code : undefined;
  return code === "ENOENT" ? "missing_file"
    : code === "EACCES" || code === "EPERM" ? "permission_denied" : "unsafe_path";
}

function mimeFromBytes(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v)) return "image/png";
  if (bytes.length >= 3 && [255,216,255].every((v, i) => bytes[i] === v)) return "image/jpeg";
  if (Buffer.from(bytes.subarray(0, 3)).toString() === "GIF") return "image/gif";
  if (Buffer.from(bytes.subarray(0, 4)).toString() === "RIFF"
    && Buffer.from(bytes.subarray(8, 12)).toString() === "WEBP") return "image/webp";
  return undefined;
}

function sameStat(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

/**
 * Narrow, optional OS adapter for an exact Native snapshot's localImage.
 * Native's public fs/readFile endpoint accepts an arbitrary path, without a per-turn
 * read capability or no-follow file-handle contract. It is therefore NOT called here.
 * Only an explicitly known, non-native-enforced sandbox and its confirmed workspace
 * roots authorize this direct, descriptor-checked read. Unverified private/OS caches
 * must be reattached by the user or read through a separately authorized Native tool.
 */
export async function resolveNativeHistoricalImages(input: {
  readonly authority: NativeTurnAuthority;
  readonly candidates: readonly NativeHistoricalImageCandidate[];
  readonly signal?: AbortSignal;
  readonly maxUniqueFiles?: number;
}): Promise<NativeHistoricalImageResolverResult> {
  const { authority, signal } = input;
  const maxUniqueFiles = input.maxUniqueFiles ?? 8;
  if (!Number.isSafeInteger(maxUniqueFiles) || maxUniqueFiles < 1 || maxUniqueFiles > 8) {
    throw new Error("Native historical media resolver has invalid file budget");
  }
  const assets: NativeInlineHistoryAsset[] = [];
  const unavailable: Array<{ evidenceId: string; reason: NativeImageUnavailableReason }> = [];
  const unique = new Map<string, { readonly bytes: Uint8Array; readonly mimeType: string; readonly sha256: string }>();
  let uniqueBytes = 0;
  for (const candidate of input.candidates.slice(-128).reverse()) {
    if (signal?.aborted) throw signal.reason ?? new Error("Native media owner cancelled");
    const deny = (reason: NativeImageUnavailableReason) => unavailable.push({ evidenceId: candidate.evidenceId, reason });
    const expected = nativeEvidenceRef({
      threadId: candidate.threadId, itemKey: `${candidate.sourceTurnId}:${candidate.itemId}`,
      partKey: String(candidate.partIndex), kind: "image",
      origin: "historical-user", source: "native_thread_read",
    }).id;
    if (authority.source !== "native-current-turn" || authority.threadId !== candidate.threadId
      || authority.turnId !== candidate.currentTurnId || expected !== candidate.evidenceId) {
      deny("owner_mismatch"); continue;
    }
    if (authority.sandbox.kind === "native-enforced") { deny("native_authority_unavailable"); continue; }
    if (!isAbsolute(candidate.path) || candidate.path.includes("\0")) { deny("unsafe_path"); continue; }
    const path = resolve(candidate.path);
    const root = authority.workspaceRoots.map(dir => resolve(dir)).find(dir => inside(dir, path));
    if (!root) { deny("outside_workspace"); continue; }
    if (constants.O_NOFOLLOW === undefined) { deny("native_authority_unavailable"); continue; }
    try {
      // Reject static symlinks in every component; do not treat realpath containment alone
      // as enough. Recheck after reading to detect replacement or parent-path changes.
      const check = async () => {
        if (await realpath(root) !== root) throw new Error("unsafe root");
        const segments = relative(root, path).split(sep);
        let entry = root;
        for (const [index, name] of segments.entries()) {
          entry = join(entry, name);
          const stat = await lstat(entry, { bigint: true });
          if (stat.isSymbolicLink() || (index === segments.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
            throw new Error("symlink or unsafe entry");
          }
        }
        if (await realpath(path) !== path) throw new Error("unsafe resolved path");
        return lstat(path, { bigint: true });
      };
      const before = await check();
      const size = Number(before.size);
      if (!Number.isSafeInteger(size) || size < 1 || size > NATIVE_EVIDENCE_MAX_BYTES) {
        deny("oversized"); continue;
      }
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Uint8Array;
      try {
        const opened = await handle.stat({ bigint: true });
        if (!sameStat(before, opened)) { deny("source_changed"); continue; }
        const buffer = Buffer.alloc(size);
        let offset = 0;
        while (offset < size) {
          signal?.throwIfAborted();
          const result = await handle.read(buffer, offset, Math.min(1024 * 1024, size - offset), offset);
          if (!result.bytesRead) break;
          offset += result.bytesRead;
        }
        const extra = Buffer.alloc(1);
        const extraRead = await handle.read(extra, 0, 1, offset);
        const after = await handle.stat({ bigint: true });
        if (offset !== size || extraRead.bytesRead !== 0 || !sameStat(opened, after)) {
          deny("source_changed"); continue;
        }
        bytes = buffer;
      } finally { await handle.close(); }
      const afterPath = await check();
      if (!sameStat(before, afterPath)) { deny("source_changed"); continue; }
      const mimeType = mimeFromBytes(bytes);
      if (!mimeType) { deny("unsupported_format"); continue; }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const key = `${mimeType}:${sha256}`;
      const previous = unique.get(key);
      if (!previous && (unique.size >= maxUniqueFiles || uniqueBytes + bytes.byteLength > NATIVE_EVIDENCE_MAX_BYTES)) {
        deny("oversized"); continue;
      }
      if (!previous) {
        unique.set(key, { bytes, sha256, mimeType });
        uniqueBytes += bytes.byteLength;
      }
      const evidence = nativeEvidenceRef({
        threadId: candidate.threadId, itemKey: `${candidate.sourceTurnId}:${candidate.itemId}`,
        partKey: String(candidate.partIndex), kind: "image",
        origin: "historical-user", source: "native_thread_read",
        sha256, bytes: bytes.byteLength,
      });
      assets.push(Object.freeze({ evidence, mimeType, bytes: previous?.bytes ?? bytes }));
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      deny(classifyFile(error));
    }
  }
  return Object.freeze({
    assets: Object.freeze(assets),
    unavailable: Object.freeze(unavailable),
    uniqueFiles: unique.size,
    uniqueBytes,
  });
}
