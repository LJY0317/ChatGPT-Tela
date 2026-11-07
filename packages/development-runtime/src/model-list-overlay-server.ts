import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { augmentNativeCodexModelCatalog } from "./web-model-catalog";
import { augmentCodexAppServerModelList } from "./app-server-model-list";
import type { ChatGptWebModelFamily } from "@chatgpt-tela/chatgpt";

const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** The public Plura model/list callback body, reusable behind an existing owned HTTP listener. */
export async function handleModelListOverlayRequest(input: {
  readonly request: Request;
  readonly families: () => readonly ChatGptWebModelFamily[];
  readonly localCompaction?: boolean;
}): Promise<Response> {
  if (input.request.method !== "POST") return new Response(null, { status: 405 });
  try {
    const bytes = await input.request.arrayBuffer();
    if (bytes.byteLength > MAX_BODY_BYTES) return Response.json({ error: "too_large" }, { status: 413 });
    const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)
      || (value as Record<string, unknown>).contractVersion !== 1 || !("result" in value)) {
      return Response.json({ error: "invalid_contract" }, { status: 400 });
    }
    const native = (value as Record<string, unknown>).result;
    const result = native && typeof native === "object" && !Array.isArray(native)
      && Array.isArray((native as Record<string, unknown>).models)
      ? augmentNativeCodexModelCatalog(native, input.families(), { localCompaction: input.localCompaction === true })
      : augmentCodexAppServerModelList(native, input.families());
    return Response.json({ contractVersion: 1, result });
  } catch {
    return Response.json({ error: "invalid_result" }, { status: 400 });
  }
}

export interface ModelListOverlayServer {
  readonly url: string;
  close(): Promise<void>;
}

function authorized(request: IncomingMessage, token: string): boolean {
  const supplied = request.headers.authorization;
  if (typeof supplied !== "string" || !supplied.startsWith("Bearer ")) return false;
  const actual = Buffer.from(supplied.slice(7));
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

export async function startModelListOverlayServer(input: {
  readonly token: string;
  readonly families: () => readonly ChatGptWebModelFamily[];
  readonly localCompaction?: boolean;
}): Promise<ModelListOverlayServer> {
  if (input.token.length < 32) throw new Error("model-list overlay token is too short");
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/model-list-overlay") {
      json(response, 404, { error: "not_found" });
      return;
    }
    if (!authorized(request, input.token)) {
      json(response, 401, { error: "unauthorized" });
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_BODY_BYTES) {
          json(response, 413, { error: "too_large" });
          return;
        }
        chunks.push(bytes);
      }
      const handled = await handleModelListOverlayRequest({
        request: new Request("http://127.0.0.1/model-list-overlay", {
          method: "POST", body: Buffer.concat(chunks),
        }),
        families: input.families,
        ...(input.localCompaction !== undefined ? { localCompaction: input.localCompaction } : {}),
      });
      response.writeHead(handled.status, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(await handled.text());
    } catch {
      json(response, 400, { error: "invalid_result" });
    }
  });
  server.requestTimeout = 2_000;
  server.headersTimeout = 2_000;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("model-list overlay did not bind TCP");
  return Object.freeze({
    url: `http://127.0.0.1:${address.port}/model-list-overlay`,
    close: () => new Promise<void>((resolvePromise, rejectPromise) => {
      server.close(error => error ? rejectPromise(error) : resolvePromise());
      server.closeAllConnections();
    }),
  });
}
