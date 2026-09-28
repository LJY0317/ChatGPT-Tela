import { createHash } from "node:crypto";

export const TELA_DEFAULT_DESKTOP_PROVIDER_ID = "chatgpt_tela_responses";
export const TELA_DEFAULT_DESKTOP_RUNTIME_HEADER = "X-ChatGPT-Tela-Runtime-Token";

export interface DefaultDesktopResponsesRoute {
  readonly baseUrl: string;
  readonly envKey: string;
  readonly providerId: string;
  readonly runtimeHeaderName: string;
  readonly modelCatalogUrl: string;
  readonly fingerprint: string;
}

const ROUTED_METHODS = new Set(["thread/start", "thread/resume", "thread/fork"]);

function normalizedBaseUrl(value: URL | string): string {
  const url = value instanceof URL ? new URL(value.href) : new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("default Desktop Responses route must use loopback http://");
  }
  if (!url.port) throw new Error("default Desktop Responses route must include an explicit port");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("default Desktop Responses route must not contain credentials, query, or fragment");
  }
  url.pathname = "/v1";
  return url.href.replace(/\/$/, "");
}

function environmentKey(value: string): string {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(value)) {
    throw new Error("default Desktop Responses env key is invalid");
  }
  return value;
}

export function createDefaultDesktopResponsesRoute(input: {
  readonly baseUrl: URL | string;
  readonly envKey: string;
  readonly credential: string;
}): DefaultDesktopResponsesRoute {
  if (input.credential.length < 32) throw new Error("default Desktop Responses credential is too short");
  const baseUrl = normalizedBaseUrl(input.baseUrl);
  const envKey = environmentKey(input.envKey);
  const runtimeHeaderName = TELA_DEFAULT_DESKTOP_RUNTIME_HEADER;
  const modelCatalogUrl = `${baseUrl}/models`;
  const credentialHash = createHash("sha256").update(input.credential, "utf8").digest("hex");
  const fingerprint = createHash("sha256").update(JSON.stringify({
    baseUrl,
    credentialHash,
    envKey,
    runtimeHeaderName,
    modelCatalogUrl,
    providerId: TELA_DEFAULT_DESKTOP_PROVIDER_ID,
  })).digest("hex");
  return Object.freeze({
    baseUrl,
    envKey,
    providerId: TELA_DEFAULT_DESKTOP_PROVIDER_ID,
    runtimeHeaderName,
    modelCatalogUrl,
    fingerprint,
  });
}

export function defaultDesktopCodexConfigArguments(route: DefaultDesktopResponsesRoute): readonly string[] {
  const prefix = `model_providers.${route.providerId}`;
  return Object.freeze([
    "-c", `model_provider=${JSON.stringify(route.providerId)}`,
    "-c", `${prefix}.name=${JSON.stringify("ChatGPT Tela Native + Web")}`,
    "-c", `${prefix}.base_url=${JSON.stringify(route.baseUrl)}`,
    "-c", `${prefix}.model_catalog_url=${JSON.stringify(route.modelCatalogUrl)}`,
    "-c", `${prefix}.wire_api=${JSON.stringify("responses")}`,
    "-c", `${prefix}.env_http_headers.${JSON.stringify(route.runtimeHeaderName)}=${JSON.stringify(route.envKey)}`,
    "-c", `${prefix}.requires_openai_auth=true`,
    "-c", `${prefix}.supports_websockets=false`,
  ]);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function rewriteDefaultDesktopAppServerRequest(
  message: string,
  route: DefaultDesktopResponsesRoute,
): string {
  let parsed: unknown;
  try { parsed = JSON.parse(message) as unknown; }
  catch { return message; }
  const root = record(parsed);
  if (!root || typeof root.method !== "string" || !ROUTED_METHODS.has(root.method)) return message;
  const params = record(root.params);
  if (!params) throw new Error("routed app-server request has non-object params");
  const existingConfig = params.config;
  if (existingConfig !== undefined && !record(existingConfig)) {
    throw new Error("routed app-server request has non-object config");
  }
  const config = { ...(record(existingConfig) ?? {}) };
  const existingProviders = config.model_providers;
  if (existingProviders !== undefined && !record(existingProviders)) {
    throw new Error("routed app-server request has non-object model_providers");
  }
  const providers = { ...(record(existingProviders) ?? {}) };
  providers[route.providerId] = {
    name: "ChatGPT Tela Native + Web",
    base_url: route.baseUrl,
    model_catalog_url: route.modelCatalogUrl,
    wire_api: "responses",
    env_http_headers: { [route.runtimeHeaderName]: route.envKey },
    requires_openai_auth: true,
    supports_websockets: false,
  };
  config.model_provider = route.providerId;
  config.model_providers = providers;
  const routedParams = {
    ...params,
    config,
    modelProvider: route.providerId,
  };
  return JSON.stringify({ ...root, params: routedParams });
}
