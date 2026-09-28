import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { startWebHttpServer, type WebHttpServer } from "@chatgpt-tela/http-host";
import type {
  BackendServiceId,
  ServiceRuntimeDescriptor,
  ServiceStatus,
} from "@chatgpt-tela/service-protocol";
import { IndependentBackendRouter, type GatewayBackendStatus } from "./backend-router";
import { CodexBackendClient } from "./codex-backend-client";
import { LoopbackBackendClient } from "./service-client";

export interface GatewayStatus {
  readonly service: ServiceStatus;
  readonly backends: readonly GatewayBackendStatus[];
}

export interface GatewayService {
  readonly instanceId: string;
  readonly endpoint: URL;
  readonly bearerToken: string;
  readonly server: WebHttpServer;
  readonly shutdownRequested: Promise<void>;
  status(signal?: AbortSignal): Promise<GatewayStatus>;
  close(): Promise<void>;
}

export type BackendDescriptorResolver = (
  service: BackendServiceId,
) => ServiceRuntimeDescriptor | undefined | Promise<ServiceRuntimeDescriptor | undefined>;

function sameSecret(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function backendClient(
  service: BackendServiceId,
  descriptor: ServiceRuntimeDescriptor,
) {
  if (descriptor.service !== service) throw new Error(`runtime descriptor belongs to ${descriptor.service}, not ${service}`);
  if (service === "codex") {
    return new CodexBackendClient({ ...descriptor, service: "codex" });
  }
  return new LoopbackBackendClient({ ...descriptor, service: "chat" });
}

export async function startGatewayService(input: {
  readonly resolveBackend: BackendDescriptorResolver;
  readonly bearerToken?: string;
  readonly backendTimeoutMs?: number;
}): Promise<GatewayService> {
  const instanceId = randomUUID();
  const bearerToken = input.bearerToken ?? randomBytes(36).toString("base64url");
  if (bearerToken.length < 32) throw new Error("Tela Gateway bearer token is too short");
  let stopping = false;
  let resolveShutdown!: () => void;
  const shutdownRequested = new Promise<void>(resolvePromise => { resolveShutdown = resolvePromise; });

  const status = async (signal?: AbortSignal): Promise<GatewayStatus> => {
    const router = new IndependentBackendRouter({ timeoutMs: input.backendTimeoutMs ?? 3_000 });
    const descriptorErrors = new Map<BackendServiceId, string>();
    for (const service of ["chat", "codex"] as const) {
      try {
        const descriptor = await input.resolveBackend(service);
        if (descriptor) router.mount(backendClient(service, descriptor));
      } catch (error) {
        descriptorErrors.set(service, error instanceof Error ? error.message : String(error));
      }
    }
    try {
      const statuses = [...await router.statuses(signal)].map(entry => {
        const detail = descriptorErrors.get(entry.service);
        return detail
          ? Object.freeze({ service: entry.service, availability: "unavailable" as const, detail })
          : entry;
      });
      return Object.freeze({
        service: Object.freeze({
          contractVersion: 1 as const,
          service: "gateway" as const,
          instanceId,
          state: stopping ? "stopping" as const : "ready" as const,
        }),
        backends: Object.freeze(statuses),
      });
    } finally {
      await router.close().catch(() => {});
    }
  };

  const server = await startWebHttpServer({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodyBytes: 16 * 1024,
    async fetch(request) {
      if (request.headers.has("origin")) return new Response(null, { status: 403 });
      const header = request.headers.get("authorization");
      const candidate = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
      if (!sameSecret(candidate, bearerToken)) return new Response(null, { status: 401 });
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/v1/status") {
        return Response.json((await status(request.signal)).service);
      }
      if (request.method === "GET" && url.pathname === "/v1/backends") {
        return Response.json(await status(request.signal));
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
    bearerToken,
    server,
    shutdownRequested,
    status,
    async close() {
      if (closed) return;
      stopping = true;
      await server.stop();
      closed = true;
    },
  });
}
