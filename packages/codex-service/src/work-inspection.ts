import { diagnosticSourcePaths, inspectNativeThread } from "@chatgpt-tela/core";
import { connectCodexAppServerWebSocket, type CodexAppServerRpc } from "@chatgpt-tela/codex";
import type { CodexService } from "./controller";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Profile = Awaited<ReturnType<CodexService["profiles"]>>[number];

function readyOwner(profile: Profile | undefined, slot: number): Profile {
  if (!profile || profile.slot !== slot || profile.controlState !== "running"
    || profile.targetSessionState !== "ready" || !profile.childProcessId
    || !profile.responsesRouteFingerprint) {
    throw new Error("the selected Native profile is not currently owner-verified");
  }
  return profile;
}

/**
 * A bounded read-only Codex-service operation. Chat uses only the authenticated
 * service protocol: it must not import Native RPC, Desktop or browser runtimes.
 * A profile's active browser is not proof it belongs to this Native thread.
 */
export function createCodexWorkInspector(input: {
  readonly service: Pick<CodexService, "profiles" | "terminalSession" | "bridgePreview">;
  readonly logsRoot: string;
  readonly connect?: typeof connectCodexAppServerWebSocket;
}) {
  return async (slot: number, threadId: string, minutes = 30) => {
    if (!Number.isSafeInteger(slot) || slot < 1 || slot > 99 || !UUID.test(threadId)
      || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 120) {
      throw new Error("work inspection requires a valid slot, thread UUID and 1-120-minute window");
    }
    const before = readyOwner((await input.service.profiles()).find(row => row.slot === slot), slot);
    const session = await input.service.terminalSession(slot);
    if (session.slot !== slot) throw new Error("Native terminal session owner mismatch");
    const rpc: CodexAppServerRpc = await (input.connect ?? connectCodexAppServerWebSocket)(session.endpoint,
      { signal: AbortSignal.timeout(10_000) });
    let thread: Awaited<ReturnType<typeof inspectNativeThread>>;
    try {
      thread = await inspectNativeThread({
        rpc, slot, threadId, minutes,
        diagnosticPaths: diagnosticSourcePaths(input.logsRoot),
      });
    } finally {
      await rpc.close().catch(() => {});
    }
    // This is a current on-demand profile observation, not a stale log or
    // a proof that a browser card belongs to the requested Native thread.
    let browser: {
      readonly activeSurfaceCount: number | null;
      readonly selectedSurface: boolean;
      readonly approvalState: "pending" | "none" | "unavailable";
      readonly observationReason?: "automation_unavailable" | "dom_observation_failed"
        | "bridge_preview_failed" | "no_active_surface" | "surface_not_selected";
      readonly wait?: NonNullable<Awaited<ReturnType<typeof input.service.bridgePreview>>["approvalWait"]>;
    };
    let observedPreview: Awaited<ReturnType<typeof input.service.bridgePreview>> | undefined;
    try {
      observedPreview = await input.service.bridgePreview(slot);
    } catch { /* Separate unknown browser state from a proven Native result. */ }
    if (observedPreview && observedPreview.slot !== slot) throw Error("browser preview owner mismatch");
    if (observedPreview) {
      const preview = observedPreview;
      const selectedSurface = preview.selectedSurfaceId !== undefined || preview.activeSurfaceCount === 1;
      const observationReason = !selectedSurface
        ? preview.activeSurfaceCount === 0 ? "no_active_surface" : "surface_not_selected"
        : preview.approvalObservationReason
          ?? (preview.approvalState ? undefined : "dom_observation_failed");
      browser = {
        activeSurfaceCount: preview.activeSurfaceCount,
        selectedSurface,
        approvalState: selectedSurface ? preview.approvalState ?? "unavailable" : "unavailable",
        ...(observationReason ? { observationReason } : {}),
        ...(selectedSurface && preview.approvalWait ? { wait: preview.approvalWait } : {}),
      };
    } else {
      // Browser status is supplemental: a failed current observation must not
      // erase an independently verified Native thread, nor prove clearance.
      browser = {
        activeSurfaceCount: null, selectedSurface: false,
        approvalState: "unavailable", observationReason: "bridge_preview_failed",
      };
    }
    const after = readyOwner((await input.service.profiles()).find(row => row.slot === slot), slot);
    const freshSession = await input.service.terminalSession(slot);
    if (before.childProcessId !== after.childProcessId
      || before.responsesRouteFingerprint !== after.responsesRouteFingerprint
      || session.endpoint !== freshSession.endpoint || freshSession.slot !== slot) {
      throw new Error("Native owner changed during read-only work inspection");
    }
    return Object.freeze({
      ...thread,
      observedAt: new Date().toISOString(),
      browser: Object.freeze({
        scope: "selected_profile_only" as const,
        attributableToThread: false as const,
        ...browser,
        approvalAuthority: "observation_only" as const,
      }),
      hostPlatformReview: Object.freeze({
        visibility: "outside_tela_pre_ingress" as const,
        agentMayApprove: false as const,
      }),
    });
  };
}
