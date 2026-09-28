import { timingSafeEqual } from "node:crypto";
import { startWebHttpServer, type WebHttpServer } from "@chatgpt-tela/http-host";

const MAX_JPEG_BYTES = 4 * 1024 * 1024;

export interface ProfileBridgePreviewServer {
  readonly endpoint: URL;
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

export async function startProfileBridgePreviewServer(input: {
  readonly slot: number;
  readonly bearerToken: string;
  readonly observe: () => Promise<{ readonly activeSurfaceCount: number; readonly jpeg?: Uint8Array }>;
}): Promise<ProfileBridgePreviewServer> {
  if (!Number.isSafeInteger(input.slot) || input.slot < 1 || input.slot > 99) {
    throw new Error("profile bridge preview slot must be 1-99");
  }
  if (input.bearerToken.length < 32) throw new Error("profile bridge preview bearer is too short");
  const server: WebHttpServer = await startWebHttpServer({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodyBytes: 1024,
    async fetch(request) {
      if (request.headers.has("origin")) return new Response(null, { status: 403 });
      if (!sameSecret(bearer(request), input.bearerToken)) return new Response(null, { status: 401 });
      const url = new URL(request.url);
      if (request.method !== "GET" || url.pathname !== "/v1/bridge-preview") {
        return new Response(null, { status: 404 });
      }
      const observed = await input.observe();
      const jpeg = observed.activeSurfaceCount === 1 ? observed.jpeg : undefined;
      if (jpeg && jpeg.byteLength > MAX_JPEG_BYTES) {
        return Response.json({ error: { message: "bridge preview exceeded bounded size" } }, { status: 409 });
      }
      return Response.json({
        contractVersion: 1,
        slot: input.slot,
        activeSurfaceCount: observed.activeSurfaceCount,
        previewAvailable: jpeg !== undefined,
        ...(jpeg ? { imageMimeType: "image/jpeg", imageBase64: Buffer.from(jpeg).toString("base64") } : {}),
      }, { headers: { "cache-control": "no-store" } });
    },
  });
  let closed = false;
  return Object.freeze({
    endpoint: new URL(`http://127.0.0.1:${server.port}/`),
    async close() {
      if (closed) return;
      closed = true;
      await server.stop();
    },
  });
}
