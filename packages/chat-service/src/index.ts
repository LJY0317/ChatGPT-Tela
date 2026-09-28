import { randomUUID, timingSafeEqual } from "node:crypto";
import { startWebHttpServer, type WebHttpServer } from "@chatgpt-tela/http-host";
import type { ServiceStatus } from "@chatgpt-tela/service-protocol";
import { chatCapabilityCatalog } from "./capability-contracts";
import { type ChatToolRuntime, type TelaChatCapability } from "./tools";

export * from "./capability-contracts";
export * from "./changes";
export * from "./agents";
export * from "./config";
export * from "./files";
export * from "./incidents";
export * from "./openai-agent";
export * from "./patch";
export * from "./paths";
export * from "./processes";
export * from "./reviews";
export * from "./tools";
export * from "./workspaces";
export * from "./worktrees";

export interface ChatService {
  readonly instanceId: string;
  readonly endpoint: URL;
  readonly bearerToken: string;
  readonly server: WebHttpServer;
  readonly shutdownRequested: Promise<void>;
  status(): ServiceStatus;
  close(): Promise<void>;
}

function sameSecret(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function startChatService(input: {
  readonly bearerToken: string;
  readonly tools?: ChatToolRuntime;
}): Promise<ChatService> {
  if (input.bearerToken.length < 32) throw new Error("Chat service bearer token is too short");
  const instanceId = randomUUID();
  let stopping = false;
  let resolveShutdown!: () => void;
  const shutdownRequested = new Promise<void>(resolvePromise => { resolveShutdown = resolvePromise; });
  const status = (): ServiceStatus => Object.freeze({
    contractVersion: 1,
    service: "chat",
    instanceId,
    state: stopping ? "stopping" : "ready",
  });
  const server = await startWebHttpServer({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodyBytes: 4 * 1024 * 1024,
    async fetch(request) {
      if (request.headers.has("origin")) return new Response(null, { status: 403 });
      const header = request.headers.get("authorization");
      const candidate = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
      if (!sameSecret(candidate, input.bearerToken)) return new Response(null, { status: 401 });
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/v1/status") return Response.json(status());
      if (request.method === "GET" && url.pathname === "/v1/capabilities") {
        return Response.json({ contractVersion: 1, service: "chat",
          capabilities: input.tools ? input.tools.capabilities : [],
          catalog: input.tools ? chatCapabilityCatalog(input.tools.capabilities) : [] });
      }
      if (request.method === "POST" && url.pathname === "/v1/call") {
        if (!input.tools) {
          return Response.json({ error: { type: "tela_chat_not_configured", message: "no locally approved workspace roots" } }, { status: 409 });
        }
        let body: unknown;
        try { body = await request.json(); }
        catch { return Response.json({ error: { type: "tela_chat_invalid_request", message: "request body must be JSON" } }, { status: 400 }); }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return Response.json({ error: { type: "tela_chat_invalid_request", message: "request body must be an object" } }, { status: 400 });
        }
        const record = body as Record<string, unknown>;
        if (typeof record.capability !== "string") {
          return Response.json({ error: { type: "tela_chat_invalid_request", message: "capability is required" } }, { status: 400 });
        }
        try {
          const result = await input.tools.call(record.capability as TelaChatCapability, record.arguments ?? {});
          return Response.json({ contractVersion: 1, service: "chat", capability: record.capability, result });
        } catch (error) {
          return Response.json({ error: { type: "tela_chat_capability_error",
            message: error instanceof Error ? error.message : String(error) } }, { status: 409 });
        }
      }
      if (request.method === "POST" && url.pathname === "/v1/shutdown") {
        queueMicrotask(resolveShutdown);
        return Response.json({ status: "shutting-down" });
      }
      return new Response(null, { status: 404 });
    },
  });
  let closed = false;
  return Object.freeze({
    instanceId,
    endpoint: new URL(`http://127.0.0.1:${server.port}/`),
    bearerToken: input.bearerToken,
    server,
    shutdownRequested,
    status,
    async close() {
      if (closed) return;
      stopping = true;
      await server.stop();
      await input.tools?.close();
      closed = true;
    },
  });
}
