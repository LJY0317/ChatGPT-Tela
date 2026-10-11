import { createHash } from "node:crypto";

/** Media provenance is independent of the renderer, upload transport and Native model state. */
export type NativeEvidenceKind = "image" | "file" | "audio" | "skill-reference" | "app-reference" | "unsupported";
export type NativeEvidenceOrigin = "current-user" | "historical-user" | "tool-result";

/** Transport adapter limits; these are Tela-owned guardrails, not ChatGPT account quotas. */
export const NATIVE_EVIDENCE_MAX_BYTES = 24 * 1024 * 1024;
export const NATIVE_EVIDENCE_MIME_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "application/pdf": "pdf", "text/plain": "txt", "text/csv": "csv", "text/markdown": "md",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
});

function evidenceObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Native/MCP encrypted tool output is opaque state, never portable user-visible text. */
export function nativeToolPartIsEncrypted(value: unknown): boolean {
  const item = evidenceObject(value);
  return item?.type === "encrypted_content"
    || (item?.type === "text"
      && evidenceObject(item._meta)?.["codex/encryptedContent"] === true);
}

/**
 * MCP EmbeddedResource supplies inline bytes in a nested resource body.
 * Use only for already returned, owner-authorized Native tool output.
 * ResourceLink, file URI and remote URL never grant a read permission.
 */
export function nativeEmbeddedResourceDataUrl(value: unknown): string | undefined {
  const part = evidenceObject(value);
  if (part?.type !== "resource") return undefined;
  const resource = evidenceObject(part.resource);
  if (!resource) return undefined;
  const mimeType = typeof resource.mimeType === "string" ? resource.mimeType.toLowerCase()
    : typeof resource.text === "string" ? "text/plain" : undefined;
  if (!mimeType || !NATIVE_EVIDENCE_MIME_EXTENSIONS[mimeType]) return undefined;
  if (typeof resource.blob === "string") {
    if (resource.blob.length > Math.ceil(NATIVE_EVIDENCE_MAX_BYTES / 3) * 4 + 4) return undefined;
    return `data:${mimeType};base64,${resource.blob}`;
  }
  if (typeof resource.text === "string") {
    if (Buffer.byteLength(resource.text, "utf8") > NATIVE_EVIDENCE_MAX_BYTES) return undefined;
    return `data:${mimeType};base64,${Buffer.from(resource.text, "utf8").toString("base64")}`;
  }
  return undefined;
}

/**
 * Codex's public Native MCP result normalizer converts a returned MCP resource
 * into a Responses input_text item containing a JSON-serialized MCP block.
 * Recognize ONLY that typed MCP wire block in a tool-result position; ordinary
 * JSON/text is not promoted to file authority. No URI is ever dereferenced.
 * Unsupported/oversize typed blocks become inert references, not original text.
 */
export function nativeSerializedMcpResourcePart(text: unknown):
  | Readonly<Record<string, unknown>> | undefined {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{")) return undefined;
  const typedPrefix = /^\{\s*"(?:type|resource|uri|mimeType|name)"\s*:/;
  if (!typedPrefix.test(trimmed)) return undefined;
  const maxEncoded = Math.ceil(NATIVE_EVIDENCE_MAX_BYTES / 3) * 4 + 4096;
  if (text.length > maxEncoded) {
    // Long MCP-resource bodies may be serialized with resource before type.
    // Do not echo a candidate oversized JSON payload to the Web model.
    if (trimmed.startsWith('{"resource":') || trimmed.startsWith('{"type":"resource"')
      || trimmed.startsWith('{"type":"resource_link"')) {
      return Object.freeze({ type: "resource_link" });
    }
    return undefined;
  }
  let parsed: Record<string, unknown> | undefined;
  try { parsed = evidenceObject(JSON.parse(text)); }
  catch { return undefined; }
  if (!parsed) return undefined;
  if (parsed.type === "resource" && evidenceObject(parsed.resource)) return parsed;
  if (parsed.type === "resource_link") return parsed;
  return undefined;
}

/** Decode only exact, bounded inline bytes supplied by a Native public contract. No I/O. */
export function decodeNativeInlineEvidence(data: string): {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
} {
  const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(data);
  if (!match) throw new Error("Native Web attachment source is not proven inline bytes");
  const mimeType = match[1]!.toLowerCase();
  if (!NATIVE_EVIDENCE_MIME_EXTENSIONS[mimeType]) throw new Error("Native Web attachment MIME is unsupported");
  const encoded = match[2]!;
  if (encoded.length < 4 || encoded.length > Math.ceil(NATIVE_EVIDENCE_MAX_BYTES / 3) * 4 + 4
    || encoded.length % 4 !== 0) {
    throw new Error("Native Web attachment is empty or exceeds the byte limit");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength < 1 || bytes.byteLength > NATIVE_EVIDENCE_MAX_BYTES
    || bytes.toString("base64") !== encoded) {
    throw new Error("Native Web attachment contains invalid or oversized inline bytes");
  }
  const magic = (prefix: readonly number[]) => prefix.every((x, i) => bytes[i] === x);
  if ((mimeType === "image/png" && !magic([137,80,78,71,13,10,26,10]))
    || (mimeType === "image/jpeg" && !magic([255,216,255]))
    || (mimeType === "image/gif" && bytes.subarray(0, 3).toString() !== "GIF")
    || (mimeType === "image/webp" && !(bytes.subarray(0, 4).toString() === "RIFF"
      && bytes.subarray(8, 12).toString() === "WEBP"))
    || (mimeType === "application/pdf" && bytes.subarray(0, 5).toString() !== "%PDF-")
    || (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      && !magic([80,75,3,4]))) {
    throw new Error("Native Web attachment bytes do not match declared media type");
  }
  return Object.freeze({
    mimeType, bytes, sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

export interface NativeEvidenceReference {
  readonly type: "nativeEvidenceReference";
  /** Stable within the exact Native source and content occurrence. Never an OS path or URL. */
  readonly id: string;
  readonly kind: NativeEvidenceKind;
  readonly origin: NativeEvidenceOrigin;
  readonly source: "native_request" | "native_thread_read";
  /** Proven inline bytes are not the same thing as delivery to a Web model. */
  readonly availability: "verified_inline_bytes" | "unavailable";
  readonly transfer: "not_transferred";
  readonly sha256?: string;
  readonly bytes?: number;
  readonly reason?: "historical_reference_only" | "unsupported_source";
}

/** Ephemeral, public-contract inline evidence. Its bytes are never persisted in a checkpoint. */
export interface NativeInlineHistoryAsset {
  readonly evidence: NativeEvidenceReference;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export function nativeEvidenceRef(input: {
  readonly threadId: string;
  readonly itemKey: string;
  readonly partKey: string;
  readonly kind: NativeEvidenceKind;
  readonly origin: NativeEvidenceOrigin;
  readonly source: NativeEvidenceReference["source"];
  readonly sha256?: string;
  readonly bytes?: number;
}): NativeEvidenceReference {
  const id = "native_asset_" + createHash("sha256")
    // Content may be unavailable at projection time and verified later. Ownership identity
    // must not change as transfer status and digest become known.
    .update(JSON.stringify([input.threadId, input.itemKey, input.partKey, input.kind, input.origin, input.source]))
    .digest("hex").slice(0, 24);
  const available = typeof input.sha256 === "string" && input.bytes !== undefined;
  return Object.freeze({
    type: "nativeEvidenceReference" as const,
    id, kind: input.kind, origin: input.origin, source: input.source,
    availability: available ? "verified_inline_bytes" as const : "unavailable" as const,
    transfer: "not_transferred" as const,
    ...(available ? { sha256: input.sha256, bytes: input.bytes } : {
      reason: input.source === "native_thread_read"
        ? "historical_reference_only" as const : "unsupported_source" as const,
    }),
  });
}
