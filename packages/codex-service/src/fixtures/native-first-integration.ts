import { expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startCodexService } from "../controller";
import type { CodexNativeTargetAdapter } from "../native-target";

async function verify() {
  const root = mkdtempSync(join(tmpdir(), "tela-native-service-"));
  const child = join(root, "child.ts");
  // Owned child and authenticated MCP/control transport are real. OS lifecycle and model server
  // are fixtures: no Desktop, OS registration, real account, private state or generation is used.
  writeFileSync(child, `
import { startCodexBridgeMcpHttpServer } from ${JSON.stringify(resolve("packages/mcp/src/http-server.ts"))};
import { createProfileSupervisorLifecycle } from ${JSON.stringify(resolve("apps/profile-runtime/src/supervision.ts"))};
const lifecycle = await createProfileSupervisorLifecycle();
const mcp = await startCodexBridgeMcpHttpServer({bridge:{inventory(){return []},async invoke(){throw new Error('unused')}},authentication:{kind:'bearer',token:process.env.CHATGPT_TELA_PRODUCT_INTERNAL_MCP_TOKEN}});
const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch(){return new Response(null,{status:404})}});
await lifecycle.publishReady({stage:'product-profile-ready',runtimeProcessId:process.pid,slot:1,routeId:process.env.CHATGPT_TELA_PRODUCT_ROUTE_ID,targetId:'fixture',nativeTargetKind:'multi-profile',nativeReady:true,webState:'preparing',profileId:'fixture',internalMcpUrl:mcp.endpointUrl.href,bridgePreviewUrl:process.env.FIXTURE_CONTROL_URL,terminalEndpoint:process.env.FIXTURE_RPC_URL,responsesUrl:server.url.href,responsesRouteFingerprint:'a'.repeat(64)});
await lifecycle.shutdownRequested;await mcp.stop();await server.stop(true);lifecycle.dispose();
`);
  let state = "preparing";
  let release!: () => void;
  const webGate = new Promise<void>(r => { release = r; });
  let waits = 0, retries = 0, quits = 0, active = false;
  const model = "chatgpt-tela-web/fixture";
  const control = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/v1/web-reconnect") { retries++; state = "ready"; }
    else if (url.pathname !== "/v1/web-state") return new Response(null, { status: 404 });
    if (url.searchParams.has("wait")) { waits++; await webGate; }
    return Response.json({ contractVersion: 1, slot: 1, webState: state, webModelIds: state === "ready" ? [model] : [] });
  } });
  const methods: string[] = [];
  const rpc = Bun.serve({hostname:"127.0.0.1",port:0,fetch(request, server) {
    return server.upgrade(request) ? undefined : new Response(null, {status:400});
  },websocket:{message(socket, data) {
    const request = JSON.parse(String(data));
    methods.push(request.method);
    if (request.id !== undefined) socket.send(JSON.stringify({id:request.id,result:request.method === "model/list" ? {data:[{model,hidden:false}],nextCursor:null} : {}}));
  }}});
  const target = {slot:1,adapterKind:"multi-profile" as const,id:"fixture",displayName:"Fixture",state:"stopped",managed:true};
  const session = () => ({targetId:"fixture",state:active?"ready":"available",...(active?{responsesRouteFingerprint:"a".repeat(64)}:{})});
  const adapter: CodexNativeTargetAdapter = {
    kind:"multi-profile",async profiles(){return [{target,session:session()}]},async resolve(){return {target,session:session()}},
    async session(){return session()},async quit(){quits++;active=false;return session()},
    profileRuntimeEnvironment(){active=true;return {FIXTURE_CONTROL_URL:control.url.href,FIXTURE_RPC_URL:`ws://127.0.0.1:${rpc.port}/`}},
  };
  const built = await Bun.build({entrypoints:[child],target:"bun",outdir:root,naming:"child.mjs"});
  expect(built.success).toBe(true);
  const service = await startCodexService({config:{},nativeTargetAdapter:adapter,profileRuntimeCommand:[process.execPath,join(root,"child.mjs")]});
  try {
    const native = await service.startProfile(1);
    expect(native.controlState).toBe("running"); expect(native.webState).toBe("preparing"); expect(native.webModelsReady).toBe(false);
    expect(waits).toBe(0); expect(service.activeProfileCount).toBe(1);
    const waiting = service.waitWebPreparation(1);
    state = "failed"; release();
    const failed = await waiting;
    expect(failed.controlState).toBe("running"); expect(failed.webState).toBe("failed"); expect(failed.webModelsReady).toBe(false);
    const recovered = await service.reconnectWeb(1);
    expect(recovered.webState).toBe("ready"); expect(recovered.webModelsReady).toBe(true);
    expect(recovered.childProcessId).toBe(native.childProcessId); expect(quits).toBe(0); expect(retries).toBe(1);
    expect(methods).toContain("model/list"); expect(methods).not.toContain("config/read");
    await service.close(); expect(quits).toBe(1);
  } finally {
    release(); await service.close(); await control.stop(true); await rpc.stop(true); rmSync(root,{recursive:true,force:true});
  }
}
await verify();
console.log(JSON.stringify({ nativeFirstServiceLifecycle: true }));
