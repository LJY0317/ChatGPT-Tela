import { checkpointPreparationPolicy, type CheckpointPreparationPolicy } from "./checkpoint-preparation-budget";
import { verifyWebModelReadiness } from "./web-model-readiness";
import { existsSync } from "node:fs";
import { resolveOwnedNativeEngine, acquireNativeBackendOwnership } from "@chatgpt-tela/product-lifecycle";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  connectCodexAppServerWebSocket,
  countLoadedAppServerActiveTurns,
  appServerCurrentTurnSource,
  appServerCompactionHistorySource,
  type CanonicalCurrentTurnSource,
} from "@chatgpt-tela/codex";
import {
  createDefaultDesktopResponsesRoute,
  resolveDefaultDesktopInstallation,
  readDefaultDesktopNativeCatalog,
  startDefaultDesktopTargetRuntime,
  TELA_DEFAULT_DESKTOP_RUNTIME_HEADER,
  type DefaultDesktopTargetRuntime,
} from "@chatgpt-tela/default-desktop-target";
import { emitDiagnosticEvent } from "@chatgpt-tela/core";
import { CHATGPT_TEMPORARY_CHAT_URL, ChatGptContextCheckpointProvider } from "@chatgpt-tela/chatgpt";
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
  createDefaultProfileCompositeProviderRouter,
  type DefaultProfileCompositeProviderRouter,
} from "./composite-provider-router";
import {
  startElectronDevelopmentRuntime,
  type ElectronDevelopmentRuntime,
  type ElectronDevelopmentRuntimeOptions,
} from "./electron";
import type { NativeCodexFetch } from "./native-passthrough";
import { augmentCodexAppServerModelList } from "./app-server-model-list";
import { augmentNativeCodexModelCatalog } from "./web-model-catalog";
import { startModelListOverlayServer, type ModelListOverlayServer } from "./model-list-overlay-server";

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
  readonly approvalAutomationDelayMs: number;
  /** Explicit owner acceptance only; consumer Work defaults to Temporary Chat. */
  readonly acceptanceSavedChat: boolean;
  /** Explicit diagnostic deadline only. Normal task lifetime belongs to Native turn authority. */
  readonly webTurnTimeoutMs?: number;
  readonly checkpointPreparationPolicy?: CheckpointPreparationPolicy;
}

export interface ProductProfileRoutedTarget {
  readonly target: { readonly id: string };
  readonly session: {
    readonly targetId: string;
    readonly state: string;
    readonly endpoint: string;
    readonly responsesRouteFingerprint: string;
    readonly modelListOverlayFingerprint?: string;
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
  get readHistoryPage() { return this.#source?.readHistoryPage?.bind(this.#source); }
  get readHistoryIndex() { return this.#source?.readHistoryIndex?.bind(this.#source); }
  async watchTurn(threadId: string, turnId: string, signal?: AbortSignal) {
    if (!this.#source) throw new Error("Native turn source is not bound");
    if (!this.#source.watchTurn) throw new Error("product Native turn lifecycle is unavailable");
    const watch = await this.#source.watchTurn(threadId, turnId, signal);
    if (!watch) throw new Error("product Native turn lifecycle is unavailable");
    return watch;
  }
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

function positiveInteger(value: string, key: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${key} must be a positive integer`);
  return parsed;
}

function boundedNonnegativeInteger(value: string | undefined, key: string, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new Error(`${key} must be an integer from 0 to ${maximum}`);
  }
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
  if (approvalAutomationMode !== "off" && approvalAutomationMode !== "full_access") {
    throw new Error("CHATGPT_TELA_APPROVAL_AUTOMATION_MODE must be off or full_access");
  }
  const acceptanceSavedSlot = optional(env, "CHATGPT_TELA_ACCEPTANCE_SAVED_CHAT_SLOT");
  if (acceptanceSavedSlot !== undefined && !/^[1-9][0-9]?$/.test(acceptanceSavedSlot)) {
    throw new Error("CHATGPT_TELA_ACCEPTANCE_SAVED_CHAT_SLOT must be an exact profile slot from 1 to 99");
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
    acceptanceSavedChat: acceptanceSavedSlot === String(browserProfile.slot),
    approvalAutomationDelayMs: boundedNonnegativeInteger(
      optional(env, "CHATGPT_TELA_APPROVAL_DELAY_MS"),
      "CHATGPT_TELA_APPROVAL_DELAY_MS",
      0,
      15_000,
    ),
    ...(optional(env, "CHATGPT_TELA_CHECKPOINT_PREPARATION_POLICY") !== undefined ? {
      checkpointPreparationPolicy: checkpointPreparationPolicy(JSON.parse(required(env, "CHATGPT_TELA_CHECKPOINT_PREPARATION_POLICY"))),
    } : {}),
    ...(optional(env, "CHATGPT_TELA_PRODUCT_WEB_TURN_TIMEOUT_MS") !== undefined ? {
      webTurnTimeoutMs: positiveInteger(required(env, "CHATGPT_TELA_PRODUCT_WEB_TURN_TIMEOUT_MS"),
        "CHATGPT_TELA_PRODUCT_WEB_TURN_TIMEOUT_MS"),
    } : {}),
  });
}

/** Shared account/discovery/connector proof; no Native lifecycle authority. */
export async function prepareProductWebDiscovery(input: {
  runtime: ElectronDevelopmentRuntime;
  browserProfile: ChatGptTelaBrowserProfile;
  connectorName: string;
  signal: AbortSignal;
  stage: (stage: string, fields?: Readonly<Record<string, string | number | boolean>>) => void;
}) {
  input.signal.throwIfAborted();
  const connectorProbeState = new ConnectorProbeState({
    directory: input.browserProfile.userDataDir,
    connectorName: input.connectorName,
  });
  const staleConnectorProbe = connectorProbeState.pending();
  if (staleConnectorProbe) {
    input.stage("connector_artifact_recovery_starting");
    const recovered = await input.runtime.recoverChatGptConnectorProbeArtifact(
      input.signal, { allowUnknownSelectedConnector: true },
    );
    input.signal.throwIfAborted();
    input.stage(recovered ? "connector_artifact_recovered" : "connector_artifact_not_owned");
  }
  input.stage("profile_proof_starting");
  const proof = await input.runtime.prepareChatGptWebSession({
    signal: input.signal,
    onProfile(observed) {
      input.signal.throwIfAborted();
      assertChatGptTelaAccountBinding(input.browserProfile, observed.account.accountFingerprint);
      input.stage("profile_proof_complete", {
        account_structure: observed.account.accountStructure,
        container_fingerprint: observed.account.containerFingerprint,
      });
      if (staleConnectorProbe) connectorProbeState.clear();
      input.stage("web_model_catalog_discovery_starting");
    },
    onFamilies(families) {
      input.stage("web_model_catalog_discovery_complete", { family_count: families.length });
    },
    onConnectorStarting() {
      input.signal.throwIfAborted();
      connectorProbeState.begin();
      input.stage("connector_proof_starting");
    },
    onConnectorProven() {
      input.signal.throwIfAborted();
      input.stage("connector_proof_complete");
      input.stage("fresh_readiness_proof_starting");
    },
  });
  input.signal.throwIfAborted();
  input.stage("fresh_readiness_proof_complete");
  connectorProbeState.clear();
  return { families: proof.families };
}

export async function startProductProfileRuntime(
  config: ProductProfileRuntimeConfig,
  options: {
    readonly electron?: ElectronDevelopmentRuntimeOptions["electron"];
    readonly multiProfileClient?: MultiProfileControlClient;
    readonly defaultDesktopTargetStarter?: typeof startDefaultDesktopTargetRuntime;
    readonly defaultDesktopNativeFetch?: NativeCodexFetch;
    readonly modelFamilyDiscovery?: ElectronDevelopmentRuntimeOptions["modelFamilyDiscovery"];
    readonly signal?: AbortSignal;
    readonly onStartupStage?: (stage: string) => void;
  } = {},
): Promise<ProductProfileRuntime> {
  if (config.acceptanceSavedChat) {
    throw new Error("saved-chat acceptance requires the Native-first runtime's owner-bound account browser");
  }
  const startupStage = (
    stage: string,
    fields: Readonly<Record<string, string | number | boolean>> = {},
  ): void => {
    emitDiagnosticEvent("chatgpt_tela_profile_startup", stage, fields);
    options.onStartupStage?.(stage);
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
  let modelListOverlay: ModelListOverlayServer | undefined;
  const nativeEngine = resolveOwnedNativeEngine();
  let startupFamilies: readonly import("@chatgpt-tela/chatgpt").ChatGptWebModelFamily[] | undefined;
  const compositeRouter: DefaultProfileCompositeProviderRouter = createDefaultProfileCompositeProviderRouter({
        runtimeHeaderName: TELA_DEFAULT_DESKTOP_RUNTIME_HEADER,
        localCompaction: nativeEngine?.localCompaction === true,
        ...(options.defaultDesktopNativeFetch ? { fetchUpstream: options.defaultDesktopNativeFetch } : {}),
        async discoverWebModelFamilies(signal) {
          if (startupFamilies) {
            const families = startupFamilies;
            startupFamilies = undefined;
            return families;
          }
          if (!runtime) throw new Error("Web model discovery ran before the browser runtime was ready");
          return runtime.discoverChatGptWebModelFamilies(signal);
        },
      });
  const nativePreparationController = new AbortController();
  const nativePreparationSignal = options.signal
    ? AbortSignal.any([options.signal, nativePreparationController.signal])
    : nativePreparationController.signal;
  let defaultInstallation: ReturnType<typeof resolveDefaultDesktopInstallation> | undefined;
  let nativeCatalog: Promise<unknown> | undefined;
  try {
    if (config.nativeTarget.kind === "default-desktop") {
      const officialInstallation = resolveDefaultDesktopInstallation({ environment: process.env });
      defaultInstallation = nativeEngine
        ? { ...officialInstallation, codexExecutable: nativeEngine.executable } : officialInstallation;
      const nativeCatalogStartedAt = Date.now();
      nativeCatalog = readDefaultDesktopNativeCatalog({
        installation: defaultInstallation, signal: nativePreparationSignal,
      }).then(catalog => {
        emitDiagnosticEvent("chatgpt_tela_profile_startup", "native_catalog_prepared", {
          elapsed_ms: Date.now() - nativeCatalogStartedAt,
        });
        return catalog;
      });
      // Browser proofs may fail first. Keep the preparation failure observed until its consumer.
      void nativeCatalog.catch(() => {});
    }
    startupStage("browser_runtime_starting");
    runtime = await startElectronDevelopmentRuntime({
      profileSlot: config.slot,
      profileId: config.browserProfile.profileId,
      chatGptUrl: CHATGPT_TEMPORARY_CHAT_URL,
      connectorName: publicIdentity.connectorName,
      approvalAutomationMode: config.approvalAutomationMode,
      approvalAutomationDelayMs: config.approvalAutomationDelayMs,
      currentTurnSource: source,
      compactionHistory: async (threadId, turnId) => {
        if (!routedTarget) throw new Error("Native compaction history target is not ready");
        return appServerCompactionHistorySource(routedTarget.session.endpoint).project(threadId, turnId);
      },
      turns,
      mcp: { kind: "external", abi: publicIdentity.webContract },
      context: {
        ...(config.checkpointPreparationPolicy ? { checkpointPreparationPolicy: config.checkpointPreparationPolicy } : {}),
        checkpointCache: new FileContextCheckpointCache({
          directory: resolve(config.browserProfile.userDataDir, "context-checkpoints"),
        }),
      },
      checkpointProvider: new ChatGptContextCheckpointProvider(),
      ...(config.webTurnTimeoutMs !== undefined ? { webTurnTimeoutMs: config.webTurnTimeoutMs } : {}),
      responses: {
        port: 0,
        runtimeToken: config.responsesToken,
      authentication: {
        kind: "header" as const,
        name: TELA_DEFAULT_DESKTOP_RUNTIME_HEADER,
      },
      requestRouter: request => compositeRouter.route(request),
      },
      ...(options.modelFamilyDiscovery ? { modelFamilyDiscovery: options.modelFamilyDiscovery } : {}),
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
    const webDiscovery = await prepareProductWebDiscovery({
      runtime, browserProfile: config.browserProfile, connectorName: publicIdentity.connectorName,
      signal: nativePreparationSignal,
      stage: startupStage,
    });
    const { families } = webDiscovery;
    startupFamilies = families;
    await compositeRouter.refreshWebModelFamilies(nativePreparationSignal);
    if (config.nativeTarget.kind === "multi-profile") {
      modelListOverlay = await startModelListOverlayServer({
        localCompaction: nativeEngine?.localCompaction === true,
        token: config.responsesToken,
        families: () => compositeRouter.cachedWebModelFamilies,
      });
      startupStage("native_target_starting");
      routedTarget = await client!.launchRoutedTarget({
        targetId: config.nativeTarget.targetId,
        startupModelCatalog: true,
        ...(nativeEngine ? { nativeEngine } : {}),
        responsesBaseUrl: runtime.responses.baseUrl,
        responsesEnvKey: PRODUCT_RESPONSES_ENV_KEY,
        responsesToken: config.responsesToken,
        runtimeHeaderName: TELA_DEFAULT_DESKTOP_RUNTIME_HEADER,
        modelListOverlay: {
          url: modelListOverlay.url,
          envKey: PRODUCT_RESPONSES_ENV_KEY,
          token: config.responsesToken,
        },
        ...(options.signal ? { signal: options.signal } : {}),
      });
      startupStage("native_target_ready");
    } else {
      startupStage("native_backend_preparing");
      const installation = defaultInstallation!;
      const route = createDefaultDesktopResponsesRoute({
        baseUrl: runtime.responses.baseUrl,
        envKey: PRODUCT_RESPONSES_ENV_KEY,
        credential: config.responsesToken,
      });
      const startDefault = options.defaultDesktopTargetStarter ?? startDefaultDesktopTargetRuntime;
      defaultDesktopTarget = await startDefault({
        installation,
        acquireBackendOwnership: () => acquireNativeBackendOwnership({ nativeHome: installation.codexHome }),
        ...(nativeCatalog ? { nativeCatalog } : {}),
        beforeDesktopLaunch: async () => {
          nativePreparationSignal.throwIfAborted();
          startupStage("native_target_starting");
        },
        route,
        credential: config.responsesToken,
        // Route authentication belongs to this target, not to the turn launching Tela.
        environment: { ...process.env, OPENAI_ORGANIZATION: config.responsesToken },
        augmentNativeCatalog: catalog => augmentNativeCodexModelCatalog(catalog, compositeRouter.cachedWebModelFamilies, { localCompaction: nativeEngine?.localCompaction === true }),
        augmentModelList: result => augmentCodexAppServerModelList(
          result,
          compositeRouter.cachedWebModelFamilies,
        ),
      });
      startupStage("native_target_ready");
      const currentTurnSource = appServerCurrentTurnSource(defaultDesktopTarget.proxyEndpoint, {
        // The default Desktop profile must not accidentally opt into a
        // Legacy includeTurns:true snapshot before admitting Web authority.
        preferBoundedTurnProof: true,
        liveTurnProof: defaultDesktopTarget.liveTurnProof,
      });
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
    if (!routedTarget.session.endpoint) throw new Error("Native target has no model catalog endpoint");
    const readinessSignal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000);
    const catalogRpc = await connectCodexAppServerWebSocket(routedTarget.session.endpoint, { signal: readinessSignal });
    try {
      await verifyWebModelReadiness(catalogRpc, families, readinessSignal);
    } finally { await catalogRpc.close(); }
    startupStage("model_catalog_verified");
    source.bind(routedTarget.currentTurnSource);
    startupStage("profile_runtime_ready");
  } catch (error) {
    nativePreparationController.abort();
    const cleanup: Promise<unknown>[] = [];
    if (nativeCatalog) cleanup.push(nativeCatalog.catch(() => undefined));
    if (defaultDesktopTarget) cleanup.push(defaultDesktopTarget.stop().catch(() => undefined));
    if (modelListOverlay) cleanup.push(modelListOverlay.close().catch(() => undefined));
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
        if (turns.size > 0) throw new Error("Native/Web profile has an active turn; finish it before shutdown");
        if (routedTarget?.session.endpoint
          && await countLoadedAppServerActiveTurns(routedTarget.session.endpoint, options.signal ? { signal: options.signal } : {}) > 0) {
          throw new Error("Native profile has an active turn; finish it before shutdown");
        }
        if (config.nativeTarget.kind === "default-desktop") {
          await defaultDesktopTarget!.stop();
        } else {
          const session = await client!.targetSession(config.nativeTarget.targetId, options.signal);
          const ownsTargetRoute = session.state === "ready"
            && session.responsesRouteFingerprint === routedTarget!.session.responsesRouteFingerprint
            && session.modelListOverlayFingerprint === routedTarget!.session.modelListOverlayFingerprint;
          if (ownsTargetRoute) {
            const stopped = await client!.quitTarget(config.nativeTarget.targetId, options.signal);
            if (stopped.state === "ready") throw new Error("product target remained ready after normal quit");
          }
        }
        // If route ownership was lost, preserve the now-unrelated target but still tear down this
        // child's Responses/browser/MCP resources. Stale product providers must not become immortal.
        const results = await Promise.allSettled([
          internalMcp!.stop(), runtime!.stop(),
          ...(modelListOverlay ? [modelListOverlay.close()] : []),
        ]);
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
