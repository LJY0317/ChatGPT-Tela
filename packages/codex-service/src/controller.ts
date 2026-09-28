import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import {
  connectCodexTurnBridge,
  type RemoteTurnBridge,
  type TurnBridgeBackend,
} from "@chatgpt-tela/mcp";
import {
  parseCodexBridgePreviewContract,
  parseCodexModelSelectionCanaryContract,
  type CodexBridgePreviewContract,
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
import { RoutedCodexTurnBridge } from "./routed-turn-bridge";

const MAX_CHILD_OUTPUT_BYTES = 64 * 1024;
const CHILD_START_TIMEOUT_MS = 90_000;
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
  readonly responsesRouteFingerprint?: string;
}

interface ChildReady {
  readonly stage: "product-profile-ready";
  readonly slot: number;
  readonly routeId: string;
  readonly targetId: string;
  readonly nativeTargetKind: "default-desktop" | "multi-profile";
  readonly profileId: string;
  readonly internalMcpUrl: string;
  readonly bridgePreviewUrl: string;
  readonly responsesUrl: string;
  readonly responsesRouteFingerprint: string;
  readonly targetProcessId?: number;
  readonly accountBinding: "verified";
}

type ProfileChildProcess = ChildProcessByStdio<null, Readable, Readable>;

interface OwnedProfile {
  readonly slot: number;
  readonly target: CodexNativeTarget;
  readonly routeId: string;
  readonly responsesRouteFingerprint: string;
  readonly targetProcessId?: number;
  readonly child: ProfileChildProcess;
  readonly bridge: RemoteTurnBridge;
  readonly bridgePreviewUrl: string;
  readonly uiToken: string;
  readonly unmount: () => void;
  stopping: Promise<void> | undefined;
}

export interface CodexService {
  readonly instanceId: string;
  readonly config: CodexServiceConfig;
  readonly tools: TurnBridgeBackend;
  serviceStatus(): ServiceStatus;
  profiles(): Promise<readonly CodexProfileStatus[]>;
  startProfile(slot: number): Promise<CodexProfileStatus>;
  stopProfile(slot: number): Promise<CodexProfileStatus>;
  bridgePreview(slot: number): Promise<CodexBridgePreviewContract>;
  modelSelectionCanary(slot: number): Promise<CodexModelSelectionCanaryContract>;
  close(): Promise<void>;
  readonly activeProfileCount: number;
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
    || item.accountBinding !== "verified") {
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
  const targetProcessId = item.targetProcessId;
  if (targetProcessId !== undefined
    && (!Number.isSafeInteger(targetProcessId) || (targetProcessId as number) < 1)) {
    throw new Error("profile child target process id is invalid");
  }
  return Object.freeze({
    stage: "product-profile-ready",
    slot: expected.slot,
    routeId: expected.routeId,
    targetId: expected.targetId,
    nativeTargetKind: expected.nativeTargetKind,
    profileId: string("profileId"),
    internalMcpUrl: internalMcpUrl.href,
    bridgePreviewUrl: bridgePreviewUrl.href,
    responsesUrl: responsesUrl.href,
    responsesRouteFingerprint: fingerprint,
    ...(targetProcessId === undefined ? {} : { targetProcessId: targetProcessId as number }),
    accountBinding: "verified",
  });
}

async function waitForReadyLine(child: ProfileChildProcess): Promise<unknown> {
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let stdoutBytes = 0;
  let ignoredStdout = "";
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.removeListener("data", onStdout);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
    };
    const fail = (message: string, cause?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      const detail = stderr.toString("utf8").trim().slice(-2000);
      rejectPromise(new Error(message + (detail ? `: ${detail}` : ""), cause ? { cause } : undefined));
    };
    const finish = (value: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(value);
    };
    const onStdout = (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_CHILD_OUTPUT_BYTES) {
        fail("profile child readiness output exceeded the bounded limit");
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
      while (true) {
        const newline = stdout.indexOf(0x0a);
        if (newline < 0) return;
        const line = stdout.subarray(0, newline).toString("utf8").trim();
        stdout = stdout.subarray(newline + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
            && (parsed as { stage?: unknown }).stage === "product-profile-ready") {
            finish(parsed);
            return;
          }
        } catch {
          // Electron/Chromium may emit non-protocol diagnostics before app readiness.
        }
        ignoredStdout = `${ignoredStdout}\n${line}`.slice(-2000);
      }
    };
    const onError = (error: Error) => fail("profile child failed to start", error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      fail(`profile child exited before readiness (code=${code ?? "null"} signal=${signal ?? "none"})`);
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.byteLength > MAX_CHILD_OUTPUT_BYTES) stderr = stderr.subarray(stderr.byteLength - MAX_CHILD_OUTPUT_BYTES);
    });
    child.once("error", onError);
    child.once("exit", onExit);
    const timeout = setTimeout(() => fail(
      `profile child readiness timed out${ignoredStdout.trim() ? `; stdout=${ignoredStdout.trim()}` : ""}`,
    ), CHILD_START_TIMEOUT_MS);
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
  if (target.adapterKind === "default-desktop") {
    return owned.targetProcessId !== undefined
      && session.desktopProcessId === owned.targetProcessId;
  }
  return session.state === "ready"
    && session.responsesRouteFingerprint === owned.responsesRouteFingerprint;
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
    controlState,
    ...(owned?.child.pid ? { childProcessId: owned.child.pid } : {}),
    ...(owned ? { responsesRouteFingerprint: owned.responsesRouteFingerprint } : {}),
  });
}

export async function startCodexService(input: {
  readonly config: CodexServiceConfig;
  readonly profileRuntimeCommand: readonly [string, ...string[]];
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Re-read user-controlled profile preferences at each profile start without restarting the Codex service. */
  readonly profileRuntimeEnvironment?: () => Readonly<Record<string, string | undefined>>;
  readonly nativeTargetAdapter?: CodexNativeTargetAdapter;
  readonly signal?: AbortSignal;
}): Promise<CodexService> {
  const instanceId = randomUUID();
  const targets = input.nativeTargetAdapter ?? new CompositeNativeTargetAdapter({
    defaultDesktop: new DefaultDesktopNativeTargetAdapter(input.environment ? { environment: input.environment } : {}),
    ...(input.config.multiProfile
      ? { multiProfile: new MultiProfileNativeTargetAdapter({ launcherCli: input.config.multiProfile.launcherCli }) }
      : {}),
  });
  const routedBridge = new RoutedCodexTurnBridge();
  const owned = new Map<number, OwnedProfile>();
  let closing: Promise<void> | undefined;
  let stopping = false;

  const targetAndSession = async (slot: number) => {
    return targets.resolve(slot, input.signal);
  };

  const stopOwned = async (profile: OwnedProfile): Promise<void> => {
    if (profile.stopping) return profile.stopping;
    profile.stopping = (async () => {
      const session = await targets.session(profile.target.id, input.signal);
      const ownsTargetRoute = ownsNativeTargetSession(profile.target, session, profile);
      if (ownsTargetRoute && profile.target.adapterKind === "multi-profile") {
        const afterQuit = await targets.quit(profile.target.id, input.signal);
        if (afterQuit.state === "ready") throw new Error("native target remained ready after normal quit");
      }
      profile.unmount();
      await profile.bridge.close().catch(() => {});
      if (profile.child.exitCode === null && profile.child.signalCode === null) profile.child.kill("SIGTERM");
      if (!await waitForExit(profile.child, CHILD_STOP_TIMEOUT_MS)) {
        throw new Error(`Tela Codex profile ${profile.slot} child did not exit after its target closed`);
      }
      owned.delete(profile.slot);
    })().catch(error => {
      profile.stopping = undefined;
      throw error;
    });
    return profile.stopping;
  };

  return Object.freeze({
    instanceId,
    config: input.config,
    tools: routedBridge,
    serviceStatus() {
      return Object.freeze({ contractVersion: 1 as const, service: "codex" as const, instanceId,
        state: stopping ? "stopping" as const : "ready" as const });
    },
    async profiles() {
      return Object.freeze((await targets.profiles(input.signal))
        .map(({ target, session }) => statusFor(target, target.slot, session, owned.get(target.slot))));
    },
    async startProfile(slotValue: number) {
      const slot = slotNumber(slotValue);
      const existing = owned.get(slot);
      if (existing && existing.child.exitCode === null && existing.child.signalCode === null) {
        const current = await targets.session(existing.target.id, input.signal);
        if (ownsNativeTargetSession(existing.target, current, existing)) {
          return statusFor(existing.target, slot, current, existing);
        }
        await stopOwned(existing);
      }
      if (existing) {
        existing.unmount();
        await existing.bridge.close().catch(() => {});
        owned.delete(slot);
      }
      const { target, session: initialSession } = await targetAndSession(slot);
      let session = initialSession;
      if (session.state === "restart-required"
        || (session.state === "ready" && session.responsesRouteFingerprint === undefined)) {
        session = await targets.quit(target.id, input.signal);
      }
      if (session.state !== "available") {
        throw new Error(`${target.displayName} must be normally quit before Tela Codex can attach its route (state=${session.state})`);
      }
      const route = routeId();
      const responsesToken = secret();
      const internalMcpToken = secret();
      const uiToken = secret();
      const child = spawn(input.profileRuntimeCommand[0], input.profileRuntimeCommand.slice(1), {
        env: {
          ...process.env,
          ...(input.environment ?? {}),
          ...(input.profileRuntimeEnvironment?.() ?? {}),
          CHATGPT_TELA_PRODUCT_PROFILE_SLOT: String(slot),
          CHATGPT_TELA_PRODUCT_ROUTE_ID: route,
          ...targets.profileRuntimeEnvironment(target),
          CHATGPT_TELA_PRODUCT_RESPONSES_TOKEN: responsesToken,
          CHATGPT_TELA_PRODUCT_INTERNAL_MCP_TOKEN: internalMcpToken,
          CHATGPT_TELA_PRODUCT_UI_TOKEN: uiToken,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let ready: ChildReady;
      try {
        ready = childReady(await waitForReadyLine(child), {
          slot,
          routeId: route,
          targetId: target.id,
          nativeTargetKind: target.adapterKind,
        });
        child.stdout.resume();
      } catch (error) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await waitForExit(child, CHILD_STOP_TIMEOUT_MS);
        throw error;
      }
      let bridge: RemoteTurnBridge | undefined;
      try {
        bridge = await connectCodexTurnBridge({ endpoint: ready.internalMcpUrl, bearerToken: internalMcpToken,
          clientName: "chatgpt-tela-codex-service" });
        const unmount = routedBridge.mount(route, bridge);
        const profile: OwnedProfile = {
          slot,
          target,
          routeId: route,
          responsesRouteFingerprint: ready.responsesRouteFingerprint,
          ...(ready.targetProcessId === undefined ? {} : { targetProcessId: ready.targetProcessId }),
          child,
          bridge,
          bridgePreviewUrl: ready.bridgePreviewUrl,
          uiToken,
          unmount,
          stopping: undefined,
        };
        owned.set(slot, profile);
        child.once("exit", () => {
          if (owned.get(slot) !== profile) return;
          profile.unmount();
          owned.delete(slot);
          void profile.bridge.close().catch(() => {});
        });
        return statusFor(target, slot, await targets.session(target.id, input.signal), profile);
      } catch (error) {
        await bridge?.close().catch(() => {});
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await waitForExit(child, CHILD_STOP_TIMEOUT_MS);
        throw error;
      }
    },
    async stopProfile(slotValue: number) {
      const slot = slotNumber(slotValue);
      const profile = owned.get(slot);
      if (profile) await stopOwned(profile);
      const { target, session } = await targetAndSession(slot);
      if (!profile && session.state === "ready") {
        throw new Error(`${target.displayName} is routed by another owner; refusing to stop it`);
      }
      return statusFor(target, slot, session, undefined);
    },
    async bridgePreview(slotValue: number) {
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
      const response = await fetch(new URL("v1/bridge-preview", profile.bridgePreviewUrl), {
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
    close() {
      if (closing) return closing;
      stopping = true;
      closing = (async () => {
        const failures: unknown[] = [];
        for (const profile of [...owned.values()]) {
          try { await stopOwned(profile); }
          catch (error) { failures.push(error); }
        }
        if (failures.length > 0) throw new AggregateError(failures, "Tela Codex could not normally stop every profile");
      })().catch(error => {
        closing = undefined;
        stopping = false;
        throw error;
      });
      return closing;
    },
    get activeProfileCount() { return owned.size; },
  });
}
