import { randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { zstdDecompress } from "node:zlib";
import { startWebHttpServer } from "@chatgpt-tela/http-host";
import type { NativeResponsesGateway } from "@chatgpt-tela/runtime";
import { handleNativeResponsesHttp } from "@chatgpt-tela/responses";

const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;
const decompressZstd = promisify(zstdDecompress);

/** Decode at the authenticated ingress, before either provider routing or Web JSON parsing. */
async function decodedRequest(request: Request, maxBytes: number): Promise<Request | Response> {
  const encoding = request.headers.get("content-encoding")?.trim().toLowerCase();
  if (!encoding || encoding === "identity") return request;
  if (encoding !== "zstd") {
    return Response.json({
      error: { type: "invalid_request_error", message: "Unsupported request content encoding" },
    }, { status: 415 });
  }
  let body: Buffer;
  try {
    body = await decompressZstd(Buffer.from(await request.arrayBuffer()), { maxOutputLength: maxBytes });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ERR_BUFFER_TOO_LARGE") return tooLarge();
    return Response.json({
      error: { type: "invalid_request_error", message: "Invalid compressed request body" },
    }, { status: 400 });
  }
  const headers = new Headers(request.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Request(request, { headers, body: Uint8Array.from(body).buffer });
}

export interface LocalResponsesServer {
  readonly hostname: string;
  readonly port: number;
  /** OpenAI-compatible provider base URL. Native Codex appends `/responses`. */
  readonly baseUrl: URL;
  readonly runtimeToken: string;
  /** Same authenticated ingress as HTTP, for in-process dispatch without a second socket. */
  handleRequest(request: Request): Promise<Response>;
  stop(): Promise<void>;
}

export type LocalResponsesAuthentication =
  | { readonly kind: "bearer" }
  | { readonly kind: "header"; readonly name: string };

export type LocalResponsesRequestRouter = (request: Request) => Promise<Response | undefined>;

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return undefined;
  const token = authorization.slice("Bearer ".length).trim();
  return token.length > 0 ? token : undefined;
}

function headerToken(request: Request, name: string): string | undefined {
  const value = request.headers.get(name)?.trim();
  return value ? value : undefined;
}

function authenticationToken(
  request: Request,
  authentication: LocalResponsesAuthentication,
): string | undefined {
  return authentication.kind === "bearer"
    ? bearerToken(request)
    : headerToken(request, authentication.name);
}

function sameSecret(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function unauthorized(authentication: LocalResponsesAuthentication): Response {
  return Response.json({
    error: { type: "authentication_error", message: "Invalid ChatGPT Tela runtime authorization" },
  }, {
    status: 401,
    ...(authentication.kind === "bearer" ? { headers: { "www-authenticate": "Bearer" } } : {}),
  });
}

function tooLarge(): Response {
  return Response.json({
    error: { type: "invalid_request_error", message: "Native Responses request body is too large" },
  }, { status: 413 });
}

function forbiddenBrowserOrigin(): Response {
  return Response.json({
    error: { type: "forbidden", message: "Browser-origin requests are not accepted by the local Native endpoint" },
  }, { status: 403 });
}

/**
 * Start ChatGPT Tela's local Native Responses endpoint.
 *
 * It binds loopback by default, requires an unguessable bearer capability, rejects browser-origin
 * requests, and delegates turn semantics to NativeResponsesGateway or an explicit product router. The server owns transport
 * lifecycle only; it has no independent task/tool state machine or background poller.
 */
export async function startLocalResponsesServer(input: {
  /** Omit only for an explicit router that owns all dispatch; unhandled requests fail closed. */
  readonly gateway?: NativeResponsesGateway;
  readonly hostname?: string;
  readonly port?: number;
  readonly runtimeToken?: string;
  readonly authentication?: LocalResponsesAuthentication;
  /**
   * Optional product-owned routing hook. Returning a Response handles the request without entering
   * the Web gateway; returning undefined delegates `/v1/responses` to the normal exact-turn path.
   * The hook receives a clone so inspection cannot consume the gateway's request body.
   */
  readonly requestRouter?: LocalResponsesRequestRouter;
  readonly maxRequestBodyBytes?: number;
}): Promise<LocalResponsesServer> {
  if (!input.gateway && !input.requestRouter) throw new Error("Responses server requires a gateway or explicit router");
  const hostname = input.hostname ?? DEFAULT_HOSTNAME;
  const runtimeToken = input.runtimeToken ?? randomBytes(32).toString("base64url");
  if (runtimeToken.length < 32) throw new Error("ChatGPT Tela runtime token must contain at least 32 characters");
  const authentication = input.authentication ?? Object.freeze({ kind: "bearer" as const });
  if (authentication.kind === "header"
    && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(authentication.name)) {
    throw new Error("ChatGPT Tela runtime authentication header is invalid");
  }
  const maxRequestBodyBytes = input.maxRequestBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxRequestBodyBytes) || maxRequestBodyBytes < 1) {
    throw new Error("maxRequestBodyBytes must be a positive safe integer");
  }

  let stopped = false;
  const handleRequest = async (request: Request): Promise<Response> => {
    if (stopped) return Response.json({ error: { code: "tela_responses_closed", message: "Tela Responses ingress is closed" } }, { status: 503 });
    request.signal.throwIfAborted();
    const url = new URL(request.url);
    if (request.headers.has("origin")) return forbiddenBrowserOrigin();
    if (!sameSecret(authenticationToken(request, authentication), runtimeToken)) {
      return unauthorized(authentication);
    }
    if (url.pathname === "/v1/responses" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      // Codex's built-in openai provider advertises WebSocket support. An explicit 426 makes it
      // fall back to the HTTP Responses transport that Tela implements for this local route.
      return new Response(null, { status: 426, headers: { upgrade: "websocket" } });
    }

    const length = request.headers.get("content-length");
    if (length !== null) {
      const bytes = Number(length);
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxRequestBodyBytes) return tooLarge();
    }
    const decoded = await decodedRequest(request, maxRequestBodyBytes);
    if (decoded instanceof Response) return decoded;
    if (input.requestRouter) {
      try {
        const routed = await input.requestRouter(decoded.clone());
        if (routed) return routed;
      } catch (error) {
        const message = error instanceof Error ? error.message : "product request routing failed";
        return Response.json({
          error: { type: "chatgpt_tela_route_error", message },
        }, { status: 502 });
      }
    }
    if (url.pathname !== "/v1/responses") return new Response(null, { status: 404 });
    if (!input.gateway) return new Response(null, { status: 404 });
    return handleNativeResponsesHttp(decoded, input.gateway);
  };
  const server = await startWebHttpServer({
    hostname,
    port: input.port ?? 0,
    maxRequestBodyBytes,
    requestTooLarge: tooLarge,
    fetch: handleRequest,
  });

  const port = server.port;
  const baseUrl = new URL(`http://${hostname}:${port}/v1/`);

  return Object.freeze({
    hostname,
    port,
    baseUrl,
    runtimeToken,
    handleRequest,
    async stop() {
      if (stopped) return;
      stopped = true;
      await server.stop();
    },
  });
}
