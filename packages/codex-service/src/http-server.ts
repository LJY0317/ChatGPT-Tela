import { randomBytes, timingSafeEqual } from "node:crypto";
import { diagnosticDurationMs, emitDiagnosticEvent } from "@chatgpt-tela/core";
import { startWebHttpServer, type WebHttpServer } from "@chatgpt-tela/http-host";
import {
  parseCodexToolInventoryRequest,
  parseCodexToolInvokeRequest,
} from "@chatgpt-tela/service-protocol";
import type { CodexService } from "./controller";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface CodexServiceHttpServer {
  readonly server: WebHttpServer;
  readonly endpoint: URL;
  readonly bearerToken: string;
  readonly shutdownRequested: Promise<void>;
  close(): Promise<void>;
}

function sameSecret(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearer(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7).trim() || undefined : undefined;
}

function error(status: number, message: string): Response {
  return Response.json({ error: { type: "tela_codex_service_error", message } }, { status });
}

function slot(pathname: string, action: "start" | "stop"): number | undefined {
  const match = new RegExp(`^/v1/codex/profiles/([1-9][0-9]?)/${action}$`).exec(pathname);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 1 && value <= 99 ? value : undefined;
}

function previewSlot(pathname: string): number | undefined {
  const match = /^\/v1\/codex\/profiles\/([1-9][0-9]?)\/bridge-preview$/.exec(pathname);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 1 && value <= 99 ? value : undefined;
}

function modelCanarySlot(pathname: string): number | undefined {
  const match = /^\/v1\/codex\/profiles\/([1-9][0-9]?)\/model-selection-canary$/.exec(pathname);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 1 && value <= 99 ? value : undefined;
}

export async function startCodexServiceHttpServer(input: {
  readonly service: CodexService;
  readonly bearerToken?: string;
}): Promise<CodexServiceHttpServer> {
  const bearerToken = input.bearerToken ?? randomBytes(36).toString("base64url");
  if (bearerToken.length < 32) throw new Error("Tela Codex service bearer token is too short");
  let resolveShutdown!: () => void;
  const shutdownRequested = new Promise<void>(resolvePromise => { resolveShutdown = resolvePromise; });
  const server = await startWebHttpServer({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodyBytes: MAX_BODY_BYTES,
    async fetch(request) {
      if (request.headers.has("origin")) return error(403, "browser-origin private service requests are not accepted");
      if (!sameSecret(bearer(request), bearerToken)) return error(401, "invalid Tela Codex service authorization");
      const url = new URL(request.url);
      try {
        if (request.method === "GET" && url.pathname === "/v1/status") {
          return Response.json(input.service.serviceStatus());
        }
        if (request.method === "GET" && url.pathname === "/v1/codex/profiles") {
          const profiles = await input.service.profiles();
          emitDiagnosticEvent("chatgpt_tela_codex", "profiles_inventory", { count: profiles.length });
          return Response.json({ contractVersion: 1, profiles });
        }
        const bridgeSlot = request.method === "GET" ? previewSlot(url.pathname) : undefined;
        if (bridgeSlot !== undefined) {
          return Response.json(await input.service.bridgePreview(bridgeSlot), {
            headers: { "cache-control": "no-store" },
          });
        }
        const canarySlot = request.method === "POST" ? modelCanarySlot(url.pathname) : undefined;
        if (canarySlot !== undefined) {
          const startedAt = Date.now();
          emitDiagnosticEvent("chatgpt_tela_codex", "model_selection_canary_begin", { slot: canarySlot });
          try {
            const result = await input.service.modelSelectionCanary(canarySlot);
            emitDiagnosticEvent("chatgpt_tela_codex", "model_selection_canary_complete", {
              slot: canarySlot,
              family_count: result.familyCount,
              exercised: result.exercised,
              duration_ms: diagnosticDurationMs(startedAt),
            });
            return Response.json(result, { headers: { "cache-control": "no-store" } });
          } catch (cause) {
            emitDiagnosticEvent("chatgpt_tela_codex", "model_selection_canary_failed", {
              slot: canarySlot,
              duration_ms: diagnosticDurationMs(startedAt),
            });
            throw cause;
          }
        }
        const startSlot = request.method === "POST" ? slot(url.pathname, "start") : undefined;
        if (startSlot !== undefined) {
          const startedAt = Date.now();
          emitDiagnosticEvent("chatgpt_tela_codex", "profile_start_begin", { slot: startSlot });
          try {
            const profile = await input.service.startProfile(startSlot);
            emitDiagnosticEvent("chatgpt_tela_codex", "profile_start_complete", {
              slot: startSlot,
              control_state: profile.controlState,
              duration_ms: diagnosticDurationMs(startedAt),
            });
            return Response.json(profile);
          } catch (cause) {
            emitDiagnosticEvent("chatgpt_tela_codex", "profile_start_failed", {
              slot: startSlot,
              duration_ms: diagnosticDurationMs(startedAt),
            });
            throw cause;
          }
        }
        const stopSlot = request.method === "POST" ? slot(url.pathname, "stop") : undefined;
        if (stopSlot !== undefined) {
          const startedAt = Date.now();
          emitDiagnosticEvent("chatgpt_tela_codex", "profile_stop_begin", { slot: stopSlot });
          try {
            const profile = await input.service.stopProfile(stopSlot);
            emitDiagnosticEvent("chatgpt_tela_codex", "profile_stop_complete", {
              slot: stopSlot,
              control_state: profile.controlState,
              duration_ms: diagnosticDurationMs(startedAt),
            });
            return Response.json(profile);
          } catch (cause) {
            emitDiagnosticEvent("chatgpt_tela_codex", "profile_stop_failed", {
              slot: stopSlot,
              duration_ms: diagnosticDurationMs(startedAt),
            });
            throw cause;
          }
        }
        if (request.method === "POST" && url.pathname === "/v1/codex/tools/inventory") {
          const parsed = parseCodexToolInventoryRequest(await request.json());
          return Response.json({ tools: await input.service.tools.inventory(parsed.turnCapability, parsed.query) });
        }
        if (request.method === "POST" && url.pathname === "/v1/codex/tools/invoke") {
          const parsed = parseCodexToolInvokeRequest(await request.json());
          return Response.json({ result: await input.service.tools.invoke(parsed.turnCapability, parsed.invocation) });
        }
        if (request.method === "POST" && url.pathname === "/v1/shutdown") {
          queueMicrotask(resolveShutdown);
          return Response.json({ status: "shutting-down" });
        }
        return new Response(null, { status: 404 });
      } catch (cause) {
        return error(409, cause instanceof Error ? cause.message : String(cause));
      }
    },
  });
  let closed = false;
  return Object.freeze({
    server,
    endpoint: new URL(`http://127.0.0.1:${server.port}/`),
    bearerToken,
    shutdownRequested,
    async close() {
      if (closed) return;
      closed = true;
      await server.stop();
    },
  });
}
