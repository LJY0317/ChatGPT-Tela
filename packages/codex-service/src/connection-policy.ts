import type { CodexProfileStatus } from "./controller";
import type { CodexService } from "./controller";
import { diagnosticFailureClass, diagnosticFingerprint, emitDiagnosticEvent } from "@chatgpt-tela/core";

/** Saved intent cannot authorize taking over or restarting an existing app. */
export function restorableWorkProfiles(profiles: readonly CodexProfileStatus[], identities: readonly string[]): readonly number[] {
  const wanted = new Set(identities);
  return profiles.filter(profile => wanted.has(profile.targetId)
    && profile.controlState === "stopped" && profile.targetSessionState === "available"
    && profile.targetState !== "running").map(profile => profile.slot);
}

/** Startup is one restoration pass; startProfile owns the fresh target check. */
export async function restoreWorkProfiles(service: Pick<CodexService, "profiles" | "startProfile">,
  identities: readonly string[], signal: AbortSignal): Promise<void> {
  emitDiagnosticEvent("chatgpt_tela_codex", "profile_restore_started", { count: identities.length });
  let restored = 0, failed = 0;
  const inventory = identities.length ? await service.profiles() : [];
  const slots = restorableWorkProfiles(inventory, identities);
  const selectedTargets = new Set(identities);
  const restorableSlots = new Set(slots);
  for (const profile of inventory) {
    if (!selectedTargets.has(profile.targetId) || restorableSlots.has(profile.slot)) continue;
    const processFields = {
      ...(profile.childProcessId !== undefined ? { runtime_process_fingerprint: diagnosticFingerprint(String(profile.childProcessId)) } : {}),
      ...(profile.desktopProcessId !== undefined ? { desktop_process_fingerprint: diagnosticFingerprint(String(profile.desktopProcessId)) } : {}),
    };
    for (const [phase, state] of [["target_state", profile.targetState],
      ["session_state", profile.targetSessionState], ["control_state", profile.controlState]] as const) {
      emitDiagnosticEvent("chatgpt_tela_codex", "profile_restore_skipped", { slot: profile.slot, phase, state, ...processFields });
    }
  }
  for (const slot of slots) {
    if (signal.aborted) break;
    emitDiagnosticEvent("chatgpt_tela_codex", "profile_restore_attempted", { slot });
    try {
      const result = await service.startProfile(slot, { requireStopped: true });
      restored++;
      emitDiagnosticEvent("chatgpt_tela_codex", "profile_restore_succeeded", { slot,
        native_ready: result.targetSessionState === "ready", web_ready: result.webModelsReady === true });
    } catch (error) {
      failed++;
      emitDiagnosticEvent("chatgpt_tela_codex", "profile_restore_failed", { slot, failure_class: diagnosticFailureClass(error) });
    }
  }
  emitDiagnosticEvent("chatgpt_tela_codex", "profile_restore_completed", { count: restored, failure_count: failed,
    eligible_count: slots.length, skipped_count: identities.length - slots.length, operation_cancelled: signal.aborted });
}
