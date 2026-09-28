import {
  chatGptWebModelId,
  type ChatGptWebEffort,
  type ChatGptWebModelFamily,
} from "@chatgpt-tela/chatgpt";
import { emitDiagnosticEvent } from "@chatgpt-tela/core";

type JsonObject = Record<string, unknown>;

function record(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function nativeTemplate(data: readonly unknown[]): JsonObject {
  for (const value of data) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as JsonObject;
    const model = typeof item.model === "string" ? item.model : undefined;
    if (!model || model.startsWith("chatgpt-tela-web/")) continue;
    if (item.hidden === true) continue;
    if (!Array.isArray(item.supportedReasoningEfforts) || item.supportedReasoningEfforts.length === 0) continue;
    return item;
  }
  throw new Error("Codex app-server model/list has no visible reasoning-capable Native template");
}

function defaultEffort(efforts: readonly ChatGptWebEffort[]): ChatGptWebEffort {
  for (const preferred of ["high", "medium", "xhigh", "low", "max"] as const) {
    if (efforts.includes(preferred)) return preferred;
  }
  throw new Error("ChatGPT Web model family has no available effort");
}

function effortDescription(template: JsonObject, effort: ChatGptWebEffort, label: string): string {
  const options = Array.isArray(template.supportedReasoningEfforts)
    ? template.supportedReasoningEfforts
    : [];
  for (const value of options) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as JsonObject;
    if (item.reasoningEffort === effort && typeof item.description === "string" && item.description.trim()) {
      return item.description;
    }
  }
  const display = effort === "xhigh" ? "Extra High" : effort === "max"
    ? "Max"
    : `${effort[0]!.toUpperCase()}${effort.slice(1)}`;
  return `${label} — ${display}`;
}

function webModel(template: JsonObject, family: ChatGptWebModelFamily): JsonObject {
  if (!/^[a-f0-9]{20}$/.test(family.key)) throw new Error("ChatGPT Web family key is invalid");
  if (!family.label.trim()) throw new Error("ChatGPT Web family label is empty");
  if (family.availableEfforts.length === 0
    || new Set(family.availableEfforts).size !== family.availableEfforts.length) {
    throw new Error("ChatGPT Web family effort availability is invalid");
  }
  const id = chatGptWebModelId(family.key);
  return {
    ...structuredClone(template),
    id,
    model: id,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: `${family.label} (Web)`,
    description: `${family.label} through the authenticated ChatGPT Web surface managed by ChatGPT Tela.`,
    modelSpecialty: null,
    hidden: false,
    supportedReasoningEfforts: family.availableEfforts.map(reasoningEffort => ({
      reasoningEffort,
      description: effortDescription(template, reasoningEffort, family.label),
    })),
    defaultReasoningEffort: defaultEffort(family.availableEfforts),
    inputModalities: ["text"],
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    availableAccessPrograms: null,
    isDefault: false,
  };
}

/**
 * Add explicit ChatGPT Web choices at the app-server boundary already owned by Tela.
 *
 * This is intentionally separate from provider `/models`: some Desktop-bundled Codex builds keep
 * their retained Native model catalog even when a custom provider supplies `model_catalog_url`.
 * Native app-server rows are preserved exactly and only Tela's prior synthetic namespace is
 * replaced by the current live browser-family projection.
 */
export function augmentCodexAppServerModelList(
  value: unknown,
  families: readonly ChatGptWebModelFamily[],
): JsonObject {
  const response = record(value, "Codex app-server model/list result");
  if (!Array.isArray(response.data)) throw new Error("Codex app-server model/list result is missing data");
  const native = response.data.filter(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return true;
    const item = value as JsonObject;
    return !(typeof item.model === "string" && item.model.startsWith("chatgpt-tela-web/"));
  }).map(value => structuredClone(value));
  if (families.length === 0) return { ...structuredClone(response), data: native };
  const template = nativeTemplate(native);
  const seen = new Set<string>();
  const web = families.map(family => {
    if (seen.has(family.key)) throw new Error("ChatGPT Web family discovery returned a duplicate identity");
    seen.add(family.key);
    return webModel(template, family);
  });
  emitDiagnosticEvent("chatgpt_tela_work", "app_server_model_list_augmented", {
    native_model_count: native.length,
    web_model_count: web.length,
    total_model_count: native.length + web.length,
  });
  return {
    ...structuredClone(response),
    data: [...native, ...web],
  };
}
