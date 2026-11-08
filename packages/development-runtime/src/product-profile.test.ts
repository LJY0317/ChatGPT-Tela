import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlledBrowserHost } from "@chatgpt-tela/browser-host";
import {
  loadProductProfileRuntimeConfig,
  prepareProductWebDiscovery,
  productPublicMcpIdentity,
  startProductProfileRuntime,
  startAppOwnedProductResponsesRuntime,
} from "./product-profile";
import { startLocalResponsesServer } from "@chatgpt-tela/local-server";
import { MultiProfileControlClient, type MultiProfileControlRunner } from "@chatgpt-tela/setup";
import { connectCodexTurnBridge } from "@chatgpt-tela/mcp";
import { createOwnershipManifest, resolveProductPaths, writeOwnershipManifest } from "@chatgpt-tela/product-lifecycle";
import { appOwnedDesktopCatalogPath, publishAppOwnedDesktopCatalog } from "./app-owned-desktop-catalog";
import { readDefaultDesktopNativeCatalog, resolveDefaultDesktopInstallation } from "@chatgpt-tela/default-desktop-target";
import { chatGptWebFamilyKey, chatGptWebModelId } from "@chatgpt-tela/chatgpt";
import { startProfileBridgePreviewServer } from "../../../apps/profile-runtime/src/bridge-preview-server";
import { startDevelopmentRuntime } from "./runtime";
import { createNativeRequestDevelopmentWebTurnPlanner } from "./native-request-planner";

function common(root: string): Record<string, string> {
  return {
    CHATGPT_TELA_PROFILE_ROOT: join(root, "profiles"),
    CHATGPT_TELA_PRODUCT_PROFILE_SLOT: "1",
    CHATGPT_TELA_PRODUCT_ROUTE_ID: "route1234",
    CHATGPT_TELA_PRODUCT_RESPONSES_TOKEN: "r".repeat(48),
    CHATGPT_TELA_PRODUCT_INTERNAL_MCP_TOKEN: "m".repeat(48),
    CHATGPT_TELA_PRODUCT_UI_TOKEN: "u".repeat(48),
  };
}

describe("product profile native-target selection", () => {
  test("ordinary profile 1 defaults to the built-in Desktop target without a launcher", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-product-default-"));
    try {
      const config = loadProductProfileRuntimeConfig(common(root));
      expect(config.nativeTarget).toEqual({ kind: "default-desktop", targetId: "default" });
      expect(config.publicMcpAbi).toBe("stable");
      expect(config.approvalAutomationMode).toBe("off");
      expect(config.approvalAutomationDelayMs).toBe(0);
      expect(config.acceptanceSavedChat).toBe(false);
      expect(config).not.toHaveProperty("webTurnTimeoutMs");
      expect(JSON.stringify(config)).not.toContain("launcherCli");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ordinary Work remains Temporary Chat unless the exact profile is explicitly selected for acceptance", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-product-saved-acceptance-"));
    try {
      expect(loadProductProfileRuntimeConfig({
        ...common(root), CHATGPT_TELA_ACCEPTANCE_SAVED_CHAT_SLOT: "1",
      }).acceptanceSavedChat).toBe(true);
      expect(loadProductProfileRuntimeConfig({
        ...common(root), CHATGPT_TELA_ACCEPTANCE_SAVED_CHAT_SLOT: "2",
      }).acceptanceSavedChat).toBe(false);
      await expect(startProductProfileRuntime(loadProductProfileRuntimeConfig({
        ...common(root), CHATGPT_TELA_ACCEPTANCE_SAVED_CHAT_SLOT: "1",
      }))).rejects.toThrow("Native-first runtime");
      for (const value of ["0", "-1", "100", "1,2", "01", "all", "true"]) {
        expect(() => loadProductProfileRuntimeConfig({
          ...common(root), CHATGPT_TELA_ACCEPTANCE_SAVED_CHAT_SLOT: value,
        })).toThrow("ACCEPTANCE_SAVED_CHAT_SLOT");
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("approval automation accepts full access only", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-product-approval-"));
    try {
      const enabled = loadProductProfileRuntimeConfig({
        ...common(root),
        CHATGPT_TELA_APPROVAL_AUTOMATION_MODE: "full_access",
        CHATGPT_TELA_APPROVAL_DELAY_MS: "2000",
      });
      expect(enabled.approvalAutomationMode).toBe("full_access");
      expect(loadProductProfileRuntimeConfig({
        ...common(root), CHATGPT_TELA_APPROVAL_AUTOMATION_MODE: "full_access",
      }).approvalAutomationMode).toBe("full_access");
      expect(enabled.approvalAutomationDelayMs).toBe(2_000);
      expect(() => loadProductProfileRuntimeConfig({
        ...common(root),
        CHATGPT_TELA_APPROVAL_AUTOMATION_MODE: "full_access",
        CHATGPT_TELA_APPROVAL_DELAY_MS: "15001",
      })).toThrow("APPROVAL_DELAY_MS");
      expect(() => loadProductProfileRuntimeConfig({
        ...common(root),
        CHATGPT_TELA_APPROVAL_AUTOMATION_MODE: "unsupported",
      })).toThrow("APPROVAL_AUTOMATION_MODE");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("only an explicit diagnostic deadline limits the entire product Web task", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-product-deadline-"));
    try {
      expect(loadProductProfileRuntimeConfig({ ...common(root),
        CHATGPT_TELA_PRODUCT_WEB_TURN_TIMEOUT_MS: "1500" }).webTurnTimeoutMs).toBe(1500);
      for (const value of ["0", "-1", "NaN", "1.5"]) {
        expect(() => loadProductProfileRuntimeConfig({ ...common(root),
          CHATGPT_TELA_PRODUCT_WEB_TURN_TIMEOUT_MS: value })).toThrow("positive integer");
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("public connector identity is ChatGPT Tela for the stable product ABI", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-product-public-abi-"));
    try {
      const stable = loadProductProfileRuntimeConfig({
        ...common(root),
        CHATGPT_TELA_PRODUCT_PUBLIC_MCP_ABI: "stable",
      });
      expect(stable.publicMcpAbi).toBe("stable");
      expect(productPublicMcpIdentity(stable.publicMcpAbi)).toEqual({
        connectorName: "ChatGPT Tela",
        webContract: "stable",
      });
      expect(productPublicMcpIdentity("stable")).toEqual({
        connectorName: "ChatGPT Tela",
        webContract: "stable",
      });
      expect(productPublicMcpIdentity("unified-development")).toEqual({
        connectorName: "ChatGPT Tela Development",
        webContract: "development",
      });
      expect(() => loadProductProfileRuntimeConfig({
        ...common(root),
        CHATGPT_TELA_PRODUCT_PUBLIC_MCP_ABI: "future-v3",
      })).toThrow("PUBLIC_MCP_ABI");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("extra profiles require the explicit Multi-Profile adapter", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-product-multi-"));
    const launcher = join(root, "plura-desktop");
    writeFileSync(launcher, "fixture", { mode: 0o700 });
    chmodSync(launcher, 0o700);
    try {
      expect(() => loadProductProfileRuntimeConfig({
        ...common(root),
        CHATGPT_TELA_PRODUCT_PROFILE_SLOT: "2",
      })).toThrow("slot 1");
      const config = loadProductProfileRuntimeConfig({
        ...common(root),
        CHATGPT_TELA_PRODUCT_PROFILE_SLOT: "2",
        CHATGPT_TELA_PRODUCT_NATIVE_TARGET_KIND: "multi-profile",
        CHATGPT_TELA_PRODUCT_TARGET_ID: "local.profile2",
        CHATGPT_TELA_PRODUCT_LAUNCHER_CLI: launcher,
      });
      expect(config.nativeTarget).toEqual({
        kind: "multi-profile",
        targetId: "local.profile2",
        launcherCli: launcher,
      });
      rmSync(launcher);
      expect(() => loadProductProfileRuntimeConfig({
        ...common(root),
        CHATGPT_TELA_PRODUCT_PROFILE_SLOT: "2",
        CHATGPT_TELA_PRODUCT_NATIVE_TARGET_KIND: "multi-profile",
        CHATGPT_TELA_PRODUCT_TARGET_ID: "local.profile2",
        CHATGPT_TELA_PRODUCT_LAUNCHER_CLI: launcher,
      })).toThrow("does not exist");
      // A removed optional provider must not change the standalone default:
      // no silent failover from an explicitly selected foreign owner.
      expect(loadProductProfileRuntimeConfig({
        ...common(root),
        CHATGPT_TELA_PRODUCT_LAUNCHER_CLI: launcher,
      }).nativeTarget).toEqual({ kind: "default-desktop", targetId: "default" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("launcher path alone does not implicitly select the optional adapter", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-product-legacy-multi-"));
    const launcher = join(root, "plura-desktop");
    writeFileSync(launcher, "fixture", { mode: 0o700 });
    try {
      const config = loadProductProfileRuntimeConfig({
        ...common(root),
        CHATGPT_TELA_PRODUCT_TARGET_ID: "default",
        CHATGPT_TELA_PRODUCT_LAUNCHER_CLI: launcher,
      });
      expect(config.nativeTarget).toEqual({ kind: "default-desktop", targetId: "default" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});


import { bindChatGptTelaAccount } from "./browser-profile";
import { ConnectorProbeState } from "./connector-probe-state";
import type { ElectronDevelopmentRuntime } from "./electron";
import type { ChatGptWebPreparationOptions } from "./profile-control";

for (const outcome of ["complete", "account-mismatch", "account-changed-during-discovery", "cleanup-failed"] as const) {
  test(`single product preparation journal: ${outcome}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-preparation-journal-"));
    try {
      const config = loadProductProfileRuntimeConfig(common(root));
      mkdirSync(config.browserProfile.userDataDir, { recursive: true });
      bindChatGptTelaAccount(config.browserProfile, "a".repeat(64));
      const marker = new ConnectorProbeState({ directory: config.browserProfile.userDataDir, connectorName: "Fixture" });
      const stages: string[] = [];
      const family = { key: "a".repeat(20), label: "Fixture", availableEfforts: ["medium"] as const };
      const runtime = {
        async prepareChatGptWebSession(options: ChatGptWebPreparationOptions) {
          options.onProfile({ capabilities: { observed: new Set(["composer", "send"]) }, account: {
            accountFingerprint: outcome === "account-mismatch" ? "b".repeat(64) : "a".repeat(64),
            accountStructure: "personal", containerFingerprint: "container",
          } });
          if (outcome === "account-changed-during-discovery") bindChatGptTelaAccount(config.browserProfile, "b".repeat(64));
          options.onFamilies?.([family]); options.onConnectorStarting?.();
          expect(marker.pending()).toBe(true);
          if (outcome === "cleanup-failed") throw new Error("cleanup failed");
          options.onConnectorProven?.();
          return { families: [family] };
        },
      } as unknown as ElectronDevelopmentRuntime;
      const operation = prepareProductWebDiscovery({ runtime, browserProfile: config.browserProfile,
        connectorName: "Fixture", signal: new AbortController().signal, stage: stage => stages.push(stage) });
      if (outcome === "complete") {
        expect((await operation)).toMatchObject({ families: [family], accountFingerprint: "a".repeat(64) });
        expect(marker.pending()).toBe(false);
        expect(stages.at(-1)).toBe("fresh_readiness_proof_complete");
      } else {
        await expect(operation).rejects.toThrow();
        expect(marker.pending()).toBe(outcome === "cleanup-failed" || outcome === "account-changed-during-discovery");
        expect(stages).not.toContain("fresh_readiness_proof_complete");
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("preparation policy is explicit and distinct from the whole-task diagnostic timeout", () => {
  const root = mkdtempSync(join(tmpdir(), "tela-preparation-policy-"));
  try {
    const policy = { maxModelCalls: 3, maxInputTokens: 200_000, maxElapsedMs: 120_000 };
    const config = loadProductProfileRuntimeConfig({ ...common(root),
      CHATGPT_TELA_CHECKPOINT_PREPARATION_POLICY: JSON.stringify(policy) });
    expect(config.checkpointPreparationPolicy).toEqual(policy);
    expect(config).not.toHaveProperty("webTurnTimeoutMs");
    for (const bad of [{ maxModelCalls: 1 }, { ...policy, maxElapsedMs: -1 }, { ...policy, misspelledLimit: 8 }]) {
      expect(() => loadProductProfileRuntimeConfig({ ...common(root),
        CHATGPT_TELA_CHECKPOINT_PREPARATION_POLICY: JSON.stringify(bad) })).toThrow("Invalid checkpoint preparation policy");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("app-owned Responses reuses a fixed capability URL while closing only Tela resources", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-app-owned-responses-"));
  try {
    const config = loadProductProfileRuntimeConfig(common(root));
    mkdirSync(config.browserProfile.userDataDir, { recursive: true });
    bindChatGptTelaAccount(config.browserProfile, "a".repeat(64));
    const temporary = await startLocalResponsesServer({ requestRouter: async () => new Response(null, { status: 404 }) });
    const ingress = { port: temporary.port, capability: "c".repeat(48) };
    await temporary.stop();
    let closes = 0, nativeRequests = 0, failNextStop = false;
    const nativeResponses: string[] = [];
    const webResponses: string[] = [];
    const webModel = chatGptWebModelId(chatGptWebFamilyKey("App owned Web fixture"));
    const starter = (async (options: Parameters<typeof import("./electron").startElectronDevelopmentRuntime>[0]) => {
      expect(options.currentTurnSource).toBeUndefined();
      expect(options.mcp).toEqual({ kind: "external", abi: "stable" });
      expect(options.responses).toMatchObject({
        port: ingress.port, runtimeToken: ingress.capability, authentication: { kind: "path" },
      });
      const responses = await startLocalResponsesServer({ ...options.responses,
        async requestRouter(request) {
          const routed = await options.responses!.requestRouter!(request);
          if (routed) return routed;
          const body = await request.json() as { model: string };
          webResponses.push(body.model);
          return Response.json({ provider: "web", model: body.model });
        } });
      return {
        responses,
        suppliedToolBridge: { inventory: () => [], async invoke() { throw Error("No fixture tool calls"); } },
        shutdownReadiness: () => "ready", prepareShutdown() {},
        async prepareChatGptWebSession(input: any) {
          input.onProfile?.({ account: { accountFingerprint: "a".repeat(64),
            accountStructure: "personal", containerFingerprint: "fixture" } });
          input.onFamilies?.([]);
          input.onConnectorStarting?.();
          input.onConnectorProven?.();
          return { families: [] };
        },
        async discoverChatGptWebModelFamilies() { return []; },
        async stop() {
          if (failNextStop) { failNextStop = false; throw Error("synthetic runtime cleanup interrupted"); }
          closes++; await responses.stop();
        },
      } as unknown as ElectronDevelopmentRuntime;
    }) as typeof import("./electron").startElectronDevelopmentRuntime;
    const open = () => startAppOwnedProductResponsesRuntime({ config, ingress, electronStarter: starter,
      nativeFetch: async request => {
        nativeRequests++;
        expect(request.headers.get("authorization")).toBe("Bearer synthetic-native-auth");
        if (new URL(request.url).pathname.endsWith("/responses")) {
          const body = await request.json() as { model: string };
          nativeResponses.push(body.model);
          return Response.json({ provider: "native", model: body.model });
        }
        return Response.json({ models: [{ slug: "native-fixture", display_name: "Fixture",
          visibility: "list", supported_in_api: true }] });
      } });
    const first = await open();
    const url = first.responses.baseUrl;
    try {
      expect(url.pathname).toContain(ingress.capability);
      expect((await fetch(new URL("models", url), { headers: { authorization: "Bearer synthetic-native-auth" } })).status).toBe(200);
      const send = async (model: string) => (await fetch(new URL("responses", url), {
        method: "POST", headers: { authorization: "Bearer synthetic-native-auth", "content-type": "application/json" },
        body: JSON.stringify({ model, input: [] }),
      })).json() as Promise<{ provider: string }>;
      expect((await send("native-fixture")).provider).toBe("native");
      expect((await send(webModel)).provider).toBe("web");
      expect((await send("native-fixture")).provider).toBe("native");
      expect(nativeResponses).toEqual(["native-fixture", "native-fixture"]);
      expect(webResponses).toEqual([webModel]);
      expect((await fetch(`http://127.0.0.1:${ingress.port}/wrong/v1/models`)).status).toBe(401);
    } finally {
      failNextStop = true;
      await expect(first.stop()).rejects.toThrow("App-owned profile cleanup failed");
      expect(closes).toBe(0);
      await first.stop();
    }
    const second = await open();
    try {
      expect(second.responses.baseUrl.href).toBe(url.href);
      expect((await fetch(new URL("models", second.responses.baseUrl),
        { headers: { authorization: "Bearer synthetic-native-auth" } })).status).toBe(200);
    } finally { await second.stop(); }
    expect(closes).toBe(2);
    expect(nativeRequests).toBe(4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("two managed app-owned profiles keep independent fixed header routes, overlay and Plura lifetime across a Tela restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-app-owned-managed-"));
  const launcher = join(root, "fixture-plura");
  writeFileSync(launcher, "fixture");
  const profiles = [2, 3] as const;
  const capabilities: Record<number, string> = { 2: "c".repeat(48), 3: "d".repeat(48) };
  const fixtureIds = profiles.map(slot => `managed.fixture.${slot}`);
  const sessions = new Map<string, { route: string; overlay: string; body: Record<string, unknown> }>();
  let createdSessions = 0;
  const calls: string[] = [];
  const toolCalls: number[] = [];
  const runner: MultiProfileControlRunner = {
    async run(_command, input) {
      const [action, ...args] = input.arguments;
      calls.push(action!);
      const argument = (name: string) => args[args.indexOf(name) + 1]!;
      const id = argument("--target");
      const output = action === "targets" ? {
        contractVersion: 1,
        targets: profiles.map(slot => ({
          id: `managed.fixture.${slot}`, displayName: `Fixture ${slot}`,
          managed: true, role: "managed", state: "stopped", sessionState: "available",
          sharedAppServerSupported: true, responsesRouteSupported: true,
          modelListOverlaySupported: true, startupModelCatalogSupported: true, profileIndex: slot,
        })),
      } : (() => {
        if (action !== "launch-target" || !fixtureIds.includes(id as typeof fixtureIds[number])) {
          throw Error("Unexpected fixture public control operation");
        }
        const route = argument("--responses-base-url");
        const overlay = argument("--model-list-overlay-url");
        const before = sessions.get(id);
        if (before && (before.route !== route || before.overlay !== overlay)) {
          throw Error("Existing Plura session route changed: normal quit required");
        }
        if (!before) {
          createdSessions++;
          sessions.set(id, {
            route, overlay,
            body: {
              contractVersion: 1, targetID: id, state: "ready",
              endpoint: `ws://127.0.0.1:${19000 + profiles.indexOf(Number(id.split(".").at(-1)) as 2 | 3)}`,
              desktopProcessID: 4200 + Number(id.split(".").at(-1)),
              responsesRouteFingerprint: createHash("sha256").update(route).digest("hex"),
              modelListOverlayFingerprint: createHash("sha256").update(overlay).digest("hex"),
            },
          });
        }
        expect(args).toContain("--startup-model-catalog");
        expect(input.environment?.CHATGPT_TELA_PRODUCT_RESPONSES_TOKEN).toBe(capabilities[Number(id.split(".").at(-1))]);
        return sessions.get(id)!.body;
      })();
      return { stdout: JSON.stringify(output), stderr: "", exitCode: 0 };
    },
  };
  const client = new MultiProfileControlClient({ command: [launcher], runner });
  const active: Array<Awaited<ReturnType<typeof startAppOwnedProductResponsesRuntime>>> = [];
  try {
    const configs = profiles.map(slot => {
      const config = loadProductProfileRuntimeConfig({
        ...common(root), CHATGPT_TELA_PRODUCT_PROFILE_SLOT: String(slot),
        CHATGPT_TELA_PRODUCT_INTERNAL_MCP_TOKEN: (slot === 2 ? "m" : "n").repeat(48),
        CHATGPT_TELA_PRODUCT_TARGET_ID: `managed.fixture.${slot}`,
        CHATGPT_TELA_PRODUCT_NATIVE_TARGET_KIND: "multi-profile",
        CHATGPT_TELA_PRODUCT_LAUNCHER_CLI: launcher,
      });
      mkdirSync(config.browserProfile.userDataDir, { recursive: true });
      bindChatGptTelaAccount(config.browserProfile, String(slot).repeat(64));
      return config;
    });
    const family = { key: chatGptWebFamilyKey("Managed fixture Web"),
      label: "Managed fixture Web", availableEfforts: ["medium"] as const };
    const nativeBySlot = new Map<number, string[]>();
    const webBySlot = new Map<number, string[]>();
    const starter = (async (options: Parameters<typeof import("./electron").startElectronDevelopmentRuntime>[0]) => {
      const slot = options.profileSlot!;
      expect(options.responses?.authentication).toEqual({ kind: "header", name: "OpenAI-Organization" });
      expect(options.responses?.modelListOverlay).toBeDefined();
      const responses = await startLocalResponsesServer({ ...options.responses,
        async requestRouter(request) {
          const routed = await options.responses!.requestRouter!(request);
          if (routed) return routed;
          const body = await request.json() as { model: string };
          webBySlot.set(slot, [...webBySlot.get(slot) ?? [], body.model]);
          return Response.json({ provider: "web", slot });
        },
      });
      return {
        responses,
        suppliedToolBridge: {
          inventory: () => [{ wireName: "fixture_echo", name: "fixture_echo", kind: "function" as const,
            description: "Fixture profile-bound tool", inputSchema: { type: "object" }, observedFrom: ["fixture"] }],
          async invoke(_capability: unknown, invocation: { callId: string }) {
            toolCalls.push(slot);
            return { callId: invocation.callId, isError: false, content: `profile-${slot}-fixture-result` };
          },
        },
        shutdownReadiness: () => "ready", prepareShutdown() {},
        async prepareChatGptWebSession(input: any) {
          input.onProfile?.({ account: { accountFingerprint: String(slot).repeat(64),
            accountStructure: "personal", containerFingerprint: `fixture-${slot}` } });
          input.onFamilies?.([family]); input.onConnectorStarting?.(); input.onConnectorProven?.();
          return { families: [family] };
        },
        async discoverChatGptWebModelFamilies() { return [family]; },
        async stop() { await responses.stop(); },
      } as unknown as ElectronDevelopmentRuntime;
    }) as typeof import("./electron").startElectronDevelopmentRuntime;
    const open = (slot: number, control = client, signal?: AbortSignal) => startAppOwnedProductResponsesRuntime({
      config: configs[profiles.indexOf(slot as 2 | 3)]!, ingress: { port: ports[slot]!, capability: capabilities[slot]! },
      electronStarter: starter, multiProfileClient: control,
      ...(signal ? { signal } : {}),
      nativeFetch: async request => {
        expect(request.headers.get("OpenAI-Organization")).toBeNull();
        expect(request.headers.get("authorization")).toBe("Bearer synthetic-native-auth");
        if (request.method === "GET") return Response.json({ models: [] });
        const body = await request.json() as { model: string };
        nativeBySlot.set(slot, [...nativeBySlot.get(slot) ?? [], body.model]);
        return Response.json({ provider: "native", slot });
      },
    });
    const ports: Record<number, number> = {};
    for (const slot of profiles) {
      const reserve = await startLocalResponsesServer({ requestRouter: async () => new Response(null, { status: 404 }) });
      ports[slot] = reserve.port;
      await reserve.stop();
    }
    const first = await open(2); active.push(first);
    const second = await open(3); active.push(second);
    expect(createdSessions).toBe(2);
    const models = { contractVersion: 1, result: { models: [
      { slug: "native-model", display_name: "Native", visibility: "list", supported_in_api: true,
        supported_reasoning_levels: [{ effort: "medium", description: "Medium" }] },
    ] } };
    for (const [i, owned] of active.entries()) {
      const slot = profiles[i]!;
      const base = owned.responses.baseUrl;
      expect(base.pathname).toBe("/v1/");
      const overlay = new URL("/model-list-overlay", base);
      expect((await fetch(overlay, { method: "POST", headers: {
        authorization: "Bearer wrong", "content-type": "application/json",
      }, body: JSON.stringify(models) })).status).toBe(401);
      const catalog = await fetch(overlay, { method: "POST", headers: {
        authorization: `Bearer ${capabilities[slot]}`, "content-type": "application/json",
      }, body: JSON.stringify(models) });
      expect(catalog.status).toBe(200);
      const projected = await catalog.json() as { result: { models: { slug: string }[] } };
      expect(projected.result.models.map(value => value.slug)).toEqual(["native-model", chatGptWebModelId(family.key)]);
      const send = async (model: string, token = capabilities[slot]!) => fetch(new URL("responses", base), {
        method: "POST", headers: {
          "OpenAI-Organization": token,
          authorization: "Bearer synthetic-native-auth", "content-type": "application/json",
        }, body: JSON.stringify({ model, input: [] }),
      });
      expect((await send("native-model", "wrong")).status).toBe(401);
      expect((await send("native-model", capabilities[slot === 2 ? 3 : 2])).status).toBe(401);
      expect((await (await send("native-model")).json()).slot).toBe(slot);
      expect((await (await send(chatGptWebModelId(family.key))).json()).provider).toBe("web");
    }
    expect(nativeBySlot.get(2)).toEqual(["native-model"]);
    expect(nativeBySlot.get(3)).toEqual(["native-model"]);
    expect(webBySlot.get(2)).toEqual([chatGptWebModelId(family.key)]);
    expect(webBySlot.get(3)).toEqual([chatGptWebModelId(family.key)]);
    for (const [i, owned] of active.entries()) {
      const bridge = await connectCodexTurnBridge({ endpoint: owned.internalMcp.endpointUrl,
        bearerToken: configs[i]!.internalMcpToken });
      try {
        const capability = `turnr_fixture_profile_${profiles[i]}_capability`;
        expect((await bridge.inventory(capability)).map(tool => tool.wireName)).toEqual(["fixture_echo"]);
        const result = await bridge.invoke(capability, {
          callId: `fixture-tool-${i}`, wireName: "fixture_echo", mode: "structured", arguments: {},
        });
        expect(result.content).toBe(`profile-${profiles[i]}-fixture-result`);
      } finally { await bridge.close(); }
    }
    expect(toolCalls).toEqual([2, 3]);
    bindChatGptTelaAccount(configs[1]!.browserProfile, "e".repeat(64));
    const changedAccountCatalog = await fetch(new URL("/model-list-overlay", second.responses.baseUrl), {
      method: "POST", headers: { authorization: `Bearer ${capabilities[3]}`, "content-type": "application/json" },
      body: JSON.stringify(models),
    });
    expect((await changedAccountCatalog.json() as { result: { models: { slug: string }[] } })
      .result.models.map(model => model.slug)).toEqual(["native-model"]);
    bindChatGptTelaAccount(configs[1]!.browserProfile, "3".repeat(64));
    await first.stop(); active.splice(0, 1);
    const restarted = await open(2); active.push(restarted);
    expect(restarted.responses.baseUrl.href).toBe(first.responses.baseUrl.href);
    expect(createdSessions).toBe(2);
    expect((await fetch(new URL("models", second.responses.baseUrl), {
      headers: { "OpenAI-Organization": capabilities[3]!, authorization: "Bearer synthetic-native-auth" },
    })).status).toBe(200);
    expect(calls).not.toContain("quit-target");
    await restarted.stop(); active.splice(active.indexOf(restarted), 1);
    const rejectedClient = new MultiProfileControlClient({ command: [launcher], runner: {
      async run(_command, input) {
        expect(input.arguments[0]).toBe("targets");
        return { stderr: "", exitCode: 0, stdout: JSON.stringify({ contractVersion: 1, targets: [{
          id: "managed.fixture.2", displayName: "Wrong owner", managed: true, role: "managed",
          state: "stopped", sessionState: "available", profileIndex: 3,
          sharedAppServerSupported: true, responsesRouteSupported: true,
          modelListOverlaySupported: true, startupModelCatalogSupported: true,
        }] }) };
      },
    } });
    await expect(open(2, rejectedClient)).rejects.toThrow("does not own the requested profile slot");
    const abort = new AbortController();
    const cancellingClient = new MultiProfileControlClient({ command: [launcher], runner: {
      async run(_command, input) {
        if (input.arguments[0] === "targets") return { stderr: "", exitCode: 0,
          stdout: JSON.stringify({ contractVersion: 1, targets: [{
            id: "managed.fixture.2", displayName: "Fixture 2", managed: true, role: "managed",
            state: "stopped", sessionState: "available", profileIndex: 2,
            sharedAppServerSupported: true, responsesRouteSupported: true,
            modelListOverlaySupported: true, startupModelCatalogSupported: true,
          }] }) };
        abort.abort();
        throw new DOMException("Fixture launch cancelled", "AbortError");
      },
    } });
    await expect(open(2, cancellingClient, abort.signal)).rejects.toThrow("Fixture launch cancelled");
    const recovered = await open(2); active.push(recovered);
    expect(createdSessions).toBe(2);
  } finally {
    await Promise.allSettled(active.map(item => item.stop()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("app-owned production shutdown resumes a failed browser close through the HTTP receipt and rebinds the same route", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-app-owned-production-stop-"));
  const config = loadProductProfileRuntimeConfig(common(root));
  mkdirSync(config.browserProfile.userDataDir, { recursive: true });
  bindChatGptTelaAccount(config.browserProfile, "a".repeat(64));
  const temporary = await startLocalResponsesServer({ requestRouter: async () => new Response(null, { status: 404 }) });
  const ingress = { port: temporary.port, capability: "s".repeat(48) };
  await temporary.stop();
  let browserCloseAttempts = 0;
  const browserHost = new ControlledBrowserHost(async () => ({
    async navigate() {}, async reveal() {}, async hide() {},
    async close() {
      browserCloseAttempts++;
      if (browserCloseAttempts === 1) throw Error("transient owned browser close failure");
    },
  }));
  const starter = (async (options: Parameters<typeof import("./electron").startElectronDevelopmentRuntime>[0]) => {
    const actual = await startDevelopmentRuntime({
      browserHost, mcp: options.mcp, planWebTurn: createNativeRequestDevelopmentWebTurnPlanner(),
      ...(options.profileSlot !== undefined ? { profileSlot: options.profileSlot } : {}),
      ...(options.routeId ? { routeId: options.routeId } : {}),
      ...(options.completedResults ? { completedResults: options.completedResults } : {}),
      ...(options.responses ? { responses: options.responses } : {}),
    });
    return { ...actual,
      async prepareChatGptWebSession(input: any) {
        input.onProfile?.({ account: { accountFingerprint: "a".repeat(64),
          accountStructure: "personal", containerFingerprint: "fixture" } });
        input.onFamilies?.([]); input.onConnectorStarting?.(); input.onConnectorProven?.();
        return { families: [] };
      },
      async discoverChatGptWebModelFamilies() { return []; },
    } as unknown as import("./electron").ElectronDevelopmentRuntime;
  }) as typeof import("./electron").startElectronDevelopmentRuntime;
  let owned: Awaited<ReturnType<typeof startAppOwnedProductResponsesRuntime>> | undefined;
  let preview: Awaited<ReturnType<typeof startProfileBridgePreviewServer>> | undefined;
  try {
    owned = await startAppOwnedProductResponsesRuntime({ config, ingress, electronStarter: starter,
      nativeFetch: async () => Response.json({ models: [] }) });
    await browserHost.acquire({ taskId: "owned-browser-fixture", epochId: "one" });
    const firstUrl = owned.responses.baseUrl.href;
    const receiptFingerprint = createHash("sha256").update(firstUrl).digest("hex");
    preview = await startProfileBridgePreviewServer({ slot: config.slot, bearerToken: config.uiToken,
      observe: async () => ({ activeSurfaceCount: 0 }),
      shutdownReadiness: () => owned!.shutdownReadiness(),
      shutdownProfile: async () => {
        await owned!.stop();
        return { responsesRouteFingerprint: receiptFingerprint };
      },
    });
    const stop = () => fetch(new URL("v1/profile-stop", preview!.endpoint), {
      method: "POST", headers: { authorization: `Bearer ${config.uiToken}` },
    });
    expect((await stop()).status).toBe(409);
    expect(browserCloseAttempts).toBe(1);
    expect((await fetch(new URL("v1/shutdown-readiness", preview.endpoint), {
      headers: { authorization: `Bearer ${config.uiToken}` },
    }).then(response => response.json())).shutdownReadiness).toBe("ready");
    const resumed = await stop();
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({ contractVersion: 1, slot: config.slot,
      phase: "cleanup-complete", responsesRouteFingerprint: receiptFingerprint });
    expect(browserCloseAttempts).toBe(2);
    expect((await stop()).status).toBe(200);
    expect(browserCloseAttempts).toBe(2);
    const fresh = await startAppOwnedProductResponsesRuntime({ config, ingress,
      electronStarter: starter, nativeFetch: async () => Response.json({ models: [] }) });
    try { expect(fresh.responses.baseUrl.href).toBe(firstUrl); }
    finally { await fresh.stop(); }
  } finally {
    await preview?.close();
    await owned?.stop().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test("app-owned startup failure releases its fixed Responses listener even if runtime cleanup rejects", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-app-owned-startup-close-"));
  const config = loadProductProfileRuntimeConfig(common(root));
  mkdirSync(config.browserProfile.userDataDir, { recursive: true });
  const reserved = await startLocalResponsesServer({ requestRouter: async () => new Response(null, { status: 404 }) });
  const ingress = { port: reserved.port, capability: "x".repeat(48) };
  await reserved.stop();
  let cleanupAttempts = 0;
  const starter = (async (options: Parameters<typeof import("./electron").startElectronDevelopmentRuntime>[0]) => {
    const responses = await startLocalResponsesServer({ ...options.responses,
      requestRouter: async () => new Response(null, { status: 503 }) });
    return { responses,
      async prepareChatGptWebSession() { throw Error("initial readiness failed"); },
      async stop() {
        cleanupAttempts++;
        await responses.stop();
        throw Error("post-close observation failed");
      },
    } as unknown as ElectronDevelopmentRuntime;
  }) as typeof import("./electron").startElectronDevelopmentRuntime;
  try {
    await expect(startAppOwnedProductResponsesRuntime({ config, ingress, electronStarter: starter }))
      .rejects.toThrow("initial readiness failed");
    expect(cleanupAttempts).toBe(1);
    const rebound = await startLocalResponsesServer({ hostname: "127.0.0.1", port: ingress.port,
      requestRouter: async () => new Response(null, { status: 204 }) });
    try { expect(rebound.port).toBe(ingress.port); }
    finally { await rebound.stop(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("app-owned first readiness binds durable results after login and isolates a changed account", async () => {
  const { createSuppliedRequestGateway } = await import("./supplied-request-gateway");
  const { chatGptWebModelId, chatGptWebFamilyKey } = await import("@chatgpt-tela/chatgpt");
  const root = mkdtempSync(join(tmpdir(), "tela-app-owned-late-binding-"));
  const config = loadProductProfileRuntimeConfig(common(root));
  const accountA = "a".repeat(64), accountB = "b".repeat(64);
  const family = chatGptWebFamilyKey("Late binding fixture");
  const body = { model: chatGptWebModelId(family), stream: false, reasoning: { effort: "medium" },
    client_metadata: { "x-codex-turn-metadata": { request_kind: "turn", thread_id: "late-thread", turn_id: "late-turn" } },
    input: [{ role: "user", content: "Keep the exact synthetic completion." }], tools: [] };
  let activeAccount = accountA, submissions = 0, gateway: ReturnType<typeof createSuppliedRequestGateway> | undefined;
  const starter = (async (options: Parameters<typeof import("./electron").startElectronDevelopmentRuntime>[0]) => {
    expect(typeof options.completedResults).toBe("function");
    const host = { async acquire({ taskId, epochId }: any) {
      return { taskId, epochId, leaseId: "late-binding-surface",
        async navigate() {}, async reveal() {}, async hide() {}, capability() {} };
    }, async release() {}, async close() {} } as any;
    const provider = {
      async submitTurn(_surface: unknown, turn: any) {
        submissions++;
        return { state: "proven", evidence: ["fixture"], value: {
          nativeTaskId: turn.nativeTaskId, nativeTurnId: turn.nativeTurnId, webEpochId: turn.webEpochId, providerTurnId: "late-web",
        } };
      },
      async waitForTurnEvent(_surface: unknown, handle: any) {
        return { state: "proven", evidence: ["fixture"], value: {
          kind: "completed", providerTurnId: handle.providerTurnId, answer: activeAccount === accountA ? "Answer A" : "Answer B",
        } };
      },
    } as any;
    gateway = createSuppliedRequestGateway({ browserHost: host, provider,
      ...(options.routeId ? { routeId: options.routeId } : {}),
      ...(options.completedResults ? { completedResults: options.completedResults } : {}),
      async prepareForSubmit() {} });
    const current = gateway;
    const responses = await startLocalResponsesServer({ ...options.responses, gateway: current });
    return { responses, suppliedToolBridge: current.toolBridge,
      shutdownReadiness: () => current.shutdownReadiness(), prepareShutdown: () => current.prepareShutdown(),
      async prepareChatGptWebSession(input: any) {
        // Existing login/setup establishes the verified binding during readiness.
        if (activeAccount === accountA) {
          expect(typeof options.completedResults).toBe("function");
          expect((options.completedResults as () => unknown)()).toBeUndefined();
        }
        bindChatGptTelaAccount(config.browserProfile, activeAccount);
        input.onProfile?.({ account: { accountFingerprint: activeAccount,
          accountStructure: "personal", containerFingerprint: "fixture" } });
        input.onFamilies?.([]); input.onConnectorStarting?.(); input.onConnectorProven?.();
        return { families: [] };
      },
      async discoverChatGptWebModelFamilies() { return []; },
      async stop() { await responses.stop(); await current.close(); },
    } as unknown as ElectronDevelopmentRuntime;
  }) as typeof import("./electron").startElectronDevelopmentRuntime;
  let owned: Awaited<ReturnType<typeof startAppOwnedProductResponsesRuntime>> | undefined;
  try {
    mkdirSync(config.browserProfile.userDataDir, { recursive: true });
    const temporary = await startLocalResponsesServer({ requestRouter: async () => new Response(null, { status: 404 }) });
    const ingress = { port: temporary.port, capability: "l".repeat(48) };
    await temporary.stop();
    owned = await startAppOwnedProductResponsesRuntime({ config, ingress, electronStarter: starter,
      nativeFetch: async () => Response.json({ models: [] }) });
    expect(await gateway!.handle(body)).toMatchObject({ type: "final", answer: "Answer A" });
    expect(owned.shutdownReadiness()).toBe("ready");
    bindChatGptTelaAccount(config.browserProfile, accountB);
    await expect(gateway!.handle({ ...body, client_metadata: {
      "x-codex-turn-metadata": { request_kind: "turn", thread_id: "late-thread", turn_id: "changed-account-turn" },
    } })).rejects.toThrow("account binding changed");
    expect(submissions).toBe(1);
    bindChatGptTelaAccount(config.browserProfile, accountA);
    await owned.stop(); owned = undefined;
    bindChatGptTelaAccount(config.browserProfile, accountB);
    activeAccount = accountB;
    owned = await startAppOwnedProductResponsesRuntime({ config, ingress, electronStarter: starter,
      nativeFetch: async () => Response.json({ models: [] }) });
    expect(await gateway!.handle(body)).toMatchObject({ type: "final", answer: "Answer B" });
    expect(submissions).toBe(2);
    expect(owned.shutdownReadiness()).toBe("ready");
  } finally { await owned?.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("app-owned startup assembles its authenticated internal MCP with the supplied host operation", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { createSuppliedRequestGateway } = await import("./supplied-request-gateway");
  const { chatGptWebModelId, chatGptWebFamilyKey } = await import("@chatgpt-tela/chatgpt");
  const root = mkdtempSync(join(tmpdir(), "tela-app-owned-startup-roundtrip-"));
  const family = { key: chatGptWebFamilyKey("Startup fixture"), label: "Startup fixture", availableEfforts: ["medium"] as const };
  const preparationOrder: string[] = [];
  const nativeReadMarker = join(root, ".codex", "catalog-read");
  let nativeCatalogReads = 0;
  let client: InstanceType<typeof Client> | undefined;
  let owned: Awaited<ReturnType<typeof startAppOwnedProductResponsesRuntime>> | undefined;
  let control = "";
  try {
    mkdirSync(join(root, ".codex"), { recursive: true });
    const chatExecutable = join(root, "ChatGPT");
    const codexExecutable = join(root, "codex");
    writeFileSync(chatExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    chmodSync(chatExecutable, 0o700);
    const nativeCatalog = { object: "list", models: [{ slug: "official-native", visibility: "list", display_name: "Native",
      supported_reasoning_levels: [{ effort: "medium", description: "Medium" }] }] };
    writeFileSync(codexExecutable, `#!/bin/sh\n: > "${nativeReadMarker}"\nprintf '%s\\n' '${JSON.stringify(nativeCatalog)}'\n`, { mode: 0o700 });
    chmodSync(codexExecutable, 0o700);
    const installation = resolveDefaultDesktopInstallation({ environment: {
      CHATGPT_EXECUTABLE: chatExecutable, CODEX_EXECUTABLE: codexExecutable,
    } });
    const paths = resolveProductPaths({ platform: process.platform, home: root, environment: {} });
    const manifest = createOwnershipManifest("fixture", new Date(), "11111111-2222-4333-8444-555555555555");
    writeOwnershipManifest(paths.installManifest, manifest);
    const config = loadProductProfileRuntimeConfig(common(root));
    mkdirSync(config.browserProfile.userDataDir, { recursive: true });
    bindChatGptTelaAccount(config.browserProfile, "a".repeat(64));
    const temporary = await startLocalResponsesServer({ requestRouter: async () => new Response(null, { status: 404 }) });
    const ingress = { port: temporary.port, capability: "r".repeat(48) }; await temporary.stop();
    const starter = (async (options: Parameters<typeof import("./electron").startElectronDevelopmentRuntime>[0]) => {
      const provider = {
        async submitTurn(_surface: unknown, turn: any) {
          control = turn.chatTools.nativeGoalControl;
          return { state: "proven", evidence: ["fixture"], value: { nativeTaskId: turn.nativeTaskId,
            nativeTurnId: turn.nativeTurnId, webEpochId: turn.webEpochId, providerTurnId: "startup-web" } };
        },
        async armToolContinuation(_surface: unknown, handle: any, callId: string) {
          return { state: "proven", evidence: ["fixture"], value: { providerTurnId: handle.providerTurnId, callId } };
        },
        async waitForTurnEvent(_surface: unknown, handle: any) {
          const result = await client!.callTool({ name: "chatgpt_tela_codex_tool_call", arguments: {
            turn_capability: control, call_id: "startup-get-goal", wire_name: "get_goal", mode: "structured", arguments: {} } });
          expect(result.isError).not.toBe(true);
          expect(JSON.stringify(result)).toContain("paused");
          return { state: "proven", evidence: ["fixture"], value: { kind: "completed",
            providerTurnId: handle.providerTurnId, answer: "Startup host result received." } };
        },
      } as any;
      const host = { async acquire({ taskId, epochId }: any) { return { taskId, epochId, leaseId: "startup-surface",
        async navigate() {}, async reveal() {}, async hide() {}, capability() {} }; },
        async release() {}, async close() {} } as any;
      const gateway = createSuppliedRequestGateway({ browserHost: host, provider,
        routeId: options.routeId!, async prepareForSubmit() {} });
      const responses = await startLocalResponsesServer({ ...options.responses, gateway });
      return { responses, suppliedToolBridge: gateway.toolBridge,
        shutdownReadiness: () => gateway.shutdownReadiness(), prepareShutdown: () => gateway.prepareShutdown(),
        async prepareChatGptWebSession(input: any) {
          preparationOrder.push(existsSync(nativeReadMarker) ? "native-catalog" : "native-catalog-missing");
          preparationOrder.push("web-account-and-discovery");
          input.onProfile?.({ account: { accountFingerprint: "a".repeat(64), accountStructure: "personal", containerFingerprint: "fixture" } });
          input.onFamilies?.([family]); input.onConnectorStarting?.(); input.onConnectorProven?.(); return { families: [family] };
        },
        async discoverChatGptWebModelFamilies() { return [family]; },
        async stop() { await responses.stop(); await gateway.close(); },
      } as unknown as ElectronDevelopmentRuntime;
    }) as typeof import("./electron").startElectronDevelopmentRuntime;
    owned = await startAppOwnedProductResponsesRuntime({ config, ingress, electronStarter: starter,
      nativeFetch: async () => Response.json({ models: [] }),
      catalogPreparation: { paths, installId: manifest.installId,
        async readNativeCatalog() { nativeCatalogReads++; return readDefaultDesktopNativeCatalog({ installation }); } },
    });
    expect(nativeCatalogReads).toBe(1);
    const prepared = JSON.parse(readFileSync(appOwnedDesktopCatalogPath(paths), "utf8"));
    expect(prepared.models.map((model: { slug: string }) => model.slug)).toEqual([
      "official-native", chatGptWebModelId(family.key),
    ]);
    expect(preparationOrder).toEqual(["native-catalog", "web-account-and-discovery"]);
    client = new Client({ name: "startup-goal", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(owned.internalMcp.endpointUrl, {
      requestInit: { headers: { authorization: `Bearer ${config.internalMcpToken}` } } }) as unknown as import("@modelcontextprotocol/sdk/shared/transport.js").Transport);
    const body = { model: chatGptWebModelId(family.key), stream: false, reasoning: { effort: "medium" },
      client_metadata: { "x-codex-turn-metadata": { request_kind: "turn", thread_id: "startup-thread", turn_id: "startup-turn" } },
      tools: [{ type: "function", name: "get_goal", parameters: { type: "object" } }],
      input: [{ role: "user", content: "Read the synthetic Goal." }] };
    const post = async (value: unknown) => (await fetch(new URL("responses", owned!.responses.baseUrl), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) })).json() as Promise<any>;
    const first = await post(body);
    expect(first.error).toBeUndefined();
    expect(first.output[0]).toMatchObject({ type: "function_call", call_id: "startup-get-goal", name: "get_goal" });
    const final = await post({ ...body, input: [...body.input, first.output[0], {
      type: "function_call_output", call_id: "startup-get-goal", output: '{"status":"paused"}' }] });
    expect(JSON.stringify(final)).toContain("Startup host result received.");
    const retired = await client.callTool({ name: "chatgpt_tela_codex_tool_inventory", arguments: { turn_capability: control } });
    expect(retired.isError).toBe(true);
  } finally {
    await client?.close();
    await owned?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("app-owned catalog retires prior Web rows before a failed account-bound discovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-app-owned-catalog-discovery-failure-"));
  let responses: Awaited<ReturnType<typeof startLocalResponsesServer>> | undefined;
  try {
    const paths = resolveProductPaths({ platform: process.platform, home: root, environment: {} });
    const manifest = createOwnershipManifest("fixture", new Date(), "11111111-2222-4333-8444-555555555555");
    writeOwnershipManifest(paths.installManifest, manifest);
    const oldFamily = { key: chatGptWebFamilyKey("Previous account model"), label: "Previous account model",
      availableEfforts: ["medium"] as const };
    await publishAppOwnedDesktopCatalog({ paths, installId: manifest.installId,
      nativeCatalog: { object: "list", models: [{ slug: "native-old", visibility: "list",
        supported_reasoning_levels: [{ effort: "medium", description: "Medium" }] }] },
      webFamilies: [oldFamily], assertCurrentAccount: () => {} });
    const config = loadProductProfileRuntimeConfig(common(root));
    mkdirSync(config.browserProfile.userDataDir, { recursive: true });
    bindChatGptTelaAccount(config.browserProfile, "a".repeat(64));
    const ingressServer = await startLocalResponsesServer({ requestRouter: async () => new Response(null, { status: 404 }) });
    const ingress = { port: ingressServer.port, capability: "f".repeat(48) };
    await ingressServer.stop();
    const nativeCatalog = { object: "list", models: [{ slug: "native-current", visibility: "list",
      supported_reasoning_levels: [{ effort: "medium", description: "Medium" }] }] };
    const starter = (async (options: Parameters<typeof import("./electron").startElectronDevelopmentRuntime>[0]) => {
      responses = await startLocalResponsesServer(options.responses!);
      return {
        responses,
        suppliedToolBridge: {} as any,
        shutdownReadiness: () => "ready" as const,
        prepareShutdown: async () => {},
        async prepareChatGptWebSession() { throw new Error("synthetic Web discovery failure"); },
        async discoverChatGptWebModelFamilies() { throw new Error("should not retry discovery"); },
        async stop() { await responses?.stop(); responses = undefined; },
      } as unknown as import("./electron").ElectronDevelopmentRuntime;
    }) as typeof import("./electron").startElectronDevelopmentRuntime;
    await expect(startAppOwnedProductResponsesRuntime({
      config, ingress, electronStarter: starter,
      catalogPreparation: { paths, installId: manifest.installId, async readNativeCatalog() { return nativeCatalog; } },
    })).rejects.toThrow("synthetic Web discovery failure");
    const published = JSON.parse(readFileSync(appOwnedDesktopCatalogPath(paths), "utf8"));
    expect(published.models.map((model: { slug: string }) => model.slug)).toEqual(["native-current"]);
  } finally {
    await responses?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
