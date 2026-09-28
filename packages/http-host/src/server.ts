import { once } from "node:events";
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

async function writeResponse(response: Response, output: ServerResponse): Promise<void> {
  output.statusCode = response.status;
  output.statusMessage = response.statusText;
  response.headers.forEach((value, name) => output.setHeader(name, value));
  if (!response.body) {
    output.end();
    return;
  }

  const reader = response.body.getReader();
  const cancel = () => {
    if (!output.writableEnded) void reader.cancel("HTTP client disconnected").catch(() => {});
  };
  output.once("close", cancel);
  try {
    while (true) {
      const value = await reader.read();
      if (value.done) break;
      if (!output.write(Buffer.from(value.value))) await once(output, "drain");
    }
    output.end();
  } finally {
    output.removeListener("close", cancel);
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
  readonly fetch: (request: Request) => Response | Promise<Response>;
  readonly requestTooLarge?: () => Response;
}): Promise<WebHttpServer> {
  if (!Number.isSafeInteger(input.maxRequestBodyBytes) || input.maxRequestBodyBytes < 1) {
    throw new Error("HTTP maxRequestBodyBytes must be a positive safe integer");
  }

  let boundPort = 0;
  const server: Server = createServer(async (incoming, outgoing) => {
    try {
      const contentLength = incoming.headers["content-length"];
      if (contentLength !== undefined) {
        const bytes = Number(contentLength);
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > input.maxRequestBodyBytes) {
          await writeResponse(input.requestTooLarge?.() ?? new Response(null, { status: 413 }), outgoing);
          return;
        }
      }

      let body: Uint8Array | undefined;
      try {
        body = await requestBody(incoming, input.maxRequestBodyBytes);
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
          await writeResponse(input.requestTooLarge?.() ?? new Response(null, { status: 413 }), outgoing);
          return;
        }
        throw error;
      }

      const requestBodyInit = body ? Uint8Array.from(body).buffer : undefined;
      const request = new Request(localRequestUrl(incoming, input.hostname, boundPort), {
        method: incoming.method ?? "GET",
        headers: requestHeaders(incoming.headers),
        ...(requestBodyInit ? { body: requestBodyInit } : {}),
      });
      await writeResponse(await input.fetch(request), outgoing);
    } catch (error) {
      if (outgoing.headersSent) {
        outgoing.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const detail = error instanceof Error ? error.message : "internal HTTP server error";
      outgoing.statusCode = 500;
      outgoing.setHeader("content-type", "application/json");
      outgoing.end(JSON.stringify({ error: { type: "chatgpt_tela_http_error", message: detail } }));
    }
  });

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
  let stopped = false;

  return Object.freeze({
    hostname: input.hostname,
    port: boundPort,
    async stop() {
      if (stopped) return;
      stopped = true;
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeIdleConnections?.();
      });
    },
  });
}
