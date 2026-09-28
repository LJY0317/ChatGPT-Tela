import {
  parseChatGptWebModelId,
  type ChatGptWebModelFamily,
} from "@chatgpt-tela/chatgpt";
import { emitDiagnosticEvent } from "@chatgpt-tela/core";
import {
  forwardNativeCodexRequest,
  type NativeCodexEndpoint,
  type NativeCodexFetch,
} from "./native-passthrough";
import { augmentNativeCodexModelCatalog } from "./web-model-catalog";

const DEFAULT_CATALOG_TTL_MS = 30_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function requestModel(request: Request): Promise<string | undefined> {
  if (request.method !== "POST") return undefined;
  try {
    const parsed = record(await request.clone().json());
    return typeof parsed?.model === "string" ? parsed.model : undefined;
  } catch {
    return undefined;
  }
}

function endpointFor(pathname: string): NativeCodexEndpoint | undefined {
  if (pathname === "/v1/models") return "models";
  if (pathname === "/v1/responses") return "responses";
  if (pathname === "/v1/responses/compact") return "responses/compact";
  if (pathname === "/v1/alpha/search") return "alpha/search";
  if (pathname === "/v1/images/generations") return "images/generations";
  if (pathname === "/v1/images/edits") return "images/edits";
  return undefined;
}

function jsonResponse(value: unknown, upstream: Response): Response {
  const headers = new Headers(upstream.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(`${JSON.stringify(value)}\n`, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

export interface DefaultProfileCompositeProviderRouter {
  route(request: Request): Promise<Response | undefined>;
  refreshWebModelFamilies(signal?: AbortSignal): Promise<readonly ChatGptWebModelFamily[]>;
  readonly cachedWebModelFamilies: readonly ChatGptWebModelFamily[];
}

/**
 * Single-provider router used by the built-in default Desktop profile.
 *
 * Native model ids keep using OpenAI's first-party Codex backend. Only Tela's explicit synthetic
 * Web namespace enters the browser exact-turn gateway. Model discovery is on-demand/single-flight;
 * a transient browser discovery failure removes Web rows but never rewrites or suppresses Native
 * catalog entries.
 */
export function createDefaultProfileCompositeProviderRouter(input: {
  readonly runtimeHeaderName: string;
  readonly discoverWebModelFamilies: (signal?: AbortSignal) => Promise<readonly ChatGptWebModelFamily[]>;
  readonly fetchUpstream?: NativeCodexFetch;
  readonly backendBaseUrl?: string;
  readonly catalogTtlMs?: number;
  readonly now?: () => number;
}): DefaultProfileCompositeProviderRouter {
  const ttlMs = input.catalogTtlMs ?? DEFAULT_CATALOG_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) throw new Error("Web model catalog TTL must be a non-negative safe integer");
  let cached: readonly ChatGptWebModelFamily[] = Object.freeze([]);
  let cachedAt = 0;
  let inFlight: Promise<readonly ChatGptWebModelFamily[]> | undefined;
  const now = input.now ?? Date.now;

  const refresh = (signal?: AbortSignal): Promise<readonly ChatGptWebModelFamily[]> => {
    if (inFlight) return inFlight;
    const operation = (async () => {
      try {
        const observed = Object.freeze([...(await input.discoverWebModelFamilies(signal))]);
        cached = observed;
        cachedAt = now();
        emitDiagnosticEvent("chatgpt_tela_work", "web_model_catalog_ready", { family_count: cached.length });
        return cached;
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown";
        const failureCode = message.includes("timed out waiting for control") ? "picker_control_timeout"
          : message.includes("timed out waiting for menu-open") ? "picker_menu_timeout"
            : message.includes("timed out waiting for advanced-families") ? "picker_advanced_timeout"
              : message.includes("effort slider") ? "picker_effort_slider"
                : message.includes("family") ? "picker_family"
                  : "picker_other";
        emitDiagnosticEvent("chatgpt_tela_work", "web_model_catalog_unavailable", {
          had_cached_catalog: cached.length > 0,
          failure_code: failureCode,
        });
        // A missing Web catalog disables Web choices for this refresh but must never take the
        // first-party Native catalog down with it. Keep a previously proven short-lived catalog;
        // with no prior proof, expose no Web rows.
        return cached;
      }
    })();
    inFlight = operation;
    void operation.finally(() => {
      if (inFlight === operation) inFlight = undefined;
    }).catch(() => {});
    return operation;
  };

  const currentFamilies = (signal?: AbortSignal): Promise<readonly ChatGptWebModelFamily[]> => {
    if (cachedAt > 0 && now() - cachedAt <= ttlMs) return Promise.resolve(cached);
    return refresh(signal);
  };

  const native = (request: Request, endpoint: NativeCodexEndpoint): Promise<Response> => (
    forwardNativeCodexRequest({
      request,
      endpoint,
      runtimeHeaderName: input.runtimeHeaderName,
      ...(input.fetchUpstream ? { fetchUpstream: input.fetchUpstream } : {}),
      ...(input.backendBaseUrl ? { backendBaseUrl: input.backendBaseUrl } : {}),
    })
  );

  return Object.freeze({
    get cachedWebModelFamilies() { return cached; },
    refreshWebModelFamilies: refresh,
    async route(request: Request) {
      const endpoint = endpointFor(new URL(request.url).pathname);
      if (!endpoint) return undefined;
      if (endpoint === "responses") {
        const model = await requestModel(request);
        if (model && parseChatGptWebModelId(model)) return undefined;
        return native(request, endpoint);
      }
      if (endpoint !== "models") return native(request, endpoint);

      const upstream = await native(request, "models");
      if (!upstream.ok) {
        emitDiagnosticEvent("chatgpt_tela_work", "web_model_catalog_native_failed", {
          status: upstream.status,
        });
        return upstream;
      }
      let catalog: unknown;
      try { catalog = await upstream.json(); }
      catch { throw new Error("Native Codex model catalog response was not valid JSON"); }
      const families = await currentFamilies(request.signal);
      const nativeCount = record(catalog)?.models;
      const augmented = augmentNativeCodexModelCatalog(catalog, families);
      const totalCount = Array.isArray(augmented.models) ? augmented.models.length : 0;
      emitDiagnosticEvent("chatgpt_tela_work", "web_model_catalog_served", {
        native_model_count: Array.isArray(nativeCount) ? nativeCount.length : 0,
        family_count: families.length,
        total_model_count: totalCount,
      });
      return jsonResponse(augmented, upstream);
    },
  });
}
