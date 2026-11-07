import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, watch, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chatGptWebFamilyKey, chatGptWebModelId } from "@chatgpt-tela/chatgpt";
import { startCodexService } from "./controller";
import type { CodexNativeTargetAdapter } from "./native-target";
import { RoutedCodexTurnBridge } from "./routed-turn-bridge";

test("app-owned parent restarts an idle provider on its fixed Responses route without owning the Desktop", async () => {
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
 async observe(){return{activeSurfaceCount:0}},webState(){return{contractVersion:1,slot,webState:'ready',webModelIds:['chatgpt-tela-web/fixture']}},
 async waitForWeb(){},shutdownReadiness(){return busy()?'blocked':'ready'},
 async shutdownProfile(){if(busy())throw Error('active supplied work');return{responsesRouteFingerprint:'a'.repeat(64)}}});
await lifecycle.publishReady({stage:'app-owned-profile-ready',runtimeProcessId:process.pid,slot,
 routeId:process.env.CHATGPT_TELA_PRODUCT_ROUTE_ID,targetId:'default',nativeTargetKind:'default-desktop',
 nativeReady:false,webState:'ready',profileId:'fixture',internalMcpUrl:mcp.endpointUrl.href,
 bridgePreviewUrl:preview.endpoint.href,responsesUrl:process.env.FIXTURE_RESPONSES,responsesRouteFingerprint:'a'.repeat(64)});
await lifecycle.shutdownRequested;await preview.close();await mcp.stop();lifecycle.dispose();
`);
  const built = await Bun.build({ entrypoints: [child], target: "bun", outdir: root, naming: "child.mjs" });
  expect(built.success).toBe(true);
  let nativeCalls = 0, delegationCalls = 0;
  const forbidden = async (): Promise<never> => { nativeCalls++; throw Error("Official Desktop is not owned"); };
  const adapter: CodexNativeTargetAdapter = {
    kind: "default-desktop", profiles: forbidden, resolve: forbidden, session: forbidden, quit: forbidden,
    profileRuntimeEnvironment: () => ({ FIXTURE_STATE: state,
      FIXTURE_RESPONSES: `http://127.0.0.1:${ingress.port}/${ingress.capability}/v1/` }),
  };
  const service = await startCodexService({ config: { appOwnedResponses: [ingress] },
    nativeTargetAdapter: adapter, profileRuntimeCommand: [process.execPath, join(root, "child.mjs")],
    webDelegationCapacity: async () => { delegationCalls++; return { total: { used: 1 }, uncertain: 1 }; } });
  const routed = service.tools as RoutedCodexTurnBridge;
  try {
    const first = await service.startProfile(1);
    expect(first).toMatchObject({ controlState: "running", webModelsReady: true,
      responsesRouteFingerprint: "a".repeat(64) });
    expect(routed.routeCount).toBe(1);
    expect(await service.profiles()).toContainEqual(expect.objectContaining({ slot: 1, controlState: "running" }));
    expect(await service.waitWebPreparation(1)).toMatchObject({ webState: "ready", webModelsReady: true });
    expect((await service.profiles())[0]).toMatchObject({ webModelsReady: true });
    expect(await service.shutdownReadiness()).toBe("ready");
    await service.waitForShutdownReadiness();
    writeFileSync(state, JSON.stringify({ busy: true }));
    expect(await service.shutdownReadiness()).toBe("blocked");
    await expect(service.stopProfile(1)).rejects.toThrow("not acknowledged");
    writeFileSync(state, JSON.stringify({ busy: false }));
    expect(await service.stopProfile(1)).toMatchObject({ controlState: "stopped" });
    expect(routed.routeCount).toBe(0);
    const restarted = await service.startProfile(1);
    expect(restarted).toMatchObject({ slot: 1, controlState: "running", webModelsReady: true,
      responsesRouteFingerprint: first.responsesRouteFingerprint });
    expect(restarted.childProcessId).not.toBe(first.childProcessId);
    expect(routed.routeCount).toBe(1);
    expect(await service.waitWebPreparation(1)).toMatchObject({ webState: "ready", webModelsReady: true });
    expect(await service.shutdownReadiness()).toBe("ready");
    expect(await service.stopProfile(1)).toMatchObject({ controlState: "stopped" });
    expect(routed.routeCount).toBe(0);
    expect(nativeCalls).toBe(0);
    expect(delegationCalls).toBe(0);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test("app-owned primary keeps managed optional profiles in the inventory", async () => {
  const ingress = { slot: 1, port: 48231, capability: "g".repeat(48) };
  const target = { slot: 2, adapterKind: "multi-profile" as const, id: "profile-2",
    displayName: "Managed Profile 2", state: "available", managed: true };
  const session = { targetId: target.id, state: "available" };
  let profileReads = 0;
  const forbidden = async (): Promise<never> => { throw Error("Native route not requested"); };
  const adapter: CodexNativeTargetAdapter = {
    kind: "composite",
    async profiles() { profileReads++; return [{ target, session }]; },
    resolve: forbidden, session: forbidden, quit: forbidden, profileRuntimeEnvironment: () => ({}),
  };
  const service = await startCodexService({
    config: { appOwnedResponses: [ingress], multiProfile: { launcherCli: "unused" } },
    nativeTargetAdapter: adapter, profileRuntimeCommand: ["unused"],
  });
  try {
    expect((await service.profiles()).map(profile => [profile.slot, profile.controlState]))
      .toEqual([[2, "stopped"], [1, "stopped"]]);
    expect(profileReads).toBe(1);
  } finally { await service.close(); }
});

test("app-owned assembly preserves an unobserved host tool answer across child restart and account isolation", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-app-owned-assembly-"));
  const accountFile = join(root, "fixture-account");
  const auditFile = join(root, "fixture-audit.jsonl");
  const releaseFile = join(root, "release-final");
  const accountA = "a".repeat(64), accountB = "b".repeat(64);
  writeFileSync(accountFile, accountA);
  writeFileSync(auditFile, "");
  const freePort = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 404 }) });
  const ingress = { slot: 1, port: freePort.port!, capability: "f".repeat(48) };
  await freePort.stop();

  const child = join(root, "assembly-child.ts");
  writeFileSync(child, `
import {appendFileSync, existsSync, mkdirSync, readFileSync, watch} from "node:fs";
import {createHash} from "node:crypto";
import {resolve, join} from "node:path";
import {Client} from ${JSON.stringify(resolve(import.meta.dir, "../../development-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js"))};
import {StreamableHTTPClientTransport} from ${JSON.stringify(resolve(import.meta.dir, "../../development-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js"))};
import {startAppOwnedProductResponsesRuntime, loadProductProfileRuntimeConfig} from ${JSON.stringify(resolve(import.meta.dir, "../../../packages/development-runtime/src/product-profile.ts"))};
import {bindChatGptTelaAccount} from ${JSON.stringify(resolve(import.meta.dir, "../../../packages/development-runtime/src/browser-profile.ts"))};
import {createSuppliedRequestGateway} from ${JSON.stringify(resolve(import.meta.dir, "../../../packages/development-runtime/src/supplied-request-gateway.ts"))};
import {startLocalResponsesServer} from ${JSON.stringify(resolve(import.meta.dir, "../../../packages/local-server/src/server.ts"))};
import {chatGptWebFamilyKey} from ${JSON.stringify(resolve(import.meta.dir, "../../../packages/chatgpt/src/index.ts"))};
import {createProfileSupervisorLifecycle} from ${JSON.stringify(resolve(import.meta.dir, "../../../apps/profile-runtime/src/supervision.ts"))};
import {startProfileBridgePreviewServer} from ${JSON.stringify(resolve(import.meta.dir, "../../../apps/profile-runtime/src/bridge-preview-server.ts"))};

const root=process.env.FIXTURE_ASSEMBLY_ROOT;
const account=readFileSync(join(root,"fixture-account"),"utf8").trim();
const config=loadProductProfileRuntimeConfig(process.env);
mkdirSync(config.browserProfile.userDataDir,{recursive:true});
bindChatGptTelaAccount(config.browserProfile,account);
const ingress={port:Number(process.env.FIXTURE_INGRESS_PORT),capability:process.env.FIXTURE_INGRESS_CAPABILITY};
const log=(event,extra={})=>appendFileSync(join(root,"fixture-audit.jsonl"),JSON.stringify({event,account,...extra})+"\\n");
const lifecycle=await createProfileSupervisorLifecycle();
const family={key:chatGptWebFamilyKey("Assembly fixture"),label:"Assembly fixture",availableEfforts:["medium"]};
let goalControl="", owned;
const provider={
  async submitTurn(_surface,turn) {
    goalControl=turn.chatTools.nativeGoalControl;
    log("submitted",{capability:goalControl});
    return {state:"proven",evidence:["fixture"],value:{nativeTaskId:turn.nativeTaskId,nativeTurnId:turn.nativeTurnId,
      webEpochId:turn.webEpochId,providerTurnId:"assembly-web"}};
  },
  async armToolContinuation(_surface,handle,callId) {
    return {state:"proven",evidence:["fixture"],value:{providerTurnId:handle.providerTurnId,callId}};
  },
  async waitForTurnEvent(_surface,handle) {
    const client=new Client({name:"assembly-fixture",version:"1.0.0"});
    await client.connect(new StreamableHTTPClientTransport(owned.internalMcp.endpointUrl,{
      requestInit:{headers:{authorization:"Bearer "+config.internalMcpToken}}}));
    let result;
    try {
      result=await client.callTool({name:"chatgpt_tela_codex_tool_call",arguments:{
        turn_capability:goalControl,call_id:"assembly-get-goal",wire_name:"get_goal",mode:"structured",arguments:{}}});
    } finally {await client.close();}
    if(result.isError||!JSON.stringify(result).includes("paused")) throw Error("host tool result did not return");
    log("tool-returned");
    if(account==="a".repeat(64)&&!existsSync(join(root,"release-final"))) {
      await new Promise(resolve=>{
        const observer=watch(root,()=>{if(existsSync(join(root,"release-final"))){observer.close();resolve();}});
        if(existsSync(join(root,"release-final"))){observer.close();resolve();}
      });
    }
    return {state:"proven",evidence:["fixture"],value:{kind:"completed",providerTurnId:handle.providerTurnId,
      answer:account==="a".repeat(64)?"Assembly A complete.":"Assembly B complete."}};
  },
};
const host={async acquire({taskId,epochId}){return{taskId,epochId,leaseId:"assembly-surface",
  async navigate(){},async reveal(){},async hide(){},capability(){}};},async release(){},async close(){}};
const starter=async options=>{
  const gateway=createSuppliedRequestGateway({browserHost:host,provider,routeId:options.routeId,
    profileSlot:options.profileSlot,completedResults:options.completedResults,async prepareForSubmit(){}});
  const responses=await startLocalResponsesServer({...options.responses,gateway});
  return {responses,suppliedToolBridge:gateway.toolBridge,shutdownReadiness:()=>gateway.shutdownReadiness(),
    prepareShutdown:()=>gateway.prepareShutdown(),
    async prepareChatGptWebSession(input){
      input.onProfile?.({account:{accountFingerprint:account,accountStructure:"personal",containerFingerprint:"fixture"}});
      input.onFamilies?.([family]);input.onConnectorStarting?.();input.onConnectorProven?.();
      return{families:[family]};
    },
    async discoverChatGptWebModelFamilies(){return[family];},
    async stop(){await responses.stop();await gateway.close();}
  };
};
owned=await startAppOwnedProductResponsesRuntime({config,ingress,electronStarter:starter,
  nativeFetch:async()=>Response.json({models:[]}),signal:lifecycle.signal});
const unauthorized=await fetch(owned.internalMcp.endpointUrl);
if(unauthorized.status!==401)throw Error("internal MCP accepted an anonymous request");
const preview=await startProfileBridgePreviewServer({slot:config.slot,bearerToken:config.uiToken,
  async observe(){return{activeSurfaceCount:0}},
  webState(){return{contractVersion:1,slot:config.slot,webState:"ready",webModelIds:["chatgpt-tela-web/assembly"]}},
  async waitForWeb(){},
  shutdownReadiness:()=>owned.shutdownReadiness(),
  async shutdownProfile(){
    if(owned.shutdownReadiness()!=="ready")throw Error("active supplied work");
    await owned.stop();
    return{responsesRouteFingerprint:createHash("sha256").update(owned.responses.baseUrl.href).digest("hex")};
  },
});
const fingerprint=createHash("sha256").update(owned.responses.baseUrl.href).digest("hex");
log("ready",{mcpUrl:owned.internalMcp.endpointUrl.href,
  journalFile:resolve(config.browserProfile.userDataDir,"native-visible-prefix-executions",account,"state.json")});
await lifecycle.publishReady({stage:"app-owned-profile-ready",runtimeProcessId:process.pid,
  slot:config.slot,routeId:config.routeId,targetId:"default",nativeTargetKind:"default-desktop",
  nativeReady:false,webState:"ready",profileId:config.browserProfile.profileId,
  internalMcpUrl:owned.internalMcp.endpointUrl.href,bridgePreviewUrl:preview.endpoint.href,
  responsesUrl:owned.responses.baseUrl.href,responsesRouteFingerprint:fingerprint});
await lifecycle.shutdownRequested;
await preview.close();lifecycle.dispose();
`);

  const built = await Bun.build({ entrypoints: [child], target: "bun", outdir: root, naming: "assembly-child.mjs" });
  expect(built.success).toBe(true);
  let nativeCalls = 0, managedDelegations = 0;
  const forbidden = async (): Promise<never> => { nativeCalls++; throw Error("Official Desktop is not owned"); };
  const adapter: CodexNativeTargetAdapter = {
    kind: "default-desktop", profiles: forbidden, resolve: forbidden, session: forbidden, quit: forbidden,
    profileRuntimeEnvironment: () => ({}),
  };
  const service = await startCodexService({
    config: { appOwnedResponses: [ingress] },
    nativeTargetAdapter: adapter,
    profileRuntimeCommand: [process.execPath, join(root, "assembly-child.mjs")],
    environment: {
      CHATGPT_TELA_PROFILE_ROOT: join(root, "profiles"),
      FIXTURE_ASSEMBLY_ROOT: root,
      FIXTURE_INGRESS_PORT: String(ingress.port),
      FIXTURE_INGRESS_CAPABILITY: ingress.capability,
    },
    webDelegationCapacity: async () => { managedDelegations++; return { total: { used: 1 }, uncertain: 1 }; },
  });
  const route = new URL("http://127.0.0.1:" + ingress.port + "/" + ingress.capability + "/v1/responses");
  const body = { model: chatGptWebModelId(chatGptWebFamilyKey("Assembly fixture")),
    stream: false, reasoning: { effort: "medium" },
    client_metadata: { "x-codex-turn-metadata": { request_kind: "turn",
      thread_id: "assembly-thread", turn_id: "assembly-turn" } },
    tools: [{ type: "function", name: "get_goal", parameters: { type: "object" } }],
    input: [{ role: "user", content: "Return the synthetic host result." }],
  };
  const post = async (value: unknown, signal?: AbortSignal): Promise<any> => {
    const response = await fetch(route, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(value),
      ...(signal ? { signal } : {}) });
    return response.json();
  };
  const events = () => readFileSync(auditFile, "utf8").trim().split("\n").filter(Boolean)
    .map(line => JSON.parse(line) as { event: string; account: string; capability?: string; mcpUrl?: string; journalFile?: string });
  const untilFile = (path: string, matches: () => boolean): Promise<void> => new Promise(resolve => {
    const observer = watch(path, () => { if (matches()) { observer.close(); resolve(); } });
    if (matches()) { observer.close(); resolve(); }
  });
  const submitted = () => events().filter(item => item.event === "submitted");
  const readiness = () => events().filter(item => item.event === "ready").at(-1)!;
  const routed = service.tools as RoutedCodexTurnBridge;
  let running = false;
  try {
    const first = await service.startProfile(1);
    running = true;
    expect(first).toMatchObject({ controlState: "running", webModelsReady: true });
    expect(routed.routeCount).toBe(1);
    expect((await fetch(new URL("http://127.0.0.1:" + ingress.port + "/wrong/v1/models"))).status).toBe(401);
    const toolCall = await post(body);
    expect(toolCall.output[0]).toMatchObject({ type: "function_call", name: "get_goal", call_id: "assembly-get-goal" });
    const control = submitted().at(-1)!.capability!;
    expect((await service.tools.inventory(control)).some(tool => tool.wireName === "get_goal")).toBe(true);
    expect(await service.shutdownReadiness()).toBe("blocked");
    await expect(service.stopProfile(1)).rejects.toThrow("not acknowledged");

    const exact = { ...body, input: [...body.input, toolCall.output[0],
      { type: "function_call_output", call_id: "assembly-get-goal", output: '{"status":"paused"}' }] };
    const observer = new AbortController();
    const dropped = post(exact, observer.signal);
    await untilFile(root, () => events().some(item => item.event === "tool-returned"));
    observer.abort(); // The final frame never reaches this HTTP observer.
    await dropped.catch(() => undefined);
    const journal = readiness().journalFile!;
    const durablySaved = untilFile(journal, () => {
      try {
        const bytes = readFileSync(journal, "utf8");
        return bytes.startsWith("=") && (JSON.parse(bytes.slice(1)).suppliedResults as any[])
          ?.some(item => item.turnId === "assembly-turn" && item.answer === "Assembly A complete.");
      } catch { return false; }
    });
    writeFileSync(releaseFile, "continue");
    await durablySaved;
    expect(await service.shutdownReadiness()).toBe("ready");
    const fixedRoute = new URL("http://127.0.0.1:" + ingress.port + "/" + ingress.capability + "/v1/").href;
    expect(first.responsesRouteFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const firstMcp = readiness().mcpUrl!;
    await service.stopProfile(1);
    running = false;
    expect(routed.routeCount).toBe(0);
    await expect(service.tools.inventory(control)).rejects.toThrow("inactive");
    await expect(fetch(firstMcp)).rejects.toThrow();

    const second = await service.startProfile(1);
    running = true;
    expect(second.childProcessId).not.toBe(first.childProcessId);
    expect(second.responsesRouteFingerprint).toBe(first.responsesRouteFingerprint);
    expect(route.href.startsWith(fixedRoute)).toBe(true);
    const recovered = await post(exact);
    expect(JSON.stringify(recovered)).toContain("Assembly A complete.");
    expect(submitted()).toHaveLength(1); // Recovery must not submit to the model.
    expect(await service.shutdownReadiness()).toBe("ready");
    await service.stopProfile(1);
    running = false;
    expect(routed.routeCount).toBe(0);

    writeFileSync(accountFile, accountB);
    await service.startProfile(1);
    running = true;
    const foreign = await post(body);
    expect(foreign.output[0]).toMatchObject({ type: "function_call", name: "get_goal" });
    const foreignFinal = await post({ ...body, input: [...body.input, foreign.output[0],
      { type: "function_call_output", call_id: "assembly-get-goal", output: '{"status":"paused"}' }] });
    expect(JSON.stringify(foreignFinal)).toContain("Assembly B complete.");
    expect(submitted().map(item => item.account)).toEqual([accountA, accountB]);
    await service.stopProfile(1);
    running = false;
    expect(routed.routeCount).toBe(0);

    writeFileSync(accountFile, accountA);
    await service.startProfile(1);
    running = true;
    expect(JSON.stringify(await post(exact))).toContain("Assembly A complete.");
    expect(submitted()).toHaveLength(2);
    await service.stopProfile(1);
    running = false;
    expect(nativeCalls).toBe(0);
    expect(managedDelegations).toBe(0);
  } finally {
    if (running) await service.close().catch(() => {});
    else await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
