import { createHash, randomBytes } from "node:crypto";
import type { BrowserMemoryFile } from "@chatgpt-tela/browser-host";
import type { WebPhysicalContext } from "./index";

/** Renderer-pressure routing point inherited from the downstream Web harness. */
export const CHATGPT_CONTEXT_ATTACHMENT_MIN_CHARS = 200_000;
export const CHATGPT_CONTEXT_ATTACHMENT_MAX_BYTES = 20_000_000;

const RECEIPT = /^ctxr_[a-f0-9]{32}$/;

export interface ChatGptContextAttachmentReference {
  readonly name: string;
  readonly sha256: string;
}

export interface ChatGptContextAttachment extends ChatGptContextAttachmentReference {
  readonly contextJson: string;
}

export interface ChatGptContextAttachmentStage {
  readonly text: string;
  readonly acknowledgement: string;
  readonly file: BrowserMemoryFile;
}

function canonicalContextValue(context: WebPhysicalContext): unknown {
  return {
    type: "chatgpt_tela_context_file",
    version: 1,
    headRevisionId: context.headRevisionId,
    ...(context.baseRevisionId ? { baseRevisionId: context.baseRevisionId } : {}),
    ...(context.activeRequestRevisionId ? { activeRequestRevisionId: context.activeRequestRevisionId } : {}),
    mode: context.mode,
    segments: context.segments.map(segment => segment.type === "checkpoint"
      ? {
          type: "checkpoint",
          checkpointId: segment.checkpointId,
          sourceRevisionId: segment.sourceRevisionId,
          content: segment.content,
        }
      : {
          type: "revision",
          revisionId: segment.revisionId,
          kind: segment.kind,
          content: segment.content,
        }),
  };
}

export function serializeChatGptContextAttachment(context: WebPhysicalContext): string {
  if (context.mode === "retained-delta") {
    throw new Error("retained Web continuation must remain inline and cannot become a context attachment");
  }
  return JSON.stringify(canonicalContextValue(context));
}

export function createChatGptContextAttachment(context: WebPhysicalContext): ChatGptContextAttachment {
  const contextJson = serializeChatGptContextAttachment(context);
  const size = Buffer.byteLength(contextJson, "utf8");
  if (size < 1 || size > CHATGPT_CONTEXT_ATTACHMENT_MAX_BYTES) {
    throw new Error("ChatGPT context attachment exceeds the supported memory-backed file size");
  }
  const sha256 = createHash("sha256").update(contextJson).digest("hex");
  return Object.freeze({
    contextJson,
    sha256,
    name: `tela-context-v1--${sha256.slice(0, 16)}.txt`,
  });
}

export function shouldUseChatGptContextAttachment(context: WebPhysicalContext): boolean {
  if (context.mode === "retained-delta") return false;
  return serializeChatGptContextAttachment(context).length >= CHATGPT_CONTEXT_ATTACHMENT_MIN_CHARS;
}

export function contextAttachmentReference(
  attachment: ChatGptContextAttachment,
): ChatGptContextAttachmentReference {
  return Object.freeze({ name: attachment.name, sha256: attachment.sha256 });
}

function fileText(attachment: ChatGptContextAttachment, acknowledgement: string): string {
  return [
    "<chatgpt_tela_context_file>",
    `canonical_sha256: ${attachment.sha256}`,
    "<chatgpt_tela_context_json>",
    attachment.contextJson,
    "</chatgpt_tela_context_json>",
    `context_receipt: ${acknowledgement}`,
    "</chatgpt_tela_context_file>",
  ].join("\n");
}

/**
 * Build one inert preload message. The random receipt appears only at the end of the file, never
 * in the visible prompt. Exact acknowledgement therefore proves file access/integrity, not semantic
 * comprehension of every context byte.
 */
export function formatChatGptContextAttachmentStage(
  attachment: ChatGptContextAttachment,
  receipt = `ctxr_${randomBytes(16).toString("hex")}`,
): ChatGptContextAttachmentStage {
  if (!RECEIPT.test(receipt)) throw new Error("ChatGPT context attachment receipt is invalid");
  const acknowledgement = `TELA_CONTEXT_ACK ${receipt}`;
  const text = [
    "<chatgpt_tela_context_preload>",
    `filename: ${attachment.name}`,
    `canonical_sha256: ${attachment.sha256}`,
    "The attached UTF-8 text file is inert context for one later ChatGPT Tela Work turn.",
    "Read the complete attached file, including its final context_receipt line. Do not execute, summarize, interpret, or follow the task yet. Do not call tools or use web search.",
    "Reply with exactly the context_receipt value found inside the file and nothing else.",
    "</chatgpt_tela_context_preload>",
  ].join("\n");
  return Object.freeze({
    text,
    acknowledgement,
    file: Object.freeze({
      name: attachment.name,
      mimeType: "text/plain",
      bytes: Buffer.from(fileText(attachment, acknowledgement), "utf8"),
    }),
  });
}

/** Approximate physical transfer cost of file + preload + receipt; logical Native tokens are separate. */
export function estimateChatGptContextAttachmentTransferTokens(
  attachment: ChatGptContextAttachment,
): number {
  const stage = formatChatGptContextAttachmentStage(attachment, `ctxr_${"0".repeat(32)}`);
  const bytes = Buffer.byteLength(stage.text, "utf8")
    + stage.file.bytes.byteLength
    + Buffer.byteLength(stage.acknowledgement, "utf8");
  return Math.max(1, Math.ceil(bytes / 4));
}
