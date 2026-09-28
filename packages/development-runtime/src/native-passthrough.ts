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
    && /^(?:resp|msg|fc|ctc|tsc)_tela_[A-Za-z0-9_-]{24}$/.test(value);
}

/**
 * Remove only identities created by Tela before a mixed Web/native thread returns to OpenAI.
 * Native ids are opaque and are never rewritten. The full semantic item content is preserved.
 */
export function scrubTelaResponsesArtifacts(value: unknown): { readonly value: unknown; readonly changed: boolean } {
  const root = record(value);
  if (!root) return Object.freeze({ value, changed: false });
  let changed = false;
  const next: Record<string, unknown> = { ...root };
  if (telaOwnedId(next.previous_response_id)) {
    delete next.previous_response_id;
    changed = true;
  }
  if (Array.isArray(root.input)) {
    next.input = root.input.map(item => {
      const source = record(item);
      if (!source || !telaOwnedId(source.id)) return item;
      const clean = { ...source };
      delete clean.id;
      changed = true;
      return clean;
    });
  }
  return Object.freeze({ value: changed ? next : value, changed });
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

  if (method === "POST") {
    const bytes = await input.request.arrayBuffer();
    body = bytes;
    if (input.endpoint === "responses" || input.endpoint === "responses/compact") {
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown; }
      catch { parsed = undefined; }
      if (parsed !== undefined) {
        const scrubbed = scrubTelaResponsesArtifacts(parsed);
        if (scrubbed.changed) {
          body = JSON.stringify(scrubbed.value);
          headers.delete("content-encoding");
        }
      }
    }
  }

  const target = new URL(`${backend}/${input.endpoint}`);
  target.search = incoming.search;
  const upstream = await fetchUpstream(new Request(target, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    signal: input.request.signal,
    redirect: input.endpoint.startsWith("images/") ? "manual" : "follow",
  }));
  const responseHeaders = forwardedHeaders(upstream.headers, input.runtimeHeaderName);
  if (input.endpoint.startsWith("images/")) responseHeaders.delete("content-encoding");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
