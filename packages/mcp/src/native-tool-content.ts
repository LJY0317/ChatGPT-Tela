import { createHash } from "node:crypto";
import {
  decodeNativeInlineEvidence, nativeEmbeddedResourceDataUrl, nativeSerializedMcpResourcePart,
  nativeToolPartIsEncrypted,
} from "@chatgpt-tela/core";

export type TelaMcpResultContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly mimeType: string; readonly data: string }
  | { readonly type: "resource"; readonly resource: {
      readonly uri: string; readonly mimeType: string; readonly text: string;
    } }
  | { readonly type: "resource"; readonly resource: {
      readonly uri: string; readonly mimeType: string; readonly blob: string;
    } };

function record(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown> : undefined;
}

const MAX_TOOL_CONTENT_ITEMS = 128;
const MAX_TOOL_MEDIA_BYTES = 24 * 1024 * 1024;
const MAX_TOOL_FILES = 8;

/**
 * Translate Native Responses/MCP tool output to the public MCP result wire.
 * Native execution and approval happen upstream. This adapter neither executes tools
 * nor fetches URLs or resources, and does not convert an opaque URI into content.
 */
export function nativeToolResultToMcpContent(input: unknown): {
  readonly content: readonly TelaMcpResultContent[];
  readonly referencedImages: number;
  readonly distinctImages: number;
  readonly uniqueImageBytes: number;
} {
  if (!Array.isArray(input)) {
    const part = record(input);
    if (typeof part?.type === "string") {
      // A singular, tagged result must use the same media/opaque validation as
      // the array contract; never JSON-stringify its raw PDF bytes or URLs.
      return nativeToolResultToMcpContent([input]);
    }
    return Object.freeze({
      content: Object.freeze([{type: "text" as const,
        text: typeof input === "string" ? input : JSON.stringify(input)}]),
      referencedImages: 0, distinctImages: 0, uniqueImageBytes: 0,
    });
  }
  if (input.length > MAX_TOOL_CONTENT_ITEMS) {
    throw new Error("Native tool result has too many content parts");
  }
  const content: TelaMcpResultContent[] = [];
  const seen = new Map<string, { readonly index: number }>();
  let images = 0;
  let distinctImages = 0;
  let bytes = 0;
  let imageBytes = 0;
  const appendResource = (encoded: string, asText: boolean): void => {
    const decoded = decodeNativeInlineEvidence(encoded);
    const key = `${decoded.mimeType}:${decoded.sha256}`;
    const existing = seen.get(key);
    if (existing) {
      content.push({ type: "text",
        text: `[Same Native tool resource as content #${existing.index}; bytes not retransmitted]` });
      return;
    }
    if (seen.size >= MAX_TOOL_FILES || bytes + decoded.bytes.byteLength > MAX_TOOL_MEDIA_BYTES) {
      throw new Error("Native tool resource exceeds bounded Web result limits");
    }
    seen.set(key, { index: content.length + 1 });
    bytes += decoded.bytes.byteLength;
    const uri = `tela-native-asset://sha256/${decoded.sha256}`;
    if (asText) {
      content.push({ type: "resource", resource: {
        uri, mimeType: decoded.mimeType, text: Buffer.from(decoded.bytes).toString("utf8"),
      } });
    } else {
      content.push({ type: "resource", resource: {
        uri, mimeType: decoded.mimeType, blob: Buffer.from(decoded.bytes).toString("base64"),
      } });
    }
  };
  for (const raw of input) {
    const part = record(raw);
    if (nativeToolPartIsEncrypted(part)) {
      content.push({ type: "text", text: "[Opaque Native tool content is not available to this Web model]" });
      continue;
    }
    if (part?.type === "image" || part?.type === "inputImage" || part?.type === "input_image") {
      const mimeType = typeof part.mimeType === "string" ? part.mimeType : undefined;
      const encoded = typeof part.data === "string" && mimeType
        ? `data:${mimeType};base64,${part.data}`
        : typeof part.imageUrl === "string" ? part.imageUrl
        : typeof part.image_url === "string" ? part.image_url
        : typeof part.url === "string" ? part.url : "";
      if (!encoded.startsWith("data:")) {
        content.push({type: "text", text: "[Native tool image exists, but the bytes are unavailable to this Web session]"});
        continue;
      }
      const decoded = decodeNativeInlineEvidence(encoded);
      if (!decoded.mimeType.startsWith("image/")) {
        throw new Error("Native tool image has an unsupported content type");
      }
      images++;
      const key = `${decoded.mimeType}:${decoded.sha256}`;
      const existing = seen.get(key);
      if (existing) {
        content.push({ type: "text",
          text: `[Same Native tool image as content #${existing.index} in this result; bytes not retransmitted]` });
        continue;
      }
      {
        if (seen.size >= MAX_TOOL_FILES || bytes + decoded.bytes.byteLength > MAX_TOOL_MEDIA_BYTES) {
          throw new Error("Native tool image exceeds bounded Web result limits");
        }
        seen.set(key, { index: content.length + 1 });
        bytes += decoded.bytes.byteLength;
        imageBytes += decoded.bytes.byteLength;
        distinctImages++;
      }
      content.push({
        type: "image", mimeType: decoded.mimeType,
        data: Buffer.from(decoded.bytes).toString("base64"),
      });
      continue;
    }
    if (part?.type === "text" || part?.type === "input_text" || part?.type === "output_text") {
      if (typeof part.text !== "string") throw new Error("Native tool text result is malformed");
      const serialized = nativeSerializedMcpResourcePart(part.text);
      if (serialized) {
        const data = nativeEmbeddedResourceDataUrl(serialized);
        if (data) appendResource(data, typeof record(serialized.resource)?.text === "string"
          && typeof record(serialized.resource)?.blob !== "string");
        else content.push({type: "text", text: "[Native MCP resource metadata only; content not transferred]"});
        continue;
      }
      content.push({ type: "text", text: part.text });
      continue;
    }
    if (part?.type === "resource") {
      const data = nativeEmbeddedResourceDataUrl(part);
      if (data) {
        const original = record(part.resource);
        appendResource(data, typeof original?.text === "string" && typeof original.blob !== "string");
        continue;
      }
    }
    if (part?.type === "file" || part?.type === "input_file" || part?.type === "inputFile") {
      const rawFile = typeof part.file_data === "string" ? part.file_data
        : typeof part.fileData === "string" ? part.fileData : undefined;
      const data = rawFile?.startsWith("data:") ? rawFile
        : typeof part.mimeType === "string" && typeof part.data === "string"
          ? `data:${part.mimeType};base64,${part.data}` : undefined;
      if (data) appendResource(data, false);
      else content.push({ type: "text", text: "[Native tool file exists, but verified bytes were not returned]" });
      continue;
    }
    if (part?.type === "resource_link" || part?.type === "resource") {
      // Resource URLs may contain private tokens or require network/account authority.
      // Inert metadata never becomes a claimed download or accidental URL disclosure.
      const resource = part.type === "resource" ? record(part.resource) : part;
      const uri = typeof resource?.uri === "string" ? resource.uri : "";
      content.push({
        type: "text",
        text: `[Native MCP resource available as metadata only; content not transferred; reference ${createHash("sha256").update(uri).digest("hex").slice(0,16)}]`,
      });
      continue;
    }
    if (!part) throw new Error("Native tool result part is malformed");
    if (typeof part.type === "string") {
      content.push({ type: "text", text: "[Native tool returned unsupported opaque content]" });
      continue;
    }
    // Unknown structured results keep their JSON representation; we do not pretend to
    // execute a future private tool or interpret its payload as a media attachment.
    content.push({ type: "text", text: JSON.stringify(part) });
  }
  return Object.freeze({
    content: Object.freeze(content),
    referencedImages: images,
    distinctImages,
    uniqueImageBytes: imageBytes,
  });
}
