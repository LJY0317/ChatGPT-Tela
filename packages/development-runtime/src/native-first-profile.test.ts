import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHATGPT_SAVED_CHAT_URL, CHATGPT_TEMPORARY_CHAT_URL, chatGptWebFamilyKey, chatGptWebModelId, ChatGptWebModelUnavailableError, ChatGptWebLoginRequiredError } from "@chatgpt-tela/chatgpt";
import { NativeResponsesGateway } from "@chatgpt-tela/runtime";
import { startLocalResponsesServer } from "@chatgpt-tela/local-server";
import { bindChatGptTelaAccount } from "./browser-profile";
import { loadProductProfileRuntimeConfig } from "./product-profile";
import type { ElectronDevelopmentRuntime } from "./electron";
import type { ElectronProfileSetupRuntime } from "./profile-setup";
import { writeWebModelDisplayCache } from "./web-model-display-cache";
import { startNativeFirstProductProfileRuntime, type NativeFirstProfileOptions, type NativeFirstProfileRuntime } from "./native-first-profile";
import type { CanonicalCurrentTurnSource } from "@chatgpt-tela/codex";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const family = { key: chatGptWebFamilyKey("Fixture Web"), label: "Fixture Web", availableEfforts: ["medium"] as const };
const model = chatGptWebModelId(family.key);
const metadata = { "x-codex-turn-metadata": { request_kind: "turn", thread_id: "thread-1", turn_id: "turn-1" } };

async function fixture(input: { noLifecycle?: boolean; dispatchFailure?: boolean; holdCreation?: boolean; fail?: "login" | "creation" | "account" | "discovery" | "connector" | "fresh" | "generation"; stopFails?: boolean; holdGeneration?: boolean; acceptanceSavedChat?: boolean; deleteAcceptanceFails?: boolean; accountBrowserFallback?: boolean; catalogRefresh?: () => Promise<void>; warmDisplay?: boolean; nativeGate?: Promise<void>; failNative?: boolean; onFreshProof?: () => void; onBrowserStopped?: () => void; onEarlyAuthority?: (available: boolean) => void; onExecutionContract?: (contract: { readonly chatGptUrl?: string; readonly webTurnTimeoutMs?: number; readonly currentTurnSource: CanonicalCurrentTurnSource; readonly context?: import("./electron").ElectronDevelopmentRuntimeOptions["context"] }) => void } = {}) {
  const root = mkdtempSync(join(tmpdir(), "tela-native-first-"));
  const config = loadProductProfileRuntimeConfig({
    CHATGPT_TELA_PROFILE_ROOT: root, CHATGPT_TELA_PRODUCT_PROFILE_SLOT: "1", CHATGPT_TELA_PRODUCT_ROUTE_ID: "fixture123",
    CHATGPT_TELA_PRODUCT_RESPONSES_TOKEN: "r".repeat(48), CHATGPT_TELA_PRODUCT_INTERNAL_MCP_TOKEN: "m".repeat(48), CHATGPT_TELA_PRODUCT_UI_TOKEN: "u".repeat(48),
    ...(input.acceptanceSavedChat ? { CHATGPT_TELA_ACCEPTANCE_SAVED_CHAT_SLOT: "1" } : {}),
  });
  mkdirSync(config.browserProfile.userDataDir, { recursive: true });
  bindChatGptTelaAccount(config.browserProfile, "a".repeat(64));
  if (input.warmDisplay) expect(writeWebModelDisplayCache(config.browserProfile, [family])).toBe(true);
  const gate = deferred<void>();
  const generationGate = deferred<void>();
  const generationStarted = deferred<void>();
  let lastBrowserResponses: Awaited<ReturnType<typeof startLocalResponsesServer>> | undefined;
  let nativeStops = 0;
  let browserStops = 0;
  let creations = 0;
  const surfaceObserverOwners: Set<() => void>[] = [];
  let nativeRequests = 0;
  let webGenerations = 0;
  let dispatchCalls = 0;
  let accountBrowserOpens = 0;
  let accountBrowserCloses = 0;
  let accountBrowserReveals = 0;
  let deleteAcceptanceCalls = 0;
  let syntheticRecoveryCalls = 0;
  let fallbackAccountBrowserStops = 0;
  let accountHide: (() => void) | undefined;
  let fail = input.fail;
  let currentTurnId = "turn-1";
  let nativeOwner = new AbortController();
  let stopFails = input.stopFails;
  const order: string[] = [];
  const source = { async currentTurn(threadId: string) { return {
    threadId, turnId: currentTurnId, cwd: "/workspace", workspaceRoots: ["/workspace"],
    sandbox: { kind: "read-only" as const, network: "restricted" as const }, proof: "turn-context" as const, environmentSourceTurnId: currentTurnId,
  }; }, ...(!input.noLifecycle ? { async watchTurn() { return { signal: nativeOwner.signal, async close() {} }; } } : {}) };
  const options: NativeFirstProfileOptions = {
    ...(input.accountBrowserFallback ? { accountBrowserStarter: async () => ({
      async openProfileSetupSurface() {
        accountBrowserOpens++;
        return {
          leaseId: `fixture-failed-web-${accountBrowserOpens}`,
          onUserHide(observer: () => void) {
            accountHide = observer;
            return () => { if (accountHide === observer) accountHide = undefined; };
          },
          async reveal() { accountBrowserReveals++; },
          async close() { accountBrowserCloses++; },
        };
      },
      async stop() { fallbackAccountBrowserStops++; },
    } as unknown as ElectronProfileSetupRuntime) } : {}),
    nativeStarter: async url => {
      order.push("native");
      // Native startup can fetch its official catalog before any browser exists.
      expect((await fetch(new URL("models", url), { headers: { authorization: "Bearer synthetic-native", "OpenAI-Organization": config.responsesToken } })).status).toBe(200);
      await input.nativeGate;
      if (input.failNative) throw new Error("Native startup failed");
      return { routedTarget: { target: { id: "fixture" }, session: { targetId: "fixture", state: "ready", endpoint: "ws://127.0.0.1:1", responsesRouteFingerprint: "fixture-route" }, currentTurnSource: source },
        ...(input.catalogRefresh ? { refreshModelCatalog: async (ids: readonly string[], signal: AbortSignal) => {
          order.push("catalog-refresh"); expect(ids).toEqual([model]); await input.catalogRefresh!(); signal.throwIfAborted();
        } } : {}),
        async stop() { nativeStops++; if (stopFails) throw new Error("normal quit refused"); } };
    },
    fetchUpstream: async request => {
      expect(request.headers.has("OpenAI-Organization")).toBe(false);
      if (new URL(request.url).pathname.endsWith("/models")) return Response.json({ models: [{ slug: "native-fixture", display_name: "Native fixture", visibility: "list", supported_in_api: true,
        default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "medium", description: "Medium" }] }] });
      nativeRequests++;
      return Response.json({ native: true });
    },
    browserStarter: async options => {
      input.onExecutionContract?.(options);
      creations++;
      if (input.onEarlyAuthority) input.onEarlyAuthority((await options.currentTurnSource.currentTurn("thread-1")) !== undefined);
      if (fail === "creation") throw new Error("browser creation failed");
      order.push("browser");
      if (input.holdCreation && creations === 1) await gate.promise;
      // Real gateway/HTTP transport; only browser generation is fake. Current-turn checks remain real.
      const gateway = new NativeResponsesGateway(options.currentTurnSource, options.turns!, async (registered, _body, nativeSignal) => {
        webGenerations++;
        generationStarted.resolve();
        if (input.holdGeneration) await Promise.race([generationGate.promise, new Promise<never>((_resolve, reject) => {
          if (nativeSignal?.aborted) reject(nativeSignal.reason);
          else nativeSignal?.addEventListener("abort", () => reject(nativeSignal.reason), { once: true });
        })]);
        nativeSignal?.throwIfAborted();
        if (fail === "generation") throw new ChatGptWebModelUnavailableError();
        registered.channel.markSubmitted(); registered.channel.markAccepted(); registered.channel.complete("mock Web reply");
      });
      const surfaceObservers = new Set<() => void>();
      surfaceObserverOwners.push(surfaceObservers);
      const responses = await startLocalResponsesServer({ gateway, ...options.responses });
      lastBrowserResponses = responses;
      return {
        responses: { ...responses, async handleRequest(request: Request) {
          dispatchCalls++;
          if (input.dispatchFailure && dispatchCalls === 1) throw new Error("synthetic dispatch failure");
          return responses.handleRequest(request);
        } },
        async stop() { browserStops++; input.onBrowserStopped?.(); await responses.stop(); await gateway.close(); },
        bridgeSurfaces: () => ({ revision: 0, surfaces: [] }),
        onBridgeSurfacesChanged(listener: () => void) { surfaceObservers.add(listener); return () => { surfaceObservers.delete(listener); }; },
        async prepareChatGptWebSession(preparation: import("./profile-control").ChatGptWebPreparationOptions) {
          if (fail === "login") throw new ChatGptWebLoginRequiredError();
          preparation.onProfile({ capabilities: { observed: new Set(["composer", "send"]) }, account: { accountFingerprint: fail === "account" ? "b".repeat(64) : "a".repeat(64), accountStructure: "personal", containerFingerprint: "fixture" } });
          if (fail === "discovery") throw new Error("discovery incomplete");
          preparation.onFamilies?.([family]);
          preparation.onConnectorStarting?.();
          if (fail === "connector") throw new Error("connector not proven");
          preparation.onConnectorProven?.();
          if (fail === "fresh") throw new Error("readiness not proven");
          input.onFreshProof?.();
          return { families: [family] };
        },
        async probeChatGptProfile() { return { account: { accountFingerprint: fail === "account" ? "b".repeat(64) : "a".repeat(64), accountStructure: "fixture", containerFingerprint: "fixture" } }; },
        async recoverChatGptConnectorProbeArtifact() { return true; },
        async discoverChatGptWebModelFamilies() { if (fail === "discovery") throw new Error("discovery incomplete"); return [family]; },
        async probeChatGptConnector() { if (fail === "connector") throw new Error("connector not proven"); },
        async probeChatGptConnection(_signal: AbortSignal, onConnectorProven?: () => void) {
          if (fail === "connector") throw new Error("connector not proven");
          onConnectorProven?.();
          if (fail === "fresh") throw new Error("readiness not proven");
          input.onFreshProof?.();
          return {};
        },
        async probeChatGptReadiness() { if (fail === "fresh") throw new Error("fresh surface not proven"); input.onFreshProof?.(); },
        async openProfileSetupSurface() {
          accountBrowserOpens++;
          return {
            leaseId: `synthetic-account-${accountBrowserOpens}`,
            onUserHide(observer: () => void) {
              accountHide = observer;
              return () => { if (accountHide === observer) accountHide = undefined; };
            },
            async reveal() { accountBrowserReveals++; },
            async runSavedChatDeleteAcceptance() {
              deleteAcceptanceCalls++;
              if (input.deleteAcceptanceFails) throw Error("synthetic after-send ownership uncertain");
              return { contractVersion: 1 as const, newlyAccepted: true as const,
                modelReplyCompleted: true,
                officialDelete: { contractVersion: 1 as const, menuOpened: true as const,
                  officialDeleteSelected: true as const,
                  officialConfirmationDispatched: true as const, historyAbsentAfterReload: true as const } };
            },
            async recoverSyntheticSavedChat() {
              syntheticRecoveryCalls++;
              return { contractVersion: 1 as const, syntheticConversationProven: true as const,
                officialDelete: { contractVersion: 1 as const, menuOpened: true as const,
                  officialDeleteSelected: true as const,
                  officialConfirmationDispatched: true as const, historyAbsentAfterReload: true as const } };
            },
            async close() { accountBrowserCloses++; },
          };
        },
      } as unknown as ElectronDevelopmentRuntime;
    },
  };
  let runtime: NativeFirstProfileRuntime;
  try { runtime = await startNativeFirstProductProfileRuntime(config, options); }
  catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
  return {
    runtime, gate, order, generationGate, generationStarted, surfaceObserverOwners,
    async breakTransport() { await lastBrowserResponses?.stop(); },
    get nativeStops() { return nativeStops; }, get browserStops() { return browserStops; },
    get creations() { return creations; }, get nativeRequests() { return nativeRequests; }, get webGenerations() { return webGenerations; },
    get accountBrowserOpens() { return accountBrowserOpens; },
    get accountBrowserCloses() { return accountBrowserCloses; },
    get accountBrowserReveals() { return accountBrowserReveals; },
    get deleteAcceptanceCalls() { return deleteAcceptanceCalls; },
    get syntheticRecoveryCalls() { return syntheticRecoveryCalls; },
    get fallbackAccountBrowserStops() { return fallbackAccountBrowserStops; },
    closeAccountBrowser() { if (!accountHide) throw Error("account browser is not open"); accountHide(); },
    changeAccount() { fail = "account"; },
    completeTurn() { nativeOwner.abort(new Error("Native completed")); },
    advanceTurn() { nativeOwner.abort(new Error("Native completed")); nativeOwner = new AbortController(); currentTurnId = "turn-2"; },
    fix() { fail = undefined; stopFails = false; },
    async post(chosen: string, client_metadata: unknown = metadata) {
      return fetch(new URL("responses", runtime.responses.baseUrl), { method: "POST", headers: { authorization: "Bearer synthetic-native", "OpenAI-Organization": config.responsesToken, "content-type": "application/json" },
        body: JSON.stringify({ model: chosen, client_metadata, input: [], tools: [] }) });
    },
    async catalog() { return (await fetch(new URL("models", runtime.responses.baseUrl), { headers: { authorization: "Bearer synthetic-native", "OpenAI-Organization": config.responsesToken } })).json(); },
    async cleanup() { gate.resolve(); generationGate.resolve(); stopFails = false; await runtime.stop(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("ordinary product tasks have no implicit Native fork, no elapsed-time deadline and require lifecycle authority", async () => {
  let contract: { readonly chatGptUrl?: string; readonly webTurnTimeoutMs?: number; readonly currentTurnSource: CanonicalCurrentTurnSource; readonly context?: import("./electron").ElectronDevelopmentRuntimeOptions["context"] } | undefined;
  const f = await fixture({ noLifecycle: true, onExecutionContract: value => { contract = value; } });
  try {
    await f.runtime.prepareWeb();
    expect(contract).not.toHaveProperty("webTurnTimeoutMs");
    expect(contract?.chatGptUrl).toBe(CHATGPT_TEMPORARY_CHAT_URL);
    // A future experimental adapter could change its internal default.
    // The real product must still omit both optional model-backed hooks.
    expect(contract?.context?.visiblePrefix?.accountNamespace).toBe("a".repeat(64));
    expect(contract?.context?.visiblePrefix?.journal).toBeDefined();
    expect(contract?.context?.visiblePrefix?.read).toBeTypeOf("function");
    expect(contract).not.toHaveProperty("compactionAnchor");
    expect(contract).not.toHaveProperty("compactionHistory");
    if (!contract?.currentTurnSource.watchTurn) throw new Error("missing product lifecycle adapter");
    // The synthetic Native source has no lifecycle contract. It must fail before browser submission.
    await expect(contract.currentTurnSource.watchTurn("thread-1", "turn-1"))
      .rejects.toThrow("product Native turn lifecycle is unavailable");
    expect(f.webGenerations).toBe(0);
    expect((await f.post("native-fixture")).status).toBe(200);
  } finally { await f.cleanup(); }
});

test("saved-chat acceptance is exact-owner opt-in and account browser close restores Temporary Chat", async () => {
  const urls: string[] = [];
  const reconnect = deferred<void>();
  let proofs = 0;
  const f = await fixture({
    acceptanceSavedChat: true,
    onExecutionContract: value => { urls.push(value.chatGptUrl ?? ""); },
    onFreshProof: () => { if (++proofs === 2) reconnect.resolve(); },
  });
  try {
    await f.runtime.waitForWeb();
    expect(urls).toEqual([CHATGPT_SAVED_CHAT_URL]);
    await f.runtime.openWebAccountBrowser();
    f.closeAccountBrowser();
    await reconnect.promise;
    expect(urls).toEqual([CHATGPT_SAVED_CHAT_URL, CHATGPT_TEMPORARY_CHAT_URL]);
    expect(f.nativeStops).toBe(0);
  } finally { await f.cleanup(); }
});

test("synthetic saved-delete acceptance is exact-owner opt-in, one-shot and does not stop Native", async () => {
  const ordinary = await fixture();
  try {
    await ordinary.runtime.waitForWeb();
    await ordinary.runtime.openWebAccountBrowser();
    await expect(ordinary.runtime.runSavedChatDeleteAcceptance()).rejects.toThrow("One unused");
    expect(ordinary.deleteAcceptanceCalls).toBe(0);
    await ordinary.runtime.closeWebAccountBrowser();
  } finally { await ordinary.cleanup(); }

  const testOnly = await fixture({ acceptanceSavedChat: true });
  try {
    await testOnly.runtime.waitForWeb();
    await expect(testOnly.runtime.runSavedChatDeleteAcceptance()).rejects.toThrow("One unused");
    await testOnly.runtime.openWebAccountBrowser();
    const receipt = await testOnly.runtime.runSavedChatDeleteAcceptance();
    expect(receipt.newlyAccepted).toBe(true);
    expect(receipt.officialDelete.historyAbsentAfterReload).toBe(true);
    await expect(testOnly.runtime.runSavedChatDeleteAcceptance()).rejects.toThrow("One unused");
    expect(testOnly.deleteAcceptanceCalls).toBe(1);
    expect(testOnly.nativeStops).toBe(0);
    await testOnly.runtime.closeWebAccountBrowser();
    expect(testOnly.runtime.webState).toBe("ready");
  } finally { await testOnly.cleanup(); }
});

test("synthetic saved-chat recovery is owner-browser-bound, Send-free and one-shot", async () => {
  const ordinary = await fixture();
  try {
    await ordinary.runtime.waitForWeb();
    await expect(ordinary.runtime.recoverSyntheticSavedChat()).rejects.toThrow("unused owner-bound");
    await ordinary.runtime.openWebAccountBrowser();
    expect((await ordinary.runtime.recoverSyntheticSavedChat()).syntheticConversationProven).toBe(true);
    expect(ordinary.syntheticRecoveryCalls).toBe(1);
    await expect(ordinary.runtime.recoverSyntheticSavedChat()).rejects.toThrow("unused owner-bound");
    await ordinary.runtime.closeWebAccountBrowser();
  } finally { await ordinary.cleanup(); }

  const owned = await fixture({ acceptanceSavedChat: true });
  try {
    await owned.runtime.waitForWeb();
    await expect(owned.runtime.recoverSyntheticSavedChat()).rejects.toThrow("unused owner-bound");
    await owned.runtime.openWebAccountBrowser();
    const done = await owned.runtime.recoverSyntheticSavedChat();
    expect(done.syntheticConversationProven).toBe(true);
    expect(done.officialDelete.historyAbsentAfterReload).toBe(true);
    await expect(owned.runtime.recoverSyntheticSavedChat()).rejects.toThrow("unused owner-bound");
    expect(owned.syntheticRecoveryCalls).toBe(1);
    expect(owned.deleteAcceptanceCalls).toBe(0);
    expect(owned.nativeStops).toBe(0);
    await owned.runtime.closeWebAccountBrowser();
    expect(owned.runtime.webState).toBe("ready");
  } finally { await owned.cleanup(); }
});

test("after-send failure leaves a pending test cleanup and never replays the message", async () => {
  const f = await fixture({ acceptanceSavedChat: true, deleteAcceptanceFails: true });
  try {
    await f.runtime.waitForWeb();
    await f.runtime.openWebAccountBrowser();
    await expect(f.runtime.runSavedChatDeleteAcceptance()).rejects.toThrow("synthetic after-send");
    await expect(f.runtime.runSavedChatDeleteAcceptance()).rejects.toThrow("One unused");
    expect(f.deleteAcceptanceCalls).toBe(1);
    expect(f.runtime.webState).toBe("preparing");
    expect(f.nativeStops).toBe(0);
    await f.runtime.closeWebAccountBrowser();
    expect(f.runtime.webState).toBe("ready");
  } finally { await f.cleanup(); }
});

test("owner-bound account browser close revalidates Web without OS accessibility or a Native stop", async () => {
  const urls: string[] = [];
  const f = await fixture({
    acceptanceSavedChat: true,
    onExecutionContract: value => { urls.push(value.chatGptUrl ?? ""); },
  });
  try {
    await f.runtime.waitForWeb();
    expect(f.runtime.accountManagementActive).toBe(false);
    await expect(f.runtime.closeWebAccountBrowser()).rejects.toThrow("No owned account browser");
    await f.runtime.openWebAccountBrowser();
    expect(f.runtime.webState).toBe("preparing");
    expect(f.runtime.accountManagementActive).toBe(true);
    await f.runtime.closeWebAccountBrowser();
    expect(f.runtime.webState).toBe("ready");
    expect(f.runtime.accountManagementActive).toBe(false);
    expect(urls).toEqual([CHATGPT_SAVED_CHAT_URL, CHATGPT_TEMPORARY_CHAT_URL]);
    expect(f.accountBrowserCloses).toBe(1);
    expect(f.nativeStops).toBe(0);
    expect((await f.post("native-fixture")).status).toBe(200);
    await expect(f.runtime.closeWebAccountBrowser()).rejects.toThrow("No owned account browser");
  } finally { await f.cleanup(); }
});

test("user-close and owner-close share the same single in-flight account revalidation", async () => {
  const f = await fixture();
  try {
    await f.runtime.waitForWeb();
    await f.runtime.openWebAccountBrowser();
    f.closeAccountBrowser();
    await f.runtime.closeWebAccountBrowser();
    expect(f.runtime.webState).toBe("ready");
    expect(f.accountBrowserCloses).toBe(1);
    expect(f.nativeStops).toBe(0);
  } finally { await f.cleanup(); }
});

test("owner-bound account browser close refuses stale Web after account mismatch but preserves Native", async () => {
  const f = await fixture();
  try {
    await f.runtime.waitForWeb();
    await f.runtime.openWebAccountBrowser();
    f.changeAccount();
    await expect(f.runtime.closeWebAccountBrowser()).rejects.toThrow();
    expect(f.runtime.webState).toBe("failed");
    expect(f.runtime.webModelIds).toEqual([]);
    expect(f.accountBrowserCloses).toBe(1);
    expect(f.nativeStops).toBe(0);
    expect((await f.post("native-fixture")).status).toBe(200);
    expect((await f.post(model)).status).toBe(400);
  } finally { await f.cleanup(); }
});

test("running Native profile opens one account browser, blocks Web submissions, and re-proves after human close", async () => {
  const complete = deferred<void>();
  let proofs = 0;
  const f = await fixture({ onFreshProof: () => { if (++proofs === 2) complete.resolve(); } });
  try {
    await f.runtime.waitForWeb();
    expect(f.runtime.webState).toBe("ready");
    await f.runtime.openWebAccountBrowser();
    await f.runtime.openWebAccountBrowser();
    expect(f.accountBrowserOpens).toBe(1);
    expect(f.accountBrowserReveals).toBe(2);
    expect(f.runtime.webState).toBe("preparing");
    expect(f.runtime.accountManagementActive).toBe(true);
    expect((await f.catalog()).models.map((row: { slug: string }) => row.slug))
      .toEqual(["native-fixture", model]);
    expect((await f.post(model)).status).toBe(400);
    expect((await f.post("native-fixture")).status).toBe(200);
    await expect(f.runtime.reconnectWeb()).rejects.toThrow("Close the account browser");
    f.closeAccountBrowser();
    await complete.promise;
    await f.runtime.waitForWeb();
    expect(f.accountBrowserCloses).toBe(1);
    expect(f.runtime.webState).toBe("ready");
    expect(f.runtime.accountManagementActive).toBe(false);
    expect(f.browserStops).toBe(1);
    expect(f.nativeStops).toBe(0);
  } finally { await f.cleanup(); }
});

test("account browser cannot interrupt an in-flight owned Web task or replay it", async () => {
  const f = await fixture({ holdGeneration: true });
  try {
    await f.runtime.waitForWeb();
    const executing = f.post(model);
    await f.generationStarted.promise;
    await expect(f.runtime.openWebAccountBrowser()).rejects.toThrow("Finish the current Web task");
    expect(f.accountBrowserOpens).toBe(0);
    expect(f.runtime.webState).toBe("ready");
    f.generationGate.resolve();
    expect((await (await executing).text())).toContain("mock Web reply");
    expect(f.webGenerations).toBe(1);
    expect(f.nativeStops).toBe(0);
  } finally { f.generationGate.resolve(); await f.cleanup(); }
});

test("changing the Web account in its browser revokes old Web models without replacing Native", async () => {
  const f = await fixture();
  try {
    await f.runtime.waitForWeb();
    await f.runtime.openWebAccountBrowser();
    f.changeAccount();
    f.closeAccountBrowser();
    // Browser removal and preparation are both asynchronous user-close
    // reactions. Wait for the observed second fixture startup, not a timer.
    for (let n = 0; n < 15 && f.creations < 2; n++) await Bun.sleep(5);
    await f.runtime.waitForWeb();
    expect(f.runtime.webState).toBe("failed");
    expect(f.runtime.webModelIds).toEqual([]);
    expect(f.nativeStops).toBe(0);
    expect((await f.post("native-fixture")).status).toBe(200);
    expect((await f.post(model)).status).toBe(400);
  } finally { await f.cleanup(); }
});

test("failed Web admission can still open the same persistent account profile without restarting Native", async () => {
  const recovered = deferred<void>();
  const f = await fixture({ fail: "discovery", accountBrowserFallback: true,
    onFreshProof: () => recovered.resolve() });
  try {
    await f.runtime.waitForWeb();
    expect(f.runtime.webState).toBe("failed");
    await f.runtime.openWebAccountBrowser();
    expect(f.accountBrowserOpens).toBe(1);
    expect(f.runtime.webState).toBe("preparing");
    expect(f.nativeStops).toBe(0);
    await expect(f.runtime.reconnectWeb()).rejects.toThrow("Close the account browser");
    f.fix();
    f.closeAccountBrowser();
    await recovered.promise;
    await f.runtime.waitForWeb();
    expect(f.runtime.webState).toBe("ready");
    expect(f.fallbackAccountBrowserStops).toBe(1);
    expect(f.nativeStops).toBe(0);
  } finally { await f.cleanup(); }
});

test("account management cannot reopen while old Web authority is still being invalidated", async () => {
  const f = await fixture({ fail: "discovery", accountBrowserFallback: true });
  try {
    await f.runtime.waitForWeb();
    expect(f.runtime.webState).toBe("failed");
    const invalidating = f.runtime.invalidateWebAccount();
    await expect(f.runtime.openWebAccountBrowser()).rejects.toThrow("Finish Web account revalidation");
    expect(f.accountBrowserOpens).toBe(0);
    await invalidating;
    expect(f.runtime.webState).toBe("failed");
    expect(f.nativeStops).toBe(0);
  } finally { await f.cleanup(); }
});

test("Native starts before held browser, failed Web cannot become Native generation, late cancellation disposes browser", async () => {
  const f = await fixture({ holdCreation: true });
  try {
    expect(f.order).toEqual(["native", "browser"]);
    expect(f.runtime.webState).toBe("preparing");
    expect((await f.post("native-fixture")).status).toBe(200);
    expect((await f.post(model)).status).toBe(400);
    expect(f.nativeRequests).toBe(1);
    expect((await f.catalog()).models).toHaveLength(1);
    const cancel = f.runtime.cancelWebPreparation();
    expect(f.runtime.webState).toBe("failed");
    expect((await f.post("native-fixture")).status).toBe(200);
    f.gate.resolve(); await cancel;
    expect(f.browserStops).toBe(1); expect(f.nativeStops).toBe(0);
    expect(f.runtime.webState).toBe("failed"); expect(f.webGenerations).toBe(0);
    const first = f.runtime.prepareWeb(); expect(f.runtime.prepareWeb()).toBe(first);
    await first;
    expect(f.creations).toBe(2); expect(f.runtime.webState).toBe("ready");
    expect((await f.catalog()).models).toHaveLength(2);
    expect((await f.post(model, { "x-codex-turn-metadata": { ...metadata["x-codex-turn-metadata"], turn_id: "stale" } })).status).not.toBe(200);
    expect(f.webGenerations).toBe(0);
    expect((await (await f.post(model)).text())).toContain("mock Web reply");
    expect((await f.post("native-fixture")).status).toBe(200);
    // Replaying a retired turn remains forbidden; the next turn in the same thread is admitted.
    expect((await f.post(model)).status).not.toBe(200);
    f.advanceTurn();
    expect((await (await f.post(model, { "x-codex-turn-metadata": { ...metadata["x-codex-turn-metadata"], turn_id: "turn-2" } })).text())).toContain("mock Web reply");
    expect(f.nativeStops).toBe(0); expect(f.webGenerations).toBe(2);
    const unknown = chatGptWebModelId(chatGptWebFamilyKey("Undiscovered"));
    expect((await f.post(unknown)).status).toBe(400); expect(f.webGenerations).toBe(2);
  } finally { await f.cleanup(); }
});

for (const fail of ["creation", "account", "discovery", "connector", "fresh"] as const) {
  test(`${fail} proof failure preserves Native and supports explicit proven retry`, async () => {
    const f = await fixture({ fail });
    try {
      await f.runtime.waitForWeb();
      expect(f.runtime.webState).toBe("failed"); expect(f.browserStops).toBe(fail === "creation" ? 0 : 1);
      expect((await f.post(model)).status).toBe(400);
      expect((await f.post("native-fixture")).status).toBe(200);
      expect(f.nativeStops).toBe(0); expect(f.webGenerations).toBe(0);
      f.fix(); await f.runtime.prepareWeb(); expect(f.runtime.webState).toBe("ready");
      expect((await (await f.post(model)).text())).toContain("mock Web reply");
    } finally { await f.cleanup(); }
  });
}

test("stop closes Web admission before late completion and releases each owned host once", async () => {
  const f = await fixture({ holdCreation: true });
  try {
    const stop = f.runtime.stop(); expect(f.runtime.stop()).toBe(stop);
    await Promise.resolve();
    expect(f.runtime.webState).toBe("closed");
    f.gate.resolve(); await stop;
    expect(f.nativeStops).toBe(1); expect(f.browserStops).toBe(1); expect(f.webGenerations).toBe(0);
    await expect(f.runtime.prepareWeb()).rejects.toThrow("closed");
  } finally { await f.cleanup(); }
});

test("failed normal Native quit keeps transport usable until explicit retry", async () => {
  const f = await fixture({ stopFails: true });
  try {
    await f.runtime.prepareWeb();
    await expect(f.runtime.stop()).rejects.toThrow("normal quit refused");
    expect((await f.post("native-fixture")).status).toBe(200);
    expect(f.runtime.webState).toBe("ready");
    expect((await f.post(model)).status).toBe(200);
    expect(f.browserStops).toBe(0);
    f.fix(); await f.runtime.stop(); expect(f.browserStops).toBe(1);
  } finally { await f.cleanup(); }
});

test("ready browser transport loss closes Web admission; explicit recovery replaces only browser", async () => {
  const f = await fixture();
  try {
    await f.runtime.prepareWeb();
    expect(f.runtime.webModelIds).toEqual([model]);
    await f.breakTransport();
    expect((await f.post(model)).status).not.toBe(200);
    expect(f.runtime.webState).toBe("failed");
    expect(f.runtime.webModelIds).toEqual([]);
    expect((await f.post("native-fixture")).status).toBe(200);
    const retry = f.runtime.reconnectWeb();
    expect(f.runtime.reconnectWeb()).toBe(retry);
    await retry;
    expect(f.runtime.webState).toBe("ready");
    expect(f.browserStops).toBe(1);
    expect(f.creations).toBe(2);
    expect(f.nativeStops).toBe(0);
    expect((await (await f.post(model)).text())).toContain("mock Web reply");
  } finally { await f.cleanup(); }
});

test("one in-process dispatch failure preserves admission and does not replay uncertain work", async () => {
  const f = await fixture({ dispatchFailure: true });
  try {
    await f.runtime.prepareWeb();
    expect((await f.post(model)).status).toBe(502);
    expect(f.runtime.webState).toBe("ready");
    expect(f.runtime.webModelIds).toEqual([model]);
    expect(f.webGenerations).toBe(0);
    expect((await (await f.post(model)).text())).toContain("mock Web reply");
    expect(f.webGenerations).toBe(1);
    expect(f.creations).toBe(1);
  } finally { await f.cleanup(); }
});

test("one failed Web generation preserves admission and permits explicit browser-only reconnect without replay", async () => {
  const f = await fixture({ fail: "generation" });
  try {
    await f.runtime.prepareWeb();
    const response = await f.post(model);
    expect(response.status).not.toBe(200);
    expect(await response.text()).toContain("tela_web_model_unavailable");
    expect(f.runtime.webState).toBe("ready");
    expect(f.runtime.webModelIds).toEqual([model]);
    expect((await f.catalog()).models.some((row: { slug: string }) => row.slug === model)).toBe(true);
    expect(f.webGenerations).toBe(1);
    expect((await f.post("native-fixture")).status).toBe(200);
    f.fix();
    await f.runtime.reconnectWeb();
    expect(f.runtime.webState).toBe("ready");
    expect(f.creations).toBe(2);
    expect(f.nativeStops).toBe(0);
    // Reconnection prepares the browser; it never resubmits the failed Native turn.
    expect((await f.post(model)).status).not.toBe(200);
    expect(f.webGenerations).toBe(1);
    f.advanceTurn();
    expect((await (await f.post(model, { "x-codex-turn-metadata": {
      request_kind: "turn", thread_id: "thread-1", turn_id: "turn-2",
    } })).text())).toContain("mock Web reply");
    expect(f.webGenerations).toBe(2);
  } finally { await f.cleanup(); }
});

test("Web reconnection cannot dispose a browser with an active streaming turn", async () => {
  const f = await fixture({ holdGeneration: true });
  try {
    await f.runtime.prepareWeb();
    const turn = f.post(model);
    await f.generationStarted.promise;
    await expect(f.runtime.reconnectWeb()).rejects.toThrow("active Web turn");
    expect(f.runtime.webState).toBe("ready");
    expect(f.browserStops).toBe(0);
    expect(f.nativeStops).toBe(0);
    f.generationGate.resolve();
    expect((await (await turn).text())).toContain("mock Web reply");
    f.completeTurn();
    await new Promise<void>(resolve => setImmediate(resolve));
    await f.runtime.reconnectWeb();
    expect(f.creations).toBe(2);
  } finally { await f.cleanup(); }
});

test("admitted Web waits for one engine refresh while Native stays usable", async () => {
  const gate = deferred<void>(); let calls = 0;
  const f = await fixture({ catalogRefresh: async () => { calls++; await gate.promise; } });
  try {
    // Wait for the explicit event without changing installed services or engine state.
    for (let attempt = 0; !calls && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 1));
    expect(calls).toBe(1);
    expect(f.runtime.webState).toBe("preparing");
    expect((await f.post("native-fixture")).status).toBe(200);
    expect(f.nativeStops).toBe(0);
    gate.resolve(); await f.runtime.waitForWeb();
    expect(f.runtime.webState).toBe("ready");
    expect(calls).toBe(1);
    await f.runtime.waitForWeb(); expect(calls).toBe(1);
  } finally { gate.resolve(); await f.cleanup(); }
});
test("engine refresh failure revokes Web but preserves Native", async () => {
  const f = await fixture({ catalogRefresh: async () => { throw new Error("catalog unavailable"); } });
  try {
    await f.runtime.waitForWeb();
    expect(f.runtime.webState).toBe("failed"); expect(f.runtime.webModelIds).toEqual([]);
    expect((await f.post("native-fixture")).status).toBe(200);
    expect((await f.post(model)).status).not.toBe(200);
    expect(f.nativeStops).toBe(0); expect(f.webGenerations).toBe(0);
  } finally { await f.cleanup(); }
});


test("browser proof overlaps held Native startup without early turn authority", async () => {
  const nativeGate = deferred<void>();
  const proof = deferred<void>();
  let settled = false;
  let earlyAuthority: boolean | undefined;
  const starting = fixture({ nativeGate: nativeGate.promise, onFreshProof: () => proof.resolve(),
    onEarlyAuthority: value => { earlyAuthority = value; } });
  void starting.then(() => { settled = true; });
  await proof.promise;
  expect(settled).toBe(false);
  expect(earlyAuthority).toBe(false);
  nativeGate.resolve();
  const f = await starting;
  try {
    await f.runtime.waitForWeb();
    expect(f.runtime.webState).toBe("ready");
    expect(f.runtime.webModelIds).toEqual([model]);
    expect((await (await f.post(model)).text())).toContain("mock Web reply");
    expect(f.nativeStops).toBe(0);
  } finally { await f.cleanup(); }
});

test("Native startup failure disposes concurrently prepared browser once", async () => {
  const nativeGate = deferred<void>();
  const proof = deferred<void>();
  let browserStops = 0;
  const starting = fixture({ nativeGate: nativeGate.promise, failNative: true,
    onFreshProof: () => proof.resolve(), onBrowserStopped: () => { browserStops++; } });
  const rejected = starting.then(() => undefined, error => error);
  await proof.promise;
  expect(browserStops).toBe(0);
  nativeGate.resolve();
  expect((await rejected)?.message).toBe("Native startup failed");
  expect(browserStops).toBe(1);
});


test("warm discovery appears in initial catalog but grants no Web execution authority", async () => {
  const f = await fixture({ warmDisplay: true, holdCreation: true });
  try {
    expect((await f.catalog()).models.map((row: { slug: string }) => row.slug)).toEqual(["native-fixture", model]);
    expect(f.runtime.webState).toBe("preparing");
    expect(f.runtime.webModelIds).toEqual([]);
    expect((await f.post(model)).status).toBe(400);
    expect(f.webGenerations).toBe(0);
    expect((await f.post("native-fixture")).status).toBe(200);
    f.gate.resolve(); await f.runtime.waitForWeb();
    expect(f.runtime.webState).toBe("ready");
    expect((await (await f.post(model)).text())).toContain("mock Web reply");
  } finally { await f.cleanup(); }
});


test("account-bound discovery survives failed preparation while Web execution stays unavailable", async () => {
  const f = await fixture({ warmDisplay: true, fail: "discovery" });
  try {
    await f.runtime.waitForWeb();
    expect(f.runtime.webState).toBe("failed");
    expect(f.runtime.webModelIds).toEqual([]);
    expect((await f.catalog()).models.map((row: { slug: string }) => row.slug))
      .toEqual(["native-fixture", model]);
    expect((await f.post(model)).status).toBe(400);
    expect(f.webGenerations).toBe(0);
    await f.runtime.invalidateWebAccount();
    expect((await f.catalog()).models.map((row: { slug: string }) => row.slug))
      .toEqual(["native-fixture", model]);
    expect((await f.post(model)).status).toBe(400);
  } finally { await f.cleanup(); }
});


test("proven account invalidation revokes a busy Web turn without stopping Native or replaying", async () => {
  const f = await fixture({ holdGeneration: true });
  try {
    await f.runtime.waitForWeb();
    const response = f.post(model);
    await f.generationStarted.promise;
    await f.runtime.invalidateWebAccount();
    expect(f.runtime.webState).toBe("failed");
    expect(f.runtime.webRuntime).toBeUndefined();
    expect(f.runtime.webModelIds).toEqual([]);
    expect(f.browserStops).toBe(1);
    expect(f.nativeStops).toBe(0);
    expect((await f.post("native-fixture")).status).toBe(200);
    expect((await f.post(model)).status).toBe(400);
    f.generationGate.resolve();
    expect(await (await response).text()).not.toContain("mock Web reply");
    expect(f.webGenerations).toBe(1);
    expect(f.creations).toBe(1);
  } finally { f.generationGate.resolve(); await f.cleanup(); }
});

test("account invalidation cancels late preparation without automatically signing in or reopening", async () => {
  const f = await fixture({ holdCreation: true });
  try {
    const first = f.runtime.invalidateWebAccount();
    const duplicate = f.runtime.invalidateWebAccount();
    expect(first).toBe(duplicate);
    expect(f.runtime.webState).toBe("failed");
    f.gate.resolve();
    await first;
    expect(f.runtime.webState).toBe("failed");
    expect(f.runtime.webModelIds).toEqual([]);
    expect(f.browserStops).toBe(1);
    expect(f.creations).toBe(1);
    expect(f.nativeStops).toBe(0);
    expect((await f.post("native-fixture")).status).toBe(200);
    await f.runtime.reconnectWeb();
    expect(f.creations).toBe(2);
    expect(f.runtime.webState).toBe("ready");
  } finally { f.gate.resolve(); await f.cleanup(); }
});


test("explicit reconnect waits for account invalidation before creating a new browser", async () => {
  const f = await fixture({ holdCreation: true });
  try {
    const invalidation = f.runtime.invalidateWebAccount();
    const reconnect = f.runtime.reconnectWeb();
    expect(f.creations).toBe(1);
    expect(f.runtime.webModelIds).toEqual([]);
    f.gate.resolve();
    await Promise.all([invalidation, reconnect]);
    expect(f.creations).toBe(2);
    expect(f.browserStops).toBe(1);
    expect(f.nativeStops).toBe(0);
    expect(f.runtime.webState).toBe("ready");
  } finally { f.gate.resolve(); await f.cleanup(); }
});

test("profile stop joins pending account cleanup and closes the late browser once", async () => {
  const f = await fixture({ holdCreation: true });
  try {
    const invalidation = f.runtime.invalidateWebAccount();
    const stopped = f.runtime.stop();
    f.gate.resolve();
    await Promise.all([invalidation, stopped]);
    expect(f.runtime.webState).toBe("closed");
    expect(f.browserStops).toBe(1);
    expect(f.nativeStops).toBe(1);
    expect(f.creations).toBe(1);
  } finally { f.gate.resolve(); await f.cleanup(); }
});


test("signed-out Web exposes login-required while Native keeps working, then owner login restores admission", async () => {
  const f = await fixture({ fail: "login", accountBrowserFallback: true });
  try {
    await f.runtime.waitForWeb();
    expect(f.runtime.webState).toBe("login-required");
    expect(f.runtime.webModelIds).toEqual([]);
    expect((await f.post("native-fixture")).status).toBe(200);
    expect(f.nativeStops).toBe(0);
    await f.runtime.openWebAccountBrowser();
    expect(f.runtime.accountManagementActive).toBe(true);
    f.fix();
    await f.runtime.closeWebAccountBrowser();
    expect(f.runtime.webState).toBe("ready");
    expect(f.runtime.webModelIds).toEqual([model]);
    expect(f.nativeStops).toBe(0);
  } finally { await f.cleanup(); }
});


test("metadata subscriptions survive replacement of the Web runtime without retaining its old host", async () => {
  const f = await fixture();
  let notifications = 0;
  const detach = f.runtime.onBridgeSurfacesChanged(() => { notifications++; });
  try {
    await f.runtime.waitForWeb();
    const before = f.runtime.bridgeSurfaces().revision;
    expect(f.surfaceObserverOwners[0]?.size).toBe(1);
    await f.runtime.reconnectWeb();
    expect(f.surfaceObserverOwners[0]?.size).toBe(0);
    expect(f.surfaceObserverOwners[1]?.size).toBe(1);
    expect(f.runtime.bridgeSurfaces().revision).toBeGreaterThan(before);
    expect(notifications).toBeGreaterThan(0);
    const current = f.runtime.bridgeSurfaces().revision;
    for (const notify of f.surfaceObserverOwners[1]!) notify();
    expect(f.runtime.bridgeSurfaces().revision).toBe(current + 1);
  } finally { detach(); await f.cleanup(); }
  expect(f.surfaceObserverOwners[1]?.size).toBe(0);
});
