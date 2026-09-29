import { describe, expect, test } from "bun:test";
import {
  CHATGPT_SAVED_CHAT_URL,
  CHATGPT_TEMPORARY_CHAT_URL,
  isChatGptTemporaryChatUrl,
} from "./session";

describe("ChatGPT conversation surface identity", () => {
  test("keeps saved/manual setup separate from disposable Work Temporary Chat state", () => {
    expect(CHATGPT_SAVED_CHAT_URL).toBe("https://chatgpt.com/");
    expect(CHATGPT_TEMPORARY_CHAT_URL).toBe("https://chatgpt.com/?temporary-chat=true");
    expect(isChatGptTemporaryChatUrl(CHATGPT_TEMPORARY_CHAT_URL)).toBe(true);
    expect(isChatGptTemporaryChatUrl(CHATGPT_SAVED_CHAT_URL)).toBe(false);
    expect(isChatGptTemporaryChatUrl("https://example.com/?temporary-chat=true")).toBe(false);
  });
});
