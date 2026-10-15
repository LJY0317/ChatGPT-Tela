import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startCodexService } from "./controller";
import type { CodexNativeTargetAdapter } from "./native-target";

test("refused default Desktop cleanup keeps authenticated child, route and service until explicit successful stop", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-stop-receipt-")), state = join(root, "stop.json");
  writeFileSync(state, JSON.stringify({ refuse: true }));
  let active = false, closes = 0, parentQuits = 0;
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { closes++; active = false; return new Response(null, { status: 204 }); } });
  const supervision = resolve(import.meta.dir, "../../../apps/profile-runtime/src/supervision.ts");
  const preview = resolve(import.meta.dir, "../../../apps/profile-runtime/src/bridge-preview-server.ts");
  const mcp = resolve(import.meta.dir, "../../mcp/src/http-server.ts");
  const child = join(root, "child.ts");
  writeFileSync(child, `import {readFileSync} from 'node:fs';
import {createProfileSupervisorLifecycle} from ${JSON.stringify(supervision)};
import {startProfileBridgePreviewServer} from ${JSON.stringify(preview)};
import {startCodexBridgeMcpHttpServer} from ${JSON.stringify(mcp)};
const lifecycle=await createProfileSupervisorLifecycle();
const mcp=await startCodexBridgeMcpHttpServer({bridge:{inventory(){return []},async invoke(){throw Error('unused')}},authentication:{kind:'bearer',token:process.env.CHATGPT_TELA_PRODUCT_INTERNAL_MCP_TOKEN}});
const preview=await startProfileBridgePreviewServer({slot:1,bearerToken:process.env.CHATGPT_TELA_PRODUCT_UI_TOKEN,async observe(){return{activeSurfaceCount:0}},async shutdownProfile(){if(JSON.parse(readFileSync(process.env.FIXTURE_STATE,'utf8')).refuse)throw Error('synthetic normal quit refusal');await fetch(process.env.FIXTURE_CLOSED);return{responsesRouteFingerprint:'a'.repeat(64)}}});
await lifecycle.publishReady({stage:'product-profile-ready',runtimeProcessId:process.pid,slot:1,routeId:process.env.CHATGPT_TELA_PRODUCT_ROUTE_ID,targetId:'default',nativeTargetKind:'default-desktop',targetProcessId:123,nativeReady:true,webState:'preparing',profileId:'fixture',internalMcpUrl:mcp.endpointUrl.href,bridgePreviewUrl:preview.endpoint.href,terminalEndpoint:'ws://127.0.0.1:1234/',responsesUrl:'http://127.0.0.1:1234/',responsesRouteFingerprint:'a'.repeat(64)});
await lifecycle.shutdownRequested;await preview.close();await mcp.stop();lifecycle.dispose();`);
  const built = await Bun.build({ entrypoints: [child], target: "bun", outdir: root, naming: "child.mjs" });
  expect(built.success).toBe(true);
  const target = { slot: 1, adapterKind: "default-desktop" as const, id: "default", displayName: "Fixture", state: "stopped", managed: true };
  const session = () => ({ targetId: "default", state: active ? "ready" : "available", ...(active ? { desktopProcessId: 123 } : {}) });
  const adapter: CodexNativeTargetAdapter = {
    kind: "default-desktop", async profiles() { return [{ target, session: session() }]; },
    async resolve() { return { target, session: session() }; }, async session() { return session(); },
    async quit() { parentQuits++; active = false; return session(); },
    profileRuntimeEnvironment() { active = true; return { FIXTURE_STATE: state, FIXTURE_CLOSED: closed.url.href }; },
  };
  const service = await startCodexService({ config: {}, profileRuntimeCommand: [process.execPath, join(root, "child.mjs")], nativeTargetAdapter: adapter });
  try {
    const started = await service.startProfile(1);
    await expect(service.close()).rejects.toThrow("normally stop");
    expect(service.activeProfileCount).toBe(1); expect(active).toBe(true); expect(closes).toBe(0); expect(parentQuits).toBe(0);
    expect((await service.profiles())[0]?.controlState).toBe("running");
    expect((await service.profiles())[0]?.childProcessId).toBe(started.childProcessId);
    expect((await service.terminalSession(1)).endpoint).toBe("ws://127.0.0.1:1234/");
    writeFileSync(state, JSON.stringify({ refuse: false }));
    await service.close();
    expect(service.activeProfileCount).toBe(0); expect(active).toBe(false); expect(closes).toBe(1); expect(parentQuits).toBe(0);

    // Reuse the real harmless child to reproduce a start admitted before close,
    // but publishing its owner after close's original snapshot would have run.
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const admission = new Promise<void>(resolve => { entered = resolve; });
    let first = true;
    const late = await startCodexService({ config: {}, profileRuntimeCommand: [process.execPath, join(root, "child.mjs")],
      nativeTargetAdapter: { ...adapter, async resolve() {
        if (first) { first = false; entered(); await blocked; }
        return { target, session: session() };
      } } });
    const starting = late.startProfile(1);
    await admission;
    let acknowledged = false;
    const closing = late.close().then(() => { acknowledged = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(acknowledged).toBe(false);
      await expect(late.startProfile(1)).rejects.toThrow("stopping");
      release();
      await starting;
      await closing;
      expect(late.activeProfileCount).toBe(0);
      expect(active).toBe(false); expect(closes).toBe(2);
    } finally {
      release();
      await starting.catch(() => {});
      await closing.catch(() => {});
      await late.close();
    }
  } finally {
    writeFileSync(state, JSON.stringify({ refuse: false }));
    await service.close(); await closed.stop(true); rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
