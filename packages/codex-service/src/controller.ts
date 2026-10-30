import { diagnosticFailureClass, emitDiagnosticEvent } from "@chatgpt-tela/core";
import { connectCodexAppServerWebSocket, readDynamicWebModelCatalog, waitForLoadedAppServerIdle, countLoadedAppServerActiveTurns, interruptLoadedAppServerTurns } from "@chatgpt-tela/codex";
import { ProfileConnectionError, type ProfileConnectionPhase, type ProfileStartOptions } from "./profile-operation";
import { parseCodexTerminalSessionContract, type CodexTerminalSessionContract } from "@chatgpt-tela/service-protocol";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import {
  connectCodexTurnBridge,
  type RemoteTurnBridge,
  type TurnBridgeBackend,
} from "@chatgpt-tela/mcp";
import {
  parseCodexWebStateContract,
  parseCodexAccountCheckContract,
  type CodexAccountCheckContract,
  parseCodexAccountDisplayContract,
  parseCodexHistoryUiContract,
  type CodexHistoryUiContract,
  parseCodexSavedDeleteAcceptanceContract,
  type CodexSavedDeleteAcceptanceContract,
  parseCodexSyntheticRecoveryContract,
  type CodexSyntheticRecoveryContract,
  type CodexAccountDisplayContract,
  type CodexWebState,
  parseCodexBridgePreviewContract,
  parseCodexContextAttachmentCanaryContract,
  parseCodexModelSelectionCanaryContract,
  type CodexBridgePreviewContract,
  type CodexContextAttachmentCanaryContract,
  type CodexModelSelectionCanaryContract,
  type ServiceStatus,
} from "@chatgpt-tela/service-protocol";
import {
  CompositeNativeTargetAdapter,
  DefaultDesktopNativeTargetAdapter,
  MultiProfileNativeTargetAdapter,
  type CodexNativeTarget,
  type CodexNativeTargetAdapter,
  type CodexNativeTargetSession,
} from "./native-target";
import { profileLaunch, verifyProfileRuntimeProcess } from "./profile-launch";
import { RoutedCodexTurnBridge } from "./routed-turn-bridge";
import { createProfileSupervisorLease, type ProfileSupervisorLease } from "./profile-supervision";
import { nativeThreadDisplayTitle } from "./bridge-surface-title";

// Native and Web preparation share an authenticated startup lease and bounded deadline.
const CHILD_START_TIMEOUT_MS = 5 * 60_000;
const CHILD_STOP_TIMEOUT_MS = 20_000;

export interface CodexServiceConfig {
  readonly multiProfile?: { readonly launcherCli: string };
}

export interface CodexProfileStatus {
  readonly slot: number;
  readonly targetId: string;
  readonly targetDisplayName: string;
  readonly targetState: string;
  readonly targetSessionState: string;
  readonly controlState: "stopped" | "running" | "restart-required" | "orphaned";
  readonly childProcessId?: number;
  /** Exact Desktop process observed by the profile owner; never the launcher/waiter PID. */
  readonly desktopProcessId?: number;
  readonly connectionInProgress?: boolean;
  readonly webModelsReady?: boolean;
  readonly webState?: CodexWebState;
  readonly accountManagementActive?: boolean;
  readonly responsesRouteFingerprint?: string;
}

interface ChildReady {
  readonly runtimeProcessId: number;
  readonly stage: "product-profile-ready";
  readonly slot: number;
  readonly routeId: string;
  readonly targetId: string;
  readonly nativeTargetKind: "default-desktop" | "multi-profile";
  readonly profileId: string;
  readonly internalMcpUrl: string;
  readonly bridgePreviewUrl: string;
  readonly terminalEndpoint?: string;
  readonly responsesUrl: string;
  readonly responsesRouteFingerprint: string;
  readonly targetProcessId?: number;
  readonly nativeReady: true;
  readonly webState: CodexWebState;
}

type ProfileChildProcess = ChildProcessByStdio<null, Readable, Readable>;

interface OwnedProfile {
  readonly runtimeProcessId: number;
  readonly slot: number;
  readonly target: CodexNativeTarget;
  readonly routeId: string;
  readonly responsesRouteFingerprint: string;
  readonly targetProcessId?: number;
  readonly child: ProfileChildProcess;
  readonly bridge: RemoteTurnBridge;
  readonly supervisor: ProfileSupervisorLease;
  readonly bridgePreviewUrl: string;
  readonly terminalEndpoint?: string;
  readonly uiToken: string;
  readonly unmount: () => void;
  webState: CodexWebState;
  webModelsReady: boolean;
  accountManagementActive: boolean;
  catalogCheck?: Promise<boolean>;
  stopping: Promise<void> | undefined;
}

export interface CodexService {
  readonly instanceId: string;
  readonly config: CodexServiceConfig;
  readonly tools: TurnBridgeBackend;
  serviceStatus(): ServiceStatus;
  shutdownReadiness(): Promise<"ready" | "blocked">;
  waitForShutdownReadiness(signal?: AbortSignal): Promise<void>;
  profiles(): Promise<readonly CodexProfileStatus[]>;
  startProfile(slot: number, options?: ProfileStartOptions): Promise<CodexProfileStatus>;
  waitWebPreparation(slot: number): Promise<CodexProfileStatus>;
  reconnectWeb(slot: number): Promise<CodexProfileStatus>;
  stopProfile(slot: number): Promise<CodexProfileStatus>;
  terminalSession(slot: number): Promise<CodexTerminalSessionContract>;
  inspectCheckpointCandidates?(slot: number, threadId: string): Promise<unknown>;
  revealBridgeSurface?(slot: number, surfaceId: string, interactive?: boolean): Promise<void>;
  openAccountBrowser?(slot: number): Promise<void>;
  closeAccountBrowser?(slot: number): Promise<void>;
  inspectAccountBrowserHistoryUi?(slot: number): Promise<CodexHistoryUiContract>;
  runSavedDeleteAcceptance?(slot: number): Promise<CodexSavedDeleteAcceptanceContract>;
  recoverSyntheticSavedChat?(slot: number): Promise<CodexSyntheticRecoveryContract>;
  bridgeSurfaces(slot: number, since?: number, signal?: AbortSignal): Promise<{ contractVersion: 1; slot: number; revision: number; surfaces: readonly { id: string; label: string; title?: string }[] }>;
  bridgePreview(slot: number, surfaceId?: string, threadId?: string): Promise<CodexBridgePreviewContract>;
  accountCheck?(slot: number): Promise<CodexAccountCheckContract>;
  accountDisplay?(slot: number): Promise<CodexAccountDisplayContract>;
  contextAttachmentCanary(slot: number): Promise<CodexContextAttachmentCanaryContract>;
  modelSelectionCanary(slot: number): Promise<CodexModelSelectionCanaryContract>;
  close(): Promise<void>;
  readonly activeProfileCount: number;
}

/** The Codex owner proved shutdown did not begin because work is active or unverifiable. */
export class CodexShutdownNotStartedError extends Error {
  constructor() {
    super("Tela Codex has active or unverifiable Native/Web work; finish it before shutdown");
    this.name = "CodexShutdownNotStartedError";
  }
}

function routeId(): string {
  return randomBytes(10).toString("hex");
}

function secret(): string {
  return randomBytes(36).toString("base64url");
}

function slotNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 99) throw new Error("profile slot must be an integer from 1 to 99");
  return value;
}

function childReady(value: unknown, expected: {
  readonly slot: number;
  readonly routeId: string;
  readonly targetId: string;
  readonly nativeTargetKind: "default-desktop" | "multi-profile";
}): ChildReady {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("profile child readiness output is not a JSON object");
  }
  const item = value as Record<string, unknown>;
  const string = (key: string): string => {
    const field = item[key];
    if (typeof field !== "string" || !field.trim()) throw new Error(`profile child readiness is missing ${key}`);
    return field;
  };
  if (item.stage !== "product-profile-ready"
    || item.slot !== expected.slot
    || string("routeId") !== expected.routeId
    || string("targetId") !== expected.targetId
    || item.nativeTargetKind !== expected.nativeTargetKind
    || item.nativeReady !== true
    || !["preparing", "ready", "login-required", "failed", "closed"].includes(item.webState as string)) {
    throw new Error("profile child readiness identity does not match the requested profile");
  }
  const internalMcpUrl = new URL(string("internalMcpUrl"));
  const bridgePreviewUrl = new URL(string("bridgePreviewUrl"));
  const responsesUrl = new URL(string("responsesUrl"));
  for (const url of [internalMcpUrl, bridgePreviewUrl, responsesUrl]) {
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      throw new Error("profile child readiness exposed a non-loopback endpoint");
    }
  }
  const fingerprint = string("responsesRouteFingerprint");
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("profile child route fingerprint is invalid");
  if (!Number.isSafeInteger(item.runtimeProcessId) || (item.runtimeProcessId as number) < 1) {
    throw new Error("profile runtime process identity is invalid");
  }
  const targetProcessId = item.targetProcessId;
  if (targetProcessId !== undefined
    && (!Number.isSafeInteger(targetProcessId) || (targetProcessId as number) < 1)) {
    throw new Error("profile child target process id is invalid");
  }
  return Object.freeze({
    stage: "product-profile-ready",
    runtimeProcessId: item.runtimeProcessId as number,
    slot: expected.slot,
    routeId: expected.routeId,
    targetId: expected.targetId,
    nativeTargetKind: expected.nativeTargetKind,
    profileId: string("profileId"),
    internalMcpUrl: internalMcpUrl.href,
    bridgePreviewUrl: bridgePreviewUrl.href,
    ...(item.terminalEndpoint === undefined ? {} : { terminalEndpoint: parseCodexTerminalSessionContract({
      contractVersion: 1, slot: expected.slot, endpoint: item.terminalEndpoint,
      runtimeProcessId: item.runtimeProcessId, responsesRouteFingerprint: fingerprint,
    }).endpoint }),
    responsesUrl: responsesUrl.href,
    responsesRouteFingerprint: fingerprint,
    ...(targetProcessId === undefined ? {} : { targetProcessId: targetProcessId as number }),
    nativeReady: true,
    webState: item.webState as CodexWebState,
  });
}

async function waitForProfileReady(child: ProfileChildProcess, supervisor: ProfileSupervisorLease, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      child.removeListener("error", onError); child.removeListener("exit", onExit);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (value?: unknown, error?: Error) => {
      if (settled) return; settled = true; cleanup();
      if (error) reject(error); else resolve(value);
    };
    const onError = (cause: Error) => finish(undefined, new Error("profile child failed to start", {cause}));
    const onExit = () => finish(undefined, new Error("profile child exited before readiness"));
    const onAbort = () => finish(undefined, new Error("profile start cancelled by service shutdown"));
    const timeout = setTimeout(() => finish(undefined, new Error("profile authenticated readiness timed out")), CHILD_START_TIMEOUT_MS);
    child.stdout.resume(); child.stderr.resume();
    child.once("error", onError); child.once("exit", onExit);
    signal?.addEventListener("abort", onAbort, {once:true});
    void supervisor.ready.then(value => finish(value), error => finish(undefined, error));
    if (signal?.aborted) onAbort();
    else if (child.exitCode !== null || child.signalCode !== null) onExit();
  });
}

async function waitForExit(child: ProfileChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise(resolvePromise => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeListener("exit", exited);
      resolvePromise(value);
    };
    const exited = () => finish(true);
    child.once("exit", exited);
    const timeout = setTimeout(() => finish(false), timeoutMs);
  });
}

function ownsNativeTargetSession(
  target: CodexNativeTarget,
  session: CodexNativeTargetSession,
  owned: OwnedProfile | undefined,
): boolean {
  if (!owned || owned.child.exitCode !== null || owned.child.signalCode !== null) return false;
  return nativeTargetRouteMatches(target, session, owned);
}

function nativeTargetRouteMatches(
  target: CodexNativeTarget,
  session: CodexNativeTargetSession,
  owned: OwnedProfile | undefined,
): boolean {
  if (!owned) return false;
  if (target.adapterKind === "default-desktop") {
    return owned.targetProcessId !== undefined
      && session.desktopProcessId === owned.targetProcessId;
  }
  return session.state === "ready"
    && session.responsesRouteFingerprint === owned.responsesRouteFingerprint;
}

/** Positive detachment evidence; unavailable discovery alone is not an idle receipt. */
function nativeTargetDetached(target: CodexNativeTarget, session: CodexNativeTargetSession, owned: OwnedProfile): boolean {
  if (session.state === "available") return true;
  return target.adapterKind === "default-desktop"
    ? session.desktopProcessId !== undefined && owned.targetProcessId !== undefined
      && session.desktopProcessId !== owned.targetProcessId
    : session.state === "ready" && session.responsesRouteFingerprint !== undefined
      && session.responsesRouteFingerprint !== owned.responsesRouteFingerprint;
}

function statusFor(target: CodexNativeTarget, slot: number, session: CodexNativeTargetSession, owned?: OwnedProfile): CodexProfileStatus {
  const childAlive = owned?.child.exitCode === null && owned.child.signalCode === null;
  const ownershipMatches = ownsNativeTargetSession(target, session, owned);
  const controlState: CodexProfileStatus["controlState"] = owned
    ? (childAlive && ownershipMatches ? "running" : "orphaned")
    : session.state === "available"
      ? "stopped"
      : "restart-required";
  return Object.freeze({
    slot,
    targetId: target.id,
    targetDisplayName: target.displayName,
    targetState: target.state,
    targetSessionState: ownershipMatches ? "ready" : session.state,
    ...(ownershipMatches && owned ? { webModelsReady: owned.webModelsReady, webState: owned.webState,
      ...(owned.accountManagementActive ? { accountManagementActive: true } : {}) } : {}),
    controlState,
    ...(session.desktopProcessId ? { desktopProcessId: session.desktopProcessId } : {}),
    ...(owned ? { childProcessId: owned.runtimeProcessId } : {}),
    ...(owned ? { responsesRouteFingerprint: owned.responsesRouteFingerprint } : {}),
  });
}

export async function startCodexService(input: {
  readonly config: CodexServiceConfig;
  readonly profileRuntimeCommand: readonly [string, ...string[]];
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Re-read user-controlled profile preferences at each profile start without restarting the Codex service. */
  readonly profileRuntimeEnvironment?: (slot: number) => Readonly<Record<string, string | undefined>>;
  readonly nativeTargetAdapter?: CodexNativeTargetAdapter;
  readonly onProfileConnectionChanged?: (targetId: string, enabled: boolean) => void;
  readonly webDelegationCapacity?: (slot: number) => { readonly total: { readonly used: number }; readonly uncertain: number }
    | Promise<{ readonly total: { readonly used: number }; readonly uncertain: number }>;
  readonly signal?: AbortSignal;
}): Promise<CodexService> {
  const instanceId = randomUUID();
  // Default Desktop is owned by Tela's built-in adapter. Additional profiles are
  // optional; provider removal cannot remove the ordinary single-profile path.
  // Start still proves/ends the exact existing app before acquiring a new runtime.
  const targets = input.nativeTargetAdapter ?? new CompositeNativeTargetAdapter({
    defaultDesktop: new DefaultDesktopNativeTargetAdapter(input.environment ? { environment: input.environment } : {}),
    ...(input.config.multiProfile ? {
      multiProfile: new MultiProfileNativeTargetAdapter({ launcherCli: input.config.multiProfile.launcherCli }),
    } : {}),
  });
  const routedBridge = new RoutedCodexTurnBridge();
  const owned = new Map<number, OwnedProfile>();
  const starting = new Map<number, Promise<void>>();
  const stoppingProfiles = new Set<number>();
  let closing: Promise<void> | undefined;
  let stopping = false;

  const targetAndSession = async (slot: number) => {
    return targets.resolve(slot, input.signal);
  };

  const interruptNativeTurns = async (slot: number, session: CodexNativeTargetSession): Promise<void> => {
    emitDiagnosticEvent("chatgpt_tela_codex", "profile_native_work_settlement", { slot, endpoint_available: !!session.endpoint });
    if (!session.endpoint) return;
    const count = await interruptLoadedAppServerTurns(session.endpoint, {
      ...(input.signal ? { signal: input.signal } : {}),
    });
    emitDiagnosticEvent("chatgpt_tela_codex", "profile_turns_interrupted", { slot, count });
  };

  const profileShutdownReadiness = async (profile: OwnedProfile, duringStop = false): Promise<"ready" | "blocked"> => {
    // Cancelling service work must not cancel cleanup of already-owned resources.
    const signal = duringStop ? undefined : input.signal;
    const blocked = (reason_class: string) => {
      emitDiagnosticEvent("chatgpt_tela_codex", "profile_shutdown_blocked", { slot: profile.slot, reason_class });
      return "blocked" as const;
    };
    if ((!duringStop && (profile.stopping || stoppingProfiles.has(profile.slot) || starting.has(profile.slot)))
      || profile.child.exitCode !== null || profile.child.signalCode !== null) return blocked("profile_transition");
    // Readiness belongs to this owned runtime, not a replacement Desktop.
    // stopOwned/runtime cleanup separately prove ownership before quitting an app.
    // The built-in Desktop adapter reports process identity, not the routed
    // app-server. Use the same owned endpoint as terminalSession for all targets.
    const session = await targets.session(profile.target.id, signal);
    try {
      if (!profile.terminalEndpoint) throw new Error("native endpoint unavailable");
      if (await countLoadedAppServerActiveTurns(profile.terminalEndpoint, signal ? { signal } : {}) > 0) return blocked("native_work");
    } catch (error) {
      if (!nativeTargetDetached(profile.target, session, profile)) throw error;
      emitDiagnosticEvent("chatgpt_tela_codex", "detached_native_observation_unavailable", { slot: profile.slot, phase: "readiness" });
    }
    // A replaced Desktop no longer belongs to this runtime. Drain its Web work
    // below, but do not require its obsolete Native connection to recover.
    const response = await fetch(new URL("v1/shutdown-readiness", profile.bridgePreviewUrl), {
      headers: { authorization: `Bearer ${profile.uiToken}` },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000),
    });
    if (!response.ok) return blocked("runtime_readiness_unavailable");
    const web = await response.json() as { contractVersion?: unknown; slot?: unknown; shutdownReadiness?: unknown };
    if (web.contractVersion !== 1 || web.slot !== profile.slot || web.shutdownReadiness !== "ready") return blocked("runtime_not_ready");
    if (input.webDelegationCapacity) {
      const capacity = await input.webDelegationCapacity(profile.slot);
      if (capacity.uncertain > 0 || capacity.total.used > 0) return blocked("delegation_reservation");
    }
    return "ready";
  };

  const shutdownReadiness = async (duringClose = false): Promise<"ready" | "blocked"> => {
    if ((!duringClose && (stopping || starting.size > 0)) || stoppingProfiles.size > 0) return "blocked";
    try {
      for (const profile of owned.values()) {
        if (await profileShutdownReadiness(profile, duringClose) !== "ready") return "blocked";
      }
      return "ready";
    } catch (error) {
      emitDiagnosticEvent("chatgpt_tela_codex", "shutdown_observation_failed", { failure_class: diagnosticFailureClass(error) });
      return "blocked";
    }
  };

  const stopOwned = async (profile: OwnedProfile, interruptTurns = false): Promise<void> => {
    if (profile.stopping) return profile.stopping;
    stoppingProfiles.add(profile.slot);
    let phase = "ownership";
    profile.stopping = (async () => {
      // Startup cancellation must not cancel normal cleanup of already-owned resources.
      const session = await targets.session(profile.target.id);
      const ownsTargetRoute = ownsNativeTargetSession(profile.target, session, profile);
      if (ownsTargetRoute && profile.target.adapterKind === "multi-profile") {
        phase = "native_work_settlement";
        if (interruptTurns) await interruptNativeTurns(profile.slot, session);
        else if (await profileShutdownReadiness(profile, true) !== "ready") {
          throw new Error("Tela Codex profile has active or unverifiable Native/Web work; finish it before shutdown");
        }
        phase = "normal_quit";
        const afterQuit = await targets.quit(profile.target.id);
        if (afterQuit.state === "ready") throw new Error("native target remained ready after normal quit");
      }
      // Process exit alone cannot attest successful Desktop cleanup. Keep the
      // exact control/supervision owner until its authenticated runtime receipt.
      phase = "runtime_cleanup";
      const response = await fetch(new URL("v1/profile-stop", profile.bridgePreviewUrl), {
        method: "POST", headers: { authorization: `Bearer ${profile.uiToken}` },
        signal: AbortSignal.timeout(CHILD_STOP_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error("Profile normal shutdown was not acknowledged; owner preserved");
      const receipt = await response.json() as { contractVersion?: unknown; slot?: unknown; phase?: unknown; responsesRouteFingerprint?: unknown };
      if (receipt.contractVersion !== 1 || receipt.slot !== profile.slot || receipt.phase !== "cleanup-complete"
        || receipt.responsesRouteFingerprint !== profile.responsesRouteFingerprint) {
        throw new Error("Profile shutdown receipt does not match its owned route");
      }
      profile.unmount();
      await profile.bridge.close().catch(() => {});
      await profile.supervisor.close();
      phase = "child_exit";
      if (!await waitForExit(profile.child, CHILD_STOP_TIMEOUT_MS)) {
        throw new Error(`Tela Codex profile ${profile.slot} child did not exit after its target closed`);
      }
      if (profile.child.exitCode !== 0 || profile.child.signalCode !== null) {
        throw new Error("Profile child did not exit successfully after acknowledged cleanup");
      }
      await profile.supervisor.close().catch(() => {});
      owned.delete(profile.slot);
    })().catch(error => {
      emitDiagnosticEvent("chatgpt_tela_codex", "profile_stop_failed", {
        slot: profile.slot, phase, failure_class: diagnosticFailureClass(error),
      });
      profile.stopping = undefined;
      throw error;
    }).finally(() => {
      stoppingProfiles.delete(profile.slot);
    });
    return profile.stopping;
  };

  async function refreshWebStatus(profile: OwnedProfile, wait = false): Promise<void> {
    profile.catalogCheck ??= (async () => {
      try {
        const response = await fetch(new URL(`v1/web-state${wait ? "?wait=1" : ""}`, profile.bridgePreviewUrl), {
          headers: { authorization: `Bearer ${profile.uiToken}` },
          signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(wait ? CHILD_START_TIMEOUT_MS : 5_000)]) : AbortSignal.timeout(wait ? CHILD_START_TIMEOUT_MS : 5_000),
        });
        if (!response.ok) throw new Error("Web state unavailable");
        const state = parseCodexWebStateContract(await response.json());
        if (state.slot !== profile.slot) throw new Error("Web state owner mismatch");
        profile.webState = state.webState;
        profile.accountManagementActive = state.accountManagementActive === true;
        if (state.webState !== "ready" || !profile.terminalEndpoint) return false;
        const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000);
        const rpc = await connectCodexAppServerWebSocket(profile.terminalEndpoint, { signal });
        try {
          const ids = await readDynamicWebModelCatalog(rpc, signal);
          return ids.length === state.webModelIds.length && state.webModelIds.every(id => ids.includes(id));
        } finally { await rpc.close(); }
      } catch { return false; }
    })();
    const check = profile.catalogCheck;
    try { profile.webModelsReady = await check; }
    finally { if (profile.catalogCheck === check) delete profile.catalogCheck; }
  }
  async function controlledProfile(slotValue: number): Promise<OwnedProfile> {
    const slot = slotNumber(slotValue);
    const profile = owned.get(slot);
    if (!profile || profile.stopping || profile.child.exitCode !== null || profile.child.signalCode !== null) throw new Error("Native profile is not running");
    const session = await targets.session(profile.target.id, input.signal);
    if (owned.get(slot) !== profile || profile.stopping || !ownsNativeTargetSession(profile.target, session, profile)) throw new Error("Native profile ownership changed");
    return profile;
  }
  async function profileStatus(profile: OwnedProfile): Promise<CodexProfileStatus> {
    const session = await targets.session(profile.target.id, input.signal);
    return statusFor(profile.target, profile.slot, session, owned.get(profile.slot));
  }

  async function readProfileAccount<T extends { readonly slot: number }>(slotValue: number, path: string, parse: (value: unknown) => T): Promise<T> {
    const slot = slotNumber(slotValue);
    const profile = await controlledProfile(slot);
    const timeout = AbortSignal.timeout(20_000);
    const response = await fetch(new URL(path, profile.bridgePreviewUrl), {
      headers: { authorization: `Bearer ${profile.uiToken}` },
      signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error("Account observation unavailable. Check the profile connection.");
    const value = parse(await response.json());
    if (value.slot !== slot || await controlledProfile(slot) !== profile) throw new Error("account observation ownership changed");
    return value;
  }

  const service: CodexService = Object.freeze({
    instanceId,
    config: input.config,
    tools: routedBridge,
    serviceStatus() {
      return Object.freeze({ contractVersion: 1 as const, service: "codex" as const, instanceId,
        state: stopping ? "stopping" as const : "ready" as const });
    },
    shutdownReadiness,
    async waitForShutdownReadiness(signal?: AbortSignal) {
      let phase = "profile_registry", slot: number | undefined;
      try {
        const observation = input.signal && signal ? AbortSignal.any([input.signal, signal]) : signal ?? input.signal;
        observation?.throwIfAborted();
        if (starting.size > 0 || stopping || stoppingProfiles.size > 0) throw new CodexShutdownNotStartedError();
        for (const profile of owned.values()) {
          if (stopping || profile.stopping) throw new CodexShutdownNotStartedError();
          slot = profile.slot; phase = "native_ownership";
          const session = await targets.session(profile.target.id, observation);
          phase = "native_completion";
          try {
            if (!profile.terminalEndpoint) throw new CodexShutdownNotStartedError();
            await waitForLoadedAppServerIdle(profile.terminalEndpoint, observation ? { signal: observation } : {});
          } catch (error) {
            observation?.throwIfAborted();
            if (!nativeTargetDetached(profile.target, session, profile)) throw error;
            emitDiagnosticEvent("chatgpt_tela_codex", "detached_native_observation_unavailable", { slot, phase });
          }
          // Web preparation is separate from Native inference. This existing wait
          // joins its owner; aborting the HTTP observation cannot cancel that work.
          phase = "web_preparation";
          const response = await fetch(new URL("v1/web-state?wait=1", profile.bridgePreviewUrl), {
            headers: { authorization: `Bearer ${profile.uiToken}` },
            timeout: false,
            ...(observation ? { signal: observation } : {}),
          });
          if (!response.ok || owned.get(profile.slot) !== profile) throw new CodexShutdownNotStartedError();
          await response.body?.cancel();
        }
        observation?.throwIfAborted();
        // Account UI, unsettled delegation or a newly admitted turn is not proof
        // of completion. Return to the caller rather than poll an unchanged gate.
        phase = "final_readiness"; slot = undefined;
        if (await shutdownReadiness() !== "ready") throw new CodexShutdownNotStartedError();
      } catch (error) {
        emitDiagnosticEvent("chatgpt_tela_codex", "shutdown_wait_failed", {
          phase, ...(slot === undefined ? {} : { slot }), failure_class: diagnosticFailureClass(error),
          abort_observed: signal?.aborted === true || input.signal?.aborted === true,
        });
        throw error;
      }
    },
    async profiles() {
      const inventory = await targets.profiles(input.signal);
      return Object.freeze(await Promise.all(inventory.map(async ({ target, session }) => {
        const profile = owned.get(target.slot);
        if (profile && !profile.stopping && ownsNativeTargetSession(target, session, profile)) {
          await refreshWebStatus(profile);

        }
        return Object.freeze({ ...statusFor(target, target.slot, session, owned.get(target.slot)),
          connectionInProgress: starting.has(target.slot) });
      })));
    },
    async startProfile(slotValue: number, options?: ProfileStartOptions) {
      if (stopping || input.signal?.aborted) throw new Error("Tela Codex is stopping");
      const slot = slotNumber(slotValue);
      if (starting.has(slot)) throw new Error("A connection operation is already running for this profile; wait for it to finish");
      let settleStart!: () => void;
      starting.set(slot, new Promise<void>(resolve => { settleStart = resolve; }));
      let phase: ProfileConnectionPhase = "checking";
      const progress = (value: ProfileConnectionPhase) => {
        phase = value;
        emitDiagnosticEvent("chatgpt_tela_codex", "profile_connection_phase", { slot, phase: value });
        options?.onProgress?.(value);
      };
      try {
      progress("checking");
      const existing = owned.get(slot);
      const existingRunning = existing && existing.child.exitCode === null && existing.child.signalCode === null;
      // A stopped launch with no live owned child performs its fresh state check below, immediately
      // before preparation. Early discovery is needed only to protect a possible live-owner transition
      // or explicit PID-bound reopen consent; do not duplicate cold-launch adapter work.
      if (options?.expectedDesktopProcessId !== undefined || (options?.requireStopped && existingRunning)) {
        if (options?.expectedDesktopProcessId !== undefined && (!Number.isSafeInteger(options.expectedDesktopProcessId) || options.expectedDesktopProcessId < 1)) {
          throw new Error("Invalid ChatGPT process identity");
        }
        const observed = await targetAndSession(slot);
        if (options?.expectedDesktopProcessId !== undefined && observed.session.desktopProcessId !== options.expectedDesktopProcessId) {
          throw new Error("ChatGPT has changed since you chose to reopen it; the current app was kept open");
        }
        if (options?.requireStopped && (observed.session.state !== "available" || observed.target.state === "running")) {
          throw new Error("Work restoration requires a stopped target; existing app preserved");
        }
      }
      if (existingRunning) {
        const current = await targets.session(existing.target.id, input.signal);
        if (ownsNativeTargetSession(existing.target, current, existing)) {
          input.onProfileConnectionChanged?.(existing.target.id, true);
          return statusFor(existing.target, slot, current, existing);
        }
        progress("closing");
        await stopOwned(existing, true);
      }
      if (existing) {
        existing.unmount();
        await existing.bridge.close().catch(() => {});
        owned.delete(slot);
      }
      const { target, session: initialSession } = await targetAndSession(slot);
      let session = initialSession;
      if (options?.expectedDesktopProcessId !== undefined && session.desktopProcessId !== options.expectedDesktopProcessId) {
        throw new Error("ChatGPT has changed since you chose to reopen it; the current app was kept open");
      }
      if (options?.requireStopped && (session.state !== "available" || target.state === "running")) {
        throw new Error("Work restoration requires a stopped target; existing app preserved");
      }
      if (session.state === "restart-required"
        || (session.state === "ready" && (session.responsesRouteFingerprint === undefined
          || options?.expectedDesktopProcessId !== undefined))) {
        progress("closing");
        emitDiagnosticEvent("chatgpt_tela_codex", "profile_reopen_quit_started", { slot,
          endpoint_available: !!session.endpoint, pid_bound: options?.expectedDesktopProcessId !== undefined,
          native_work_settlement_requested: options?.expectedDesktopProcessId === undefined });
        if (options?.expectedDesktopProcessId === undefined) await interruptNativeTurns(slot, session);
        session = await targets.quit(target.id, input.signal, options?.expectedDesktopProcessId);
      }
      if (session.state !== "available") {
        throw new Error(`${target.displayName} must be normally quit before Tela Codex can attach its route (state=${session.state})`);
      }
      progress("preparing");
      const route = routeId();
      const responsesToken = secret();
      const internalMcpToken = secret();
      const uiToken = secret();
      const supervisor = await createProfileSupervisorLease({ onProgress: phase => progress(phase as ProfileConnectionPhase) });
      const launch = profileLaunch(input.profileRuntimeCommand);
      let child: ProfileChildProcess;
      try {
        child = spawn(launch.command[0], launch.command.slice(1), {
          env: {
            ...process.env,
            ...(input.environment ?? {}),
            ...(input.profileRuntimeEnvironment?.(slot) ?? {}),
            CHATGPT_TELA_PRODUCT_PROFILE_SLOT: String(slot),
            CHATGPT_TELA_PRODUCT_ROUTE_ID: route,
            ...targets.profileRuntimeEnvironment(target),
            CHATGPT_TELA_PRODUCT_RESPONSES_TOKEN: responsesToken,
            CHATGPT_TELA_PRODUCT_INTERNAL_MCP_TOKEN: internalMcpToken,
            CHATGPT_TELA_PRODUCT_UI_TOKEN: uiToken,
            ...supervisor.environment,
          },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        await supervisor.close().catch(() => {});
        throw error;
      }
      let ready: ChildReady;
      try {
        ready = childReady(await waitForProfileReady(child, supervisor, input.signal), {
          slot,
          routeId: route,
          targetId: target.id,
          nativeTargetKind: target.adapterKind,
        });
        await verifyProfileRuntimeProcess(launch, ready.runtimeProcessId, child.pid);
        child.stdout.resume();
      } catch (error) {
        await supervisor.close().catch(() => {});
        await waitForExit(child, CHILD_STOP_TIMEOUT_MS);
        throw error;
      }
      let bridge: RemoteTurnBridge | undefined;
      try {
        progress("connecting");
        bridge = await connectCodexTurnBridge({ endpoint: ready.internalMcpUrl, bearerToken: internalMcpToken,
          clientName: "chatgpt-tela-codex-service" });
        const unmount = routedBridge.mount(route, bridge);
        const profile: OwnedProfile = {
          runtimeProcessId: ready.runtimeProcessId,
          slot,
          target,
          routeId: route,
          responsesRouteFingerprint: ready.responsesRouteFingerprint,
          ...(ready.targetProcessId === undefined ? {} : { targetProcessId: ready.targetProcessId }),
          child,
          bridge,
          supervisor,
          bridgePreviewUrl: ready.bridgePreviewUrl,
          ...(ready.terminalEndpoint === undefined ? {} : { terminalEndpoint: ready.terminalEndpoint }),
          uiToken,
          unmount,
          webState: ready.webState,
          webModelsReady: false,
          accountManagementActive: false,
          stopping: undefined,
        };
        owned.set(slot, profile);
        child.once("exit", () => {
          if (owned.get(slot) !== profile) return;
          if (profile.stopping) return;
          profile.unmount();
          void profile.supervisor.close().catch(() => {});
          void profile.bridge.close().catch(() => {});
          void (async () => {
            try {
              const session = await targets.session(profile.target.id);
              if (nativeTargetRouteMatches(profile.target, session, profile)) {
                const afterQuit = await targets.quit(profile.target.id);
                if (afterQuit.state === "ready") {
                  throw new Error("native target remained ready after unexpected profile child exit");
                }
              }
              emitDiagnosticEvent("chatgpt_tela_codex", "profile_child_exit_cleanup_complete", { slot });
            } catch {
              emitDiagnosticEvent("chatgpt_tela_codex", "profile_child_exit_cleanup_failed", { slot });
            } finally {
              if (owned.get(slot) === profile) owned.delete(slot);
            }
          })();
        });
        const status = statusFor(target, slot, await targets.session(target.id, input.signal), profile);
        progress("ready");
        input.onProfileConnectionChanged?.(target.id, true);
        return status;
      } catch (error) {
        const partial = owned.get(slot);
        if (partial?.child === child) { partial.unmount(); owned.delete(slot); }
        await bridge?.close().catch(() => {});
        await supervisor.close().catch(() => {});
        await waitForExit(child, CHILD_STOP_TIMEOUT_MS);
        throw error;
      }
      } catch (cause) {
        emitDiagnosticEvent("chatgpt_tela_codex", "profile_connection_failed", { slot, phase });
        throw new ProfileConnectionError(phase, { cause });
      } finally { starting.delete(slot); settleStart(); }
    },
    async stopProfile(slotValue: number) {
      const slot = slotNumber(slotValue);
      const profile = owned.get(slot);
      if (profile) await stopOwned(profile, true);
      const { target, session } = await targetAndSession(slot);
      if (!profile && session.state === "ready") {
        throw new Error(`${target.displayName} is routed by another owner; refusing to stop it`);
      }
      input.onProfileConnectionChanged?.(target.id, false);
      return statusFor(target, slot, session, undefined);
    },
    async waitWebPreparation(slotValue: number) {
      const profile = await controlledProfile(slotValue);
      // Join an already-running inventory read, then perform one event-driven wait.
      await profile.catalogCheck;
      await refreshWebStatus(profile, true);
      return profileStatus(profile);
    },
    async reconnectWeb(slotValue: number) {
      const profile = await controlledProfile(slotValue);
      const response = await fetch(new URL("v1/web-reconnect", profile.bridgePreviewUrl), {
        method: "POST", headers: { authorization: `Bearer ${profile.uiToken}` },
        signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(CHILD_START_TIMEOUT_MS)]) : AbortSignal.timeout(CHILD_START_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error("Web reconnection did not complete. Native remains available; finish any active Web turn before retrying.");
      const state = parseCodexWebStateContract(await response.json());
      if (state.slot !== profile.slot) throw new Error("Web reconnect owner mismatch");
      profile.webState = state.webState;
      profile.accountManagementActive = state.accountManagementActive === true;
      await profile.catalogCheck;
      await refreshWebStatus(profile);
      return profileStatus(profile);
    },
    async terminalSession(slotValue: number) {
      const slot = slotNumber(slotValue);
      const profile = owned.get(slot);
      if (!profile || profile.stopping || profile.child.exitCode !== null || profile.child.signalCode !== null) {
        throw new Error("terminal requires a running Tela profile");
      }
      const session = await targets.session(profile.target.id, input.signal);
      if (owned.get(slot) !== profile || profile.stopping || !ownsNativeTargetSession(profile.target, session, profile)) {
        throw new Error("terminal profile route ownership changed");
      }
      if (!profile.terminalEndpoint) throw new Error("profile runtime requires an update before terminal attachment");
      return parseCodexTerminalSessionContract({ contractVersion: 1, slot, endpoint: profile.terminalEndpoint,
        runtimeProcessId: profile.runtimeProcessId, responsesRouteFingerprint: profile.responsesRouteFingerprint });
    },
    async inspectCheckpointCandidates(slotValue: number, threadId: string) {
      const slot = slotNumber(slotValue);
      const profile = await controlledProfile(slot);
      const response = await fetch(new URL("v1/checkpoint-inspection", profile.bridgePreviewUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${profile.uiToken}`, "content-type": "application/json" },
        body: JSON.stringify({ threadId }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw Error("Checkpoint inspection unavailable");
      const value: unknown = await response.json();
      if (await controlledProfile(slot) !== profile) throw Error("Checkpoint inspection owner changed");
      return value;
    },
    async revealBridgeSurface(slotValue: number, surfaceId: string, interactive = false) {
      const profile = owned.get(slotNumber(slotValue));
      if (!profile || profile.child.exitCode !== null || profile.child.signalCode !== null) throw new Error("profile is not running");
      if (!/^surface_[A-Za-z0-9_-]{32}$/.test(surfaceId)) throw new Error("invalid surface selection");
      const response = await fetch(new URL("v1/bridge-reveal", profile.bridgePreviewUrl), {
        method: "POST", headers: { authorization: `Bearer ${profile.uiToken}`, "content-type": "application/json" },
        body: JSON.stringify({ surfaceId, interactive }), signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) throw new Error("Selected Web session has ended. Refresh the session list.");
    },
    async openAccountBrowser(slotValue: number) {
      const profile = owned.get(slotNumber(slotValue));
      if (!profile || profile.stopping || profile.child.exitCode !== null || profile.child.signalCode !== null) {
        throw new Error("Tela Work profile is not running");
      }
      const response = await fetch(new URL("v1/account-browser", profile.bridgePreviewUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${profile.uiToken}` },
        signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error("Finish active Web work before opening the account browser");
    },
    async closeAccountBrowser(slotValue: number) {
      const profile = owned.get(slotNumber(slotValue));
      if (!profile || profile.stopping || profile.child.exitCode !== null || profile.child.signalCode !== null) {
        throw new Error("Tela Work profile is not running");
      }
      const response = await fetch(new URL("v1/account-browser-close", profile.bridgePreviewUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${profile.uiToken}` },
        signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(60_000)])
          : AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error("Account browser closure was not confirmed. Inspect profile Web state.");
    },
    async inspectAccountBrowserHistoryUi(slotValue: number) {
      const slot = slotNumber(slotValue);
      const profile = owned.get(slot);
      if (!profile || profile.stopping || profile.child.exitCode !== null || profile.child.signalCode !== null) {
        throw new Error("An owned running Tela Work profile is required for history inspection");
      }
      const response = await fetch(new URL("v1/account-browser-history-ui", profile.bridgePreviewUrl), {
        headers: { authorization: `Bearer ${profile.uiToken}` },
        signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error("Open this profile's idle account browser before inspecting its history UI");
      const result = parseCodexHistoryUiContract(await response.json());
      if (result.slot !== slot) throw new Error("History UI observation does not match profile owner");
      return result;
    },
    async runSavedDeleteAcceptance(slotValue: number) {
      const slot = slotNumber(slotValue);
      const profile = owned.get(slot);
      if (!profile || profile.stopping || profile.child.exitCode !== null || profile.child.signalCode !== null) {
        throw new Error("An owner-bound running profile is required for saved-chat cleanup acceptance");
      }
      // Deliberate one-shot POST. Do not retry it if the request or response is uncertain.
      const response = await fetch(new URL("v1/account-browser-saved-delete-acceptance", profile.bridgePreviewUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${profile.uiToken}` },
        signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(120_000)])
          : AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error("Saved test conversation may need manual cleanup in the owner account browser");
      const receipt = parseCodexSavedDeleteAcceptanceContract(await response.json());
      if (receipt.slot !== slot) throw new Error("Saved test conversation cleanup has a mismatched profile owner");
      return receipt;
    },
    async recoverSyntheticSavedChat(slotValue: number) {
      const slot = slotNumber(slotValue), profile = owned.get(slot);
      if (!profile || profile.stopping || profile.child.exitCode !== null || profile.child.signalCode !== null) {
        throw Error("An exact owner-bound profile is required for synthetic cleanup");
      }
      // Never retry: the first call may have already completed the official UI click.
      const response = await fetch(new URL("v1/account-browser-synthetic-cleanup", profile.bridgePreviewUrl), {
        method: "POST", headers: { authorization: `Bearer ${profile.uiToken}` },
        signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(115_000)])
          : AbortSignal.timeout(115_000),
      });
      if (!response.ok) throw Error("Synthetic cleanup not proven; owner UI requires inspection");
      const receipt = parseCodexSyntheticRecoveryContract(await response.json());
      if (receipt.slot !== slot) throw Error("Synthetic cleanup owner slot mismatch");
      return receipt;
    },
    async accountCheck(slotValue: number) {
      return readProfileAccount(slotValue, "v1/account-check", parseCodexAccountCheckContract);
    },
    async accountDisplay(slotValue: number) {
      return readProfileAccount(slotValue, "v1/account-display", parseCodexAccountDisplayContract);
    },
    async bridgeSurfaces(slotValue: number, since?: number, signal?: AbortSignal) {
      const slot = slotNumber(slotValue);
      const profile = owned.get(slot);
      if (!profile || profile.stopping || profile.child.exitCode !== null || profile.child.signalCode !== null) {
        throw new Error("profile browser surfaces unavailable");
      }
      const url = new URL("v1/bridge-surfaces", profile.bridgePreviewUrl);
      if (since !== undefined) url.searchParams.set("since", String(since));
      const response = await fetch(url, { headers: { authorization: `Bearer ${profile.uiToken}` }, ...(signal ? { signal } : {}) });
      if (!response.ok) throw new Error("profile browser surfaces unavailable");
      const result = await response.json() as { contractVersion: number; slot: number; revision: number; surfaces: { id: string; label: string; taskId?: string; title?: string }[] };
      if (result.contractVersion !== 1 || result.slot !== slot || !Number.isSafeInteger(result.revision)
        || result.revision < 0 || !Array.isArray(result.surfaces)
        || result.surfaces.some(row => !/^surface_[A-Za-z0-9_-]{32}$/.test(row.id) || typeof row.label !== "string" || row.label.length > 200
          || (row.taskId !== undefined && (typeof row.taskId !== "string" || row.taskId.length > 512)))
        || new Set(result.surfaces.map(row => row.id)).size !== result.surfaces.length) {
        throw new Error("invalid browser surface inventory");
      }
      let rpc: Awaited<ReturnType<typeof connectCodexAppServerWebSocket>> | undefined;
      const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000);
      try {
        if (profile.terminalEndpoint && result.surfaces.some(row => row.taskId
          && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(row.taskId))) {
          rpc = await connectCodexAppServerWebSocket(profile.terminalEndpoint, { signal: deadline });
        }
      } catch { /* Native metadata is optional; keep the established session labels. */ }
      const surfaces = [] as { id: string; label: string; title?: string }[];
      for (const [index, row] of result.surfaces.entries()) {
        let title: string | undefined;
        if (rpc && row.taskId && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(row.taskId)) {
          try {
            const response = await rpc.request("thread/read", { threadId: row.taskId, includeTurns: false }, deadline);
            title = nativeThreadDisplayTitle(response, row.taskId);
          } catch { /* Missing metadata uses this surface's own fallback label. */ }
        }
        surfaces.push({ id: row.id, label: row.label, ...(title ? { title } : {}) });
      }
      await rpc?.close().catch(() => {});
      return { contractVersion: 1 as const, slot, revision: result.revision, surfaces };
    },
    async bridgePreview(slotValue: number, surfaceId?: string, threadId?: string) {
      const slot = slotNumber(slotValue);
      const profile = owned.get(slot);
      if (!profile || profile.child.exitCode !== null || profile.child.signalCode !== null) {
        return Object.freeze({
          contractVersion: 1 as const,
          slot,
          activeSurfaceCount: 0,
          previewAvailable: false,
        });
      }
      const url = new URL("v1/bridge-preview", profile.bridgePreviewUrl);
      if (surfaceId) url.searchParams.set("surfaceId", surfaceId);
      if (threadId) url.searchParams.set("threadId", threadId);
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${profile.uiToken}` },
        signal: AbortSignal.timeout(3_000),
      });
      const value = await response.json().catch(() => undefined) as unknown;
      if (!response.ok) throw new Error(`profile bridge preview failed with HTTP ${response.status}`);
      const preview = parseCodexBridgePreviewContract(value);
      if (preview.slot !== slot) throw new Error("profile bridge preview slot does not match its owner");
      return preview;
    },
    async modelSelectionCanary(slotValue: number) {
      const slot = slotNumber(slotValue);
      const profile = owned.get(slot);
      if (!profile || profile.child.exitCode !== null || profile.child.signalCode !== null) {
        throw new Error(`Tela Codex profile ${slot} is not running`);
      }
      const response = await fetch(new URL("v1/model-selection-canary", profile.bridgePreviewUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${profile.uiToken}` },
        signal: AbortSignal.timeout(20_000),
      });
      const value = await response.json().catch(() => undefined) as unknown;
      if (!response.ok) {
        const message = value && typeof value === "object" && !Array.isArray(value)
          ? (value as { error?: { message?: unknown } }).error?.message
          : undefined;
        throw new Error(typeof message === "string" && message.trim()
          ? message
          : `profile model selection canary failed with HTTP ${response.status}`);
      }
      const canary = parseCodexModelSelectionCanaryContract(value);
      if (canary.slot !== slot) throw new Error("profile model selection canary slot does not match its owner");
      return canary;
    },
    async contextAttachmentCanary(slotValue: number) {
      const slot = slotNumber(slotValue);
      const profile = owned.get(slot);
      if (!profile || profile.child.exitCode !== null || profile.child.signalCode !== null) {
        throw new Error(`Tela Codex profile ${slot} is not running`);
      }
      const response = await fetch(new URL("v1/context-attachment-canary", profile.bridgePreviewUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${profile.uiToken}` },
        // The semantic preload owns a bounded 120s proof window (attachment upload + exact
        // receipt). Keep the service envelope slightly wider and propagate cancellation through
        // the profile HTTP request instead of abandoning a hidden browser operation in place.
        signal: AbortSignal.timeout(150_000),
      });
      const value = await response.json().catch(() => undefined) as unknown;
      if (!response.ok) {
        const message = value && typeof value === "object" && !Array.isArray(value)
          ? (value as { error?: { message?: unknown } }).error?.message
          : undefined;
        throw new Error(typeof message === "string" && message.trim()
          ? message
          : `profile context attachment canary failed with HTTP ${response.status}`);
      }
      const canary = parseCodexContextAttachmentCanaryContract(value);
      if (canary.slot !== slot) throw new Error("profile context attachment canary slot does not match its owner");
      return canary;
    },
    close() {
      if (closing) return closing;
      const stoppedSlots: number[] = [];
      closing = (async () => {
        stopping = true;
        if (await shutdownReadiness(true) !== "ready") throw new CodexShutdownNotStartedError();
        // Admission is closed before taking this snapshot. An already-admitted
        // start may publish its child late; drain it before enumerating owners.
        await Promise.all([...starting.values()]);
        for (const profile of [...owned.values()]) {
          await stopOwned(profile, false);
          stoppedSlots.push(profile.slot);
        }
      })().catch(async error => {
        stopping = false;
        const failures: unknown[] = [error];
        // Restore only profiles this shutdown finished closing, through the same
        // normal start path. The refused/uncertain profile keeps its owner.
        for (const slot of stoppedSlots) {
          try { await service.startProfile(slot); }
          catch (failure) { failures.push(failure); }
        }
        closing = undefined;
        if (failures.length > 1) throw new AggregateError(failures, "Profile shutdown failed and restoration is incomplete");
        throw error;
      });
      return closing;
    },
    get activeProfileCount() { return owned.size; },
  });
  return service;
}
