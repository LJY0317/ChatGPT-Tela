import {
  decodeNativeInlineEvidence, nativeEmbeddedResourceDataUrl, nativeSerializedMcpResourcePart,
  nativeToolPartIsEncrypted, nativeEvidenceRef,
  type NativeEvidenceKind, type NativeEvidenceOrigin, type NativeEvidenceReference,
} from "@chatgpt-tela/core";
import {
  webEvidenceFilename,
  type WebTurnMedia,
} from "@chatgpt-tela/chatgpt";

export interface NativeProjectedMedia {
  readonly evidence: NativeEvidenceReference;
  readonly file?: WebTurnMedia["file"];
}
export interface NativeProjectedContent {
  readonly text: string;
  readonly media: readonly NativeProjectedMedia[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function marker(input: {
  readonly threadId: string; readonly itemKey: string; readonly partKey: string;
  readonly kind: NativeEvidenceKind; readonly origin: NativeEvidenceOrigin;
  readonly data?: string;
}): NativeProjectedMedia {
  if (!input.data) {
    return { evidence: nativeEvidenceRef({ ...input, source: "native_request" }) };
  }
  const { mimeType, bytes, sha256 } = decodeNativeInlineEvidence(input.data);
  if ((input.kind === "image") !== mimeType.startsWith("image/")) {
    throw new Error("Native attachment kind does not match verified media type");
  }
  const evidence = nativeEvidenceRef({
    ...input, source: "native_request", sha256, bytes: bytes.byteLength,
  });
  return Object.freeze({
    evidence,
    file: Object.freeze({
      name: webEvidenceFilename(sha256, mimeType),
      mimeType,
      bytes,
    }),
  });
}

/**
 * Only an embedded data URI in the Native *request* supplies bytes. A Native fileId, OS path
 * or remote URL alone is never an upload authority; no filesystem/network access is attempted.
 */
function mediaPart(
  part: Record<string, unknown>, input: {
    readonly threadId: string; readonly itemKey: string; readonly partKey: string;
    readonly origin: NativeEvidenceOrigin;
  },
): NativeProjectedMedia | undefined {
  const type = part.type;
  if (typeof type !== "string") return undefined;
  const image = type === "input_image" || type === "image" || type === "localImage"
    || type === "inputImage" || type === "imageView";
  const file = type === "input_file" || type === "file" || type === "inputFile"
    || type === "resource_link" || type === "resource";
  const audio = type === "audio" || type === "localAudio" || type === "input_audio";
  const kind: NativeEvidenceKind = image ? "image" : file ? "file" : audio ? "audio"
    : type === "skill" ? "skill-reference" : type === "mention" ? "app-reference" : "unsupported";
  // Native function outputs may include opaque encrypted content, including MCP text blocks
  // explicitly marked as encrypted by Codex. Those bytes are neither visible model text nor
  // portable evidence: keep only an unavailable reference rather than JSON-stringifying them.
  if (nativeToolPartIsEncrypted(part)) {
    return marker({ ...input, kind: "unsupported" });
  }
  if (!image && !file && !audio && type !== "skill" && type !== "mention") return undefined;
  let data: string | undefined;
  if (image) data = typeof part.image_url === "string" ? part.image_url
    : typeof part.imageUrl === "string" ? part.imageUrl
    : typeof part.url === "string" ? part.url : undefined;
  if (image && !data && typeof part.mimeType === "string" && typeof part.data === "string") {
    data = `data:${part.mimeType};base64,${part.data}`;
  }
  if (file) data = typeof part.file_data === "string" ? part.file_data
    : typeof part.fileData === "string" ? part.fileData : undefined;
  if (file && !data && typeof part.mimeType === "string"
    && typeof part.data === "string" && type === "file") {
    data = `data:${part.mimeType};base64,${part.data}`;
  }
  // MCP EmbeddedResource has a nested, *already returned* blob or text body.
  // ResourceLink is not an EmbeddedResource and never triggers a URL/file read.
  if (type === "resource" && !data) data = nativeEmbeddedResourceDataUrl(part);
  // For current user input, missing/remote bytes must be reported before submitting a Web request.
  if ((image || file) && input.origin === "current-user" && (!data || !data.startsWith("data:"))) {
    throw new Error("Native Web attachment source is not proven inline bytes");
  }
  return marker({ ...input, kind, ...(data?.startsWith("data:") && (image || file) ? { data } : {}) });
}

/** Preserve text/media order and stable part references rather than flattening media into prose. */
export function projectNativeUserContent(
  value: unknown, threadId: string, itemKey: string,
): NativeProjectedContent {
  if (typeof value === "string") return { text: value, media: [] };
  if (!Array.isArray(value)) {
    if (value === null || value === undefined) return { text: "", media: [] };
    throw new Error("Native request has invalid user content");
  }
  const parts: string[] = [];
  const media: NativeProjectedMedia[] = [];
  for (const [index, raw] of value.entries()) {
    if (typeof raw === "string") { parts.push(raw); continue; }
    const part = record(raw);
    if (!part) throw new Error("Native request content contains malformed entry");
    if (part.type === "input_text" || part.type === "text" || part.type === "output_text") {
      if (typeof part.text !== "string") throw new Error("Native request text is malformed");
      parts.push(part.text);
      continue;
    }
    const evidence = mediaPart(part, {
      threadId, itemKey, partKey: String(index), origin: "current-user",
    });
    if (!evidence) throw new Error("Native request has unsupported content type");
    media.push(evidence);
    parts.push(JSON.stringify(evidence.evidence));
  }
  return { text: parts.join("\n"), media };
}

/**
 * Parse non-text tool-result content through the same adapter. Unsupported tool media keeps an
 * unavailable marker, while real inline bytes are passed to the same later browser upload.
 */
export function projectNativeToolEvidence(
  item: Record<string, unknown>, threadId: string, itemKey: string,
): { readonly item: Record<string, unknown>; readonly media: readonly NativeProjectedMedia[] } {
  const media: NativeProjectedMedia[] = [];
  const visit = (raw: unknown, slot: string, depth: number): unknown => {
    if (depth > 24) throw new Error("Native tool output nesting exceeds projection limit");
    if (Array.isArray(raw)) return raw.map((v, i) => visit(v, `${slot}.${i}`, depth + 1));
    const part = record(raw);
    if (!part) return raw;
    if ((part.type === "input_text" || part.type === "text")
      && typeof part.text === "string") {
      const serialized = nativeSerializedMcpResourcePart(part.text);
      if (serialized) {
        const converted = mediaPart(serialized, {
          threadId, itemKey, partKey: slot, origin: "tool-result",
        });
        if (converted) {
          media.push(converted);
          return converted.evidence;
        }
      }
    }
    const evidence = mediaPart(part, {
      threadId, itemKey, partKey: slot, origin: "tool-result",
    });
    if (evidence) {
      media.push(evidence);
      return evidence.evidence;
    }
    return Object.fromEntries(Object.entries(part).map(([k, v]) => [k, visit(v, `${slot}.${k}`, depth + 1)]));
  };
  return { item: visit(item, "root", 0) as Record<string, unknown>, media };
}
