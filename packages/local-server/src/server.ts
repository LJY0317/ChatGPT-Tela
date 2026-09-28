import { randomBytes, timingSafeEqual } from "node:crypto";
import { startWebHttpServer } from "@chatgpt-tela/http-host";
import type { NativeResponsesGateway } from "@chatgpt-tela/runtime";
import { handleNativeResponsesHttp } from "@chatgpt-tela/responses";

const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;

export interface LocalResponsesServer {
  readonly hostname: string;
  readonly port: number;
  /** OpenAI-compatible provider base URL. Native Codex appends `/responses`. */
  readonly baseUrl: URL;
  readonly runtimeToken: string;
  stop(): Promise<void>;
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return undefined;
  const token = authorization.slice("Bearer ".length).trim();
  return token.length > 0 ? token : undefined;
}

function sameSecret(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function unauthorized(): Response {
  return Response.json({
    error: { type: "authentication_error", message: "Invalid ChatGPT Tela runtime authorization" },
  }, {
    status: 401,
    headers: { "www-authenticate": "Bearer" },
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
 * requests, and delegates all turn semantics to NativeResponsesGateway. The server owns transport
 * lifecycle only; it has no independent task/tool state machine or background poller.
 */
export async function startLocalResponsesServer(input: {
  readonly gateway: NativeResponsesGateway;
  readonly hostname?: string;
  readonly port?: number;
  readonly runtimeToken?: string;
  readonly maxRequestBodyBytes?: number;
}): Promise<LocalResponsesServer> {
  const hostname = input.hostname ?? DEFAULT_HOSTNAME;
  const runtimeToken = input.runtimeToken ?? randomBytes(32).toString("base64url");
  if (runtimeToken.length < 32) throw new Error("ChatGPT Tela runtime token must contain at least 32 characters");
  const maxRequestBodyBytes = input.maxRequestBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxRequestBodyBytes) || maxRequestBodyBytes < 1) {
    throw new Error("maxRequestBodyBytes must be a positive safe integer");
  }

  const server = await startWebHttpServer({
    hostname,
    port: input.port ?? 0,
    maxRequestBodyBytes,
    requestTooLarge: tooLarge,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/v1/responses") return new Response(null, { status: 404 });
      if (request.headers.has("origin")) return forbiddenBrowserOrigin();
      if (!sameSecret(bearerToken(request), runtimeToken)) return unauthorized();

      const length = request.headers.get("content-length");
      if (length !== null) {
        const bytes = Number(length);
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxRequestBodyBytes) return tooLarge();
      }
      return handleNativeResponsesHttp(request, input.gateway);
    },
  });

  const port = server.port;
  const baseUrl = new URL(`http://${hostname}:${port}/v1/`);
  let stopped = false;

  return Object.freeze({
    hostname,
    port,
    baseUrl,
    runtimeToken,
    async stop() {
      if (stopped) return;
      stopped = true;
      await server.stop();
    },
  });
}
