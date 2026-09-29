import { describe, expect, test } from "bun:test";
import {
  CHATGPT_CONTEXT_ATTACHMENT_MIN_CHARS,
  createChatGptContextAttachment,
  estimateChatGptContextAttachmentTransferTokens,
  formatChatGptContextAttachmentStage,
  shouldUseChatGptContextAttachment,
} from "./context-attachment";

function context(content: string) {
  return {
    headRevisionId: "r1",
    activeRequestRevisionId: "r1",
    mode: "full" as const,
    logicalTokens: Math.ceil(content.length / 4),
    transferTokens: Math.ceil(content.length / 4),
    segments: [{ type: "revision" as const, revisionId: "r1", kind: "user" as const, content }],
  };
}

describe("ChatGPT context attachment transport", () => {
  test("routes only large fresh physical contexts to a deterministic memory-backed file identity", () => {
    expect(shouldUseChatGptContextAttachment(context("small"))).toBe(false);
    const large = context("x".repeat(CHATGPT_CONTEXT_ATTACHMENT_MIN_CHARS + 1_000));
    expect(shouldUseChatGptContextAttachment(large)).toBe(true);
    const first = createChatGptContextAttachment(large);
    const second = createChatGptContextAttachment(large);
    expect(first).toEqual(second);
    expect(first.name).toMatch(/^tela-context-v1--[a-f0-9]{16}\.txt$/);
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("one-shot receipt exists only after the complete context payload in the file", () => {
    const attachment = createChatGptContextAttachment(context("large-context"));
    const receipt = `ctxr_${"a".repeat(32)}`;
    const stage = formatChatGptContextAttachmentStage(attachment, receipt);
    const file = Buffer.from(stage.file.bytes).toString("utf8");
    expect(stage.acknowledgement).toBe(`TELA_CONTEXT_ACK ${receipt}`);
    expect(stage.text).not.toContain(receipt);
    expect(file).toContain(attachment.contextJson);
    expect(file.indexOf(attachment.contextJson)).toBeLessThan(file.indexOf(receipt));
    expect(stage.file.name).toBe(attachment.name);
    expect(estimateChatGptContextAttachmentTransferTokens(attachment)).toBeGreaterThan(attachment.contextJson.length / 4);
  });

  test("retained suffixes never become file preloads", () => {
    const retained = {
      ...context("x".repeat(CHATGPT_CONTEXT_ATTACHMENT_MIN_CHARS + 1_000)),
      mode: "retained-delta" as const,
      baseRevisionId: "r0",
    };
    expect(shouldUseChatGptContextAttachment(retained)).toBe(false);
    expect(() => createChatGptContextAttachment(retained)).toThrow("remain inline");
  });
});
