import { augmentNativeCodexModelCatalog } from "./web-model-catalog";
import { augmentCodexAppServerModelList } from "./app-server-model-list";
import { classifyNetworkFailure, emitDiagnosticEvent } from "@chatgpt-tela/core";
import { resolve } from "node:path";
import { appServerCurrentTurnSource, appServerCompactionHistorySource, appServerNativeHandoffSource, connectCodexAppServerWebSocket, refreshAdmittedWebModelCatalog } from "@chatgpt-tela/codex";
import { chatGptWebModelId, CHATGPT_SAVED_CHAT_URL, CHATGPT_TEMPORARY_CHAT_URL, ChatGptContextCheckpointProvider, parseChatGptWebModelId, type ChatGptWebModelFamily, type ChatGptHistoryUiReadiness, type SavedChatCleanupAcceptanceReceipt } from "@chatgpt-tela/chatgpt";
import { createDefaultDesktopResponsesRoute, resolveDefaultDesktopInstallation, startDefaultDesktopTargetRuntime, TELA_DEFAULT_DESKTOP_RUNTIME_HEADER } from "@chatgpt-tela/default-desktop-target";
import { startLocalResponsesServer, type LocalResponsesServer } from "@chatgpt-tela/local-server";
import { startCodexBridgeMcpHttpServer, type CodexBridgeMcpHttpServer } from "@chatgpt-tela/mcp";
import { resolveOwnedNativeEngine } from "@chatgpt-tela/product-lifecycle";
import { ActiveTurnRegistry } from "@chatgpt-tela/runtime";
import { MultiProfileControlClient } from "@chatgpt-tela/setup";
import { createDefaultProfileCompositeProviderRouter } from "./composite-provider-router";
import { FileContextCheckpointCache } from "./context-cache";
import { readChatGptTelaAccountBinding } from "./browser-profile";
import { startModelListOverlayServer } from "./model-list-overlay-server";
import { readWebModelDisplayCache, writeWebModelDisplayCache } from "./web-model-display-cache";
import { startElectronDevelopmentRuntime, type ElectronDevelopmentRuntime, type ElectronDevelopmentRuntimeOptions } from "./electron";
import type { ElectronProfileSetupSurface } from "./profile-control";
import { startElectronProfileSetupRuntime, type ElectronProfileSetupRuntime } from "./profile-setup";
import type { NativeCodexFetch } from "./native-passthrough";
import { prepareProductWebDiscovery, productPublicMcpIdentity, PRODUCT_RESPONSES_ENV_KEY, type ProductProfileRuntimeConfig, type ProductProfileRoutedTarget } from "./product-profile";

export type NativeFirstWebState = "preparing" | "ready" | "failed" | "closed";
export interface NativeFirstTarget {
  readonly routedTarget: ProductProfileRoutedTarget;
  readonly localCompaction?: boolean;
  readonly refreshModelCatalog?: (admittedIds: readonly string[], signal: AbortSignal) => Promise<void>;
  /** On Web account change, revoke every previous uncommitted media receipt. */
  readonly invalidateIngressMedia?: () => void;
  stop(): Promise<void>;
}
export interface NativeFirstProfileRuntime {
  readonly config: ProductProfileRuntimeConfig;
  readonly responses: LocalResponsesServer;
  readonly internalMcp: CodexBridgeMcpHttpServer;
  readonly routedTarget: ProductProfileRoutedTarget;
  /** Browser/account/connector admission, NOT Desktop picker visibility or freshness. */
  readonly webState: NativeFirstWebState;
  readonly webRuntime: ElectronDevelopmentRuntime | undefined;
  readonly webModelIds: readonly string[];
  waitForWeb(): Promise<void>;
  reconnectWeb(): Promise<void>;
  /** On-demand, same-profile account browser. Native remains owned/running;
   * the old Web admission is suspended until its user-close revalidation. */
  openWebAccountBrowser(): Promise<void>;
  /** Explicit owner-bound close when OS accessibility cannot deliver user-close.
   * Closes only the account browser and revalidates Web; never stops Native. */
  closeWebAccountBrowser(): Promise<void>;
  /** Content-free inspection of the *open* exact owner's official history UI. */
  inspectWebHistoryUi(): Promise<ChatGptHistoryUiReadiness>;
  /** ONE-SHOT, explicit saved-Web test: send one synthetic chat and delete by official UI. */
  runSavedChatDeleteAcceptance(): Promise<SavedChatCleanupAcceptanceReceipt>;
  /** Revoke old Web authority on a proven account change; never changes Native authentication. */
  invalidateWebAccount(): Promise<void>;
  prepareWeb(): Promise<void>;
  cancelWebPreparation(): Promise<void>;
  stop(): Promise<void>;
}
export interface NativeFirstProfileOptions {
  readonly electron?: ElectronDevelopmentRuntimeOptions["electron"];
  readonly fetchUpstream?: NativeCodexFetch;
  readonly signal?: AbortSignal;
  readonly onWebState?: (state: NativeFirstWebState) => void;
  /** Dependency injection for isolated fixtures; the defaults use normal owned lifecycles. */
  readonly nativeStarter?: (url: URL) => Promise<NativeFirstTarget>;
  /** Verified candidate descriptor for custom Native fixtures, before initial catalog delivery. */
  readonly nativeEngine?: ReturnType<typeof resolveOwnedNativeEngine>;
  readonly browserStarter?: typeof startElectronDevelopmentRuntime;
  /** Injected only for isolated login-browser fixtures. Normal product uses
   * the same Electron app/profile partition when Web admission has failed. */
  readonly accountBrowserStarter?: typeof startElectronProfileSetupRuntime;
}

function catalogRefreshForEndpoint(endpoint: string): NonNullable<NativeFirstTarget["refreshModelCatalog"]> {
  return async (ids, signal) => {
    const rpc = await connectCodexAppServerWebSocket(endpoint, { signal });
    try { await refreshAdmittedWebModelCatalog(rpc, ids, signal); }
    finally { await rpc.close(); }
  };
}

/** Observe existing startup waits only: no sampler, retry, or additional runtime operation. */
async function observeStartupWait<T>(phase: string, operation: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  emitDiagnosticEvent("chatgpt_tela_profile_startup", "startup_wait_started", { phase });
  let outcome = "completed";
  try {
    return await operation();
  } catch (error) {
    outcome = "failed";
    throw error;
  } finally {
    emitDiagnosticEvent("chatgpt_tela_profile_startup", "startup_wait_settled", {
      phase, outcome, duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
    });
  }
}

async function startNativeTarget(config: ProductProfileRuntimeConfig, url: URL, nativeEngine: ReturnType<typeof resolveOwnedNativeEngine>, displayFamilies: () => readonly ChatGptWebModelFamily[]): Promise<NativeFirstTarget> {
  if (config.nativeTarget.kind === "default-desktop") {
    const official = resolveDefaultDesktopInstallation({ environment: process.env });
    const host = await startDefaultDesktopTargetRuntime({
      installation: nativeEngine ? { ...official, codexExecutable: nativeEngine.executable } : official,
      route: createDefaultDesktopResponsesRoute({ baseUrl: url, envKey: PRODUCT_RESPONSES_ENV_KEY, credential: config.responsesToken }),
      credential: config.responsesToken,
      environment: { ...process.env, OPENAI_ORGANIZATION: config.responsesToken },
      // Only the signed seed contract consumes a real catalog while retaining remote discovery.
      ...(nativeEngine?.catalogSeed ? {
        catalogMode: "seeded-remote" as const,
        augmentNativeCatalog: (catalog: unknown) => augmentNativeCodexModelCatalog(catalog, displayFamilies(), { localCompaction: nativeEngine.localCompaction }),
        // A fresh Native cache can replace the seed. Projection is display-only;
        // admission and current-turn authority remain in the Responses router.
        augmentModelList: (result: unknown) => augmentCodexAppServerModelList(result, displayFamilies()),
      } : {}),
    });
    const publicSource = appServerCurrentTurnSource(host.proxyEndpoint, {
      includeNativeGoal: true, preferBoundedTurnProof: true,
      liveTurnProof: host.liveTurnProof,
    });
    return {
      localCompaction: nativeEngine?.localCompaction === true,
      invalidateIngressMedia: () => {
        host.ingressMedia.clear();
        host.liveTurnProof.clear();
      },
      ...(nativeEngine?.catalogRefresh ? { refreshModelCatalog: catalogRefreshForEndpoint(host.proxyEndpoint) } : {}),
      routedTarget: {
        target: { id: "default" },
        session: { targetId: "default", state: "ready", endpoint: host.proxyEndpoint,
          desktopProcessId: host.desktopPid, responsesRouteFingerprint: host.responsesRouteFingerprint },
        currentTurnSource: {
          async currentTurn(threadId) {
            const proven = await publicSource.currentTurn(threadId);
            if (!proven) return undefined;
            const ingressMedia = host.ingressMedia.current(proven.threadId, proven.turnId);
            return ingressMedia ? Object.freeze({ ...proven, ingressMedia }) : proven;
          },
          watchTurn: (threadId, turnId, signal) => publicSource.watchTurn(threadId, turnId, signal),
        },
      },
      stop: () => host.stop(),
    };
  }
  const client = new MultiProfileControlClient({ command: [config.nativeTarget.launcherCli] });
  const id = config.nativeTarget.targetId;
  // Use the same public display contract as the atomic multi-profile path. This
  // callback is on demand; cached display families never grant turn authority.
  const overlay = await startModelListOverlayServer({
    token: config.responsesToken, families: displayFamilies,
    localCompaction: nativeEngine?.localCompaction === true,
  });
  try {
    const launched = await observeStartupWait("native_adapter_launch", () => client.launchRoutedTarget({
      targetId: id, responsesBaseUrl: url, responsesEnvKey: PRODUCT_RESPONSES_ENV_KEY,
      responsesToken: config.responsesToken, runtimeHeaderName: TELA_DEFAULT_DESKTOP_RUNTIME_HEADER,
      ...(nativeEngine ? { nativeEngine } : {}),
      modelListOverlay: { url: overlay.url, envKey: PRODUCT_RESPONSES_ENV_KEY, token: config.responsesToken },
    }));
    // The completed public launch already proves its ready session, route/overlay/engine and exact
    // Desktop PID. Preserve that proof instead of discarding PID and issuing another CLI inventory.
    const initial = launched.session;
    if (!initial.desktopProcessId) throw new Error("Native launch did not prove its Desktop process identity");
    const routedTarget: ProductProfileRoutedTarget = {
      ...launched, session: { ...launched.session, desktopProcessId: initial.desktopProcessId },
    };
    return {
      localCompaction: nativeEngine?.localCompaction === true,
      ...(nativeEngine?.catalogRefresh ? { refreshModelCatalog: catalogRefreshForEndpoint(routedTarget.session.endpoint) } : {}),
      routedTarget,
      async stop() {
        const current = await client.targetSession(id);
        // Lost ownership means preserve the unrelated app and release only Tela resources.
        if (current.state === "ready"
          && current.responsesRouteFingerprint === routedTarget.session.responsesRouteFingerprint
          && current.modelListOverlayFingerprint === routedTarget.session.modelListOverlayFingerprint
          && current.desktopProcessId === routedTarget.session.desktopProcessId) {
          const stopped = await client.quitTarget(id, undefined, current.desktopProcessId);
          if (stopped.state === "ready") throw new Error("Native profile remained ready after normal quit");
        }
        await overlay.close();
      },
    };
  } catch (error) {
    await overlay.close();
    throw error;
  }
}

/**
 * Explicit source candidate. Not selected by installed startup until picker refresh and service IPC
 * acceptance are proven. Native owns its lifecycle; browser admission only controls Web dispatch.
 */
export async function startNativeFirstProductProfileRuntime(
  config: ProductProfileRuntimeConfig, options: NativeFirstProfileOptions = {},
): Promise<NativeFirstProfileRuntime> {
  options.signal?.throwIfAborted();
  const turns = new ActiveTurnRegistry({ routeId: config.routeId });
  const identity = productPublicMcpIdentity(config.publicMcpAbi);
  const nativeEngine = options.nativeStarter ? options.nativeEngine : resolveOwnedNativeEngine();
  let state: NativeFirstWebState = "preparing";
  let browser: ElectronDevelopmentRuntime | undefined;
  let admitted: readonly ChatGptWebModelFamily[] = [];
  let displayed = readWebModelDisplayCache(config.browserProfile);
  let preparation: Promise<void> | undefined;
  let accountInvalidation: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let native: NativeFirstTarget | undefined;
  let webRequests = 0;
  let accountBrowserBlocked = false;
  let accountBrowser: {
    surface: ElectronProfileSetupSurface;
    detach: () => void;
    settle: () => Promise<void>;
    readonly fallback?: ElectronProfileSetupRuntime;
  } | undefined;
  let accountBrowserOpening: Promise<void> | undefined;
  let accountBrowserSettling: Promise<void> | undefined;
  const isClosed = () => state === "closed";
  const setState = (next: NativeFirstWebState) => {
    state = next;
    emitDiagnosticEvent("chatgpt_tela_profile_startup", "web_admission_state", { state: next });
    options.onWebState?.(next);
  };
  const createRouter = (localCompaction: boolean) => createDefaultProfileCompositeProviderRouter({
    runtimeHeaderName: TELA_DEFAULT_DESKTOP_RUNTIME_HEADER,
    localCompaction,
    ...(options.fetchUpstream ? { fetchUpstream: options.fetchUpstream } : {}),
    // Cached discovery is display only; admitted/current-turn checks govern every Web request.
    discoverWebModelFamilies: async () => displayed,
  });
  let router = createRouter(nativeEngine?.localCompaction === true);
  const responses = await startLocalResponsesServer({
    runtimeToken: config.responsesToken,
    authentication: { kind: "header", name: TELA_DEFAULT_DESKTOP_RUNTIME_HEADER },
    async requestRouter(request) {
      const routed = await router.route(request);
      if (routed) return routed;
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/responses") return undefined;
      const body = await request.clone().json().catch(() => undefined);
      const model = typeof body?.model === "string" ? parseChatGptWebModelId(body.model) : undefined;
      if (!model) return undefined;
      if (accountBrowserBlocked || state !== "ready" || !browser
        || !admitted.some(family => family.key === model.familyKey)) {
        return Response.json({ error: { type: "invalid_request_error", code: "tela_web_not_ready",
          message: "Web connection is not ready for this model. Native remains available." } }, { status: 400 });
      }
      // Dispatch through the same authenticated ingress without a redundant local HTTP hop.
      // The existing gateway/planner still proves exact current turn, family/effort,
      // connector, and compaction authority; catalog presence alone cannot authorize a Web turn.
      const target = new URL("responses", browser.responses.baseUrl);
      const headers = new Headers(request.headers);
      headers.delete("host");
      headers.delete("content-length");
      webRequests++;
      try {
        const response = await browser.responses.handleRequest(new Request(target, { method: "POST", headers, body: await request.arrayBuffer(), signal: request.signal }));
        if (response.status === 503) {
          const failure = await response.clone().json().catch(() => undefined);
          if (failure?.error?.code === "tela_responses_closed") {
            admitted = [];
            if (!isClosed()) setState("failed");
          }
        }
        if (response.status === 409) {
          const failure = await response.clone().json().catch(() => undefined);
          if (failure?.error?.code === "tela_web_model_unavailable") {
            // No implicit rediscovery or resubmission. A proven missing model invalidates the
            // preparation snapshot; the normal explicit reconnect establishes fresh admission.
            admitted = [];
            displayed = [];
            writeWebModelDisplayCache(config.browserProfile, []);
            if (!isClosed()) setState("failed");
            await router.refreshWebModelFamilies();
            emitDiagnosticEvent("chatgpt_tela_profile_startup", "web_catalog_invalidated", { reason_class: "model_unavailable" });
          }
        }
        return response;
      } catch (error) {
        // A request failure is not profile admission authority. Native lifecycle remains
        // authoritative; uncertain work is never replayed by this dispatch boundary.
        emitDiagnosticEvent("chatgpt_tela_profile_startup", "web_dispatch_failed", {
          network_kind: classifyNetworkFailure(error), admission_invalidated: false,
        });
        throw error;
      } finally { webRequests--; }
    },
  });
  let internalMcp: CodexBridgeMcpHttpServer | undefined;
  let nativeReady!: Promise<NativeFirstTarget>;
  let browserClosing: Promise<void> | undefined;
  // The explicit saved-chat acceptance session ends when the owner closes its
  // account browser after cleanup; reconnection restores ordinary Temporary Chat.
  let acceptanceSavedChat = config.acceptanceSavedChat;
  let acceptanceDeleteStarted = false;
  const closeBrowser = (): Promise<void> => {
    if (browserClosing) return browserClosing;
    if (!browser) return Promise.resolve();
    const owned = browser;
    const operation = (async () => {
      await owned.stop();
      if (browser === owned) browser = undefined;
    })();
    browserClosing = operation;
    void operation.finally(() => {
      if (browserClosing === operation) browserClosing = undefined;
    }).catch(() => {});
    return operation;
  };
  const prepareWeb = (): Promise<void> => {
    if (state === "closed") return Promise.reject(new Error("Native-first profile is closed"));
    if (accountBrowserBlocked) return Promise.reject(new Error("Finish Web account management before reconnecting"));
    if (accountInvalidation) return accountInvalidation.then(() => prepareWeb());
    if (preparation) return preparation;
    if (state === "ready") return Promise.resolve();
    const attempt = new AbortController();
    controller = attempt;
    const signal = options.signal ? AbortSignal.any([options.signal, attempt.signal]) : attempt.signal;
    setState("preparing");
    const operation = (async () => {
      let webPhase = "browser_starting";
      const startedAt = performance.now();
      try {
        signal.throwIfAborted();
        await closeBrowser();
        signal.throwIfAborted();
        browser = await (options.browserStarter ?? startElectronDevelopmentRuntime)({
          profileId: config.browserProfile.profileId,
          chatGptUrl: acceptanceSavedChat ? CHATGPT_SAVED_CHAT_URL : CHATGPT_TEMPORARY_CHAT_URL,
          connectorName: identity.connectorName,
          // Browser preparation may precede Native. No evidence means no turn authority.
          currentTurnSource: {
            currentTurn: threadId => native?.routedTarget.currentTurnSource.currentTurn(threadId) ?? Promise.resolve(undefined),
            watchTurn: async (threadId, turnId, signal) => {
              const source = native?.routedTarget.currentTurnSource;
              if (!source?.watchTurn) throw new Error("product Native turn lifecycle is unavailable");
              const watch = await source.watchTurn(threadId, turnId, signal);
              if (!watch) throw new Error("product Native turn lifecycle is unavailable");
              return watch;
            },
          },
          turns, mcp: { kind: "external", abi: identity.webContract },
          approvalAutomationMode: config.approvalAutomationMode,
          approvalAutomationDelayMs: config.approvalAutomationDelayMs,
          ...(config.webTurnTimeoutMs !== undefined ? { webTurnTimeoutMs: config.webTurnTimeoutMs } : {}),
          // An earlier profile/account binding must be re-proven during Web
          // discovery. Separate account namespaces prevent a later intentional
          // rebind from reusing another account's derived history checkpoint.
          context: (() => {
            const account = readChatGptTelaAccountBinding(config.browserProfile);
            return account ? {
              checkpointCache: new FileContextCheckpointCache({
                directory: resolve(config.browserProfile.userDataDir,
                  "context-checkpoints", account.accountFingerprint),
              }),
              historyCheckpointCache: new FileContextCheckpointCache({
                directory: resolve(config.browserProfile.userDataDir,
                  "native-history-checkpoints", account.accountFingerprint),
              }),
            } : {};
          })(),
          checkpointProvider: new ChatGptContextCheckpointProvider(),
          compactionAnchor: (threadId, turnId, signal) => {
            if (!native) throw new Error("Native context authority is not ready");
            return appServerCompactionHistorySource(native.routedTarget.session.endpoint)
              .latestAnchor(threadId, turnId, signal);
          },
          nativeWebHandoff: (threadId, turnId, signal) => {
            if (!native) throw new Error("Native context authority is not ready");
            return appServerNativeHandoffSource(native.routedTarget.session.endpoint)
              .latest(threadId, turnId, signal);
          },
          verifyNativeWebHandoff: (threadId, turnId, handoffTurnId, answerDigest, signal) => {
            if (!native) throw new Error("Native context authority is not ready");
            return appServerNativeHandoffSource(native.routedTarget.session.endpoint)
              .verifyRecent(threadId, turnId, handoffTurnId, answerDigest, signal);
          },
          // Automatic extra-model Native forks remain strictly research-only.
          // Current public app-server responses do not attest historical
          // executed model/provider or pre-execution tool-free fork policy.
          // Do not wire even a default-denied probe into normal product
          // sessions: explicit source/owner capability must be implemented
          // and reviewed before future production opt-in.
          compactionHistory: (threadId, turnId) => {
            if (!native) throw new Error("Native context authority is not ready");
            return appServerCompactionHistorySource(native.routedTarget.session.endpoint).project(threadId, turnId);
          },
          responses: { port: 0, runtimeToken: config.responsesToken,
            authentication: { kind: "header", name: TELA_DEFAULT_DESKTOP_RUNTIME_HEADER } },
          electron: { ...options.electron, userDataDir: config.browserProfile.userDataDir },
        });
        signal.throwIfAborted();
        const proof = await prepareProductWebDiscovery({
          runtime: browser, browserProfile: config.browserProfile, connectorName: identity.connectorName,
          signal,
          stage: (stage, fields) => {
            webPhase = stage;
            emitDiagnosticEvent("chatgpt_tela_profile_startup", stage, fields);
          },
        });
        signal.throwIfAborted();
        // Parallel discovery is preparation only. Admission waits for the owned Native target.
        if (!writeWebModelDisplayCache(config.browserProfile, proof.families)) {
          emitDiagnosticEvent("chatgpt_tela_profile_startup", "web_display_cache_write_failed", {});
        }
        webPhase = "waiting_for_native";
        const target = await observeStartupWait("web_native_wait", () => nativeReady);
        signal.throwIfAborted();
        admitted = Object.freeze([...proof.families]);
        displayed = admitted;
        await observeStartupWait("web_catalog_projection", () => router.refreshWebModelFamilies(signal));
        // Only a signed owned engine capability enables this extension. No inventory polling.
        webPhase = "engine_catalog_refresh";
        await observeStartupWait("web_engine_catalog_refresh", async () => {
          await target.refreshModelCatalog?.(admitted.map(family => chatGptWebModelId(family.key)), signal);
        });
        signal.throwIfAborted();
        setState("ready");
      } catch (error) {
        emitDiagnosticEvent("chatgpt_tela_profile_startup", "web_admission_failed", {
          phase: webPhase, reason_class: signal.aborted ? "cancelled" : "proof_failed",
          duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
        });
        admitted = [];
        displayed = [];
        await router.refreshWebModelFamilies();
        if (!isClosed()) setState("failed");
        // Includes late browser creation after cancellation; never leaves an orphan or admits it.
        await closeBrowser();
        throw error;
      }
    })();
    preparation = operation;
    void operation.finally(() => { if (preparation === operation) preparation = undefined; }).catch(() => {});
    return operation;
  };
  try {
    internalMcp = await startCodexBridgeMcpHttpServer({ turns, port: 0,
      authentication: { kind: "bearer", token: config.internalMcpToken } });
    // Prime the in-memory projection before the engine first reads its normal Native catalog.
    await router.refreshWebModelFamilies();
    nativeReady = (async () => {
      native = await observeStartupWait("native_target_start", () =>
        (options.nativeStarter ?? (url => startNativeTarget(config, url, nativeEngine, () => displayed)))(responses.baseUrl));
      options.signal?.throwIfAborted();
      if (nativeEngine && native.localCompaction !== nativeEngine.localCompaction) throw new Error("Native catalog capability changed during startup");
      router = createRouter(native.localCompaction === true);
      await observeStartupWait("native_catalog_projection", () => router.refreshWebModelFamilies());
      return native;
    })();
    // Web preparation overlaps Native startup, but never delays returning Native readiness.
    void prepareWeb().catch(() => {});
    await nativeReady;
  } catch (error) {
    setState("closed");
    admitted = [];
    controller?.abort(new Error("Native startup failed"));
    await preparation?.catch(() => {});
    // Preserve Native transport if its normal owner cannot close it.
    if (native) await native.stop();
    await Promise.allSettled([responses.stop(), ...(internalMcp ? [internalMcp.stop()] : [])]);
    throw error;
  }
  const target = native!;
  const mcp = internalMcp;
  let stopping: Promise<void> | undefined;
  const result: NativeFirstProfileRuntime = {
    config, responses, internalMcp: mcp, routedTarget: target.routedTarget,
    get webState() { return state; },
    get webRuntime() { return state === "ready" ? browser : undefined; },
    get webModelIds() { return Object.freeze(admitted.map(family => chatGptWebModelId(family.key))); },
    async waitForWeb() { await preparation?.catch(() => {}); },
    openWebAccountBrowser() {
      if (isClosed()) return Promise.reject(new Error("Native-first profile is closed"));
      if (accountInvalidation) return Promise.reject(new Error("Finish Web account revalidation before reopening its browser"));
      if (accountBrowserSettling) return Promise.reject(new Error("Finish Web account revalidation before reopening its browser"));
      if (accountBrowserOpening) return accountBrowserOpening;
      if (accountBrowser) return accountBrowser.surface.reveal();
      if (accountBrowserBlocked || !((state === "ready" && browser) || (state === "failed" && !browser))) {
        return Promise.reject(new Error("Finish Web preparation before opening the account browser"));
      }
      // A manual account change can invalidate context and an unfinished
      // submission. Never reveal an interactive login surface while either
      // one is owned, and never stop/restart the Native Desktop on this path.
      if (webRequests || turns.size) {
        return Promise.reject(new Error("Finish the current Web task before changing the account"));
      }
      accountBrowserBlocked = true;
      const owner = browser;
      const opening = (async () => {
        let surface: ElectronProfileSetupSurface | undefined;
        let fallback: ElectronProfileSetupRuntime | undefined;
        let suspended = false;
        try {
          if (owner) {
            surface = await owner.openProfileSetupSurface({ reveal: false });
          } else {
            // Web failed before admission: its BrowserHost was disposed.
            // Reuse this Electron process's *same Tela profile partition*
            // with an isolated, control-only surface; do not launch a second
            // app, Native engine, MCP listener or Responses route.
            fallback = await (options.accountBrowserStarter ?? startElectronProfileSetupRuntime)({
              slot: config.slot,
              profileId: config.browserProfile.profileId,
              profileRoot: config.browserProfile.profileRoot,
              browserUserDataDir: config.browserProfile.userDataDir,
              accountBindingPath: config.browserProfile.accountBindingPath,
              revealWhenReady: true,
              runContextCanary: false,
            }, options.electron ? { electron: options.electron } : {});
            surface = await fallback.openProfileSetupSurface({ reveal: false });
          }
          if (isClosed() || browser !== owner || webRequests || turns.size) {
            throw new Error("Web account browser ownership changed during setup");
          }
          const owned = surface;
          const fallbackOwner = fallback;
          const settle = (): Promise<void> => {
            if (accountBrowser?.surface !== owned) {
              return accountBrowserSettling ?? Promise.reject(new Error("Account browser owner changed"));
            }
            acceptanceSavedChat = false;
            const current = accountBrowser;
            accountBrowser = undefined;
            current?.detach();
            // User-close or explicitly authenticated owner-close takes exactly
            // the same path. Never resubmit or replace the Native owner.
            const operation = (async () => {
              await owned.close();
              await fallbackOwner?.stop();
              if (isClosed()) return;
              await result.invalidateWebAccount();
              if (!isClosed()) await result.reconnectWeb();
            })();
            accountBrowserSettling = operation;
            void operation.finally(() => {
              if (accountBrowserSettling === operation) accountBrowserSettling = undefined;
            }).catch(() => {});
            return operation;
          };
          const detach = owned.onUserHide(() => {
            void settle().catch(() => {
              emitDiagnosticEvent("chatgpt_tela_profile_startup", "web_account_browser_settled", {
                outcome: "reconnection_failed",
              });
            });
          });
          accountBrowser = { surface: owned, detach, settle,
            ...(fallbackOwner ? { fallback: fallbackOwner } : {}) };
          // These models cannot be used while the human may change the shared
          // persistent cookie jar. Web re-verification is mandatory on close.
          admitted = []; displayed = [];
          writeWebModelDisplayCache(config.browserProfile, []);
          setState("preparing");
          suspended = true;
          await owned.reveal();
        } catch (error) {
          if (accountBrowser?.surface === surface) {
            accountBrowser?.detach(); accountBrowser = undefined;
          }
          await surface?.close().catch(() => {});
          await fallback?.stop().catch(() => {});
          // A failed reveal never authorizes stale Web models. The user can
          // explicitly reconnect; Native is still available.
          if (!isClosed() && suspended) setState("failed");
          throw error;
        } finally {
          if (!accountBrowser) accountBrowserBlocked = false;
        }
      })();
      accountBrowserOpening = opening;
      void opening.finally(() => {
        if (accountBrowserOpening === opening) accountBrowserOpening = undefined;
      }).catch(() => {});
      return opening;
    },
    closeWebAccountBrowser() {
      if (isClosed()) return Promise.reject(new Error("Native-first profile is closed"));
      if (webRequests || turns.size) {
        return Promise.reject(new Error("Finish the current Web task before closing the account browser"));
      }
      if (accountBrowserSettling) return accountBrowserSettling;
      if (accountBrowserOpening) {
        return accountBrowserOpening.then(() => result.closeWebAccountBrowser());
      }
      if (!accountBrowser) return Promise.reject(new Error("No owned account browser is open"));
      return accountBrowser.settle();
    },
    inspectWebHistoryUi() {
      if (isClosed() || !accountBrowser || accountBrowserSettling || accountBrowserOpening
        || webRequests || turns.size || !accountBrowser.surface.probeChatGptHistoryUi) {
        return Promise.reject(new Error("An idle owned account browser must be open for history inspection"));
      }
      return accountBrowser.surface.probeChatGptHistoryUi();
    },
    runSavedChatDeleteAcceptance() {
      if (isClosed() || !acceptanceSavedChat || acceptanceDeleteStarted || !accountBrowser
        || accountBrowserSettling || accountBrowserOpening || webRequests || turns.size
        || !accountBrowser.surface.runSavedChatDeleteAcceptance) {
        return Promise.reject(new Error("One unused exact-profile saved-chat test lease and an idle owner browser are required"));
      }
      // Never repeat this potential Send operation, even on transient errors.
      acceptanceDeleteStarted = true;
      return accountBrowser.surface.runSavedChatDeleteAcceptance();
    },
    reconnectWeb() {
      if (state === "closed") return Promise.reject(new Error("Native-first profile is closed"));
      if (accountBrowserBlocked) return Promise.reject(new Error("Close the account browser before reconnecting Web"));
      if (accountInvalidation) return accountInvalidation.then(() => result.reconnectWeb());
      if (preparation) return preparation;
      // Registry stays owned through streaming completion, beyond receipt of HTTP headers.
      if (webRequests || turns.size) return Promise.reject(new Error("Finish or stop the active Web turn before reconnecting"));
      admitted = [];
      setState("failed");
      return prepareWeb();
    },
    invalidateWebAccount() {
      if (accountInvalidation) return accountInvalidation;
      if (state === "closed") return Promise.resolve();
      const reason = new Error("Web account authority changed");
      const managedSurface = accountBrowser;
      accountBrowser = undefined;
      managedSurface?.detach();
      accountBrowserBlocked = false;
      native?.invalidateIngressMedia?.();
      // Revoke before awaiting cleanup: old cached rows and late browser completions
      // cannot authorize work under the next account.
      admitted = [];
      displayed = [];
      writeWebModelDisplayCache(config.browserProfile, []);
      controller?.abort(reason);
      turns.cancelAll(reason);
      setState("failed");
      const operation = (async () => {
        await preparation?.catch(() => {});
        await managedSurface?.surface.close().catch(() => {});
        await managedSurface?.fallback?.stop().catch(() => {});
        await closeBrowser();
        await router.refreshWebModelFamilies();
      })();
      accountInvalidation = operation;
      void operation.finally(() => {
        if (accountInvalidation === operation) accountInvalidation = undefined;
      }).catch(() => {});
      return operation;
    },
    prepareWeb,
    async cancelWebPreparation() {
      if (!preparation) return;
      controller?.abort(new Error("Web preparation cancelled"));
      if (!isClosed()) setState("failed");
      await preparation.catch(() => {});
    },
    stop() {
      if (stopping) return stopping;
      setState("closed");
      admitted = [];
      accountBrowser?.detach();
      const accountBrowserFallback = accountBrowser?.fallback;
      accountBrowser = undefined;
      accountBrowserBlocked = false;
      controller?.abort(new Error("Native-first profile stopped"));
      stopping = (async () => {
        await target.stop();
        await accountBrowserFallback?.stop();
        await preparation?.catch(() => {});
        await accountInvalidation;
        await closeBrowser();
        const cleanup = await Promise.allSettled([mcp.stop(), responses.stop()]);
        const failures = cleanup.filter((r): r is PromiseRejectedResult => r.status === "rejected");
        if (failures.length) throw new AggregateError(failures.map(r => r.reason), "Native-first cleanup incomplete");
      })().catch(error => { stopping = undefined; throw error; });
      return stopping;
    },
  };
  // Returning Native readiness never waits for browser creation/proof. Failure is observable state,
  // not an unhandled rejection and not a reason to close Native. Explicit retry is single-flight.
  return Object.freeze(result);
}
