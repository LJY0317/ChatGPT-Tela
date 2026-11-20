import {
  parseChatGptWebModelId,
  type ChatGptWebModelFamily,
} from "@chatgpt-tela/chatgpt";
import { emitDiagnosticEvent } from "@chatgpt-tela/core";
import { createHash } from "node:crypto";
import {
  forwardNativeCodexRequest,
  type NativeCodexEndpoint,
  type NativeCodexFetch,
} from "./native-passthrough";
import { augmentNativeCodexModelCatalog } from "./web-model-catalog";

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

function unavailableWebCompaction(): Response {
  emitDiagnosticEvent("chatgpt_tela_work", "web_remote_compaction_unavailable");
  return Response.json({
    error: {
      type: "invalid_request_error",
      code: "tela_web_compaction_unsupported",
      message: "This legacy compaction endpoint is unsupported for Web models. Use an engine with Responses compaction-v2 or compact with a Native model. Native usage limits apply; this request did not change conversation history.",
    },
  // A capability mismatch is an invalid request, not a transient server failure.
  }, { status: 400 });
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
  const body = `${JSON.stringify(value)}\n`;
  const headers = new Headers(upstream.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.set("etag", `W/"${createHash("sha256").update(body).digest("base64url")}"`);
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

export interface DefaultProfileCompositeProviderRouter {
  route(request: Request): Promise<Response | undefined>;
}

/**
 * Single-provider router used by the built-in default Desktop profile.
 *
 * Native model ids keep using OpenAI's first-party Codex backend. Only Tela's explicit synthetic
 * Web namespace enters the browser exact-turn gateway. Catalog reads project the Web families
 * already verified by the current connection.
 */
export function createDefaultProfileCompositeProviderRouter(input: {
  readonly runtimeHeaderName: string;
  readonly webModelFamilies?: () => readonly ChatGptWebModelFamily[];
  readonly fetchUpstream?: NativeCodexFetch;
  readonly backendBaseUrl?: string;
  /** Granted only when this profile launches the verified owned engine. */
  readonly localCompaction?: boolean;
}): DefaultProfileCompositeProviderRouter {
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
    async route(request: Request) {
      const endpoint = endpointFor(new URL(request.url).pathname);
      if (!endpoint) return undefined;
      if (endpoint === "responses") {
        const model = await requestModel(request);
        if (model && parseChatGptWebModelId(model)) {
          return undefined;
        }
        return native(request, endpoint);
      }
      if (endpoint === "responses/compact") {
        const model = await requestModel(request);
        if (model && parseChatGptWebModelId(model)) {
          return unavailableWebCompaction();
        }
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
      const families = input.webModelFamilies?.() ?? [];
      const nativeCount = record(catalog)?.models;
      let augmented: unknown;
      try {
        augmented = augmentNativeCodexModelCatalog(catalog, families, { localCompaction: input.localCompaction === true });
      } catch {
        emitDiagnosticEvent("chatgpt_tela_work", "web_model_catalog_augmentation_failed");
        // The first-party catalog is still authoritative when the optional Web projection fails.
        return jsonResponse(catalog, upstream);
      }
      const totalModels = record(augmented)?.models;
      const totalCount = Array.isArray(totalModels) ? totalModels.length : 0;
      emitDiagnosticEvent("chatgpt_tela_work", "web_model_catalog_served", {
        native_model_count: Array.isArray(nativeCount) ? nativeCount.length : 0,
        family_count: families.length,
        total_model_count: totalCount,
      });
      return jsonResponse(augmented, upstream);
    },
  });
}
