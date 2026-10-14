import { classifyNetworkFailure, emitDiagnosticEvent } from "@chatgpt-tela/core";
import { diagnoseNativeFailure, nativeRequestShape } from "./native-failure-diagnostics";
import { observeNativeResponse } from "./native-reasoning-observation";
const DEFAULT_CODEX_BACKEND = "https://chatgpt.com/backend-api/codex";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

export type NativeCodexEndpoint =
  | "models"
  | "responses"
  | "responses/compact"
  | "alpha/search"
  | "images/generations"
  | "images/edits";

export type NativeCodexFetch = (request: Request) => Promise<Response>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function telaOwnedId(value: unknown): boolean {
  return typeof value === "string"
    && /^(?:resp|msg|fc|ctc|tsc|rs)_tela_[A-Za-z0-9_-]{24}$/.test(value);
}

/**
 * Remove only identities created by Tela before a mixed Web/native thread returns to OpenAI.
 * Native ids are opaque and are never rewritten. The full semantic item content is preserved.
 */
export function scrubTelaResponsesArtifacts(value: unknown): { readonly value: unknown; readonly changed: boolean;
  readonly removedReferences: number; readonly strippedItemIds: number; readonly removedDisplayItems: number } {
  const root = record(value);
  const counts = { removedReferences: 0, strippedItemIds: 0, removedDisplayItems: 0 };
  if (!root) return Object.freeze({ value, changed: false, ...counts });
  let changed = false;
  const next: Record<string, unknown> = { ...root };
  if (telaOwnedId(next.previous_response_id)) {
    delete next.previous_response_id;
    counts.removedReferences++;
    changed = true;
  }
  if (Array.isArray(root.input)) {
    next.input = root.input.flatMap(item => {
      const source = record(item);
      if (!source || !telaOwnedId(source.id)) return [item];
      // Browser-public progress has no first-party persisted reasoning state to look up.
      // Its display-only item must not become Native model input after a Web→Native switch.
      if (source.type === "reasoning" && String(source.id).startsWith("rs_tela_")) {
        counts.removedDisplayItems++;
        changed = true;
        return [];
      }
      const clean = { ...source };
      delete clean.id;
      counts.strippedItemIds++;
      changed = true;
      return [clean];
    });
  }
  return Object.freeze({ value: changed ? next : value, changed, ...counts });
}

function forwardedHeaders(source: Headers, runtimeHeaderName: string): Headers {
  const headers = new Headers();
  source.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === runtimeHeaderName.toLowerCase()) return;
    headers.append(name, value);
  });
  headers.delete("content-length");
  return headers;
}

function requireFirstPartyAuthorization(request: Request): void {
  const authorization = request.headers.get("authorization")?.trim();
  if (!authorization || authorization.length > 16_384 || /[\r\n]/.test(authorization)) {
    throw new Error("Native Codex passthrough requires first-party request authorization");
  }
}

export async function forwardNativeCodexRequest(input: {
  readonly request: Request;
  readonly endpoint: NativeCodexEndpoint;
  readonly runtimeHeaderName: string;
  readonly fetchUpstream?: NativeCodexFetch;
  readonly backendBaseUrl?: string;
}): Promise<Response> {
  requireFirstPartyAuthorization(input.request);
  const fetchUpstream = input.fetchUpstream ?? fetch;
  const backend = (input.backendBaseUrl ?? DEFAULT_CODEX_BACKEND).replace(/\/$/, "");
  const incoming = new URL(input.request.url);
  const headers = forwardedHeaders(input.request.headers, input.runtimeHeaderName);
  const method = input.endpoint === "models" ? "GET" : "POST";
  let body: BodyInit | undefined;
  let shape = nativeRequestShape(undefined);

  if (method === "POST") {
    const bytes = await input.request.arrayBuffer();
    body = bytes;
    if (input.endpoint === "responses" || input.endpoint === "responses/compact") {
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown; }
      catch { parsed = undefined; }
      if (parsed !== undefined) {
        const scrubbed = scrubTelaResponsesArtifacts(parsed);
        shape = nativeRequestShape(scrubbed.value);
        shape.fields.tela_scrubbed = scrubbed.changed;
        Object.assign(shape.fields, {
          removed_reference_count: scrubbed.removedReferences,
          stripped_item_id_count: scrubbed.strippedItemIds,
          removed_display_item_count: scrubbed.removedDisplayItems,
        });
        if (scrubbed.changed) {
          body = JSON.stringify(scrubbed.value);
          headers.delete("content-encoding");
        }
      }
      // Unchanged requests retain the original buffer; compare bytes only on the existing
      // rewrite path. No payload digest, second body read, cache or periodic work is needed.
      const forwarded = typeof body === "string" ? Buffer.from(body) : Buffer.from(bytes);
      Object.assign(shape.fields, { body_unchanged: typeof body !== "string"
        || Buffer.from(bytes).equals(forwarded), received_bytes: bytes.byteLength,
        forwarded_bytes: forwarded.byteLength });
    }
  }

  const target = new URL(`${backend}/${input.endpoint}`);
  target.search = incoming.search;
  const started = Date.now();
  let upstream: Response;
  try {
    const outgoing = new Request(target, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    signal: input.request.signal,
    redirect: input.endpoint.startsWith("images/") ? "manual" : "follow",
    });
    if (input.endpoint === "responses" || input.endpoint === "responses/compact") {
      emitDiagnosticEvent("chatgpt_tela_network", "native_dispatch_started", {
        ...shape.fields, provider_kind: "native", route_kind: input.endpoint.replaceAll("/", "_"), dispatch_count: 1,
      });
    }
    upstream = await fetchUpstream(outgoing);
  } catch (error) {
    emitDiagnosticEvent("chatgpt_tela_network", "native_backend_request_failed", {
      ...shape.fields, route_kind: input.endpoint.replaceAll("/", "_"), reason_class: classifyNetworkFailure(error),
      duration_ms: Date.now() - started, cancelled: input.request.signal.aborted,
    });
    throw error;
  }
  if (input.endpoint === "responses" || input.endpoint === "responses/compact") {
    emitDiagnosticEvent("chatgpt_tela_network", "native_dispatch_headers_received", {
      route_kind: input.endpoint.replaceAll("/", "_"), status_code: upstream.status,
      duration_ms: Date.now() - started,
    });
  }
  const responseHeaders = forwardedHeaders(upstream.headers, input.runtimeHeaderName);
  if (input.endpoint.startsWith("images/")) responseHeaders.delete("content-encoding");
  // The observer returns error bodies untouched; existing failure inspection remains authoritative.
  const responseBody = input.endpoint === "responses" ? observeNativeResponse(upstream, shape) : upstream.body;
  const diagnosedBody = upstream.status >= 400
    ? diagnoseNativeFailure(upstream, shape, input.endpoint, Date.now() - started) : responseBody;
  return new Response(diagnosedBody, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
