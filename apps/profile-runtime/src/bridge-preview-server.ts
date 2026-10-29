import { timingSafeEqual } from "node:crypto";
import { diagnosticFailureFields, emitDiagnosticEvent } from "@chatgpt-tela/core";
import { startWebHttpServer, type WebHttpServer } from "@chatgpt-tela/http-host";
import type { AccountCheck } from "./account-check";
import type { AccountDisplay } from "./account-display";
import { parseCodexApprovalWait, type CodexApprovalWaitContract, parseCodexAccountDisplayContract, parseCodexHistoryUiContract, parseCodexSavedDeleteAcceptanceContract, parseCodexSyntheticRecoveryContract, type CodexHistoryUiContract, type CodexSavedDeleteAcceptanceContract, type CodexSyntheticRecoveryContract } from "@chatgpt-tela/service-protocol";

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
  /** Cleanup receipt only. Keep this control endpoint and supervision lease
   * alive until the parent receives it and releases its lease. */
  readonly shutdownProfile?: () => Promise<{ readonly responsesRouteFingerprint: string }>;
  readonly shutdownReadiness?: () => "ready" | "blocked";
  readonly inspectCheckpointCandidates?: (threadId: string) => Promise<unknown>;
  readonly openAccountBrowser?: () => Promise<void>;
  readonly closeAccountBrowser?: () => Promise<void>;
  readonly inspectHistoryUi?: () => Promise<Omit<CodexHistoryUiContract, "slot">>;
  readonly runSavedDeleteAcceptance?: () => Promise<Omit<CodexSavedDeleteAcceptanceContract, "slot">>;
  readonly recoverSyntheticSavedChat?: () => Promise<Omit<CodexSyntheticRecoveryContract, "slot">>;
  readonly reveal?: (id: string, interactive?: boolean) => Promise<void>;
  readonly surfaces?: () => { readonly revision: number; readonly surfaces: readonly { readonly id: string; readonly label: string; readonly taskId?: string; readonly title?: string }[] };
  readonly onSurfacesChanged?: (listener: () => void) => () => void;
  readonly observe: (id?: string) => Promise<{ readonly activeSurfaceCount: number; readonly retention?: import("@chatgpt-tela/core").BrowserRetentionObservation; readonly surfaces?: readonly {readonly id: string; readonly label: string}[]; readonly selectedSurfaceId?: string; readonly jpeg?: Uint8Array; readonly approvalState?: "pending" | "none" | "unavailable"; readonly approvalObservationReason?: "automation_unavailable" | "dom_observation_failed"; readonly approvalWait?: CodexApprovalWaitContract }>;
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
  let shutdown: Promise<{ readonly responsesRouteFingerprint: string }> | undefined;
  const server: WebHttpServer = await startWebHttpServer({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodyBytes: 1024,
    async fetch(request) {
      if (request.headers.has("origin")) return new Response(null, { status: 403 });
      if (!sameSecret(bearer(request), input.bearerToken)) return new Response(null, { status: 401 });
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/v1/profile-stop" && input.shutdownProfile) {
        try {
          shutdown ??= input.shutdownProfile().catch(error => { shutdown = undefined; throw error; });
          const receipt = await shutdown;
          return Response.json({ contractVersion: 1, slot: input.slot,
            phase: "cleanup-complete", responsesRouteFingerprint: receipt.responsesRouteFingerprint },
          { headers: { "cache-control": "no-store" } });
        } catch (error) {
          emitDiagnosticEvent("chatgpt_tela_codex", "profile_shutdown_failed", {
            slot: input.slot, ...diagnosticFailureFields(error),
          });
          return Response.json({ error: { code: "tela_profile_shutdown_blocked",
            message: "The owned app has not completed normal shutdown. Its control connection is preserved." } },
          { status: 409, headers: { "cache-control": "no-store" } });
        }
      }
      if (request.method === "GET" && url.pathname === "/v1/shutdown-readiness" && input.shutdownReadiness) {
        return Response.json({ contractVersion: 1, slot: input.slot, shutdownReadiness: input.shutdownReadiness() },
          { headers: { "cache-control": "no-store" } });
      }
      if (request.method === "POST" && url.pathname === "/v1/checkpoint-inspection" && input.inspectCheckpointCandidates) {
        const body = await request.json().catch(() => undefined) as { threadId?: unknown } | undefined;
        if (!body || typeof body.threadId !== "string"
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.threadId)
          || Object.keys(body).some(key => key !== "threadId")) return new Response(null, { status: 400 });
        try {
          return Response.json({ ...(await input.inspectCheckpointCandidates(body.threadId) as Record<string, unknown>),
            contractVersion: 1, slot: input.slot, threadId: body.threadId },
            { headers: { "cache-control": "no-store" } });
        } catch {
          return Response.json({ contractVersion: 1, slot: input.slot, threadId: body.threadId,
            readiness: "unknown", reason: "storage_unavailable" },
            { headers: { "cache-control": "no-store" } });
        }
      }
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
        } catch (error) {
          emitDiagnosticEvent("chatgpt_tela_profile_startup", "web_reconnect_failed", {
            ...diagnosticFailureFields(error), slot: input.slot,
          });
          return Response.json({ error: { message: "Web reconnection did not complete. Native remains available. Finish any active Web turn before retrying." } },
            { status: 409, headers: { "cache-control": "no-store" } });
        }
      }
      if (request.method === "POST" && url.pathname === "/v1/account-browser" && input.openAccountBrowser) {
        try {
          await input.openAccountBrowser();
          return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
        } catch {
          return Response.json({ error: { message: "Finish your active Web work, then open the account browser." } },
            { status: 409, headers: { "cache-control": "no-store" } });
        }
      }
      if (request.method === "POST" && url.pathname === "/v1/account-browser-close" && input.closeAccountBrowser) {
        try {
          await input.closeAccountBrowser();
          return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
        } catch {
          return Response.json({ error: { message: "The owned account browser could not close and revalidate Web. Check the profile state." } },
            { status: 409, headers: { "cache-control": "no-store" } });
        }
      }
      if (request.method === "GET" && url.pathname === "/v1/account-browser-history-ui" && input.inspectHistoryUi) {
        try {
          const result = parseCodexHistoryUiContract({ ...await input.inspectHistoryUi(), slot: input.slot });
          return Response.json(result, { headers: { "cache-control": "no-store" } });
        } catch {
          return Response.json({ error: { message: "No idle owned account browser is available for history inspection." } },
            { status: 409, headers: { "cache-control": "no-store" } });
        }
      }
      if (request.method === "POST" && url.pathname === "/v1/account-browser-saved-delete-acceptance" && input.runSavedDeleteAcceptance) {
        try {
          const receipt = parseCodexSavedDeleteAcceptanceContract({
            ...await input.runSavedDeleteAcceptance(), slot: input.slot,
          });
          return Response.json(receipt, { headers: { "cache-control": "no-store" } });
        } catch {
          // A Send may have occurred. Never return a success receipt or silently retry.
          // The owned account browser remains open so the owner can manually clean up.
          return Response.json({ error: { message: "Saved test-chat deletion was not proven. Inspect the owner account browser without retrying Send." } },
            { status: 409, headers: { "cache-control": "no-store" } });
        }
      }
      if (request.method === "POST" && url.pathname === "/v1/account-browser-synthetic-cleanup" && input.recoverSyntheticSavedChat) {
        try {
          const receipt = parseCodexSyntheticRecoveryContract({
            ...await input.recoverSyntheticSavedChat(), slot: input.slot,
          });
          return Response.json(receipt, { headers: { "cache-control": "no-store" } });
        } catch {
          return Response.json({ error: { message: "One synthetic saved chat could not be safely verified or deleted. Inspect this owner's account browser; do not retry." } },
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
      if (request.method === "GET" && url.pathname === "/v1/bridge-surfaces" && input.surfaces) {
        const since = url.searchParams.get("since");
        if (since !== null && /^\d+$/.test(since) && input.onSurfacesChanged && Number(since) === input.surfaces().revision) {
          await new Promise<void>(resolve => {
            let finished = false;
            let unsubscribe = () => {};
            const done = () => {
              if (finished) return;
              finished = true;
              unsubscribe();
              request.signal.removeEventListener("abort", done);
              resolve();
            };
            unsubscribe = input.onSurfacesChanged!(done);
            request.signal.addEventListener("abort", done, { once: true });
            if (request.signal.aborted || input.surfaces!().revision !== Number(since)) done();
          });
        }
        if (request.signal.aborted) return new Response(null, { status: 499 });
        return Response.json({ contractVersion: 1, slot: input.slot, ...input.surfaces() },
          { headers: { "cache-control": "no-store" } });
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
        ...(observed.retention ? { retention: observed.retention } : {}),
        ...(observed.surfaces ? { surfaces: observed.surfaces } : {}),
        ...(observed.selectedSurfaceId ? { selectedSurfaceId: observed.selectedSurfaceId } : {}),
        ...(observed.selectedSurfaceId && observed.approvalState ? { approvalState: observed.approvalState } : {}),
        ...(observed.selectedSurfaceId && observed.approvalState === "unavailable" && observed.approvalObservationReason
          ? { approvalObservationReason: observed.approvalObservationReason } : {}),
        ...(observed.selectedSurfaceId && observed.approvalWait ? { approvalWait: parseCodexApprovalWait(observed.approvalWait) } : {}),
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
