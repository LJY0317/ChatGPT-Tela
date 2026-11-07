import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, watch, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { chatGptWebFamilyKey, chatGptWebModelId } from "@chatgpt-tela/chatgpt";
import { startCodexService } from "./controller";
import type { CodexNativeTargetAdapter } from "./native-target";
import { RoutedCodexTurnBridge } from "./routed-turn-bridge";
import { startAppOwnedProductResponsesRuntime, loadProductProfileRuntimeConfig } from "../../development-runtime/src/product-profile";
import { bindChatGptTelaAccount } from "../../development-runtime/src/browser-profile";
import { createSuppliedRequestGateway } from "../../development-runtime/src/supplied-request-gateway";
import { startLocalResponsesServer } from "../../local-server/src/server";
import { encodeNativeResponsesOutcome, nativeResponsesSsePlan } from "@chatgpt-tela/responses";

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

// Opt-in: use the unmodified official Desktop-bundled engine against only isolated
// configuration and the same production app-owned Responses router as the child.
const officialEngine = process.env.TELA_OFFICIAL_ENGINE;
test.skipIf(!officialEngine)("official engine selects Web then original Native tools in one thread through app-owned assembly", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-official-app-owned-"));
  const home = join(root, "codex-home");
  const nativeModel = "fixture-native";
  const family = chatGptWebFamilyKey("Official assembly");
  const webModel = chatGptWebModelId(family);
  const marker = "TELA_NATIVE_ORIGINAL_TOOL_OK";
  const nativeEntry = {
    slug: nativeModel, display_name: "Fixture Native", description: "Isolated native model",
    visibility: "list", supported_in_api: true, default_reasoning_level: "medium",
    supported_reasoning_levels: [{ effort: "medium", description: "Medium" }],
    input_modalities: ["text"], tool_mode: "direct", context_window: 128000,
    shell_type: "shell_command", priority: 1, support_verbosity: false,
    truncation_policy: { mode: "tokens", limit: 10000 },
    experimental_supported_tools: [], base_instructions: "Run only isolated fixture instructions.",
  };
  const ingressPort = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 404 }) });
  const ingress = { port: ingressPort.port!, capability: "p".repeat(48) };
  await ingressPort.stop();
  const config = loadProductProfileRuntimeConfig({
    CHATGPT_TELA_PROFILE_ROOT: join(root, "profiles"),
    CHATGPT_TELA_PRODUCT_PROFILE_SLOT: "1",
    CHATGPT_TELA_PRODUCT_ROUTE_ID: "officialfixture",
    CHATGPT_TELA_PRODUCT_RESPONSES_TOKEN: "r".repeat(48),
    CHATGPT_TELA_PRODUCT_INTERNAL_MCP_TOKEN: "m".repeat(48),
    CHATGPT_TELA_PRODUCT_UI_TOKEN: "u".repeat(48),
  });
  mkdirSync(home, { recursive: true });
  mkdirSync(config.browserProfile.userDataDir, { recursive: true });
  bindChatGptTelaAccount(config.browserProfile, "a".repeat(64));
  const webRequests: any[] = [], nativeRequests: any[] = [];
  let nativeCatalogReads = 0;
  let nativeCatalogUnavailable = false;
  const provider = {
    async submitTurn(_surface: unknown, turn: any) {
      webRequests.push({ turnId: turn.nativeTurnId, tools: turn.chatTools });
      return { state: "proven", evidence: ["fixture"], value: { nativeTaskId: turn.nativeTaskId,
        nativeTurnId: turn.nativeTurnId, webEpochId: turn.webEpochId, providerTurnId: "web-fixture" } };
    },
    async waitForTurnEvent(_surface: unknown, handle: any) {
      return { state: "proven", evidence: ["fixture"], value: {
        kind: "completed", providerTurnId: handle.providerTurnId, answer: "Web selection completed." } };
    },
  } as any;
  const host = { async acquire({ taskId, epochId }: any) {
    return { taskId, epochId, leaseId: "official-assembly", async navigate() {},
      async reveal() {}, async hide() {}, capability() {} };
  }, async release() {}, async close() {} } as any;
  const nativeFetch = async (request: Request): Promise<Response> => {
    expect(request.headers.get("authorization")).toBe("Bearer isolated-fixture-only");
    if (request.method === "GET") {
      nativeCatalogReads++;
      if (nativeCatalogUnavailable) return Response.json({ error: "isolated catalog unavailable" }, { status: 503 });
      return Response.json({ models: [nativeEntry] });
    }
    const body = await request.json() as any;
    nativeRequests.push(body);
    expect(body.model).toBe(nativeModel);
    const items = (body.input ?? []).flatMap((item: any) => item.type === "additional_tools" ? item.tools ?? [] : []);
    const flattened = [...(body.tools ?? []), ...items].flatMap((item: any) =>
      item.type === "namespace" ? item.tools ?? [] : [item]);
    expect(flattened.some((item: any) => item.name === "exec_command")).toBe(true);
    const matched = (body.input ?? []).some((item: any) =>
      item.type === "function_call_output" && item.call_id === "native-exec" &&
      typeof item.output === "string" && item.output.includes(marker));
    const outcome = matched
      ? { type: "final" as const, answer: "Native original tool completed.",
        delivery: { capability: "fixture-native" } }
      : { type: "tool-call" as const, item: { type: "function_call" as const,
        name: "exec_command", call_id: "native-exec",
        arguments: JSON.stringify({ cmd: `printf ${marker}`, workdir: root, login: false }) },
        delivery: { capability: "fixture-native", callId: "native-exec" } };
    const encoded = encodeNativeResponsesOutcome({ outcome, model: nativeModel });
    return new Response(nativeResponsesSsePlan(outcome, encoded).frames.join(""),
      { headers: { "content-type": "text/event-stream" } });
  };
  const starter = (async (options: any) => {
    const gateway = createSuppliedRequestGateway({ browserHost: host, provider,
      routeId: options.routeId, profileSlot: options.profileSlot,
      completedResults: options.completedResults, async prepareForSubmit() {} });
    const responses = await startLocalResponsesServer({ ...options.responses, gateway });
    return { responses, suppliedToolBridge: gateway.toolBridge,
      shutdownReadiness: () => gateway.shutdownReadiness(),
      prepareShutdown: () => gateway.prepareShutdown(),
      async prepareChatGptWebSession(input: any) {
        input.onProfile?.({ account: { accountFingerprint: "a".repeat(64),
          accountStructure: "personal", containerFingerprint: "fixture" } });
        input.onFamilies?.([{ key: family, label: "Official assembly", availableEfforts: ["medium"] }]);
        input.onConnectorStarting?.(); input.onConnectorProven?.();
        return { families: [{ key: family, label: "Official assembly", availableEfforts: ["medium"] }] };
      },
      async discoverChatGptWebModelFamilies() {
        return [{ key: family, label: "Official assembly", availableEfforts: ["medium"] }];
      },
      async stop() { await responses.stop(); await gateway.close(); },
    };
  }) as unknown as typeof import("../../development-runtime/src/electron").startElectronDevelopmentRuntime;
  let owned: Awaited<ReturnType<typeof startAppOwnedProductResponsesRuntime>> | undefined;
  let engine: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
  try {
    expect(execFileSync(officialEngine!, ["--version"], { encoding: "utf8" })).toContain("0.167.");
    owned = await startAppOwnedProductResponsesRuntime({ config, ingress, electronStarter: starter, nativeFetch });
    // Cold app-server: there is no model_catalog_json and no prior Native/Web
    // cache. Query its public model/list while the product /models route exists.
    const coldHome = join(root, "cold-codex-home");
    mkdirSync(coldHome, { recursive: true });
    const discoveredNative = JSON.parse(execFileSync(officialEngine!, ["debug", "models"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH!, HOME: root, CODEX_HOME: coldHome,
        OPENAI_API_KEY: "isolated-fixture-only", TMPDIR: root },
    })) as { models: { slug: string; visibility?: string }[] };
    expect(discoveredNative.models.some(entry => entry.visibility === "list")).toBe(true);
    expect(discoveredNative.models.map(entry => entry.slug)).not.toContain(webModel);
    writeFileSync(join(coldHome, "config.toml"), [
      'model_provider = "fixture"', '[model_providers.fixture]', 'name = "OpenAI"',
      `base_url = ${JSON.stringify(owned.responses.baseUrl.href.slice(0, -1))}`,
      'wire_api = "responses"', 'requires_openai_auth = false', 'env_key = "OPENAI_API_KEY"',
    ].join("\n"));
    const coldEngine = Bun.spawn([officialEngine!, "app-server", "--stdio"], {
      cwd: root, env: { PATH: process.env.PATH!, HOME: root, CODEX_HOME: coldHome,
        OPENAI_API_KEY: "isolated-fixture-only", TMPDIR: root },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const coldReplies = new Map<number, {resolve(value:any):void;reject(error:unknown):void}>();
    let coldSequence = 0;
    const coldReading = (async () => {
      const reader = coldEngine.stdout.getReader();
      let buffer = "";
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        buffer += new TextDecoder().decode(part.value);
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          if (!line) continue;
          const message = JSON.parse(line);
          if (message.id === undefined) continue;
          const waiter = coldReplies.get(message.id); coldReplies.delete(message.id);
          if (message.error) waiter?.reject(message.error); else waiter?.resolve(message.result);
        }
      }
    })();
    const coldRpc = (method:string, params:unknown) => new Promise<any>((resolve,reject) => {
      const id=++coldSequence;coldReplies.set(id,{resolve,reject});
      coldEngine.stdin.write(JSON.stringify({id,method,params})+"\n");
    });
    try {
      await coldRpc("initialize",{clientInfo:{name:"tela-cold-models",version:"0.0.0"},capabilities:{experimentalApi:true}});
      coldEngine.stdin.write(JSON.stringify({method:"initialized"})+"\n");
      const coldConfig = await coldRpc("config/read",{});
      expect(coldConfig.config.model_catalog_json ?? null).toBeNull();
      const coldList = await coldRpc("model/list",{includeHidden:true});
      expect(coldList.data.length).toBeGreaterThan(0);
      expect(coldList.data.map((entry:any)=>entry.model)).not.toContain(webModel);
      expect(nativeCatalogReads).toBe(0);
      // The official app-server owns its catalog snapshot. Fetching the
      // product route in this session does not install Web choices into it.
      const coldProviderCatalog = await fetch(new URL("models", owned.responses.baseUrl), {
        headers: {authorization:"Bearer isolated-fixture-only"},
      });
      expect((await coldProviderCatalog.json() as any).models.map((entry:any)=>entry.slug))
        .toEqual([nativeModel, webModel]);
      const unrefreshed = await coldRpc("model/list",{includeHidden:true});
      expect(unrefreshed.data.map((entry:any)=>entry.model)).not.toContain(webModel);
    } finally {
      coldEngine.stdin.end();await coldEngine.exited;await coldReading;
    }
    const catalogFile = join(home, "models.json");
    const catalogResponse = await fetch(new URL("models", owned.responses.baseUrl), {
      headers: { authorization: "Bearer isolated-fixture-only" },
    });
    expect(catalogResponse.status).toBe(200);
    const providerCatalog = await catalogResponse.json() as { models: any[] };
    expect(providerCatalog.models.map(item => item.slug)).toEqual([nativeModel, webModel]);
    expect(providerCatalog.models[0]).toEqual(nativeEntry);
    expect(providerCatalog.models[1]).toMatchObject({ slug: webModel, tool_mode: null });
    writeFileSync(catalogFile, JSON.stringify(providerCatalog));
    const endpoint = owned.responses.baseUrl.href;
    writeFileSync(join(home, "config.toml"), [
      `model = ${JSON.stringify(webModel)}`, 'model_provider = "fixture"',
      `model_catalog_json = ${JSON.stringify(catalogFile)}`,
      '[model_providers.fixture]', 'name = "OpenAI"',
      `base_url = ${JSON.stringify(endpoint.slice(0, -1))}`,
      'wire_api = "responses"', 'requires_openai_auth = false', 'env_key = "OPENAI_API_KEY"',
    ].join("\n"));
    engine = Bun.spawn([officialEngine!, "app-server", "--stdio"], {
      cwd: root, env: { PATH: process.env.PATH!, HOME: root, CODEX_HOME: home,
        OPENAI_API_KEY: "isolated-fixture-only", TMPDIR: root },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    let nextId = 0;
    const pending = new Map<number, { resolve(value: any): void; reject(error: unknown): void }>();
    const notes: any[] = [];
    const awaiting: { method: string; resolve(value: any): void }[] = [];
    const reader = engine.stdout.getReader();
    const reading = (async () => {
      let buffer = "";
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        buffer += new TextDecoder().decode(part.value);
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          if (!line) continue;
          const value = JSON.parse(line);
          if (value.id !== undefined) {
            const task = pending.get(value.id); pending.delete(value.id);
            if (value.error) task?.reject(value.error); else task?.resolve(value.result);
          } else {
            const waiter = awaiting.findIndex(item => item.method === value.method);
            if (waiter < 0) notes.push(value); else awaiting.splice(waiter, 1)[0]!.resolve(value);
          }
        }
      }
    })();
    const rpc = (method: string, params?: unknown) => new Promise<any>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      engine!.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
    const notification = (method: string) => new Promise<any>(resolve => {
      const found = notes.findIndex(value => value.method === method);
      if (found >= 0) resolve(notes.splice(found, 1)[0]);
      else awaiting.push({ method, resolve });
    });
    try {
      await rpc("initialize", { clientInfo: { name: "tela-app-owned-integration", version: "0.0.0" },
        capabilities: { experimentalApi: true } });
      engine.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
      const catalog = await rpc("model/list", { includeHidden: true });
      const effective = await rpc("config/read", { includeLayers: true });
      expect(effective.config).toMatchObject({ model_provider: "fixture", model_catalog_json: catalogFile });
      expect(effective.config.model_providers.fixture).toMatchObject({
        base_url: endpoint.slice(0, -1), env_key: "OPENAI_API_KEY",
      });
      expect(catalog.data.map((entry: any) => entry.model)).toEqual(expect.arrayContaining([webModel, nativeModel]));
      const thread = await rpc("thread/start", { model: webModel, modelProvider: "fixture",
        cwd: root, approvalPolicy: "never", sandbox: "danger-full-access", historyMode: "paginated",
        ephemeral: false, baseInstructions: "Run only the isolated fixture tasks." });
      const threadId = thread.thread.id;
      await rpc("turn/start", { threadId, model: webModel, effort: "medium",
        input: [{ type: "text", text: "Return the fixture Web answer." }] });
      expect((await notification("turn/completed")).params.turn.status).toBe("completed");
      expect(webRequests).toHaveLength(1);
      expect(nativeRequests).toHaveLength(0);
      await rpc("turn/start", { threadId, model: nativeModel, effort: "medium",
        input: [{ type: "text", text: "Execute the original Native fixture tool." }] });
      const nativeCompletion = await notification("turn/completed");
      expect(nativeCompletion.params.turn.status).toBe("completed");
      expect(nativeRequests).toHaveLength(2);
      expect(webRequests).toHaveLength(1);
      expect(nativeRequests[1].input.some((item: any) =>
        item.type === "function_call_output" && item.call_id === "native-exec" &&
        item.output.includes(marker))).toBe(true);
      const resumed = await rpc("thread/read", { threadId, includeTurns: true });
      expect(resumed.thread.id).toBe(threadId);
      expect(resumed.thread.turns).toHaveLength(2);
      nativeCatalogUnavailable = true;
      const inaccessibleCatalog = await fetch(new URL("models", owned.responses.baseUrl), {
        headers: { authorization: "Bearer isolated-fixture-only" },
      });
      expect(inaccessibleCatalog.status).toBe(503);
      // The official engine retains its legitimate Native model while Web
      // discovery's upstream catalog endpoint is temporarily unavailable.
      const available = await rpc("model/list", { includeHidden: true });
      expect(available.data.map((entry: any) => entry.model)).toContain(nativeModel);
    } finally {
      engine.stdin.end();
      await engine.exited;
      await reading;
    }
  } finally {
    await owned?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
