import { createHash } from "node:crypto";
import type { BrowserMemoryFile } from "@chatgpt-tela/browser-host";
import {
  NATIVE_EVIDENCE_MAX_BYTES, NATIVE_EVIDENCE_MIME_EXTENSIONS,
  type NativeEvidenceReference,
} from "@chatgpt-tela/core";
import type { WebPhysicalContext } from "./index";

/** Browser upload adapter never opens a path, downloads a URL, or reads a Native DB. */
export interface WebTurnMedia {
  readonly evidence: NativeEvidenceReference;
  readonly revisionId: string;
  readonly file: BrowserMemoryFile;
}

export interface WebTurnMediaManifestEntry {
  readonly evidenceId: string;
  readonly revisionId: string;
  readonly kind: "image" | "file";
  readonly filename: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly status: "attachment_expected_on_this_web_turn";
}

export interface WebTurnMediaStatistics {
  readonly logicalReferences: number;
  readonly uniqueFiles: number;
  readonly uniqueBytes: number;
}

/** Conservative Tela adapter ceilings, not assertions about changing ChatGPT account limits. */
export const WEB_TURN_MEDIA_MAX_FILES = 8;
/** Independent bound for model-visible relationships, even if each points to the same file. */
export const WEB_TURN_MEDIA_MAX_REFERENCES = 128;
export const WEB_TURN_MEDIA_MAX_BYTES = NATIVE_EVIDENCE_MAX_BYTES;
export const WEB_TURN_MEDIA_MIME_EXTENSION = NATIVE_EVIDENCE_MIME_EXTENSIONS;

export function webEvidenceFilename(sha256: string, mimeType: string): string {
  const ext = WEB_TURN_MEDIA_MIME_EXTENSION[mimeType];
  if (!/^[0-9a-f]{64}$/.test(sha256) || !ext) throw new Error("Web media MIME or digest is unsupported");
  return `tela-evidence-${sha256.slice(0, 24)}.${ext}`;
}

/**
 * Validate exact Native-to-physical-context lineage before the browser may receive any bytes.
 * Duplicate content references upload one physical file, but keep each logical reference.
 */
export function prepareWebTurnMedia(
  context: WebPhysicalContext,
  media: readonly WebTurnMedia[],
): { readonly files: readonly BrowserMemoryFile[];
  readonly manifest: readonly WebTurnMediaManifestEntry[];
  readonly statistics: WebTurnMediaStatistics;
} {
  if (media.length > WEB_TURN_MEDIA_MAX_REFERENCES) {
    throw new Error("Web evidence reference count exceeds adapter limit");
  }
  const revisions = new Map(context.segments.filter(s => s.type === "revision")
    .map(s => [s.revisionId, s.evidence ?? []]));
  const references = new Set<string>();
  const files = new Map<string, BrowserMemoryFile>();
  const manifest: WebTurnMediaManifestEntry[] = [];
  let totalBytes = 0;
  for (const item of media) {
    const { evidence, revisionId, file } = item;
    const refs = revisions.get(revisionId);
    const matches = refs?.filter(ref => ref.id === evidence.id) ?? [];
    const bound = matches[0];
    // Text is untrusted model context. The exact typed evidence list is the only media
    // ownership link, including through a nested checkpoint's inert JSON source.
    if (!bound || references.has(evidence.id)) {
      throw new Error("Web media evidence reference is unavailable or duplicated");
    }
    if ((evidence.kind !== "image" && evidence.kind !== "file")
      || evidence.sha256 === undefined || evidence.bytes === undefined) {
      throw new Error("Web media evidence has an unsupported format");
    }
    references.add(evidence.id);
    const size = file.bytes.byteLength;
    if (size < 1 || size > WEB_TURN_MEDIA_MAX_BYTES
      || size !== evidence.bytes
      || createHash("sha256").update(file.bytes).digest("hex") !== evidence.sha256
      || file.name !== webEvidenceFilename(evidence.sha256, file.mimeType)
      || (evidence.kind === "image" && !file.mimeType.startsWith("image/"))
      || (evidence.kind === "file" && file.mimeType.startsWith("image/"))) {
      throw new Error("Web media bytes, MIME, and Native digest did not match");
    }
    const already = files.get(file.name);
    if (already && (already.mimeType !== file.mimeType || !Buffer.from(already.bytes).equals(Buffer.from(file.bytes)))) {
      throw new Error("Web media filename collides with different content");
    }
    if (!already) {
      totalBytes += size;
      if (files.size >= WEB_TURN_MEDIA_MAX_FILES) throw new Error("Web evidence attachment count exceeds adapter limit");
      if (totalBytes > WEB_TURN_MEDIA_MAX_BYTES) throw new Error("Web evidence total upload bytes exceed adapter limit");
      files.set(file.name, file);
    }
    manifest.push(Object.freeze({
      evidenceId: evidence.id, revisionId, kind: evidence.kind,
      filename: file.name, sha256: evidence.sha256, bytes: size,
      status: "attachment_expected_on_this_web_turn" as const,
    }));
  }
  return Object.freeze({
    files: Object.freeze([...files.values()]),
    manifest: Object.freeze(manifest),
    statistics: Object.freeze({
      logicalReferences: manifest.length,
      uniqueFiles: files.size,
      uniqueBytes: totalBytes,
    }),
  });
}
