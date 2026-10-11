import { describe, expect, test } from "bun:test";
import {
  CHATGPT_SAVED_CHAT_URL,
  CHATGPT_TEMPORARY_CHAT_URL,
  isChatGptTemporaryChatUrl,
  isChatGptProvisionalConversationUrl,
} from "./session";

describe("ChatGPT conversation surface identity", () => {
  test("recognizes only the current optimistic Web route, never a saved or foreign route", () => {
    const path = "/c/local-chatgpt%3A00000000-0000-0000-0000-000000000001";
    expect(isChatGptProvisionalConversationUrl("https://chatgpt.com" + path)).toBe(true);
    expect(isChatGptProvisionalConversationUrl("https://example.com" + path)).toBe(false);
    expect(isChatGptProvisionalConversationUrl("https://chatgpt.com/c/00000000-0000-0000-0000-000000000001")).toBe(false);
    expect(isChatGptProvisionalConversationUrl("https://chatgpt.com/c/local-chatgpt%3Aother")).toBe(false);
    expect(isChatGptProvisionalConversationUrl("https://chatgpt.com/c/%broken")).toBe(false);
  });
  test("keeps saved/manual setup separate from disposable Work Temporary Chat state", () => {
    expect(CHATGPT_SAVED_CHAT_URL).toBe("https://chatgpt.com/");
    expect(CHATGPT_TEMPORARY_CHAT_URL).toBe("https://chatgpt.com/?temporary-chat=true");
    expect(isChatGptTemporaryChatUrl(CHATGPT_TEMPORARY_CHAT_URL)).toBe(true);
    expect(isChatGptTemporaryChatUrl(CHATGPT_SAVED_CHAT_URL)).toBe(false);
    expect(isChatGptTemporaryChatUrl("https://example.com/?temporary-chat=true")).toBe(false);
  });
});
