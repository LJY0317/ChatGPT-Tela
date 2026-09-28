import {
  chatGptWebModelId,
  type ChatGptWebEffort,
  type ChatGptWebModelFamily,
} from "@chatgpt-tela/chatgpt";

type JsonObject = Record<string, unknown>;

function record(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function visibleNativeTemplate(models: readonly unknown[]): JsonObject {
  for (const value of models) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const model = value as JsonObject;
    if (typeof model.slug !== "string" || !model.slug || model.slug.startsWith("chatgpt-tela-web/")) continue;
    if (model.visibility !== "list") continue;
    if (!Array.isArray(model.supported_reasoning_levels) || model.supported_reasoning_levels.length === 0) continue;
    return model;
  }
  throw new Error("Native Codex model catalog has no list-visible reasoning-capable template");
}

function effortDescription(template: JsonObject, effort: ChatGptWebEffort, label: string): string {
  const levels = Array.isArray(template.supported_reasoning_levels)
    ? template.supported_reasoning_levels
    : [];
  for (const value of levels) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const level = value as JsonObject;
    if (level.effort === effort && typeof level.description === "string" && level.description.trim()) {
      return level.description;
    }
  }
  const name = effort === "xhigh" ? "Extra High" : effort === "max" ? "Max" : `${effort[0]!.toUpperCase()}${effort.slice(1)}`;
  return `${label} — ${name}`;
}

function defaultEffort(efforts: readonly ChatGptWebEffort[]): ChatGptWebEffort {
  for (const preferred of ["high", "medium", "xhigh", "low", "max"] as const) {
    if (efforts.includes(preferred)) return preferred;
  }
  throw new Error("ChatGPT Web model family has no available effort");
}

function webModel(template: JsonObject, family: ChatGptWebModelFamily): JsonObject {
  if (family.key.length !== 20 || family.key !== family.key.toLowerCase() || !/^[a-f0-9]+$/.test(family.key)) {
    throw new Error("ChatGPT Web model family identity is invalid");
  }
  if (!family.label.trim()) throw new Error("ChatGPT Web model family label is empty");
  if (family.availableEfforts.length === 0
    || new Set(family.availableEfforts).size !== family.availableEfforts.length) {
    throw new Error("ChatGPT Web model family effort availability is invalid");
  }
  const supported = new Set<ChatGptWebEffort>(["low", "medium", "high", "xhigh", "max"]);
  if (family.availableEfforts.some(effort => !supported.has(effort))) {
    throw new Error("ChatGPT Web model family contains an unsupported effort");
  }
  const model: JsonObject = {
    ...structuredClone(template),
    slug: chatGptWebModelId(family.key),
    display_name: `${family.label} (Web)`,
    description: `${family.label} through the authenticated ChatGPT Web surface managed by ChatGPT Tela.`,
    visibility: "list",
    supported_in_api: true,
    default_reasoning_level: defaultEffort(family.availableEfforts),
    supported_reasoning_levels: family.availableEfforts.map(effort => ({
      effort,
      description: effortDescription(template, effort, family.label),
    })),
    // Tela currently proves only text reconstruction. Image/file uploads remain fail-closed until
    // the browser adapter has an exact attachment identity/readback boundary.
    input_modalities: ["text"],
    // Do not inherit native service tiers or migration metadata into a browser-backed route.
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    upgrade: null,
    availability_nux: null,
    // A native template may collapse tool semantics into a provider-specific code mode. Tela's Web
    // bridge needs ordinary Responses tool items so exact Native inventory can cross the MCP seam.
    tool_mode: null,
  };
  delete model.comp_hash;
  return model;
}

/**
 * Append live ChatGPT Web rows without rewriting any Native Codex model entry.
 *
 * This consumes the provider-facing `ModelsResponse` shape (`models` with snake_case ModelInfo),
 * not app-server's separate `model/list` camelCase response. Codex therefore remains responsible
 * for translating, sorting and presenting the current catalog to its own UI.
 */
export function augmentNativeCodexModelCatalog(
  value: unknown,
  families: readonly ChatGptWebModelFamily[],
): JsonObject {
  const catalog = record(value, "Native Codex model catalog");
  if (!Array.isArray(catalog.models)) throw new Error("Native Codex model catalog is missing models");
  const nativeModels = catalog.models.filter(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return true;
    const slug = (value as JsonObject).slug;
    return typeof slug !== "string" || !slug.startsWith("chatgpt-tela-web/");
  }).map(value => structuredClone(value));
  if (families.length === 0) return { ...structuredClone(catalog), models: nativeModels };
  const template = visibleNativeTemplate(nativeModels);
  const seen = new Set<string>();
  const webModels = families.map(family => {
    if (seen.has(family.key)) throw new Error("ChatGPT Web model discovery returned a duplicate family");
    seen.add(family.key);
    return webModel(template, family);
  });
  return {
    ...structuredClone(catalog),
    models: [...nativeModels, ...webModels],
  };
}
