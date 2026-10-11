import { describe, expect, test } from "bun:test";
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
  executableFixtureTest("owns app-server/proxy/Desktop without putting the Responses secret on argv", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-default-runtime-"));
    const home = join(root, "home");
    mkdirSync(home);
    const logPath = join(root, "backend.json");
    const codex = join(root, "fake-codex");
    const chat = join(root, "fake-chatgpt");
    executable(codex, `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
const args=process.argv.slice(2);
writeFileSync(process.env.TELA_FIXTURE_LOG, JSON.stringify({args, secret:process.env.CHATGPT_TELA_RUNTIME_TOKEN ?? null}));
const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(req,s){return s.upgrade(req)?undefined:new Response(null,{status:400})},websocket:{message(ws,msg){if(typeof msg!=="string")return;const v=JSON.parse(msg);if(v.method==="initialize")ws.send(JSON.stringify({id:v.id,result:{}}));}}});
console.error("codex app-server (WebSockets)");
console.error("  listening on: ws://127.0.0.1:"+server.port);
const stop=()=>{server.stop(true);process.exit(0)};process.on("SIGTERM",stop);process.on("SIGINT",stop);await new Promise(()=>{});
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
      environment: { TELA_FIXTURE_LOG: logPath, OPENAI_ORGANIZATION: "r".repeat(48) },
      // The shebang fixture is a Bun process, unlike the real native executable.
      processIds: async () => fixtureDesktopPid === undefined ? [] : [fixtureDesktopPid],
      normalQuit: async (_installation, pid) => { process.kill(pid, "SIGTERM"); },
    });
    fixtureDesktopPid = runtime.desktopPid;
    try {
      expect(runtime.desktopPid).toBeGreaterThan(0);
      expect(runtime.backendPid).toBeGreaterThan(0);
      expect(runtime.proxyEndpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/$/);
      expect(runtime.responsesRouteFingerprint).toBe(route.fingerprint);
      const log = JSON.parse(readFileSync(logPath, "utf8")) as { args: string[]; secret: string | null };
      expect(log.args[0]).toBe("app-server");
      expect(log.secret).toBe("r".repeat(48));
      expect(log.args.join(" ")).not.toContain("r".repeat(48));
      expect(log.args).toContain("ws://127.0.0.1:0");
    } finally {
      await runtime.stop();
      expect(() => process.kill(runtime.desktopPid, 0)).toThrow();
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
const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(req,s){return s.upgrade(req)?undefined:new Response(null,{status:400})},websocket:{message(ws,msg){if(typeof msg!=="string")return;const v=JSON.parse(msg);if(v.method==="initialize")ws.send(JSON.stringify({id:v.id,result:{}}));}}});
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
