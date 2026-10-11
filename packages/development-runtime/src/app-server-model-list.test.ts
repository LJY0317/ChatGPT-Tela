import { describe, expect, test } from "bun:test";
import { chatGptWebFamilyKey, chatGptWebModelId } from "@chatgpt-tela/chatgpt";
import { augmentCodexAppServerModelList } from "./app-server-model-list";

const native = {
  id: "gpt-native",
  model: "gpt-native",
  upgrade: null,
  upgradeInfo: null,
  availabilityNux: null,
  displayName: "Native",
  description: "Native model",
  modelSpecialty: null,
  hidden: false,
  supportedReasoningEfforts: [
    { reasoningEffort: "low", description: "Low" },
    { reasoningEffort: "medium", description: "Medium" },
    { reasoningEffort: "high", description: "High" },
    { reasoningEffort: "max", description: "Maximum" },
  ],
  defaultReasoningEffort: "medium",
  inputModalities: ["text", "image"],
  supportsPersonality: false,
  multiAgentVersion: "v2",
  additionalSpeedTiers: ["fast"],
  serviceTiers: [{ id: "priority", name: "Fast", description: "Fast" }],
  defaultServiceTier: "priority",
  availableAccessPrograms: { cyber: ["standard"] },
  isDefault: true,
};

describe("Codex app-server model/list augmentation", () => {
  test("preserves Native rows exactly and appends current Web family choices", () => {
    const before = { data: [native], nextCursor: null, future: { keep: true } };
    const snapshot = structuredClone(before);
    const key = chatGptWebFamilyKey("GPT 5.6 Sol");
    const result = augmentCodexAppServerModelList(before, [{
      key,
      label: "GPT 5.6 Sol",
      availableEfforts: ["low", "medium", "high", "max"],
    }]);
    expect(before).toEqual(snapshot);
    expect(result.future).toEqual({ keep: true });
    expect((result.data as any[])[0]).toEqual(native);
    expect((result.data as any[])[1]).toMatchObject({
      id: chatGptWebModelId(key),
      model: chatGptWebModelId(key),
      displayName: "GPT 5.6 Sol (Web)",
      hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Low" },
        { reasoningEffort: "medium", description: "Medium" },
        { reasoningEffort: "high", description: "High" },
        { reasoningEffort: "max", description: "Maximum" },
      ],
      defaultReasoningEffort: "high",
      inputModalities: ["text"],
      additionalSpeedTiers: [],
      serviceTiers: [],
      defaultServiceTier: null,
      availableAccessPrograms: null,
      isDefault: false,
      multiAgentVersion: "v2",
    });
  });

  test("replaces stale Tela rows from an earlier browser discovery", () => {
    const key = chatGptWebFamilyKey("Current");
    const result = augmentCodexAppServerModelList({
      data: [native, { ...native, id: "chatgpt-tela-web/family/deadbeefdeadbeefdead", model: "chatgpt-tela-web/family/deadbeefdeadbeefdead" }],
      nextCursor: null,
    }, [{ key, label: "Current", availableEfforts: ["medium"] }]);
    expect((result.data as any[]).map(item => item.model)).toEqual([
      "gpt-native",
      chatGptWebModelId(key),
    ]);
  });

  test("with no proven browser catalog, returns Native rows only", () => {
    const result = augmentCodexAppServerModelList({ data: [native], nextCursor: null }, []);
    expect(result).toEqual({ data: [native], nextCursor: null });
  });
});
