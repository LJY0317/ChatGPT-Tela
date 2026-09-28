import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  appServerCurrentTurnSource,
  type CanonicalCurrentTurnSource,
} from "@chatgpt-tela/codex";
import {
  createDefaultDesktopResponsesRoute,
  resolveDefaultDesktopInstallation,
  startDefaultDesktopTargetRuntime,
  type DefaultDesktopTargetRuntime,
} from "@chatgpt-tela/default-desktop-target";
import { emitDiagnosticEvent } from "@chatgpt-tela/core";
import {
  CHATGPT_TELA_DISPLAY_NAME,
  startCodexBridgeMcpHttpServer,
  type CodexBridgeMcpHttpServer,
} from "@chatgpt-tela/mcp";
import { ActiveTurnRegistry } from "@chatgpt-tela/runtime";
import {
  MultiProfileControlClient,
} from "@chatgpt-tela/setup";
import {
  assertChatGptTelaAccountBinding,
  resolveChatGptTelaBrowserProfile,
  type ChatGptTelaBrowserProfile,
} from "./browser-profile";
import { FileContextCheckpointCache } from "./context-cache";
import { ConnectorProbeState } from "./connector-probe-state";
import {
  startElectronDevelopmentRuntime,
  type ElectronDevelopmentRuntime,
  type ElectronDevelopmentRuntimeOptions,
} from "./electron";

const DEFAULT_WEB_TURN_TIMEOUT_MS = 120_000;
export const PRODUCT_RESPONSES_ENV_KEY = "CHATGPT_TELA_PRODUCT_RESPONSES_TOKEN";
export const PRODUCT_UI_ENV_KEY = "CHATGPT_TELA_PRODUCT_UI_TOKEN";
const PRODUCT_UNIFIED_DEVELOPMENT_CONNECTOR_NAME = "ChatGPT Tela Development";

export type ProductProfilePublicMcpAbi = "stable" | "unified-development";

export function productPublicMcpIdentity(abi: ProductProfilePublicMcpAbi): {
  readonly connectorName: string;
  readonly webContract: "development" | "stable";
} {
  if (abi === "stable") {
    return Object.freeze({ connectorName: CHATGPT_TELA_DISPLAY_NAME, webContract: "stable" });
  }
  return Object.freeze({ connectorName: PRODUCT_UNIFIED_DEVELOPMENT_CONNECTOR_NAME, webContract: "development" });
}

export type ProductProfileNativeTargetConfig =
  | {
      readonly kind: "default-desktop";
      readonly targetId: "default";
    }
  | {
      readonly kind: "multi-profile";
      readonly targetId: string;
      readonly launcherCli: string;
    };

export interface ProductProfileRuntimeConfig {
  readonly slot: number;
  readonly routeId: string;
  readonly nativeTarget: ProductProfileNativeTargetConfig;
  readonly browserProfile: ChatGptTelaBrowserProfile;
  readonly responsesToken: string;
  readonly internalMcpToken: string;
  readonly uiToken: string;
  readonly publicMcpAbi: ProductProfilePublicMcpAbi;
  readonly approvalAutomationMode: import("@chatgpt-tela/chatgpt").ChatGptApprovalAutomationMode;
  readonly webTurnTimeoutMs: number;
}

export interface ProductProfileRoutedTarget {
  readonly target: { readonly id: string };
  readonly session: {
    readonly targetId: string;
    readonly state: string;
    readonly endpoint: string;
    readonly responsesRouteFingerprint: string;
    readonly desktopProcessId?: number;
  };
  readonly currentTurnSource: CanonicalCurrentTurnSource;
}

export interface ProductProfileRuntime {
  readonly config: ProductProfileRuntimeConfig;
  readonly runtime: ElectronDevelopmentRuntime;
  readonly internalMcp: CodexBridgeMcpHttpServer;
  readonly routedTarget: ProductProfileRoutedTarget;
  stop(): Promise<void>;
}

class LateBoundCurrentTurnSource implements CanonicalCurrentTurnSource {
  #source: CanonicalCurrentTurnSource | undefined;

  bind(source: CanonicalCurrentTurnSource): void {
    if (this.#source) throw new Error("product current-turn source is already bound");
    this.#source = source;
  }

  currentTurn(threadId: string) {
    if (!this.#source) throw new Error("product current-turn source is not bound yet");
    return this.#source.currentTurn(threadId);
  }
}

function required(env: Readonly<Record<string, string | undefined>>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`product profile runtime requires ${key}`);
  if (/\u0000|\r|\n/.test(value)) throw new Error(`${key} must be a single-line value`);
  return value;
}

function optional(env: Readonly<Record<string, string | undefined>>, key: string): string | undefined {
  const value = env[key]?.trim();
  return value || undefined;
}

function absoluteFile(value: string, key: string): string {
  const path = resolve(value.startsWith("~/") ? `${homedir()}/${value.slice(2)}` : value);
  if (!existsSync(path)) throw new Error(`${key} does not exist: ${path}`);
  return path;
}

function positiveInteger(value: string | undefined, key: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${key} must be a positive integer`);
  return parsed;
}

export function loadProductProfileRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ProductProfileRuntimeConfig {
  const slotRaw = required(env, "CHATGPT_TELA_PRODUCT_PROFILE_SLOT");
  const browserProfile = resolveChatGptTelaBrowserProfile({
    slot: slotRaw,
    ...(optional(env, "CHATGPT_TELA_PROFILE_ROOT")
      ? { profileRoot: optional(env, "CHATGPT_TELA_PROFILE_ROOT")! }
      : {}),
    environment: env,
  });
  const routeId = required(env, "CHATGPT_TELA_PRODUCT_ROUTE_ID");
  if (!/^[A-Za-z0-9]{8,32}$/.test(routeId)) {
    throw new Error("CHATGPT_TELA_PRODUCT_ROUTE_ID must contain 8-32 ASCII alphanumeric characters");
  }
  const responsesToken = required(env, PRODUCT_RESPONSES_ENV_KEY);
  const internalMcpToken = required(env, "CHATGPT_TELA_PRODUCT_INTERNAL_MCP_TOKEN");
  const uiToken = required(env, PRODUCT_UI_ENV_KEY);
  if (responsesToken.length < 32) throw new Error(`${PRODUCT_RESPONSES_ENV_KEY} is too short`);
  if (internalMcpToken.length < 32) throw new Error("CHATGPT_TELA_PRODUCT_INTERNAL_MCP_TOKEN is too short");
  if (uiToken.length < 32) throw new Error(`${PRODUCT_UI_ENV_KEY} is too short`);
  const publicMcpAbi = optional(env, "CHATGPT_TELA_PRODUCT_PUBLIC_MCP_ABI") ?? "stable";
  if (publicMcpAbi !== "stable" && publicMcpAbi !== "unified-development") {
    throw new Error("CHATGPT_TELA_PRODUCT_PUBLIC_MCP_ABI must be stable or unified-development");
  }
  const approvalAutomationMode = optional(env, "CHATGPT_TELA_APPROVAL_AUTOMATION_MODE") ?? "off";
  if (approvalAutomationMode !== "off" && approvalAutomationMode !== "recognized_once") {
    throw new Error("CHATGPT_TELA_APPROVAL_AUTOMATION_MODE must be off or recognized_once");
  }
  const nativeKind = optional(env, "CHATGPT_TELA_PRODUCT_NATIVE_TARGET_KIND") ?? "default-desktop";
  let nativeTarget: ProductProfileNativeTargetConfig;
  if (nativeKind === "default-desktop") {
    if (browserProfile.slot !== 1) throw new Error("built-in default Desktop target is available only for canonical profile slot 1");
    const targetId = optional(env, "CHATGPT_TELA_PRODUCT_TARGET_ID") ?? "default";
    if (targetId !== "default") throw new Error("built-in default Desktop target id must be default");
    nativeTarget = Object.freeze({ kind: "default-desktop" as const, targetId: "default" as const });
  } else if (nativeKind === "multi-profile") {
    nativeTarget = Object.freeze({
      kind: "multi-profile" as const,
      targetId: required(env, "CHATGPT_TELA_PRODUCT_TARGET_ID"),
      launcherCli: absoluteFile(
        required(env, "CHATGPT_TELA_PRODUCT_LAUNCHER_CLI"),
        "CHATGPT_TELA_PRODUCT_LAUNCHER_CLI",
      ),
    });
  } else {
    throw new Error("CHATGPT_TELA_PRODUCT_NATIVE_TARGET_KIND must be default-desktop or multi-profile");
  }
  return Object.freeze({
    slot: browserProfile.slot,
    routeId,
    nativeTarget,
    browserProfile,
    responsesToken,
    internalMcpToken,
    uiToken,
    publicMcpAbi,
    approvalAutomationMode,
    webTurnTimeoutMs: positiveInteger(
      optional(env, "CHATGPT_TELA_PRODUCT_WEB_TURN_TIMEOUT_MS"),
      "CHATGPT_TELA_PRODUCT_WEB_TURN_TIMEOUT_MS",
      DEFAULT_WEB_TURN_TIMEOUT_MS,
    ),
  });
}

export async function startProductProfileRuntime(
  config: ProductProfileRuntimeConfig,
  options: {
    readonly electron?: ElectronDevelopmentRuntimeOptions["electron"];
    readonly multiProfileClient?: MultiProfileControlClient;
    readonly defaultDesktopTargetStarter?: typeof startDefaultDesktopTargetRuntime;
    readonly signal?: AbortSignal;
  } = {},
): Promise<ProductProfileRuntime> {
  const startupStage = (
    stage: string,
    fields: Readonly<Record<string, string | number | boolean>> = {},
  ): void => {
    emitDiagnosticEvent("chatgpt_tela_profile_startup", stage, fields);
  };
  const publicIdentity = productPublicMcpIdentity(config.publicMcpAbi);
  const turns = new ActiveTurnRegistry({ routeId: config.routeId });
  const source = new LateBoundCurrentTurnSource();
  const client = config.nativeTarget.kind === "multi-profile"
    ? options.multiProfileClient ?? new MultiProfileControlClient({ command: [config.nativeTarget.launcherCli] })
    : undefined;
  let runtime: ElectronDevelopmentRuntime | undefined;
  let internalMcp: CodexBridgeMcpHttpServer | undefined;
  let routedTarget: ProductProfileRoutedTarget | undefined;
  let defaultDesktopTarget: DefaultDesktopTargetRuntime | undefined;
  try {
    startupStage("browser_runtime_starting");
    runtime = await startElectronDevelopmentRuntime({
      profileId: config.browserProfile.profileId,
      connectorName: publicIdentity.connectorName,
      connectorRoutingMode: config.publicMcpAbi === "stable" ? "automatic-fallback" : "explicit",
      approvalAutomationMode: config.approvalAutomationMode,
      currentTurnSource: source,
      turns,
      mcp: { kind: "external", abi: publicIdentity.webContract },
      context: {
        checkpointCache: new FileContextCheckpointCache({
          directory: resolve(config.browserProfile.userDataDir, "context-checkpoints"),
        }),
      },
      webTurnTimeoutMs: config.webTurnTimeoutMs,
      responses: { port: 0, runtimeToken: config.responsesToken },
      electron: {
        ...(options.electron ?? {}),
        userDataDir: config.browserProfile.userDataDir,
      },
    });
    startupStage("browser_runtime_ready");
    internalMcp = await startCodexBridgeMcpHttpServer({
      turns,
      port: 0,
      authentication: { kind: "bearer", token: config.internalMcpToken },
    });
    startupStage("internal_mcp_ready");
    const connectorProbeState = new ConnectorProbeState({
      directory: config.browserProfile.userDataDir,
      connectorName: publicIdentity.connectorName,
    });
    const staleConnectorProbe = connectorProbeState.pending();
    startupStage("connector_artifact_recovery_starting");
    const recoveredConnectorArtifact = await runtime.recoverChatGptConnectorProbeArtifact(
      options.signal,
      staleConnectorProbe ? { allowUnknownSelectedConnector: true } : undefined,
    );
    startupStage(recoveredConnectorArtifact
      ? "connector_artifact_recovered"
      : "connector_artifact_not_owned");
    startupStage("profile_proof_starting");
    const observed = await runtime.probeChatGptProfile(options.signal);
    assertChatGptTelaAccountBinding(config.browserProfile, observed.account.accountFingerprint);
    startupStage("profile_proof_complete", {
      account_structure: observed.account.accountStructure,
      container_fingerprint: observed.account.containerFingerprint,
    });
    if (staleConnectorProbe) connectorProbeState.clear();
    connectorProbeState.begin();
    startupStage("connector_proof_starting");
    await runtime.probeChatGptConnector(options.signal);
    startupStage("connector_proof_complete");
    // Connector selection/cleanup happens on a disposable surface. Prove a second fresh surface is
    // still empty before attaching the Native target so cross-window/cloud draft restoration cannot
    // turn into a delayed consequential submit failure.
    startupStage("fresh_readiness_proof_starting");
    await runtime.probeChatGptReadiness(options.signal);
    startupStage("fresh_readiness_proof_complete");
    connectorProbeState.clear();
    if (config.nativeTarget.kind === "multi-profile") {
      startupStage("native_target_starting");
      routedTarget = await client!.launchRoutedTarget({
        targetId: config.nativeTarget.targetId,
        responsesBaseUrl: runtime.responses.baseUrl,
        responsesEnvKey: PRODUCT_RESPONSES_ENV_KEY,
        responsesToken: config.responsesToken,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      startupStage("native_target_ready");
    } else {
      startupStage("native_target_starting");
      const installation = resolveDefaultDesktopInstallation({ environment: process.env });
      const route = createDefaultDesktopResponsesRoute({
        baseUrl: runtime.responses.baseUrl,
        envKey: PRODUCT_RESPONSES_ENV_KEY,
        credential: config.responsesToken,
      });
      const startDefault = options.defaultDesktopTargetStarter ?? startDefaultDesktopTargetRuntime;
      defaultDesktopTarget = await startDefault({
        installation,
        route,
        credential: config.responsesToken,
        environment: process.env,
      });
      startupStage("native_target_ready");
      const currentTurnSource = appServerCurrentTurnSource(defaultDesktopTarget.proxyEndpoint);
      routedTarget = Object.freeze({
        target: Object.freeze({ id: "default" }),
        session: Object.freeze({
          targetId: "default",
          state: "ready",
          endpoint: defaultDesktopTarget.proxyEndpoint,
          responsesRouteFingerprint: defaultDesktopTarget.responsesRouteFingerprint,
          desktopProcessId: defaultDesktopTarget.desktopPid,
        }),
        currentTurnSource,
      });
    }
    source.bind(routedTarget.currentTurnSource);
    startupStage("profile_runtime_ready");
  } catch (error) {
    const cleanup: Promise<unknown>[] = [];
    if (defaultDesktopTarget) cleanup.push(defaultDesktopTarget.stop().catch(() => undefined));
    if (routedTarget && config.nativeTarget.kind === "multi-profile") {
      cleanup.push(client!.quitTarget(config.nativeTarget.targetId, options.signal).catch(() => undefined));
    }
    if (internalMcp) cleanup.push(internalMcp.stop());
    if (runtime) cleanup.push(runtime.stop());
    await Promise.allSettled(cleanup);
    throw error;
  }

  let stopping: Promise<void> | undefined;
  return Object.freeze({
    config,
    runtime,
    internalMcp,
    routedTarget,
    stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        if (config.nativeTarget.kind === "default-desktop") {
          await defaultDesktopTarget!.stop();
        } else {
          const session = await client!.targetSession(config.nativeTarget.targetId, options.signal);
          const ownsTargetRoute = session.state === "ready"
            && session.responsesRouteFingerprint === routedTarget!.session.responsesRouteFingerprint;
          if (ownsTargetRoute) {
            const stopped = await client!.quitTarget(config.nativeTarget.targetId, options.signal);
            if (stopped.state === "ready") throw new Error("product target remained ready after normal quit");
          }
        }
        // If route ownership was lost, preserve the now-unrelated target but still tear down this
        // child's Responses/browser/MCP resources. Stale product providers must not become immortal.
        const results = await Promise.allSettled([internalMcp!.stop(), runtime!.stop()]);
        const failures = results
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map(result => result.reason);
        if (failures.length > 0) throw new AggregateError(failures, "product profile runtime cleanup was incomplete");
      })().catch(error => {
        stopping = undefined;
        throw error;
      });
      return stopping;
    },
  });
}
