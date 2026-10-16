import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { classifyNetworkFailure, diagnosticContext, diagnosticDurationMs, diagnosticFingerprint, emitDiagnosticEvent, withDiagnosticContext } from "@chatgpt-tela/core";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

export interface WebHttpServer {
  readonly hostname: string;
  readonly port: number;
  stop(): Promise<void>;
}

export interface WebHttpResponseLifecycle {
  /** Run only after the response has been handed to the transport, never on disconnect. */
  afterResponse(callback: () => void): void;
}

function requestHeaders(input: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else {
      headers.append(name, value);
    }
  }
  return headers;
}

async function requestBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes) throw new RequestBodyTooLargeError();
    chunks.push(buffer);
  }
  if (size === 0) return undefined;
  return Buffer.concat(chunks, size);
}

class RequestBodyTooLargeError extends Error {
  constructor() {
    super("HTTP request body is too large");
  }
}

function localRequestUrl(request: IncomingMessage, hostname: string, port: number): URL {
  const host = hostname.includes(":") ? `[${hostname}]` : hostname;
  return new URL(request.url ?? "/", `http://${host}:${port}/`);
}

async function writeResponse(response: Response, output: ServerResponse, signal: AbortSignal, written?: (bytes: number) => void): Promise<void> {
  output.statusCode = response.status;
  output.statusMessage = response.statusText;
  response.headers.forEach((value, name) => output.setHeader(name, value));
  if (!response.body) {
    output.end();
    return;
  }

  const reader = response.body.getReader();
  const cancel = () => {
    if (!output.writableEnded) void reader.cancel("HTTP response cancelled").catch(() => {});
  };
  output.once("close", cancel);
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    while (true) {
      const value = await reader.read();
      if (signal.aborted || output.destroyed) return;
      if (value.done) break;
      const writable = output.write(Buffer.from(value.value));
      written?.(value.value.byteLength);
      if (!writable) await once(output, "drain", { signal });
    }
    output.end();
  } finally {
    output.removeListener("close", cancel);
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/**
 * Small Fetch-compatible HTTP host that runs under stock Node/Electron as well as Bun.
 * Request bodies are bounded before the application handler sees them; response bodies remain
 * streamed so SSE/MCP transports do not acquire a second buffering/state layer.
 */
export async function startWebHttpServer(input: {
  readonly hostname: string;
  readonly port?: number;
  readonly maxRequestBodyBytes: number;
  readonly fetch: (request: Request, lifecycle: WebHttpResponseLifecycle) => Response | Promise<Response>;
  readonly requestTooLarge?: () => Response;
}): Promise<WebHttpServer> {
  if (!Number.isSafeInteger(input.maxRequestBodyBytes) || input.maxRequestBodyBytes < 1) {
    throw new Error("HTTP maxRequestBodyBytes must be a positive safe integer");
  }

  let boundPort = 0;
  const activeRequests = new Set<AbortController>();
  const server: Server = createServer((incoming, outgoing) => withDiagnosticContext({
    request_fingerprint: diagnosticFingerprint(randomUUID()),
    ...(typeof incoming.headers["x-tela-diagnostic-parent"] === "string" ? { parent_fingerprint: incoming.headers["x-tela-diagnostic-parent"] } : {}),
    ...(typeof incoming.headers["x-tela-diagnostic-scope"] === "string" ? { scope_fingerprint: incoming.headers["x-tela-diagnostic-scope"] } : {}),
  }, async () => {
    const startedAt = Date.now();
    const origin = diagnosticContext();
    let writeCount = 0, writeBytes = 0, lastWriteAt = 0;
    const transportEvidence = () => ({ socket_write_count: writeCount, socket_write_bytes: writeBytes,
      last_socket_write_at_ms: lastWriteAt, last_socket_write_age_ms: lastWriteAt ? Math.max(0, Date.now() - lastWriteAt) : -1,
      delivery: "socket_write_only" });
    const written = (bytes: number) => { writeCount++; writeBytes += bytes; lastWriteAt = Date.now(); };
    emitDiagnosticEvent("chatgpt_tela_http", "http_request_start", {
      method_class: ["GET", "POST", "DELETE", "OPTIONS"].includes(incoming.method ?? "") ? incoming.method!.toLowerCase() : "other",
    });
    outgoing.once("finish", () => withDiagnosticContext(origin, () => emitDiagnosticEvent("chatgpt_tela_http", "http_response_finished", {
      duration_ms: diagnosticDurationMs(startedAt), status: outgoing.statusCode, ...transportEvidence(),
    })));
    const controller = new AbortController();
    activeRequests.add(controller);
    const disconnected = (source: "request_aborted" | "response_closed") => {
      if (!outgoing.writableFinished && !controller.signal.aborted) {
        withDiagnosticContext(origin, () => emitDiagnosticEvent("chatgpt_tela_http", "http_transport_closed", {
          duration_ms: diagnosticDurationMs(startedAt), reason_class: "remote_cancel_or_disconnect",
          close_source: source, headers_sent: outgoing.headersSent, request_complete: incoming.complete,
          ...transportEvidence(),
          request_timeout_ms: server.requestTimeout, headers_timeout_ms: server.headersTimeout,
          socket_timeout_ms: incoming.socket.timeout ?? 0,
        }));
        controller.abort(new Error("HTTP client disconnected"));
      }
    };
    const requestAborted = () => disconnected("request_aborted");
    const responseClosed = () => disconnected("response_closed");
    const responseError = (error: Error & { code?: string }) => withDiagnosticContext(origin, () =>
      emitDiagnosticEvent("chatgpt_tela_http", "http_transport_error", {
        duration_ms: diagnosticDurationMs(startedAt), headers_sent: outgoing.headersSent,
        reason_class: error.code === "ECONNRESET" ? "connection_reset" : error.code === "EPIPE" ? "broken_pipe"
          : error.code === "ETIMEDOUT" ? "socket_timeout" : "socket_error", ...transportEvidence(),
      }));
    incoming.once("aborted", requestAborted);
    outgoing.once("close", responseClosed);
    outgoing.once("error", responseError);
    const cancelled = () => {
      withDiagnosticContext(origin, () => emitDiagnosticEvent("chatgpt_tela_http", "http_request_observer_aborted", {
        duration_ms: diagnosticDurationMs(startedAt), headers_sent: outgoing.headersSent,
        reason_class: controller.signal.reason instanceof Error && controller.signal.reason.message === "HTTP server stopped"
          ? "server_shutdown" : "remote_cancel_or_disconnect", ...transportEvidence(),
      }));
      if (!outgoing.writableFinished) outgoing.destroy();
    };
    controller.signal.addEventListener("abort", cancelled, { once: true });
    try {
      const contentLength = incoming.headers["content-length"];
      if (contentLength !== undefined) {
        const bytes = Number(contentLength);
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > input.maxRequestBodyBytes) {
          await writeResponse(input.requestTooLarge?.() ?? new Response(null, { status: 413 }), outgoing, controller.signal);
          return;
        }
      }

      let body: Uint8Array | undefined;
      try {
        body = await requestBody(incoming, input.maxRequestBodyBytes);
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
          await writeResponse(input.requestTooLarge?.() ?? new Response(null, { status: 413 }), outgoing, controller.signal);
          return;
        }
        throw error;
      }

      const requestBodyInit = body ? Uint8Array.from(body).buffer : undefined;
      emitDiagnosticEvent("chatgpt_tela_http", "http_request_received", { request_bytes: body?.byteLength ?? 0 });
      const request = new Request(localRequestUrl(incoming, input.hostname, boundPort), {
        method: incoming.method ?? "GET",
        headers: requestHeaders(incoming.headers),
        signal: controller.signal,
        ...(requestBodyInit ? { body: requestBodyInit } : {}),
      });
      const response = await input.fetch(request, {
        afterResponse(callback) { outgoing.once("finish", callback); },
      });
      emitDiagnosticEvent("chatgpt_tela_http", response.status >= 400 ? "http_response_error" : "http_response_ready", { status: response.status, duration_ms: diagnosticDurationMs(startedAt) });
      await writeResponse(response, outgoing, controller.signal, written);
    } catch (error) {
      emitDiagnosticEvent("chatgpt_tela_http", "http_request_failed", { duration_ms: diagnosticDurationMs(startedAt), network_kind: classifyNetworkFailure(error), abort_observed: controller.signal.aborted, ...transportEvidence() });
      if (outgoing.destroyed) return;
      if (outgoing.headersSent) {
        outgoing.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const detail = error instanceof Error ? error.message : "internal HTTP server error";
      outgoing.statusCode = 500;
      outgoing.setHeader("content-type", "application/json");
      outgoing.end(JSON.stringify({ error: { type: "chatgpt_tela_http_error", message: detail } }));
    } finally {
      activeRequests.delete(controller);
      incoming.removeListener("aborted", requestAborted);
      outgoing.removeListener("close", responseClosed);
      controller.signal.removeEventListener("abort", cancelled);
    }
  }));

  server.listen(input.port ?? 0, input.hostname);
  try {
    await once(server, "listening");
  } catch (error) {
    server.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("HTTP server did not bind a TCP address");
  }
  boundPort = address.port;
  let stopping: Promise<void> | undefined;

  return Object.freeze({
    hostname: input.hostname,
    port: boundPort,
    stop() {
      if (!stopping) {
        stopping = new Promise<void>((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
          for (const controller of activeRequests) controller.abort(new Error("HTTP server stopped"));
          server.closeAllConnections();
        });
      }
      return stopping;
    },
  });
}
