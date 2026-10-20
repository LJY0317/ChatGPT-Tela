import { randomUUID, timingSafeEqual } from "node:crypto";
import { capturePrivateDiagnosticValue, diagnosticFingerprint, diagnosticDurationMs, diagnosticFailureFields, emitDiagnosticEvent } from "@chatgpt-tela/core";
import { startWebHttpServer, type WebHttpServer } from "@chatgpt-tela/http-host";
import type { ServiceStatus } from "@chatgpt-tela/service-protocol";
import { chatCapabilityCatalog } from "./capability-contracts";
import { type ChatToolRuntime, type TelaChatCapability } from "./tools";

export * from "./capability-contracts";
export * from "./changes";
export * from "./agents";
export * from "./config";
export * from "./files";
export * from "./exports";
export * from "./imports";
export * from "./exploration";
export * from "./incidents";
export * from "./openai-agent";
export * from "./patch";
export * from "./paths";
export * from "./processes";
export * from "./reviews";
export * from "./review-diff";
export * from "./skills";
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

function resultDiagnosticFields(result: unknown): Readonly<Record<string, number | boolean>> {
  let resultBytes: number | undefined;
  try {
    const json = JSON.stringify(result);
    if (json !== undefined) resultBytes = Buffer.byteLength(json, "utf8");
  } catch {
    // Result serialization belongs to the response boundary; diagnostics stay best-effort.
  }
  const record = result && typeof result === "object" && !Array.isArray(result)
    ? result as Record<string, unknown>
    : undefined;
  const array = Array.isArray(result) ? result : undefined;
  const hasMore = record?.hasMore === true
    || array?.some(item => item && typeof item === "object" && !Array.isArray(item)
      && (item as Record<string, unknown>).hasMore === true) === true;
  const outputTruncated = record?.outputTruncated === true;
  return Object.freeze({
    ...(resultBytes === undefined ? {} : { result_bytes: resultBytes }),
    ...(array ? { item_count: array.length } : {}),
    ...(hasMore ? { has_more: true } : {}),
    ...(outputTruncated ? { truncated: true } : {}),
  });
}

export async function startChatService(input: {
  readonly bearerToken: string;
  readonly tools?: ChatToolRuntime;
  readonly workspacePolicyFingerprint?: string;
}): Promise<ChatService> {
  if (input.bearerToken.length < 32) throw new Error("Chat service bearer token is too short");
  const instanceId = randomUUID();
  let stopping = false;
  let activeCalls = 0;
  const assertShutdownReady = () => {
    if (activeCalls > 0) throw new Error("Tela Chat has an active capability request; finish it before shutdown");
    input.tools?.assertCanClose();
  };
  const prepareShutdown = () => {
    try { assertShutdownReady(); }
    catch (error) {
      emitDiagnosticEvent("chatgpt_tela_chat", "shutdown_rejected", {
        reason_class: activeCalls > 0 ? "active_calls" : "unresolved_work", active_calls: activeCalls,
      });
      throw error;
    }
    stopping = true;
  };
  let resolveShutdown!: () => void;
  const shutdownRequested = new Promise<void>(resolvePromise => { resolveShutdown = resolvePromise; });
  const status = (includeShutdownReadiness = false): ServiceStatus => Object.freeze({
    contractVersion: 1,
    service: "chat",
    instanceId,
    state: stopping ? "stopping" : "ready",
    ...(includeShutdownReadiness ? { shutdownReadiness: (() => {
      if (stopping) return "blocked" as const;
      try { assertShutdownReady(); return "ready" as const; }
      catch { return "blocked" as const; }
    })() } : {}),
  });
  const server = await startWebHttpServer({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodyBytes: 4 * 1024 * 1024,
    async fetch(request, lifecycle) {
      if (request.headers.has("origin")) return new Response(null, { status: 403 });
      const header = request.headers.get("authorization");
      const candidate = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
      if (!sameSecret(candidate, input.bearerToken)) return new Response(null, { status: 401 });
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/v1/status") {
        return Response.json(status(url.searchParams.get("shutdown-readiness") === "1"));
      }
      if (request.method === "GET" && url.pathname === "/v1/chat/workspace-policy") {
        return Response.json({contractVersion:1,service:"chat",fingerprint:input.workspacePolicyFingerprint ?? null});
      }
      if (request.method === "GET" && url.pathname === "/v1/capabilities") {
        emitDiagnosticEvent("chatgpt_tela_chat", "capability_inventory", {
          count: input.tools?.capabilities.length ?? 0,
        });
        return Response.json({ contractVersion: 1, service: "chat",
          capabilities: input.tools ? input.tools.capabilities : [],
          catalog: input.tools ? chatCapabilityCatalog(input.tools.capabilities) : [] });
      }
      if (request.method === "POST" && url.pathname === "/v1/call") {
        if (stopping) return Response.json({ error: { type: "tela_chat_stopping", message: "Tela Chat is shutting down" } }, { status: 503 });
        activeCalls++;
        let released = false;
        let workFinished = false, deliveryFinished = false;
        const release = () => {
          if (released || !workFinished || !deliveryFinished) return;
          released = true;
          activeCalls--;
        };
        const delivered = () => { deliveryFinished = true; release(); };
        void lifecycle.responseFinished.then(delivered);
        try {
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
          const diagnosticCapability = input.tools.capabilities.includes(record.capability as TelaChatCapability)
            ? record.capability : "unknown";
          const args = record.arguments as { workspace_id?: unknown; operation_id?: unknown } | null;
          const correlation = {
            ...(typeof args?.workspace_id === "string" && args.workspace_id.length <= 512
              ? { workspace_fingerprint: diagnosticFingerprint(args.workspace_id) } : {}),
            ...(typeof args?.operation_id === "string" && args.operation_id.length <= 64
              ? { operation_fingerprint: diagnosticFingerprint(args.operation_id) } : {}),
          };
          const startedAt = Date.now();
          emitDiagnosticEvent("chatgpt_tela_chat", "capability_call_start", { ...correlation,
            capability: diagnosticCapability,
          });
          try {
            const result = await input.tools.call(record.capability as TelaChatCapability, record.arguments ?? {});
            emitDiagnosticEvent("chatgpt_tela_chat", "capability_call_complete", { ...correlation,
              capability: diagnosticCapability,
              duration_ms: diagnosticDurationMs(startedAt),
              ...resultDiagnosticFields(result),
            });
            return Response.json({ contractVersion: 1, service: "chat", capability: record.capability, result });
          } catch (error) {
            if (diagnosticCapability === "apply_patch") {
              const args = record.arguments as { patch?: unknown; workspace_id?: unknown } | null;
              // Only the existing opt-in private capture retains error/path
              // details. Preserve action headers and the exception, not the whole patch.
              capturePrivateDiagnosticValue("web_execution_failure", {
                capability: "apply_patch", error: error instanceof Error ? error.message : String(error),
                patchHeaders: typeof args?.patch === "string" ? args.patch.split("\n")
                  .filter(line => /^\*\*\* (?:Add File|Update File|Delete File|Move to): /.test(line)) : [],
              });
            }
            emitDiagnosticEvent("chatgpt_tela_chat", "capability_call_failed", { ...correlation,
              capability: diagnosticCapability,
              duration_ms: diagnosticDurationMs(startedAt),
              ...diagnosticFailureFields(error), phase: "capability",
            });
            return Response.json({ error: { type: "tela_chat_capability_error",
              message: error instanceof Error ? error.message : String(error) } }, { status: 409 });
          }
        } finally { workFinished = true; release(); }
      }
      if (request.method === "POST" && url.pathname === "/v1/shutdown") {
        if (stopping) return Response.json({ error: { type: "tela_chat_stopping", message: "Tela Chat is already shutting down" } }, { status: 409 });
        try { prepareShutdown(); }
        catch {
          return Response.json({ contractVersion: 1, service: "chat", instanceId, shutdown: "not-started",
            error: { type: "tela_chat_shutdown_blocked", message: "Finish active or unresolved Chat work before shutting down" } }, { status: 409 });
        }
        void lifecycle.responseFinished.then(resolveShutdown);
        return Response.json({ status: "shutting-down" });
      }
      return new Response(null, { status: 404 });
    },
  });
  let closed = false;
  let closing: Promise<void> | undefined;
  return Object.freeze({
    instanceId,
    endpoint: new URL(`http://127.0.0.1:${server.port}/`),
    bearerToken: input.bearerToken,
    server,
    shutdownRequested,
    status,
    async close() {
      if (closed) return;
      if (closing) return closing;
      prepareShutdown();
      closing = (async () => {
        try {
          await input.tools?.close();
          await server.stop();
          closed = true;
        } finally { closing = undefined; }
      })();
      return closing;
    },
  });
}
