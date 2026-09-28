import { describe, expect, test } from "bun:test";
import { chatGptWebFamilyKey, chatGptWebModelId } from "@chatgpt-tela/chatgpt";
import { augmentNativeCodexModelCatalog } from "./web-model-catalog";

describe("composite Native + ChatGPT Web model catalog", () => {
  test("preserves every Native row and appends only observed Web family/effort rows", () => {
    const native = {
      object: "list",
      future_field: { preserve: true },
      models: [
        {
          slug: "native-a",
          display_name: "Native A",
          description: "native",
          visibility: "list",
          supported_in_api: true,
          default_reasoning_level: "medium",
          supported_reasoning_levels: [
            { effort: "low", description: "Low native" },
            { effort: "high", description: "High native" },
          ],
          input_modalities: ["text", "image"],
          service_tiers: [{ id: "fast" }],
          default_service_tier: "fast",
          comp_hash: "native-hash",
          tool_mode: "code",
          priority: 7,
        },
        { slug: "hidden-native", visibility: "hide", arbitrary: 42 },
      ],
    };
    const before = structuredClone(native);
    const label = "GPT 5.6 Sol";
    const key = chatGptWebFamilyKey(label);
    const result = augmentNativeCodexModelCatalog(native, [{
      key,
      label,
      availableEfforts: ["low", "high", "max"],
    }]);

    expect(native).toEqual(before);
    expect(result.future_field).toEqual({ preserve: true });
    expect((result.models as any[]).slice(0, 2)).toEqual(before.models);
    expect((result.models as any[])[2]).toMatchObject({
      slug: chatGptWebModelId(key),
      display_name: "GPT 5.6 Sol (Web)",
      visibility: "list",
      supported_in_api: true,
      default_reasoning_level: "high",
      supported_reasoning_levels: [
        { effort: "low", description: "Low native" },
        { effort: "high", description: "High native" },
        { effort: "max", description: "GPT 5.6 Sol — Max" },
      ],
      input_modalities: ["text"],
      service_tiers: [],
      default_service_tier: null,
      tool_mode: null,
      priority: 7,
    });
    expect((result.models as any[])[2].comp_hash).toBeUndefined();
  });

  test("removes stale Tela rows before appending the live catalog", () => {
    const key = chatGptWebFamilyKey("Current");
    const result = augmentNativeCodexModelCatalog({
      models: [
        {
          slug: "native",
          visibility: "list",
          supported_reasoning_levels: [{ effort: "medium", description: "Medium" }],
          default_reasoning_level: "medium",
        },
        { slug: "chatgpt-tela-web/family/deadbeefdeadbeefdead", visibility: "list" },
      ],
    }, [{ key, label: "Current", availableEfforts: ["medium"] }]);
    expect((result.models as any[]).map(model => model.slug)).toEqual([
      "native",
      chatGptWebModelId(key),
    ]);
  });

  test("fails closed on malformed Native catalogs or duplicate live families", () => {
    expect(() => augmentNativeCodexModelCatalog({}, [])).toThrow("missing models");
    const key = chatGptWebFamilyKey("One");
    const catalog = {
      models: [{
        slug: "native",
        visibility: "list",
        supported_reasoning_levels: [{ effort: "medium", description: "Medium" }],
      }],
    };
    expect(() => augmentNativeCodexModelCatalog(catalog, [
      { key, label: "One", availableEfforts: ["medium"] },
      { key, label: "One", availableEfforts: ["medium"] },
    ])).toThrow("duplicate family");
  });
});
