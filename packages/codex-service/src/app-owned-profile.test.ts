import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startCodexService } from "./controller";
import type { CodexNativeTargetAdapter } from "./native-target";

test("app-owned parent accepts and stops its provider without owning the running Desktop", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-app-owned-parent-"));
  const state = join(root, "state.json");
  writeFileSync(state, JSON.stringify({ busy: false }));
  const portOwner = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 404 }) });
  const ingress = { slot: 1, port: portOwner.port!, capability: "g".repeat(48) };
  await portOwner.stop();
  const child = join(root, "child.ts");
  writeFileSync(child, `
import {readFileSync} from 'node:fs';
import {createProfileSupervisorLifecycle} from ${JSON.stringify(resolve(import.meta.dir, "../../../apps/profile-runtime/src/supervision.ts"))};
import {startProfileBridgePreviewServer} from ${JSON.stringify(resolve(import.meta.dir, "../../../apps/profile-runtime/src/bridge-preview-server.ts"))};
import {startCodexBridgeMcpHttpServer} from ${JSON.stringify(resolve(import.meta.dir, "../../mcp/src/http-server.ts"))};
const slot=1,lifecycle=await createProfileSupervisorLifecycle();
const mcp=await startCodexBridgeMcpHttpServer({bridge:{inventory(){return []},async invoke(){throw Error('unused')}},authentication:{kind:'bearer',token:process.env.CHATGPT_TELA_PRODUCT_INTERNAL_MCP_TOKEN}});
const busy=()=>JSON.parse(readFileSync(process.env.FIXTURE_STATE,'utf8')).busy;
const preview=await startProfileBridgePreviewServer({slot,bearerToken:process.env.CHATGPT_TELA_PRODUCT_UI_TOKEN,
 async observe(){return{activeSurfaceCount:0}},shutdownReadiness(){return busy()?'blocked':'ready'},
 async shutdownProfile(){if(busy())throw Error('active supplied work');return{responsesRouteFingerprint:'a'.repeat(64)}}});
await lifecycle.publishReady({stage:'app-owned-profile-ready',runtimeProcessId:process.pid,slot,
 routeId:process.env.CHATGPT_TELA_PRODUCT_ROUTE_ID,targetId:'default',nativeTargetKind:'default-desktop',
 nativeReady:false,webState:'ready',profileId:'fixture',internalMcpUrl:mcp.endpointUrl.href,
 bridgePreviewUrl:preview.endpoint.href,responsesUrl:process.env.FIXTURE_RESPONSES,responsesRouteFingerprint:'a'.repeat(64)});
await lifecycle.shutdownRequested;await preview.close();await mcp.stop();lifecycle.dispose();
`);
  const built = await Bun.build({ entrypoints: [child], target: "bun", outdir: root, naming: "child.mjs" });
  expect(built.success).toBe(true);
  let nativeCalls = 0;
  const forbidden = async (): Promise<never> => { nativeCalls++; throw Error("Official Desktop is not owned"); };
  const adapter: CodexNativeTargetAdapter = {
    kind: "default-desktop", profiles: async () => [], resolve: forbidden, session: forbidden, quit: forbidden,
    profileRuntimeEnvironment: () => ({ FIXTURE_STATE: state,
      FIXTURE_RESPONSES: `http://127.0.0.1:${ingress.port}/${ingress.capability}/v1/` }),
  };
  const service = await startCodexService({ config: { appOwnedResponses: [ingress] },
    nativeTargetAdapter: adapter, profileRuntimeCommand: [process.execPath, join(root, "child.mjs")] });
  try {
    expect(await service.startProfile(1)).toMatchObject({ controlState: "running", webModelsReady: true });
    expect(await service.profiles()).toContainEqual(expect.objectContaining({ slot: 1, controlState: "running" }));
    expect(await service.shutdownReadiness()).toBe("ready");
    writeFileSync(state, JSON.stringify({ busy: true }));
    expect(await service.shutdownReadiness()).toBe("blocked");
    await expect(service.stopProfile(1)).rejects.toThrow("not acknowledged");
    writeFileSync(state, JSON.stringify({ busy: false }));
    expect(await service.stopProfile(1)).toMatchObject({ controlState: "stopped" });
    expect(nativeCalls).toBe(0);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});
