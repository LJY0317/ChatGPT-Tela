import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startCodexService } from "./controller";
import type { CodexNativeTargetAdapter } from "./native-target";
import { loadProductProfileRuntimeConfig } from "../../development-runtime/src/product-profile";
import { bindChatGptTelaAccount } from "../../development-runtime/src/browser-profile";

test("parent-to-child managed Responses routes keep profile ownership across real HTTP, overlay, stop and restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-managed-parent-cross-"));
  const launcher = join(root, "plura-fixture");
  const failMarker = join(root, "wrong-owner");
  writeFileSync(launcher, "scripted public control fixture");
  const freePort = () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const value = server.port!;
    server.stop(true);
    return value;
  };
  const ingress = [2, 3].map(slot => ({ slot, port: freePort(),
    capability: (slot === 2 ? "c" : "d").repeat(48) }));
  const child = join(root, "managed-child.ts");
  writeFileSync(child, `
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createProfileSupervisorLifecycle } from ${JSON.stringify(resolve(import.meta.dir, "../../../apps/profile-runtime/src/supervision.ts"))};
import { startProfileBridgePreviewServer } from ${JSON.stringify(resolve(import.meta.dir, "../../../apps/profile-runtime/src/bridge-preview-server.ts"))};
import { startAppOwnedProductResponsesRuntime, loadProductProfileRuntimeConfig } from ${JSON.stringify(resolve(import.meta.dir, "../../development-runtime/src/product-profile.ts"))};
import { bindChatGptTelaAccount } from ${JSON.stringify(resolve(import.meta.dir, "../../development-runtime/src/browser-profile.ts"))};
import { startLocalResponsesServer } from ${JSON.stringify(resolve(import.meta.dir, "../../local-server/src/server.ts"))};
import { MultiProfileControlClient } from ${JSON.stringify(resolve(import.meta.dir, "../../setup/src/multi-profile.ts"))};
const slot = Number(process.env.CHATGPT_TELA_PRODUCT_PROFILE_SLOT);
const account = String(slot).repeat(64);
const ingress = JSON.parse(process.env.FIXTURE_MANAGED_INGRESS).find(item => item.slot === slot);
const targetId = "fixture.managed." + slot;
const config = loadProductProfileRuntimeConfig({ ...process.env,
  CHATGPT_TELA_PROFILE_ROOT: process.env.FIXTURE_PROFILE_ROOT,
  CHATGPT_TELA_PRODUCT_NATIVE_TARGET_KIND: "multi-profile",
  CHATGPT_TELA_PRODUCT_TARGET_ID: targetId,
  CHATGPT_TELA_PRODUCT_LAUNCHER_CLI: process.env.FIXTURE_PLURA_LAUNCHER });
mkdirSync(config.browserProfile.userDataDir, { recursive: true });
bindChatGptTelaAccount(config.browserProfile, account);
const lifecycle = await createProfileSupervisorLifecycle();
const control = new MultiProfileControlClient({ command: [process.env.FIXTURE_PLURA_LAUNCHER], runner: {
  async run(_command, input) {
    if (input.arguments[0] === "targets") return { exitCode: 0, stderr: "", stdout: JSON.stringify({
      contractVersion: 1, targets: [{ id: targetId, displayName: "Fixture " + slot,
      role: "managed", managed: true, state: "available", sessionState: "available",
      sharedAppServerSupported: true, responsesRouteSupported: true,
      modelListOverlaySupported: true, startupModelCatalogSupported: true,
      profileIndex: existsSync(process.env.FIXTURE_FAIL_MARKER) ? slot + 1 : slot }] }) };
    if (input.arguments[0] !== "launch-target") throw Error("Unexpected public Plura operation");
    const args = input.arguments;
    const value = name => args[args.indexOf(name) + 1];
    if (value("--target") !== targetId || input.environment.CHATGPT_TELA_PRODUCT_RESPONSES_TOKEN !== ingress.capability) {
      throw Error("Wrong owner or capability in Plura launch");
    }
    return { exitCode: 0, stderr: "", stdout: JSON.stringify({
      contractVersion: 1, targetID: targetId, state: "ready",
      endpoint: "ws://127.0.0.1:19012",
      responsesRouteFingerprint: createHash("sha256").update(value("--responses-base-url")).digest("hex"),
      modelListOverlayFingerprint: createHash("sha256").update(value("--model-list-overlay-url")).digest("hex"),
    }) };
  },
} });
const starter = async options => {
  const responses = await startLocalResponsesServer({ ...options.responses,
    async requestRouter(request) {
      const route = await options.responses.requestRouter(request);
      if (route) return route;
      const body = await request.json();
      options.completedResults?.(); // Same account scope used by the production supplied gateway.
      return Response.json({ slot, provider: "web", model: body.model });
    } });
  return {
    responses, suppliedToolBridge: { inventory: () => [], async invoke() { throw Error("No fixture tool"); } },
    shutdownReadiness: () => "ready", prepareShutdown() {},
    async prepareChatGptWebSession(input) {
      input.onProfile?.({ account: { accountFingerprint: account,
        accountStructure: "personal", containerFingerprint: "fixture-" + slot } });
      input.onFamilies?.([{ key: "b".repeat(20), label: "Managed Web", availableEfforts: ["medium"] }]);
      input.onConnectorStarting?.(); input.onConnectorProven?.();
      return { families: [{ key: "b".repeat(20), label: "Managed Web", availableEfforts: ["medium"] }] };
    },
    async discoverChatGptWebModelFamilies() {
      return [{ key: "b".repeat(20), label: "Managed Web", availableEfforts: ["medium"] }];
    },
    async stop() { await responses.stop(); },
  };
};
let owned;
let preview;
try {
  owned = await startAppOwnedProductResponsesRuntime({ config, ingress,
    electronStarter: starter, multiProfileClient: control,
    nativeFetch: async request => {
      if (request.headers.get("OpenAI-Organization")) throw Error("Native upstream received profile capability");
      return request.method === "GET"
        ? Response.json({ models: [{ slug: "native-fixture", display_name: "Native", visibility: "list",
          supported_in_api: true, supported_reasoning_levels: [{ effort: "medium", description: "Medium" }] }] })
        : Response.json({ slot, provider: "native" });
    } });
  preview = await startProfileBridgePreviewServer({
    slot, bearerToken: config.uiToken, async observe() { return { activeSurfaceCount: 0 }; },
    webState() { return { contractVersion: 1, slot, webState: "ready", webModelIds: [] }; },
    async waitForWeb() {}, shutdownReadiness: () => owned.shutdownReadiness(),
    async shutdownProfile() {
      await owned.stop();
      return { responsesRouteFingerprint: createHash("sha256").update(owned.responses.baseUrl.href).digest("hex") };
    },
  });
  await lifecycle.publishReady({
    stage: "app-owned-profile-ready", runtimeProcessId: process.pid,
    slot, routeId: config.routeId, targetId, nativeTargetKind: "multi-profile",
    nativeReady: false, webState: "ready", profileId: config.browserProfile.profileId,
    internalMcpUrl: owned.internalMcp.endpointUrl.href,
    bridgePreviewUrl: preview.endpoint.href, responsesUrl: owned.responses.baseUrl.href,
    responsesRouteFingerprint: createHash("sha256").update(owned.responses.baseUrl.href).digest("hex"),
  });
  await lifecycle.shutdownRequested;
} finally {
  await owned?.stop();
  await preview?.close();
  lifecycle.dispose();
}
`);
  const built = await Bun.build({ entrypoints: [child], target: "bun", outdir: root, naming: "managed-child.mjs" });
  expect(built.success).toBe(true);
  const reads: number[] = [];
  const quits: string[] = [];
  const targets = [2, 3].map(slot => ({
    target: { slot, adapterKind: "multi-profile" as const, id: `fixture.managed.${slot}`,
      displayName: `Managed ${slot}`, state: "available", managed: true },
    session: { targetId: `fixture.managed.${slot}`, state: "available" },
  }));
  const adapter: CodexNativeTargetAdapter = {
    kind: "multi-profile",
    async profiles() { return targets; },
    async resolve(slot) { reads.push(slot); const found = targets.find(row => row.target.slot === slot);
      if (!found) throw Error("Unknown fixture target"); return found; },
    async session(targetId) { const found = targets.find(row => row.target.id === targetId);
      if (!found) throw Error("Unknown fixture target"); return found.session; },
    async quit(targetId) { quits.push(targetId); throw Error("App-owned Native quit forbidden"); },
    profileRuntimeEnvironment: () => ({}),
  };
  const service = await startCodexService({
    config: { appOwnedResponses: ingress, multiProfile: { launcherCli: launcher } },
    nativeTargetAdapter: adapter, profileRuntimeCommand: [process.execPath, join(root, "managed-child.mjs")],
    environment: { FIXTURE_MANAGED_INGRESS: JSON.stringify(ingress), FIXTURE_PLURA_LAUNCHER: launcher,
      FIXTURE_PROFILE_ROOT: join(root, "profiles"), FIXTURE_FAIL_MARKER: failMarker },
  });
  try {
    writeFileSync(failMarker, "synthetic wrong profile index");
    await expect(service.startProfile(2)).rejects.toThrow();
    await expect(fetch(`http://127.0.0.1:${ingress[0]!.port}/v1/models`)).rejects.toThrow();
    rmSync(failMarker);
    const first = await service.startProfile(2);
    const second = await service.startProfile(3);
    expect([first.targetId, second.targetId]).toEqual(["fixture.managed.2", "fixture.managed.3"]);
    expect([first.webModelsReady, second.webModelsReady]).toEqual([true, true]);
    const url = (slot: number) => new URL(`http://127.0.0.1:${ingress.find(item => item.slot === slot)!.port}/v1/`);
    const send = async (slot: number, capability: string, model: string) => {
      const response = await fetch(new URL("responses", url(slot)), { method: "POST",
        headers: { "OpenAI-Organization": capability, authorization: "Bearer fixture-native",
          "content-type": "application/json" }, body: JSON.stringify({ model, input: [] }) });
      return { status: response.status, body: await response.json() as { slot?: number; provider?: string } };
    };
    const webModel = "chatgpt-tela-web/family/" + "b".repeat(20);
    for (const slot of [2, 3]) {
      const own = ingress.find(item => item.slot === slot)!;
      const foreign = ingress.find(item => item.slot !== slot)!;
      expect((await send(slot, foreign.capability, webModel)).status).toBe(401);
      expect((await send(slot, own.capability, "native-fixture")).body).toMatchObject({ slot, provider: "native" });
      expect((await send(slot, own.capability, webModel)).body).toMatchObject({ slot, provider: "web" });
      const overlay = new URL("/model-list-overlay", url(slot));
      const native = { contractVersion: 1, result: { models: [{ slug: "native-fixture",
        display_name: "Native", visibility: "list", supported_in_api: true,
        supported_reasoning_levels: [{ effort: "medium", description: "Medium" }] }] } };
      const wrong = await fetch(overlay, { method: "POST",
        headers: { authorization: `Bearer ${foreign.capability}`, "content-type": "application/json" },
        body: JSON.stringify(native) });
      expect(wrong.status).toBe(401);
      const ownOverlay = await fetch(overlay, { method: "POST", headers: {
        authorization: `Bearer ${own.capability}`, "content-type": "application/json",
      }, body: JSON.stringify(native) });
      expect(ownOverlay.status).toBe(200);
      const models = await ownOverlay.json() as { result: { models: { slug: string }[] } };
      expect(models.result.models.map(item => item.slug)).toEqual(["native-fixture", webModel]);
    }
    const profile2 = loadProductProfileRuntimeConfig({
      CHATGPT_TELA_PROFILE_ROOT: join(root, "profiles"),
      CHATGPT_TELA_PRODUCT_PROFILE_SLOT: "2", CHATGPT_TELA_PRODUCT_ROUTE_ID: "fixtureroute2",
      CHATGPT_TELA_PRODUCT_RESPONSES_TOKEN: ingress[0]!.capability,
      CHATGPT_TELA_PRODUCT_INTERNAL_MCP_TOKEN: "m".repeat(48),
      CHATGPT_TELA_PRODUCT_UI_TOKEN: "u".repeat(48),
      CHATGPT_TELA_PRODUCT_NATIVE_TARGET_KIND: "multi-profile",
      CHATGPT_TELA_PRODUCT_TARGET_ID: "fixture.managed.2",
      CHATGPT_TELA_PRODUCT_LAUNCHER_CLI: launcher,
    });
    bindChatGptTelaAccount(profile2.browserProfile, "e".repeat(64));
    const staleCatalog = await fetch(new URL("models", url(2)), {
      headers: { "OpenAI-Organization": ingress[0]!.capability, authorization: "Bearer fixture-native" },
    });
    expect((await staleCatalog.json() as { models: { slug: string }[] }).models.map(item => item.slug))
      .toEqual(["native-fixture"]);
    const nativeCatalog = { contractVersion: 1, result: { data: [{ id: "native", model: "native",
      supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }] }] } };
    const overlayAfterChange = await fetch(new URL("/model-list-overlay", url(2)), { method: "POST",
      headers: { authorization: `Bearer ${ingress[0]!.capability}`, "content-type": "application/json" },
      body: JSON.stringify(nativeCatalog),
    });
    expect((await overlayAfterChange.json() as { result: { data: { model: string }[] } }).result.data
      .map(item => item.model)).toEqual(["native"]);
    expect((await send(2, ingress[0]!.capability, webModel)).status).toBe(502);
    expect((await send(3, ingress[1]!.capability, webModel)).body).toMatchObject({ slot: 3, provider: "web" });
    bindChatGptTelaAccount(profile2.browserProfile, "2".repeat(64));
    expect(await service.shutdownReadiness()).toBe("ready");
    await service.stopProfile(2);
    expect((await send(3, ingress[1]!.capability, webModel)).body).toMatchObject({ slot: 3, provider: "web" });
    await expect(fetch(new URL("models", url(2)))).rejects.toThrow();
    const again = await service.startProfile(2);
    expect(again.responsesRouteFingerprint).toBe(first.responsesRouteFingerprint);
    expect((await send(2, ingress[0]!.capability, webModel)).body).toMatchObject({ slot: 2, provider: "web" });
    await service.stopProfile(3);
    await service.stopProfile(2);
    expect(quits).toEqual([]);
    expect(reads.slice(0, 4)).toEqual([2, 2, 3, 2]);
    expect(new Set(reads)).toEqual(new Set([2, 3]));
  } finally {
    await service.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});
