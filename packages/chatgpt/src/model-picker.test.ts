import { describe, expect, test } from "bun:test";
import {
  chatGptWebFamilyKey,
  chatGptWebModelId,
  parseChatGptWebModelId,
} from "./model-picker";

describe("ChatGPT Web model route identity", () => {
  test("derives one stable opaque family identity from the visible label", () => {
    const first = chatGptWebFamilyKey("  GPT 5.6   Sol ");
    const second = chatGptWebFamilyKey("GPT 5.6 Sol");
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{20}$/);
    expect(chatGptWebModelId(first)).toBe(`chatgpt-tela-web/family/${first}`);
    expect(parseChatGptWebModelId(chatGptWebModelId(first))).toEqual({ familyKey: first });
  });

  test("native model ids remain outside the Web route namespace and malformed Web ids fail closed", () => {
    expect(parseChatGptWebModelId("gpt-native-model")).toBeUndefined();
    expect(() => parseChatGptWebModelId("chatgpt-tela-web/family/not-a-key")).toThrow("malformed");
  });
});
