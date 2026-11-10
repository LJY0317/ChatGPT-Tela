import { checkpointPreparationPolicy, type CheckpointPreparationPolicy } from "./checkpoint-preparation-budget";
import { verifyWebModelReadiness } from "./web-model-readiness";
import { existsSync } from "node:fs";
import { resolveOwnedNativeEngine, acquireNativeBackendOwnership, type ProductPaths } from "@chatgpt-tela/product-lifecycle";
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
import { diagnosticFailureFields, emitDiagnosticEvent } from "@chatgpt-tela/core";
import { chatGptWebModelId, CHATGPT_TEMPORARY_CHAT_URL, ChatGptContextCheckpointProvider } from "@chatgpt-tela/chatgpt";
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
  bindChatGptTelaAccount,
  readChatGptTelaAccountBinding,
  resolveChatGptTelaBrowserProfile,
  type ChatGptTelaBrowserProfile,
} from "./browser-profile";
import { FileContextCheckpointCache } from "./context-cache";
import { FileNativeVisiblePrefixStageJournal } from "./native-visible-prefix-journal";
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
import { publishAppOwnedDesktopCatalog } from "./app-owned-desktop-catalog";
import { handleModelListOverlayRequest, startModelListOverlayServer, type ModelListOverlayServer } from "./model-list-overlay-server";

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

/**
 * App-owned Responses ingress with an install-owned fixed port and capability.
 * The independent default Desktop keeps its explicit provider configuration;
 * additional managed targets use Plura's public routed-launch and model overlay.
 * Tela never owns or quits those Native/Desktop processes, and rebinding the
 * same callback on restart does not replace their existing Plura session.
 */
type AccountSurface = Awaited<ReturnType<ElectronDevelopmentRuntime["openProfileSetupSurface"]>>;

export async function startAppOwnedProductResponsesRuntime(input: {
  readonly config: ProductProfileRuntimeConfig;
  readonly ingress: { readonly port: number; readonly capability: string };
  readonly electronStarter?: typeof startElectronDevelopmentRuntime;
  /** Only for isolated public-control fixtures. Production uses the configured launcher. */
  readonly multiProfileClient?: MultiProfileControlClient;
  readonly nativeFetch?: NativeCodexFetch;
  readonly signal?: AbortSignal;
  /** Installed profile runtime publishes only to the exact install-owned resource. */
  readonly catalogPreparation?: {
    readonly paths: ProductPaths;
    readonly installId: string;
    readonly readNativeCatalog?: () => Promise<unknown>;
  };
}): Promise<{
  readonly runtime: ElectronDevelopmentRuntime;
  readonly responses: ElectronDevelopmentRuntime["responses"];
  readonly internalMcp: CodexBridgeMcpHttpServer;
  readonly webState: "preparing" | "ready" | "failed";
  readonly webModelIds: readonly string[];
  readonly accountManagementActive: boolean;
  readonly accountRevision: number;
  openWebAccountBrowser(): Promise<void>;
  closeWebAccountBrowser(): Promise<void>;
  reconnectWeb(): Promise<void>;
  shutdownReadiness(): "ready" | "blocked";
  stop(): Promise<void>;
}> {
  const { config, ingress } = input;
  if (config.nativeTarget.kind === "multi-profile" && config.slot < 2) {
    throw new Error("App-owned additional Desktop requires a managed profile slot");
  }
  if (!Number.isSafeInteger(ingress.port) || ingress.port < 1 || ingress.port > 65535
    || !/^[A-Za-z0-9_-]{43,128}$/.test(ingress.capability)) {
    throw new Error("App-owned Responses requires an install-owned fixed port and URL capability");
  }
  const identity = productPublicMcpIdentity(config.publicMcpAbi);
  const managed = config.nativeTarget.kind === "multi-profile";
  let completedResults: import("./supplied-request-gateway").SuppliedResultScope | undefined;
  let webState: "preparing" | "ready" | "failed" = "preparing";
  let accountRevision = 0;
  let accountSurface: AccountSurface | undefined;
  let detachAccount: (() => void) | undefined;
  let accountOpening: Promise<void> | undefined;
  let accountClosing: Promise<void> | undefined;
  let preparation: Promise<void> | undefined;
  let revalidate!: () => Promise<void>;
  const accountActive = () => !!(accountOpening || accountSurface || accountClosing);
  const reconnect = (): Promise<void> => {
    if (preparation) return preparation;
    webState = "preparing";
    completedResults = undefined;
    preparation = revalidate().then(() => { webState = "ready"; }, error => { webState = "failed"; throw error; })
      .finally(() => { preparation = undefined; });
    return preparation;
  };
  // Runtime and login discovery can begin without a binding. The validated
  // account owns the result journal only after the existing readiness proof.
  const resultScope = () => {
    if (!completedResults) return undefined;
    const binding = readChatGptTelaAccountBinding(config.browserProfile);
    if (binding?.accountFingerprint !== completedResults.accountFingerprint) {
      throw Error("App-owned Web result storage account binding changed");
    }
    return completedResults;
  };
  const webAccountCurrent = () => {
    if (!completedResults || accountActive() || webState !== "ready") return false;
    const binding = readChatGptTelaAccountBinding(config.browserProfile);
    return binding?.accountFingerprint === completedResults.accountFingerprint;
  };
  let runtime: ElectronDevelopmentRuntime | undefined;
  let startupFamilies: readonly import("@chatgpt-tela/chatgpt").ChatGptWebModelFamily[] | undefined;
  const router = createDefaultProfileCompositeProviderRouter({
    runtimeHeaderName: TELA_DEFAULT_DESKTOP_RUNTIME_HEADER,
    webAccountCurrent,
    ...(input.nativeFetch ? { fetchUpstream: input.nativeFetch } : {}),
    discoverWebModelFamilies: signal => {
      if (startupFamilies) {
        const observed = startupFamilies;
        startupFamilies = undefined;
        return Promise.resolve(observed);
      }
      return runtime?.discoverChatGptWebModelFamilies(signal) ?? Promise.resolve([]);
    },
  });
  runtime = await (input.electronStarter ?? startElectronDevelopmentRuntime)({
    profileSlot: config.slot,
    routeId: config.routeId,
    completedResults: resultScope,
    profileId: config.browserProfile.profileId,
    chatGptUrl: CHATGPT_TEMPORARY_CHAT_URL,
    connectorName: identity.connectorName,
    approvalAutomationMode: config.approvalAutomationMode,
    approvalAutomationDelayMs: config.approvalAutomationDelayMs,
    ...(config.webTurnTimeoutMs !== undefined ? { webTurnTimeoutMs: config.webTurnTimeoutMs } : {}),
    mcp: { kind: "external", abi: identity.webContract },
    responses: {
      hostname: "127.0.0.1",
      port: ingress.port,
      runtimeToken: ingress.capability,
      authentication: { kind: "path" },
      requestRouter: async request => {
        const native = await router.route(request);
        if (native) return native;
        if (!webAccountCurrent()) return Response.json({ error: {
          code: "tela_web_not_ready", message: "Finish account management and reconnect Web before continuing." } }, { status: 409 });
        return undefined;
      },
    },
    electron: { userDataDir: config.browserProfile.userDataDir },
  });
  let internalMcp: CodexBridgeMcpHttpServer | undefined;
  let startupPhase = "native_catalog";
  const startupStarted = performance.now();
  try {
    input.signal?.throwIfAborted();
    const preparation = input.catalogPreparation;
    const installation = preparation && !preparation.readNativeCatalog
      ? resolveDefaultDesktopInstallation({ environment: process.env }) : undefined;
    const nativeCatalog = preparation
      ? await (preparation.readNativeCatalog
        ? preparation.readNativeCatalog()
        : readDefaultDesktopNativeCatalog({ installation: installation!, ...(input.signal ? { signal: input.signal } : {}) }))
      : undefined;
    revalidate = async () => {
      startupPhase = "web_discovery";
      // Retire any Web rows from a previous account before attempting discovery.
      // If login, quota or model discovery fails, the install-owned registration
      // artifact remains usable with Native models only.
      if (preparation && nativeCatalog !== undefined) {
        await publishAppOwnedDesktopCatalog({ paths: preparation.paths, installId: preparation.installId, slot: config.slot,
          nativeCatalog, webFamilies: [], assertCurrentAccount: () => {} });
      }
      const webDiscovery = await prepareProductWebDiscovery({
        runtime, browserProfile: config.browserProfile, connectorName: identity.connectorName,
        signal: input.signal ?? new AbortController().signal,
        stage: (stage, fields = {}) => emitDiagnosticEvent("chatgpt_tela_profile_startup", stage, {
          slot: config.slot, mode: "app-owned", ...fields,
        }),
      });
      const binding = assertChatGptTelaAccountBinding(config.browserProfile, webDiscovery.accountFingerprint);
      const resultStore = new FileNativeVisiblePrefixStageJournal({
        directory: resolve(config.browserProfile.userDataDir, "native-visible-prefix-executions", binding.accountFingerprint),
        initializationPath: `${config.browserProfile.accountBindingPath}.native-prefix-${binding.accountFingerprint}`,
      });
      completedResults = {
        profileSlot: config.slot, accountFingerprint: binding.accountFingerprint,
        store: resultStore,
      };
      // Use this same readiness proof as the initial /models projection. A subsequent
      // router refresh may mask a transient browser error by retaining older rows.
      const families = webDiscovery.families;
      startupFamilies = families;
      // Existing owned readiness also retires old account results: a replaced
      // binding may never be used again, so its expired bodies and receipts
      // must not depend on a future host replay.
      await FileNativeVisiblePrefixStageJournal.pruneProfileResults(config.browserProfile).catch(error => {
        emitDiagnosticEvent("chatgpt_tela_work", "provider_result_retention_failed", {
          ...diagnosticFailureFields(error),
        });
      });
      await router.refreshWebModelFamilies(input.signal);
      startupPhase = "catalog_publish";
      if (preparation && nativeCatalog !== undefined) {
        await publishAppOwnedDesktopCatalog({ paths: preparation.paths, installId: preparation.installId, slot: config.slot,
          nativeCatalog, webFamilies: families,
          assertCurrentAccount: () => {
            const current = readChatGptTelaAccountBinding(config.browserProfile);
            if (!current || current.accountFingerprint !== binding.accountFingerprint) {
              throw new Error("Desktop model catalog account binding changed during preparation");
            }
          },
        });
      }
    };
    await reconnect();
    input.signal?.throwIfAborted();
    if (!runtime.suppliedToolBridge || !runtime.shutdownReadiness || !runtime.prepareShutdown)
      throw Error("App-owned runtime did not expose its operation lifecycle");
    startupPhase = "internal_mcp";
    internalMcp = await startCodexBridgeMcpHttpServer({ bridge: runtime.suppliedToolBridge,
      port: 0, authentication: { kind: "bearer", token: config.internalMcpToken } });
    if (config.nativeTarget.kind === "multi-profile") {
      startupPhase = "desktop_launch";
      const client = input.multiProfileClient ?? new MultiProfileControlClient({ command: [config.nativeTarget.launcherCli] });
      await client.launchTarget({ targetId: config.nativeTarget.targetId, expectedProfileIndex: config.slot,
        ...(input.signal ? { signal: input.signal } : {}) });
    }
    const ownedMcp = internalMcp;
    const owned = runtime;
    const closeAccount = (): Promise<void> => {
      if (accountClosing) return accountClosing;
      if (accountOpening) return accountOpening.then(() => closeAccount());
      if (!accountSurface) return Promise.resolve();
      const surface = accountSurface;
      detachAccount?.(); detachAccount = undefined;
      accountRevision++;
      accountClosing = (async () => {
        try {
          // Only this explicit human account-management session can replace a binding.
          const observed = await surface.probeChatGptProfile(input.signal);
          bindChatGptTelaAccount(config.browserProfile, observed.account.accountFingerprint);
        } finally {
          await surface.close();
          if (accountSurface === surface) accountSurface = undefined;
        }
        await reconnect();
      })().catch(error => { webState = "failed"; throw error; })
        .finally(() => { accountClosing = undefined; });
      return accountClosing;
    };
    const openAccount = (): Promise<void> => {
      if (accountClosing) return Promise.reject(Error("Finish account revalidation first"));
      if (accountOpening) return accountOpening;
      if (accountSurface) return accountSurface.reveal();
      if (owned.shutdownReadiness!() !== "ready") return Promise.reject(Error("Finish the current Web task before changing the account"));
      accountRevision++;
      accountOpening = (async () => {
        if (!owned.resetWebAccount) throw Error("Web account management is unavailable");
        await owned.resetWebAccount();
        const surface = await owned.openProfileSetupSurface({ reveal: false });
        accountSurface = surface;
        detachAccount = surface.onUserHide(() => { void closeAccount().catch(error =>
          emitDiagnosticEvent("chatgpt_tela_profile_startup", "web_account_browser_settle_failed", diagnosticFailureFields(error))); });
        try { await surface.reveal(); }
        catch (error) { detachAccount?.(); detachAccount = undefined; await surface.close(); accountSurface = undefined; throw error; }
      })().finally(() => { accountOpening = undefined; });
      return accountOpening;
    };
    let stopping: Promise<void> | undefined;
    let mcpClosed = false;
    let runtimeClosed = false;
    return Object.freeze({
      runtime: owned,
      responses: owned.responses,
      internalMcp: ownedMcp,
      get webState() { return webState; },
      get webModelIds() { return webState === "ready" ? router.cachedWebModelFamilies.map(family => chatGptWebModelId(family.key)) : []; },
      get accountManagementActive() { return accountActive(); },
      get accountRevision() { return accountRevision; },
      openWebAccountBrowser: openAccount,
      closeWebAccountBrowser: closeAccount,
      reconnectWeb() {
        return accountActive() || owned.shutdownReadiness!() !== "ready"
          ? Promise.reject(Error("Finish account management and active Web work first")) : reconnect();
      },
      shutdownReadiness: () => accountActive() ? "blocked" : owned.shutdownReadiness!(),
      // Close admission only after exact work is settled, in the same JS turn.
      stop() {
        if (stopping) return stopping;
        owned.prepareShutdown!();
        return stopping = (async () => {
          await accountOpening?.catch(() => {});
          detachAccount?.(); detachAccount = undefined;
          await accountClosing?.catch(() => {});
          await accountSurface?.close(); accountSurface = undefined;
          const failures = await Promise.allSettled([
            ...(mcpClosed ? [] : [(async () => { await ownedMcp.stop(); mcpClosed = true; })()]),
            ...(runtimeClosed ? [] : [(async () => { await owned.stop(); runtimeClosed = true; })()]),
          ]);
          const rejected = failures.filter((result): result is PromiseRejectedResult => result.status === "rejected");
          if (rejected.length) throw new AggregateError(rejected.map(result => result.reason), "App-owned profile cleanup failed");
        })().catch(error => { stopping = undefined; throw error; });
      },
    });
  } catch (error) {
    emitDiagnosticEvent("chatgpt_tela_profile_startup", "app_owned_startup_failed", {
      slot: config.slot, phase: startupPhase, duration_ms: Math.round(performance.now() - startupStarted),
      ...diagnosticFailureFields(error),
    });
    // Startup owns both resources once created. An MCP close failure must not
    // prevent the already-bound Responses listener and Web owner from closing.
    const cleanup = await Promise.allSettled([
      ...(internalMcp ? [internalMcp.stop()] : []),
      runtime.stop(),
    ]);
    for (const result of cleanup) if (result.status === "rejected") {
      emitDiagnosticEvent("chatgpt_tela_work", "app_owned_startup_cleanup_failed", {
        ...diagnosticFailureFields(result.reason),
      });
    }
    throw error;
  }
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
  let observedAccountFingerprint: string | undefined;
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
      observedAccountFingerprint = observed.account.accountFingerprint;
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
  if (!observedAccountFingerprint) throw new Error("Web readiness did not prove an account identity");
  assertChatGptTelaAccountBinding(input.browserProfile, observedAccountFingerprint);
  input.stage("fresh_readiness_proof_complete");
  connectorProbeState.clear();
  return { families: proof.families, accountFingerprint: observedAccountFingerprint };
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
  if (config.nativeTarget.kind !== "default-desktop") throw Error("Plura Desktop uses the app-owned Responses provider, not an external Native session");
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
    {
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
    if (internalMcp) cleanup.push(internalMcp.stop());
    if (runtime) cleanup.push(runtime.stop());
    await Promise.allSettled(cleanup);
    throw error;
  }

  let stopping: Promise<void> | undefined;
  let targetStopped = false;
  let mcpClosed = false;
  let runtimeClosed = false;
  let overlayClosed = false;
  return Object.freeze({
    config,
    runtime,
    internalMcp,
    routedTarget,
    stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        if (turns.size > 0) throw new Error("Native/Web profile has an active turn; finish it before shutdown");
        if (!targetStopped && routedTarget?.session.endpoint
          && await countLoadedAppServerActiveTurns(routedTarget.session.endpoint, options.signal ? { signal: options.signal } : {}) > 0) {
          throw new Error("Native profile has an active turn; finish it before shutdown");
        }
        if (!targetStopped && config.nativeTarget.kind === "default-desktop") {
          await defaultDesktopTarget!.stop();
          targetStopped = true;
        }
        // If route ownership was lost, preserve the now-unrelated target but still tear down this
        // child's Responses/browser/MCP resources. Stale product providers must not become immortal.
        const results = await Promise.allSettled([
          ...(mcpClosed ? [] : [(async () => { await internalMcp!.stop(); mcpClosed = true; })()]),
          ...(runtimeClosed ? [] : [(async () => { await runtime!.stop(); runtimeClosed = true; })()]),
          ...(modelListOverlay && !overlayClosed ? [(async () => { await modelListOverlay.close(); overlayClosed = true; })()] : []),
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
