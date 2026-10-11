import { timingSafeEqual } from "node:crypto";
import { startWebHttpServer, type WebHttpServer } from "@chatgpt-tela/http-host";
import type { AccountCheck } from "./account-check";
import type { AccountDisplay } from "./account-display";
import { parseCodexAccountDisplayContract } from "@chatgpt-tela/service-protocol";

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
  readonly accountCheck?: () => Promise<AccountCheck>;
  readonly accountDisplay?: () => Promise<AccountDisplay>;
  readonly slot: number;
  readonly bearerToken: string;
  readonly webState?: () => unknown;
  readonly waitForWeb?: () => Promise<void>;
  readonly reconnectWeb?: () => Promise<void>;
  readonly reveal?: (id: string, interactive?: boolean) => Promise<void>;
  readonly observe: (id?: string) => Promise<{ readonly activeSurfaceCount: number; readonly surfaces?: readonly {readonly id: string; readonly label: string}[]; readonly selectedSurfaceId?: string; readonly jpeg?: Uint8Array; readonly approvalState?: "pending" | "none" | "unavailable" }>;
  readonly probeModelSelection?: () => Promise<{
    readonly familyCount: number;
    readonly exercised: boolean;
    readonly testedEffort?: "low" | "medium" | "high" | "xhigh" | "max";
    readonly restoredEffort: "low" | "medium" | "high" | "xhigh" | "max";
  }>;
  readonly probeContextAttachment?: (signal?: AbortSignal) => Promise<{
    readonly attachmentBytes: number;
    readonly receiptVerified: true;
  }>;
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
      if (request.method === "GET" && url.pathname === "/v1/account-display" && input.accountDisplay) {
        return Response.json(parseCodexAccountDisplayContract({ contractVersion: 1, slot: input.slot, ...await input.accountDisplay() }),
          { headers: { "cache-control": "no-store" } });
      }
      if (request.method === "GET" && url.pathname === "/v1/account-check" && input.accountCheck) {
        const { nativeSignIn, webBinding, nativeWebContainer, userIdentity } = await input.accountCheck();
        return Response.json({ contractVersion: 1, slot: input.slot, nativeSignIn, webBinding, nativeWebContainer, userIdentity },
          { headers: { "cache-control": "no-store" } });
      }
      if (request.method === "GET" && url.pathname === "/v1/web-state" && input.webState) {
        if (url.searchParams.get("wait") === "1") await input.waitForWeb?.();
        return Response.json(input.webState(), { headers: { "cache-control": "no-store" } });
      }
      if (request.method === "POST" && url.pathname === "/v1/web-reconnect" && input.reconnectWeb && input.webState) {
        try {
          await input.reconnectWeb();
          return Response.json(input.webState(), { headers: { "cache-control": "no-store" } });
        } catch {
          return Response.json({ error: { message: "Web reconnection did not complete. Native remains available. Finish any active Web turn before retrying." } },
            { status: 409, headers: { "cache-control": "no-store" } });
        }
      }
      if (request.method === "POST" && url.pathname === "/v1/model-selection-canary") {
        if (!input.probeModelSelection) return new Response(null, { status: 404 });
        try {
          const result = await input.probeModelSelection();
          return Response.json({ contractVersion: 1, slot: input.slot, ...result }, {
            headers: { "cache-control": "no-store" },
          });
        } catch (error) {
          return Response.json({
            error: {
              type: "chatgpt_tela_model_selection_canary_error",
              message: error instanceof Error ? error.message : String(error),
            },
          }, { status: 409, headers: { "cache-control": "no-store" } });
        }
      }
      if (request.method === "POST" && url.pathname === "/v1/context-attachment-canary") {
        if (!input.probeContextAttachment) return new Response(null, { status: 404 });
        try {
          const result = await input.probeContextAttachment(request.signal);
          return Response.json({ contractVersion: 1, slot: input.slot, ...result }, {
            headers: { "cache-control": "no-store" },
          });
        } catch (error) {
          return Response.json({
            error: {
              type: "chatgpt_tela_context_attachment_canary_error",
              message: error instanceof Error ? error.message : String(error),
            },
          }, { status: 409, headers: { "cache-control": "no-store" } });
        }
      }
      if (request.method === "POST" && url.pathname === "/v1/bridge-reveal") {
        const body = await request.json().catch(() => undefined);
        if (!input.reveal || typeof body?.surfaceId !== "string" || !/^surface_[A-Za-z0-9_-]{32}$/.test(body.surfaceId)) return new Response(null, { status: 400 });
        if (body.interactive !== undefined && typeof body.interactive !== "boolean") return new Response(null, { status: 400 });
        try { await input.reveal(body.surfaceId, body.interactive === true); return new Response(null, { status: 204 }); }
        catch { return Response.json({ error: { message: "Selected Web session has ended. Refresh the session list." } }, { status: 409 }); }
      }
      if (request.method !== "GET" || url.pathname !== "/v1/bridge-preview") return new Response(null, { status: 404 });
      const observed = await input.observe(url.searchParams.get("surfaceId") ?? undefined);
      const jpeg = observed.activeSurfaceCount === 1 || observed.selectedSurfaceId ? observed.jpeg : undefined;
      if (jpeg && jpeg.byteLength > MAX_JPEG_BYTES) {
        return Response.json({ error: { message: "bridge preview exceeded bounded size" } }, { status: 409 });
      }
      return Response.json({
        contractVersion: 1,
        slot: input.slot,
        activeSurfaceCount: observed.activeSurfaceCount,
        ...(observed.surfaces ? { surfaces: observed.surfaces } : {}),
        ...(observed.selectedSurfaceId ? { selectedSurfaceId: observed.selectedSurfaceId } : {}),
        ...(observed.selectedSurfaceId && observed.approvalState ? { approvalState: observed.approvalState } : {}),
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
