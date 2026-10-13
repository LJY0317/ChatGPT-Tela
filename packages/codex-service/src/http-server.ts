import { randomBytes, timingSafeEqual } from "node:crypto";
import { diagnosticDurationMs, emitDiagnosticEvent } from "@chatgpt-tela/core";
import { startWebHttpServer, type WebHttpServer } from "@chatgpt-tela/http-host";
import {
  parseCodexToolInventoryRequest,
  parseCodexToolInvokeRequest,
  parseCodexAccountCheckContract,
  parseCodexAccountDisplayContract,
  parseCodexHistoryUiContract,
  parseCodexSavedDeleteAcceptanceContract,
  parseCodexSyntheticRecoveryContract,
} from "@chatgpt-tela/service-protocol";
import { ProfileConnectionError } from "./profile-operation";
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

function slot(pathname: string, action: "start" | "stop" | "web-reconnect"): number | undefined {
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

function contextAttachmentCanarySlot(pathname: string): number | undefined {
  const match = /^\/v1\/codex\/profiles\/([1-9][0-9]?)\/context-attachment-canary$/.exec(pathname);
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
    async fetch(request, lifecycle) {
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
        const terminalMatch = request.method === "GET"
          ? /^\/v1\/codex\/profiles\/([1-9][0-9]?)\/terminal-session$/.exec(url.pathname) : null;
        if (terminalMatch) {
          return Response.json(await input.service.terminalSession(Number(terminalMatch[1])), {
            headers: { "cache-control": "no-store" },
          });
        }
        const accountMatch = request.method === "GET"
          ? /^\/v1\/codex\/profiles\/([1-9][0-9]?)\/account-check$/.exec(url.pathname) : null;
        if (accountMatch && input.service.accountCheck) {
          return Response.json(parseCodexAccountCheckContract(await input.service.accountCheck(Number(accountMatch[1]))), {
            headers: { "cache-control": "no-store" },
          });
        }
        const displayMatch = request.method === "GET"
          ? /^\/v1\/codex\/profiles\/([1-9][0-9]?)\/account-display$/.exec(url.pathname) : null;
        if (displayMatch && input.service.accountDisplay) {
          return Response.json(parseCodexAccountDisplayContract(await input.service.accountDisplay(Number(displayMatch[1]))), {
            headers: { "cache-control": "no-store" },
          });
        }
        const revealMatch = /^\/v1\/codex\/profiles\/([1-9][0-9]?)\/bridge-reveal$/.exec(url.pathname);
        if (request.method === "POST" && revealMatch && input.service.revealBridgeSurface) {
          const body = await request.json().catch(() => undefined);
          if (typeof body?.surfaceId !== "string" || (body.interactive !== undefined && typeof body.interactive !== "boolean")) return error(400, "invalid surface selection");
          await input.service.revealBridgeSurface(Number(revealMatch[1]), body.surfaceId, body.interactive === true);
          return new Response(null, { status: 204 });
        }
        const browserMatch = request.method === "POST"
          ? /^\/v1\/codex\/profiles\/([1-9][0-9]?)\/account-browser$/.exec(url.pathname) : null;
        if (browserMatch && input.service.openAccountBrowser) {
          await input.service.openAccountBrowser(Number(browserMatch[1]));
          return new Response(null, { status: 204 });
        }
        const closeBrowserMatch = request.method === "POST"
          ? /^\/v1\/codex\/profiles\/([1-9][0-9]?)\/account-browser-close$/.exec(url.pathname) : null;
        if (closeBrowserMatch && input.service.closeAccountBrowser) {
          await input.service.closeAccountBrowser(Number(closeBrowserMatch[1]));
          return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
        }
        const historyMatch = request.method === "GET"
          ? /^\/v1\/codex\/profiles\/([1-9][0-9]?)\/account-browser-history-ui$/.exec(url.pathname) : null;
        if (historyMatch && input.service.inspectAccountBrowserHistoryUi) {
          const slot = Number(historyMatch[1]);
          const result = parseCodexHistoryUiContract(await input.service.inspectAccountBrowserHistoryUi(slot));
          if (result.slot !== slot) throw new Error("History UI observation profile ownership mismatch");
          return Response.json(result, { headers: { "cache-control": "no-store" } });
        }
        const savedDeleteMatch = request.method === "POST"
          ? /^\/v1\/codex\/profiles\/([1-9][0-9]?)\/saved-delete-acceptance$/.exec(url.pathname) : null;
        if (savedDeleteMatch && input.service.runSavedDeleteAcceptance) {
          const slot = Number(savedDeleteMatch[1]);
          const receipt = parseCodexSavedDeleteAcceptanceContract(await input.service.runSavedDeleteAcceptance(slot));
          if (receipt.slot !== slot) throw new Error("Saved Chat delete acceptance profile ownership mismatch");
          return Response.json(receipt, { headers: { "cache-control": "no-store" } });
        }
        const syntheticRecoveryMatch = request.method === "POST"
          ? /^\/v1\/codex\/profiles\/([1-9][0-9]?)\/synthetic-cleanup$/.exec(url.pathname) : null;
        if (syntheticRecoveryMatch && input.service.recoverSyntheticSavedChat) {
          const slot = Number(syntheticRecoveryMatch[1]);
          const receipt = parseCodexSyntheticRecoveryContract(await input.service.recoverSyntheticSavedChat(slot));
          if (receipt.slot !== slot) throw Error("Synthetic saved cleanup receipt from different profile");
          return Response.json(receipt, { headers: { "cache-control": "no-store" } });
        }
        const bridgeSlot = request.method === "GET" ? previewSlot(url.pathname) : undefined;
        if (bridgeSlot !== undefined) {
          return Response.json(await input.service.bridgePreview(bridgeSlot, url.searchParams.get("surfaceId") ?? undefined), {
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
        const contextCanarySlot = request.method === "POST" ? contextAttachmentCanarySlot(url.pathname) : undefined;
        if (contextCanarySlot !== undefined) {
          const startedAt = Date.now();
          emitDiagnosticEvent("chatgpt_tela_codex", "context_attachment_canary_begin", { slot: contextCanarySlot });
          try {
            const result = await input.service.contextAttachmentCanary(contextCanarySlot);
            emitDiagnosticEvent("chatgpt_tela_codex", "context_attachment_canary_complete", {
              slot: contextCanarySlot,
              attachment_bytes: result.attachmentBytes,
              receipt_verified: result.receiptVerified,
              duration_ms: diagnosticDurationMs(startedAt),
            });
            return Response.json(result, { headers: { "cache-control": "no-store" } });
          } catch (cause) {
            emitDiagnosticEvent("chatgpt_tela_codex", "context_attachment_canary_failed", {
              slot: contextCanarySlot,
              duration_ms: diagnosticDurationMs(startedAt),
            });
            throw cause;
          }
        }
        const reconnectSlot = request.method === "POST" ? slot(url.pathname, "web-reconnect") : undefined;
        if (reconnectSlot !== undefined) return Response.json(await input.service.reconnectWeb(reconnectSlot));
        const startSlot = request.method === "POST" ? slot(url.pathname, "start") : undefined;
        if (startSlot !== undefined) {
          const text = await request.text();
          let options: { expectedDesktopProcessId?: number; requireStopped?: boolean } = {};
          try {
            if (text.length > 1024) throw new Error("Too large");
            if (text) {
              const value = JSON.parse(text);
              if (!value || typeof value !== "object" || Array.isArray(value)
                || Object.keys(value).some(key => !["expectedDesktopProcessId", "requireStopped"].includes(key))
                || (value.expectedDesktopProcessId !== undefined && (!Number.isSafeInteger(value.expectedDesktopProcessId) || value.expectedDesktopProcessId < 1))
                || (value.requireStopped !== undefined && typeof value.requireStopped !== "boolean")) throw new Error("Invalid options");
              options = value;
            }
          } catch { return error(400, "Invalid ChatGPT reopen request"); }
          if (request.headers.get("accept") === "application/x-ndjson") {
            const encoder = new TextEncoder();
            const stream = new ReadableStream<Uint8Array>({
              start(controller) {
                let disconnected = false;
                const send = (value: unknown) => {
                  if (disconnected) return;
                  try { controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`)); }
                  catch { disconnected = true; }
                };
                const startedAt = Date.now();
                emitDiagnosticEvent("chatgpt_tela_codex", "profile_start_begin", { slot: startSlot });
                void input.service.startProfile(startSlot, { ...options, onProgress: phase => send({ phase }) }).then(async profile => {
                  send({ profile });
                  if (profile.webState === "preparing") send({ profile: await input.service.waitWebPreparation(startSlot) });
                  emitDiagnosticEvent("chatgpt_tela_codex", "profile_start_complete", { slot: startSlot, duration_ms: diagnosticDurationMs(startedAt) });
                }).catch(cause => {
                  const phase = cause instanceof ProfileConnectionError ? cause.phase : "checking";
                  send({ error: { phase, message: cause instanceof ProfileConnectionError ? cause.message : "Connection could not be started. Refresh status before trying again." } });
                  emitDiagnosticEvent("chatgpt_tela_codex", "profile_start_failed", { slot: startSlot, phase, duration_ms: diagnosticDurationMs(startedAt) });
                }).finally(() => { try { controller.close(); } catch { /* Client disconnected; operation retains its single owner. */ } });
              },
            });
            return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
          }
          const startedAt = Date.now();
          emitDiagnosticEvent("chatgpt_tela_codex", "profile_start_begin", { slot: startSlot });
          try {
            const profile = await input.service.startProfile(startSlot, options);
            emitDiagnosticEvent("chatgpt_tela_codex", "profile_start_complete", {
              slot: startSlot,
              control_state: profile.controlState,
              duration_ms: diagnosticDurationMs(startedAt),
            });
            return Response.json(profile);
          } catch (cause) {
            emitDiagnosticEvent("chatgpt_tela_codex", "profile_start_failed", {
              slot: startSlot,
              phase: cause instanceof ProfileConnectionError ? cause.phase : "checking",
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
          lifecycle.afterResponse(resolveShutdown);
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
