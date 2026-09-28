import { randomBytes, timingSafeEqual } from "node:crypto";
import { startWebHttpServer, type WebHttpServer } from "@chatgpt-tela/http-host";
import type { ProductControlConfig } from "./config";
import {
  startProductControlPlane,
  type ProductControlPlane,
  type ProductControlStatus,
  type ProductProfileStatus,
} from "./controller";

const MAX_CONTROL_BODY_BYTES = 16 * 1024;

export interface ProductControlDaemon {
  readonly control: ProductControlPlane;
  readonly server: WebHttpServer;
  readonly endpoint: URL;
  readonly token: string;
  readonly shutdownRequested: Promise<void>;
  stop(): Promise<void>;
}

function sameSecret(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearer(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length).trim() || undefined;
}

function error(status: number, message: string): Response {
  return Response.json({ error: { type: "chatgpt_tela_control_error", message } }, { status });
}

function slot(pathname: string, action: "start" | "stop"): number | undefined {
  const match = new RegExp(`^/profiles/([1-9][0-9]?)/${action}$`).exec(pathname);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 1 && value <= 99 ? value : undefined;
}

export async function startProductControlDaemon(input: {
  readonly config: ProductControlConfig;
  readonly profileRuntimeCommand: readonly [string, ...string[]];
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): Promise<ProductControlDaemon> {
  const control = await startProductControlPlane({
    config: input.config,
    profileRuntimeCommand: input.profileRuntimeCommand,
    ...(input.environment ? { environment: input.environment } : {}),
  });
  const token = randomBytes(36).toString("base64url");
  let resolveShutdown!: () => void;
  const shutdownRequested = new Promise<void>(resolvePromise => { resolveShutdown = resolvePromise; });
  let stopped = false;
  let stopping: Promise<void> | undefined;
  const server = await startWebHttpServer({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodyBytes: MAX_CONTROL_BODY_BYTES,
    async fetch(request) {
      if (request.headers.has("origin")) return error(403, "browser-origin control requests are not accepted");
      if (!sameSecret(bearer(request), token)) return error(401, "invalid ChatGPT Tela control authorization");
      const url = new URL(request.url);
      try {
        if (request.method === "GET" && url.pathname === "/status") {
          return Response.json(await control.status());
        }
        const startSlot = request.method === "POST" ? slot(url.pathname, "start") : undefined;
        if (startSlot !== undefined) return Response.json(await control.startProfile(startSlot));
        const stopSlot = request.method === "POST" ? slot(url.pathname, "stop") : undefined;
        if (stopSlot !== undefined) return Response.json(await control.stopProfile(stopSlot));
        if (request.method === "POST" && url.pathname === "/shutdown") {
          if (control.activeProfileCount !== 0) {
            return error(409, "stop every active ChatGPT Tela profile before shutting down the control daemon");
          }
          queueMicrotask(resolveShutdown);
          return Response.json({ status: "shutting-down" });
        }
        return new Response(null, { status: 404 });
      } catch (cause) {
        return error(409, cause instanceof Error ? cause.message : String(cause));
      }
    },
  });
  const endpoint = new URL(`http://127.0.0.1:${server.port}/`);
  return Object.freeze({
    control,
    server,
    endpoint,
    token,
    shutdownRequested,
    stop() {
      if (stopped) return Promise.resolve();
      if (stopping) return stopping;
      stopping = (async () => {
        await control.close();
        await server.stop();
        stopped = true;
      })().catch(cause => {
        stopping = undefined;
        throw cause;
      });
      return stopping;
    },
  });
}

async function jsonResponse<T>(response: Response): Promise<T> {
  const value = await response.json().catch(() => undefined) as unknown;
  if (!response.ok) {
    const message = value && typeof value === "object" && !Array.isArray(value)
      && typeof (value as { error?: { message?: unknown } }).error?.message === "string"
      ? (value as { error: { message: string } }).error.message
      : `control request failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return value as T;
}

export class ProductControlDaemonClient {
  readonly #endpoint: URL;
  readonly #token: string;

  constructor(input: { readonly endpoint: URL | string; readonly token: string }) {
    this.#endpoint = input.endpoint instanceof URL ? new URL(input.endpoint.href) : new URL(input.endpoint);
    if (this.#endpoint.protocol !== "http:"
      || !["127.0.0.1", "localhost", "[::1]"].includes(this.#endpoint.hostname)) {
      throw new Error("control daemon endpoint must use loopback http://");
    }
    if (input.token.length < 32) throw new Error("control daemon token is invalid");
    this.#token = input.token;
  }

  #request(path: string, method: "GET" | "POST"): Promise<Response> {
    return fetch(new URL(path, this.#endpoint), {
      method,
      headers: { authorization: `Bearer ${this.#token}` },
    });
  }

  async status(): Promise<ProductControlStatus> {
    return jsonResponse(await this.#request("status", "GET"));
  }

  async startProfile(slot: number): Promise<ProductProfileStatus> {
    return jsonResponse(await this.#request(`profiles/${slot}/start`, "POST"));
  }

  async stopProfile(slot: number): Promise<ProductProfileStatus> {
    return jsonResponse(await this.#request(`profiles/${slot}/stop`, "POST"));
  }

  async shutdown(): Promise<void> {
    await jsonResponse(await this.#request("shutdown", "POST"));
  }
}
