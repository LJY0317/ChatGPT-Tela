import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { startWebHttpServer } from "@chatgpt-tela/http-host";
import type { TurnCapabilityResolver } from "@chatgpt-tela/runtime";
import { createDevelopmentMcpServer } from "./development-server";
import {
  createCodexBridgeMcpServer,
  createCodexBridgeMcpServerForBridge,
} from "./codex-bridge-server";
import type { TurnBridgeBackend } from "./turn-bridge";

const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_PATH = "/mcp";
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_SESSIONS = 16;

export type McpHttpAuthentication =
  | { readonly kind: "none" }
  | { readonly kind: "bearer"; readonly token?: string };

export interface McpHttpServer {
  readonly hostname: string;
  readonly port: number;
  readonly endpointUrl: URL;
  readonly authentication: "none" | "bearer";
  readonly bearerToken?: string;
  readonly activeSessionCount: number;
  stop(): Promise<void>;
}

interface SessionEntry {
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly server: McpServer;
  closed: boolean;
}

export type DevelopmentMcpHttpAuthentication = McpHttpAuthentication;
export type DevelopmentMcpHttpServer = McpHttpServer;
export type CodexBridgeMcpHttpAuthentication = McpHttpAuthentication;
export type CodexBridgeMcpHttpServer = McpHttpServer;
export type CustomMcpHttpAuthentication = McpHttpAuthentication;
export type CustomMcpHttpServer = McpHttpServer;

function errorResponse(status: number, message: string): Response {
  return Response.json({
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  }, { status });
}

function bearer(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return undefined;
  const token = authorization.slice("Bearer ".length).trim();
  return token || undefined;
}

function sameSecret(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function normalizePath(value: string | undefined): string {
  const path = value ?? DEFAULT_PATH;
  if (!path.startsWith("/") || path.includes("?") || path.includes("#") || path.includes("\u0000")) {
    throw new Error("MCP HTTP path must be an absolute URL pathname");
  }
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/**
 * Start ChatGPT Tela's development MCP Streamable HTTP endpoint.
 *
 * Each MCP session gets its own SDK transport/server pair while all pairs share the exact same
 * ActiveTurnRegistry. Session storage is bounded and event-driven; there is no health poller or
 * bridge-owned tool catalog. The endpoint binds loopback by default so an exposure provider (Secure
 * Tunnel, DevSpace/Tailscale Funnel, or another HTTPS gateway) can own public reachability separately.
 */
async function startMcpHttpServer(input: {
  readonly createServer: () => McpServer;
  readonly label: string;
  readonly hostname?: string;
  readonly port?: number;
  readonly path?: string;
  readonly authentication?: McpHttpAuthentication;
  readonly maxRequestBodyBytes?: number;
  readonly maxSessions?: number;
}): Promise<McpHttpServer> {
  const hostname = input.hostname ?? DEFAULT_HOSTNAME;
  const path = normalizePath(input.path);
  const maxRequestBodyBytes = input.maxRequestBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxSessions = input.maxSessions ?? DEFAULT_MAX_SESSIONS;
  if (!Number.isSafeInteger(maxRequestBodyBytes) || maxRequestBodyBytes < 1) {
    throw new Error(`${input.label} MCP maxRequestBodyBytes must be a positive safe integer`);
  }
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 1) {
    throw new Error(`${input.label} MCP maxSessions must be a positive safe integer`);
  }

  const requestedAuth = input.authentication ?? { kind: "bearer" as const };
  const bearerToken = requestedAuth.kind === "bearer"
    ? requestedAuth.token ?? randomBytes(32).toString("base64url")
    : undefined;
  if (bearerToken !== undefined && bearerToken.length < 32) {
    throw new Error(`${input.label} MCP bearer token must contain at least 32 characters`);
  }

  const sessions = new Map<string, SessionEntry>();
  let pendingInitializations = 0;
  let stopped = false;

  const closeEntry = async (sessionId: string, entry: SessionEntry): Promise<void> => {
    if (entry.closed) return;
    entry.closed = true;
    if (sessions.get(sessionId) === entry) sessions.delete(sessionId);
    await Promise.allSettled([entry.transport.close(), entry.server.close()]);
  };

  const createSession = async (): Promise<SessionEntry> => {
    const server = input.createServer();
    let entry: SessionEntry | undefined;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      maxRequestBodySize: maxRequestBodyBytes,
      keepAliveMs: 15_000,
      onsessioninitialized(sessionId) {
        if (!entry) throw new Error(`${input.label} MCP session initialized before ownership was ready`);
        sessions.set(sessionId, entry);
      },
    });
    entry = { transport, server, closed: false };
    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (!sessionId) return;
      const owned = sessions.get(sessionId);
      if (owned === entry) {
        sessions.delete(sessionId);
        entry!.closed = true;
        void server.close().catch(() => {});
      }
    };
    try {
      await server.connect(transport);
      return entry;
    } catch (error) {
      entry.closed = true;
      await Promise.allSettled([transport.close(), server.close()]);
      throw error;
    }
  };

  const webServer = await startWebHttpServer({
    hostname,
    port: input.port ?? 0,
    maxRequestBodyBytes,
    requestTooLarge: () => errorResponse(413, "MCP request body is too large"),
    async fetch(request) {
      if (stopped) return errorResponse(503, `ChatGPT Tela ${input.label} MCP server is stopping`);
      const url = new URL(request.url);
      if (url.pathname !== path) return new Response(null, { status: 404 });
      if (request.headers.has("origin")) return errorResponse(403, "Browser-origin MCP requests are not accepted");
      if (bearerToken !== undefined && !sameSecret(bearer(request), bearerToken)) {
        return Response.json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Invalid ChatGPT Tela MCP authorization" },
          id: null,
        }, { status: 401, headers: { "www-authenticate": "Bearer" } });
      }

      const sessionId = request.headers.get("mcp-session-id") ?? undefined;
      let parsedBody: unknown;
      if (request.method === "POST") {
        try {
          parsedBody = await request.json();
        } catch {
          return errorResponse(400, "MCP request body must be valid JSON");
        }
      }

      if (sessionId) {
        const entry = sessions.get(sessionId);
        if (!entry || entry.closed) return errorResponse(404, "Unknown or closed MCP session");
        return entry.transport.handleRequest(
          request,
          request.method === "POST" ? { parsedBody } : undefined,
        );
      }

      if (request.method !== "POST" || !isInitializeRequest(parsedBody)) {
        return errorResponse(400, "MCP request requires a valid session or initialize request");
      }

      if (sessions.size + pendingInitializations >= maxSessions) {
        return errorResponse(503, `${input.label} MCP session capacity reached`);
      }
      pendingInitializations += 1;

      let entry: SessionEntry;
      try {
        entry = await createSession();
        const response = await entry.transport.handleRequest(request, { parsedBody });
        if (!entry.transport.sessionId) {
          entry.closed = true;
          await Promise.allSettled([entry.transport.close(), entry.server.close()]);
        }
        return response;
      } catch (error) {
        return errorResponse(503, error instanceof Error ? error.message : "Unable to create MCP session");
      } finally {
        pendingInitializations -= 1;
      }
    },
  });

  const port = webServer.port;
  const endpointUrl = new URL(`http://${hostname}:${port}${path}`);

  return {
    hostname,
    port,
    endpointUrl,
    authentication: bearerToken === undefined ? "none" : "bearer",
    ...(bearerToken !== undefined ? { bearerToken } : {}),
    get activeSessionCount() { return sessions.size; },
    async stop() {
      if (stopped) return;
      stopped = true;
      await webServer.stop();
      const owned = [...sessions.entries()];
      sessions.clear();
      await Promise.allSettled(owned.map(([sessionId, entry]) => closeEntry(sessionId, entry)));
    },
  };
}

export async function startCustomMcpHttpServer(input: {
  readonly createServer: () => McpServer;
  readonly label: string;
  readonly hostname?: string;
  readonly port?: number;
  readonly path?: string;
  readonly authentication?: CustomMcpHttpAuthentication;
  readonly maxRequestBodyBytes?: number;
  readonly maxSessions?: number;
}): Promise<CustomMcpHttpServer> {
  return startMcpHttpServer(input);
}

export async function startDevelopmentMcpHttpServer(input: {
  readonly turns: TurnCapabilityResolver;
  readonly hostname?: string;
  readonly port?: number;
  readonly path?: string;
  readonly authentication?: DevelopmentMcpHttpAuthentication;
  readonly maxRequestBodyBytes?: number;
  readonly maxSessions?: number;
}): Promise<DevelopmentMcpHttpServer> {
  return startMcpHttpServer({
    ...input,
    createServer: () => createDevelopmentMcpServer(input.turns),
    label: "development",
  });
}

export async function startCodexBridgeMcpHttpServer(input: ({
  readonly turns: TurnCapabilityResolver;
  readonly bridge?: never;
} | {
  readonly bridge: TurnBridgeBackend;
  readonly turns?: never;
}) & {
  readonly hostname?: string;
  readonly port?: number;
  readonly path?: string;
  readonly authentication?: CodexBridgeMcpHttpAuthentication;
  readonly maxRequestBodyBytes?: number;
  readonly maxSessions?: number;
}): Promise<CodexBridgeMcpHttpServer> {
  return startMcpHttpServer({
    ...input,
    createServer: () => input.bridge
      ? createCodexBridgeMcpServerForBridge(input.bridge)
      : createCodexBridgeMcpServer(input.turns),
    label: "codex-bridge",
  });
}
