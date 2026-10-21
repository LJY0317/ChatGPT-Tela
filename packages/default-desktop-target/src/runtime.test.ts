import { describe, expect, test } from "bun:test";
import { diagnosticFingerprint } from "@chatgpt-tela/core";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultDesktopResponsesRoute } from "./route";
import { startDefaultDesktopTargetRuntime } from "./runtime";

function executable(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o700 });
  chmodSync(path, 0o700);
}

describe("built-in default Desktop target runtime", () => {
  const executableFixtureTest = process.platform === "win32" ? test.skip : test;
  executableFixtureTest.each(["paginated", "legacy"] as const)("settles owned %s Native work before Desktop/backend shutdown without exposing Responses secrets", async historyMode => {
    const root = mkdtempSync(join(tmpdir(), "tela-default-runtime-"));
    const home = join(root, "home");
    mkdirSync(home);
    const logPath = join(root, "backend.json");
    const statePath = join(root, "native-state");
    writeFileSync(statePath, "active");
    const codex = join(root, "fake-codex");
    const chat = join(root, "fake-chatgpt");
    executable(codex, `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
const args=process.argv.slice(2);
const active=()=>readFileSync(process.env.TELA_FIXTURE_STATE,"utf8")==="active";
writeFileSync(process.env.TELA_FIXTURE_LOG, JSON.stringify({args, secret:process.env.CHATGPT_TELA_RUNTIME_TOKEN ?? null}));
const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(req,s){return s.upgrade(req)?undefined:new Response(null,{status:400})},websocket:{message(ws,msg){if(typeof msg!=="string")return;const v=JSON.parse(msg);let result;
if(v.method==="initialize")result={};
else if(v.method==="thread/loaded/list")result={data:["fixture-thread"],nextCursor:null};
else if(v.method==="thread/read")result={thread:{id:"fixture-thread",cwd:"/fixture",historyMode:process.env.TELA_FIXTURE_HISTORY_MODE,status:{type:active()?"active":"idle"}}};
else if(v.method==="thread/turns/list")result={data:[{id:"fixture-turn",status:"inProgress",itemsView:"notLoaded",items:[]}],nextCursor:null};
else if(v.method==="turn/interrupt"){writeFileSync(process.env.TELA_FIXTURE_STATE,"idle");writeFileSync(process.env.TELA_FIXTURE_LOG,JSON.stringify({args,secret:process.env.CHATGPT_TELA_RUNTIME_TOKEN??null,nativeInterrupted:true}));result={};}
if(v.id!==undefined&&result!==undefined)ws.send(JSON.stringify({id:v.id,result}));}}});
console.error("codex app-server (WebSockets)");
console.error("  listening on: ws://127.0.0.1:"+server.port);
const stop=()=>{if(active())return;server.stop(true);process.exit(0)};process.on("SIGTERM",stop);process.on("SIGINT",stop);await new Promise(()=>{});
`);
    executable(chat, `#!/usr/bin/env bun
const ws=new WebSocket(process.env.CODEX_APP_SERVER_WS_URL);await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",reject,{once:true})});
const stop=()=>{try{ws.close()}catch{};process.exit(0)};process.on("SIGTERM",stop);process.on("SIGINT",stop);setInterval(()=>{},1000);
`);
    const route = createDefaultDesktopResponsesRoute({
      baseUrl: "http://127.0.0.1:18741/v1",
      envKey: "CHATGPT_TELA_RUNTIME_TOKEN",
      credential: "r".repeat(48),
    });
    let fixtureDesktopPid: number | undefined;
    let normalQuitCalls = 0;
    const ownershipEvents: string[] = [];
    const lifecycleEvents: { stage: string; fields: Record<string, any> }[] = [];
    const runtime = await startDefaultDesktopTargetRuntime({
      installation: {
        platform: "linux",
        chatGptExecutable: chat,
        codexExecutable: codex,
        codexHome: join(home, ".codex"),
        userDataDir: join(home, "Library/Application Support/Codex"),
        normalQuitSupported: true,
      },
      route,
      credential: "r".repeat(48),
      acquireBackendOwnership: async () => {
        ownershipEvents.push("claimed");
        return {
          beginSpawn() { ownershipEvents.push("spawning"); },
          attachBackend(pid) { expect(pid).toBeGreaterThan(0); ownershipEvents.push("attached"); },
          proveBackendExit() { ownershipEvents.push("exited"); },
          cancelBeforeSpawn() {},
        };
      },
      environment: { TELA_FIXTURE_LOG: logPath, TELA_FIXTURE_STATE: statePath, TELA_FIXTURE_HISTORY_MODE: historyMode, OPENAI_ORGANIZATION: "r".repeat(48) },
      // The shebang fixture is a Bun process, unlike the real native executable.
      processIds: async () => fixtureDesktopPid === undefined ? [] : [fixtureDesktopPid],
      normalQuit: async (_installation, pid) => { normalQuitCalls++; process.kill(pid, "SIGTERM"); },
      onDiagnostic: (stage, fields) => lifecycleEvents.push({ stage, fields: { ...fields } }),
    });
    fixtureDesktopPid = runtime.desktopPid;
    try {
      expect(runtime.desktopPid).toBeGreaterThan(0);
      expect(runtime.backendPid).toBeGreaterThan(0);
      expect(runtime.proxyEndpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/$/);
      expect(runtime.responsesRouteFingerprint).toBe(route.fingerprint);
      expect(lifecycleEvents.find(event => event.stage === "desktop_start_complete")?.fields).toMatchObject({
        runtime_process_fingerprint: diagnosticFingerprint(String(process.pid)),
        backend_process_fingerprint: diagnosticFingerprint(String(runtime.backendPid)),
        desktop_process_fingerprint: diagnosticFingerprint(String(runtime.desktopPid)),
      });
      const log = JSON.parse(readFileSync(logPath, "utf8")) as { args: string[]; secret: string | null };
      expect(log.args[0]).toBe("app-server");
      expect(log.secret).toBe("r".repeat(48));
      expect(log.args.join(" ")).not.toContain("r".repeat(48));
      expect(log.args).toContain("ws://127.0.0.1:0");
      if (historyMode === "legacy") {
        await expect(runtime.stop()).rejects.toThrow("unindexed active turn");
        expect(normalQuitCalls).toBe(0);
        expect(ownershipEvents).toEqual(["claimed", "spawning", "attached"]);
        expect(readFileSync(statePath, "utf8")).toBe("active");
        expect(() => process.kill(runtime.desktopPid, 0)).not.toThrow();
        // Independent canonical settlement permits the same owned stop to resume.
        writeFileSync(statePath, "idle");
      }
    } finally {
      await runtime.stop();
      expect(() => process.kill(runtime.desktopPid, 0)).toThrow();
      expect(() => process.kill(runtime.backendPid, 0)).toThrow();
      expect(normalQuitCalls).toBe(1);
      expect(ownershipEvents).toEqual(["claimed", "spawning", "attached", "exited"]);
      expect(JSON.parse(readFileSync(logPath, "utf8")).nativeInterrupted === true).toBe(historyMode === "paginated");
      const quit = lifecycleEvents.filter(event => event.stage === "desktop_quit_requested").at(-1)!;
      const stopped = lifecycleEvents.filter(event => event.stage === "desktop_stop_complete").at(-1)!;
      expect(quit.fields).toMatchObject({
        runtime_process_fingerprint: diagnosticFingerprint(String(process.pid)),
        backend_process_fingerprint: diagnosticFingerprint(String(runtime.backendPid)),
        desktop_process_fingerprint: diagnosticFingerprint(String(runtime.desktopPid)),
      });
      expect(typeof quit.fields.duration_ms).toBe("number");
      expect(stopped.fields.duration_ms).toBeGreaterThanOrEqual(quit.fields.duration_ms);
      rmSync(root, { recursive: true, force: true });
    }
  });

  executableFixtureTest("shutdown preserves a replacement Desktop when the originally spawned pid loses current-process ownership", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-default-runtime-ownership-loss-"));
    const home = join(root, "home");
    mkdirSync(home);
    const codex = join(root, "fake-codex");
    const chat = join(root, "fake-chatgpt");
    executable(codex, `#!/usr/bin/env bun
const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(req,s){return s.upgrade(req)?undefined:new Response(null,{status:400})},websocket:{message(ws,msg){if(typeof msg!=="string")return;const v=JSON.parse(msg);if(v.method==="initialize")ws.send(JSON.stringify({id:v.id,result:{}}));else if(v.method==="thread/loaded/list")ws.send(JSON.stringify({id:v.id,result:{data:[],nextCursor:null}}));}}});
console.error("codex app-server (WebSockets)");console.error("  listening on: ws://127.0.0.1:"+server.port);
const stop=()=>{server.stop(true);process.exit(0)};process.on("SIGTERM",stop);process.on("SIGINT",stop);await new Promise(()=>{});
`);
    executable(chat, `#!/usr/bin/env bun
const ws=new WebSocket(process.env.CODEX_APP_SERVER_WS_URL);await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",reject,{once:true})});
ws.addEventListener("close",()=>process.exit(0),{once:true});setInterval(()=>{},1000);
`);
    const route = createDefaultDesktopResponsesRoute({
      baseUrl: "http://127.0.0.1:18741/v1",
      envKey: "CHATGPT_TELA_RUNTIME_TOKEN",
      credential: "r".repeat(48),
    });
    let normalQuitCalls = 0;
    const runtime = await startDefaultDesktopTargetRuntime({
      installation: {
        platform: "linux",
        chatGptExecutable: chat,
        codexExecutable: codex,
        codexHome: join(home, ".codex"),
        userDataDir: join(home, "Library/Application Support/Codex"),
        normalQuitSupported: true,
      },
      route,
      credential: "r".repeat(48),
      environment: { ...process.env, OPENAI_ORGANIZATION: "r".repeat(48) },
      processIds: async () => [],
      normalQuit: async () => { normalQuitCalls += 1; },
    });
    try {
      const startedAt = Date.now();
      await runtime.stop();
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(normalQuitCalls).toBe(0);
    } finally {
      for (const pid of [runtime.desktopPid, runtime.backendPid]) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ }
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("backend ownership refusal occurs before any backend executable can be spawned", async () => {
  const events: { stage: string; fields: any }[] = [];
  await expect(startDefaultDesktopTargetRuntime({
    installation: { platform: "linux", chatGptExecutable: "/missing/chat", codexExecutable: "/missing/backend", codexHome: "/private/home", userDataDir: "/private/data", normalQuitSupported: true },
    route: createDefaultDesktopResponsesRoute({ baseUrl: "http://127.0.0.1:18741/v1", envKey: "TEST_KEY", credential: "s".repeat(48) }),
    credential: "s".repeat(48), processIds: async () => [],
    acquireBackendOwnership: async () => { throw Error("Previous Native backend is still running"); },
    onDiagnostic: (stage, fields) => events.push({ stage, fields }),
  })).rejects.toThrow("Previous Native backend is still running");
  expect(events.at(-1)).toMatchObject({ stage: "desktop_start_failed", fields: { phase: "backend_ownership" } });
  expect(events.some(e => e.fields.phase === "backend")).toBe(false);
  expect(JSON.stringify(events)).not.toContain("private");
});

test("startup refusal emits a payload-free checking phase without launching processes",async()=>{
 const events:{stage:string;fields:any}[]=[];
 await expect(startDefaultDesktopTargetRuntime({
  installation:{platform:"darwin",chatGptExecutable:"/private/fixture/ChatGPT",codexExecutable:"/private/fixture/codex",codexHome:"/private/fixture/home",userDataDir:"/private/fixture/data",normalQuitSupported:true},
  route:createDefaultDesktopResponsesRoute({baseUrl:"http://127.0.0.1:18741/v1",envKey:"TEST_KEY",credential:"s".repeat(48)}),credential:"s".repeat(48),
  processIds:async()=>[999],onDiagnostic:(stage,fields)=>events.push({stage,fields}),
 })).rejects.toThrow("already running");
 expect(events.map(e=>e.stage)).toEqual(["desktop_start_phase","desktop_start_failed"]);
 expect(events[1]!.fields.phase).toBe("checking");expect(events[0]!.fields.operation_fingerprint).toBe(events[1]!.fields.operation_fingerprint);
 expect(JSON.stringify(events)).not.toContain("private");expect(JSON.stringify(events)).not.toContain("999");expect(JSON.stringify(events)).not.toContain("127.0.0.1");
});

test("seeded remote mode rejects a missing real catalog before lifecycle observation", async () => {
  let observations = 0;
  await expect(startDefaultDesktopTargetRuntime({
    installation: { platform: "linux", chatGptExecutable: "/fixture/chat", codexExecutable: "/fixture/codex", codexHome: "/fixture/home", userDataDir: "/fixture/data", normalQuitSupported: true },
    route: createDefaultDesktopResponsesRoute({ baseUrl: "http://127.0.0.1:18741/v1", envKey: "CHATGPT_TELA_RUNTIME_TOKEN", credential: "r".repeat(48) }),
    credential: "r".repeat(48), catalogMode: "seeded-remote",
    processIds: async () => { observations++; return []; },
  })).rejects.toThrow("real initial catalog");
  expect(observations).toBe(0);
});
