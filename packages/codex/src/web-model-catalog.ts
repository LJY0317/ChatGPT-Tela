import type { CodexAppServerRpc } from "./app-server";
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid model catalog response");
  return value as Record<string, unknown>;
}
/** Read-only, on-demand proof of the effective catalog and visible Tela model rows. */
export async function readVisibleWebModelCatalog(rpc: Pick<CodexAppServerRpc, "request">, signal: AbortSignal): Promise<readonly string[]> {
  const config = object(object(await rpc.request("config/read", { includeLayers: false }, signal)).config);
  if (typeof config.model_catalog_json !== "string" || !config.model_catalog_json.trim()) throw new Error("Web model startup catalog is not active");
  return readDynamicWebModelCatalog(rpc, signal);
}

/** Read the engine-owned dynamic list without requiring a Tela startup file. */
export async function readDynamicWebModelCatalog(rpc: Pick<CodexAppServerRpc, "request">, signal: AbortSignal): Promise<readonly string[]> {
  return visibleWebModels(await rpc.request("model/list", { includeHidden: true }, signal));
}

function visibleWebModels(value: unknown): readonly string[] {
  const list = object(value);
  if (!Array.isArray(list.data) || list.nextCursor) throw new Error("Web model list is incomplete");
  const models = list.data.map(object).filter(model => model.hidden !== true
    && typeof model.model === "string" && model.model.startsWith("chatgpt-tela-web/"))
    .map(model => model.model as string);
  if (!models.length || new Set(models).size !== models.length) throw new Error("Web model catalog has no complete visible choices");
  return Object.freeze(models);
}

/** Tela-owned experimental engine extension, not an upstream RPC.
 * Call once after an admitted catalog change, never from ordinary inventory polling.
 * A valid response can contain the official last-good fallback: require exact admitted IDs.
 * Unsupported engines reject the method; never retry, edit caches or restart Native here.
 */
export async function refreshAdmittedWebModelCatalog(
  rpc: Pick<CodexAppServerRpc, "request">,
  admittedIds: readonly string[],
  signal: AbortSignal,
): Promise<readonly string[]> {
  if (!admittedIds.length || new Set(admittedIds).size !== admittedIds.length
    || admittedIds.some(id => !id.startsWith("chatgpt-tela-web/"))) throw new Error("Invalid admitted Web catalog");
  const response = object(await rpc.request("tela/modelCatalog/refresh", { includeHidden: true }, signal));
  if (response.contractVersion !== 1) throw new Error("Unsupported Tela catalog refresh contract");
  const visible = visibleWebModels(response.catalog);
  if (visible.length !== admittedIds.length || !admittedIds.every(id => visible.includes(id))) {
    throw new Error("Engine catalog does not match admitted Web models");
  }
  return visible;
}
