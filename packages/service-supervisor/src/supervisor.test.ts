import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProductPaths } from "@chatgpt-tela/product-lifecycle";
import { readServiceRuntimeDescriptor, writeServiceRuntimeDescriptor } from "@chatgpt-tela/service-protocol";
import { LocalServiceSupervisor } from "./index";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

function isolatedProductEnvironment(home: string, installId: string): Record<string, string> {
  if (process.platform === "win32") {
    return {
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      CHATGPT_TELA_INSTALL_ID: installId,
    };
  }
  if (process.platform === "linux") {
    return {
      HOME: home,
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_RUNTIME_DIR: join(home, ".runtime"),
      CHATGPT_TELA_INSTALL_ID: installId,
    };
  }
  return { HOME: home, CHATGPT_TELA_INSTALL_ID: installId };
}

describe("local service supervisor", () => {
  async function drainFixture(delayMs: number, replacement = false, acknowledgmentDelayMs = 0) {
    const root=mkdtempSync(join(tmpdir(),"tela-owned-drain-")), descriptorPath=join(root,"descriptor.json");
    const installId="drain-install", instanceId="drain-instance", token="d".repeat(48);
    const replacementValue={version:1,service:"codex",installId,instanceId:"replacement",pid:process.pid,endpoint:"http://127.0.0.1:1/",bearerToken:token,startedAt:new Date().toISOString()};
    const script=`const fs=require('node:fs');const file=process.env.TELA_TEST_DESCRIPTOR;const delay=Number(process.env.TELA_TEST_DELAY);const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){if(req.headers.get('authorization')!=='Bearer '+${JSON.stringify(token)})return new Response(null,{status:401});if(new URL(req.url).pathname==='/v1/status')return Response.json({contractVersion:1,service:'codex',instanceId:${JSON.stringify(instanceId)},state:'ready'});if(req.method==='POST'){await new Promise(resolve=>setTimeout(resolve,Number(process.env.TELA_TEST_ACK_DELAY)));if(process.env.TELA_TEST_REPLACEMENT)fs.writeFileSync(file,process.env.TELA_TEST_REPLACEMENT);else fs.rmSync(file,{force:true});setTimeout(()=>{server.stop(true);process.exit(0);},delay);return Response.json({});}return new Response(null,{status:404});}});console.log(JSON.stringify({port:server.port}));`;
    const child=Bun.spawn([process.execPath,"-e",script],{env:{...process.env,TELA_TEST_DESCRIPTOR:descriptorPath,TELA_TEST_DELAY:String(delayMs),TELA_TEST_ACK_DELAY:String(acknowledgmentDelayMs),...(replacement?{TELA_TEST_REPLACEMENT:JSON.stringify(replacementValue)}:{})},stdout:"pipe",stderr:"pipe"});
    try {
      const reader=child.stdout.getReader();let text="";
      while(!text.includes("\n")){const chunk=await reader.read();if(chunk.done)throw Error("fixture exited before ready");text+=new TextDecoder().decode(chunk.value);if(text.length>4096)throw Error("fixture readiness exceeds limit");}
      const {port}=JSON.parse(text.trim());reader.releaseLock();
      writeServiceRuntimeDescriptor(descriptorPath,{version:1,service:"codex",installId,instanceId,pid:child.pid!,endpoint:`http://127.0.0.1:${port}/`,bearerToken:token,startedAt:new Date().toISOString()});
      return {root,descriptorPath,child,supervisor:new LocalServiceSupervisor({installId})};
    }catch(e){child.kill();await child.exited;rmSync(root,{recursive:true,force:true});throw e;}
  }

  test("waits for Codex cleanup acknowledgement beyond the generic HTTP request deadline", async () => {
    const f = await drainFixture(50, false, 2_300);
    try {
      expect(await f.supervisor.shutdown({ service: "codex", descriptorPath: f.descriptorPath })).toBe(true);
      expect(await f.child.exited).toBe(0);
    } finally {
      f.child.kill();
      await f.child.exited;
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test("waits beyond 10s for actual owned Codex exit even when its descriptor disappears early", async () => {
    const f=await drainFixture(11200);
    try {
      const at=performance.now();expect(await f.supervisor.shutdown({service:"codex",descriptorPath:f.descriptorPath})).toBe(true);
      expect(performance.now()-at).toBeGreaterThan(10000);expect(await f.child.exited).toBe(0);
      expect(existsSync(f.descriptorPath)).toBe(false);
    }finally{f.child.kill();await f.child.exited;rmSync(f.root,{recursive:true,force:true});}
  },25000);

  test("late old-service exit preserves a replacement service descriptor",async()=>{
    const f=await drainFixture(300,true);
    try {
      expect(await f.supervisor.shutdown({service:"codex",descriptorPath:f.descriptorPath})).toBe(true);
      expect(await f.child.exited).toBe(0);expect(existsSync(f.descriptorPath)).toBe(true);
    }finally{f.child.kill();await f.child.exited;rmSync(f.root,{recursive:true,force:true});}
  });

  test("starts, reuses, and normally shuts down one exact Chat daemon", async () => {
    const home = mkdtempSync(join(tmpdir(), "tela-supervisor-"));
    const environment = isolatedProductEnvironment(home, "supervisor-install-1");
    const paths = resolveProductPaths({ platform: process.platform, home, environment });
    const descriptorPath = join(paths.serviceRuntime("chat"), "descriptor.json");
    const logPath = join(paths.logsRoot, "chat-supervisor-test.log");
    const supervisor = new LocalServiceSupervisor({ installId: "supervisor-install-1" });
    const input = {
      service: "chat" as const,
      descriptorPath,
      command: [process.execPath, resolve(repoRoot, "apps/chat-daemon/src/main.ts")] as const,
      cwd: repoRoot,
      environment,
      logPath,
    };
    try {
      const first = await supervisor.ensure(input);
      expect(first.status.state).toBe("ready");
      expect(first.descriptor.service).toBe("chat");
      const second = await supervisor.ensure(input);
      expect(second.descriptor.pid).toBe(first.descriptor.pid);
      expect(await supervisor.shutdown({ service: "chat", descriptorPath })).toBe(true);
      expect(existsSync(descriptorPath)).toBe(false);
      expect(await supervisor.current({ service: "chat", descriptorPath })).toBeUndefined();
    } finally {
      const running = await supervisor.current({ service: "chat", descriptorPath }).catch(() => undefined);
      if (running) await supervisor.shutdown({ service: "chat", descriptorPath }).catch(() => {});
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test("supervises Gateway, Chat, and Codex as independent process failure domains", async () => {
    const home = mkdtempSync(join(tmpdir(), "tela-supervisor-split-"));
    const common = isolatedProductEnvironment(home, "supervisor-split-install");
    const paths = resolveProductPaths({ platform: process.platform, home, environment: common });
    const supervisor = new LocalServiceSupervisor({ installId: "supervisor-split-install" });
    const descriptor = (service: "gateway" | "chat" | "codex") => join(paths.serviceRuntime(service), "descriptor.json");
    try {
      const chat = await supervisor.ensure({
        service: "chat",
        descriptorPath: descriptor("chat"),
        command: [process.execPath, resolve(repoRoot, "apps/chat-daemon/src/main.ts")],
        cwd: repoRoot,
        environment: common,
        logPath: join(paths.logsRoot, "chat-split-test.log"),
      });
      const codex = await supervisor.ensure({
        service: "codex",
        descriptorPath: descriptor("codex"),
        command: [process.execPath, resolve(repoRoot, "apps/codex-daemon/src/main.ts")],
        cwd: repoRoot,
        environment: {
          ...common,
          CHATGPT_TELA_CODEX_MULTI_PROFILE_LAUNCHER_CLI: process.platform === "win32" ? process.execPath : "/bin/true",
          CHATGPT_TELA_PRODUCT_PROFILE_RUNTIME_EXECUTABLE: process.platform === "win32" ? process.execPath : "/bin/true",
          CHATGPT_TELA_PRODUCT_PROFILE_RUNTIME_ENTRYPOINT: process.platform === "win32" ? "--version" : "/tmp/tela-unused-profile-runtime",
        },
        logPath: join(paths.logsRoot, "codex-split-test.log"),
      });
      const gateway = await supervisor.ensure({
        service: "gateway",
        descriptorPath: descriptor("gateway"),
        command: [process.execPath, resolve(repoRoot, "apps/gateway-daemon/src/main.ts")],
        cwd: repoRoot,
        environment: common,
        logPath: join(paths.logsRoot, "gateway-split-test.log"),
      });
      expect(chat.status.state).toBe("ready");
      expect(codex.status.state).toBe("ready");
      expect(gateway.status.state).toBe("ready");

      const backendStatus = async () => {
        const response = await fetch(new URL("v1/backends", gateway.descriptor.endpoint), {
          headers: { authorization: `Bearer ${gateway.descriptor.bearerToken}` },
        });
        expect(response.status).toBe(200);
        return await response.json() as { backends: Array<{ service: string; availability: string }> };
      };
      expect((await backendStatus()).backends.map(item => [item.service, item.availability])).toEqual([
        ["chat", "ready"],
        ["codex", "ready"],
      ]);

      await supervisor.shutdown({ service: "chat", descriptorPath: descriptor("chat") });
      expect((await backendStatus()).backends.map(item => [item.service, item.availability])).toEqual([
        ["chat", "unavailable"],
        ["codex", "ready"],
      ]);
      expect((await supervisor.current({ service: "gateway", descriptorPath: descriptor("gateway") }))?.status.state).toBe("ready");

      await supervisor.shutdown({ service: "codex", descriptorPath: descriptor("codex") });
      expect((await backendStatus()).backends.map(item => [item.service, item.availability])).toEqual([
        ["chat", "unavailable"],
        ["codex", "unavailable"],
      ]);
      expect((await supervisor.current({ service: "gateway", descriptorPath: descriptor("gateway") }))?.status.state).toBe("ready");
      await supervisor.shutdown({ service: "gateway", descriptorPath: descriptor("gateway") });
    } finally {
      for (const service of ["gateway", "chat", "codex"] as const) {
        await supervisor.shutdown({ service, descriptorPath: descriptor(service) }).catch(() => {});
      }
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});


describe("OS-started runtime readiness", () => {
  async function fixture(run: (f: {
    descriptorPath: string; publish: (installId?: string, service?: "chat" | "codex") => void;
    supervisor: LocalServiceSupervisor; setState: (state: string) => void;
    setInstance: (id: string) => void; setHttpStatus: (status: number) => void;
    requestCount: () => number;
  }) => Promise<void>) {
    const root = mkdtempSync(join(tmpdir(), "tela-runtime-ready-"));
    const descriptorPath = join(root, "descriptor.json");
    let state = "degraded", instanceId = "ready-instance", httpStatus = 200, requests = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      requests++;
      expect(request.headers.get("authorization")).toBe(`Bearer ${"r".repeat(48)}`);
      return Response.json({ contractVersion: 1, service: "chat", instanceId, state }, { status: httpStatus });
    } });
    const publish = (installId = "ready-install", service: "chat" | "codex" = "chat") =>
      writeServiceRuntimeDescriptor(descriptorPath, { version: 1, service, installId,
        instanceId: "ready-instance", pid: process.pid, endpoint: server.url.href,
        bearerToken: "r".repeat(48), startedAt: new Date().toISOString() });
    try { await run({ descriptorPath, publish, supervisor: new LocalServiceSupervisor({ installId: "ready-install" }),
      setState: value => { state = value; }, setInstance: value => { instanceId = value; },
      setHttpStatus: value => { httpStatus = value; }, requestCount: () => requests }); }
    finally { await server.stop(true); rmSync(root, { recursive: true, force: true }); }
  }

  test("waits for delayed descriptor publication and authenticated ready after degraded", async () => {
    await fixture(async f => {
      const waiting = f.supervisor.waitUntilReady({ service: "chat", descriptorPath: f.descriptorPath, timeoutMs: 1_500 });
      f.publish();
      await Bun.sleep(120);
      f.setState("ready");
      expect((await waiting).status.state).toBe("ready");
    });
  });

  test("missing and nonready runtimes exhaust one finite observation budget", async () => {
    await fixture(async f => {
      await expect(f.supervisor.waitUntilReady({ service: "chat", descriptorPath: f.descriptorPath, timeoutMs: 100 })).rejects.toThrow("did not become ready");
      f.publish();
      await expect(f.supervisor.waitUntilReady({ service: "chat", descriptorPath: f.descriptorPath, timeoutMs: 100 })).rejects.toThrow("did not become ready");
      expect(readServiceRuntimeDescriptor(f.descriptorPath)?.installId).toBe("ready-install");
    });
  });

  for (const mismatch of ["install", "service", "instance", "authentication"] as const) {
    test(`rejects ${mismatch} mismatch without treating it as startup delay`, async () => {
      await fixture(async f => {
        f.publish(mismatch === "install" ? "foreign" : "ready-install", mismatch === "service" ? "codex" : "chat");
        if (mismatch === "instance") f.setInstance("foreign-instance");
        if (mismatch === "authentication") f.setHttpStatus(401);
        f.setState("ready");
        await expect(f.supervisor.waitUntilReady({ service: "chat", descriptorPath: f.descriptorPath, timeoutMs: 1_000 })).rejects.toThrow();
        expect(readServiceRuntimeDescriptor(f.descriptorPath)).toBeDefined();
        expect(f.requestCount()).toBe(mismatch === "install" || mismatch === "service" ? 0 : 1);
      });
    });
  }
});

test("failed old endpoint observation cannot delete a successor descriptor", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-readiness-successor-"));
  const descriptorPath = join(root, "descriptor.json");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
    writeServiceRuntimeDescriptor(descriptorPath, { ...original, instanceId: "successor", pid: process.pid });
    await gate;
    return Response.json({ contractVersion: 1, service: "chat", instanceId: "old", state: "ready" });
  } });
  const original = { version: 1 as const, service: "chat" as const, installId: "successor-install",
    instanceId: "old", pid: 2_147_483_647, endpoint: server.url.href,
    bearerToken: "s".repeat(48), startedAt: new Date().toISOString() };
  writeServiceRuntimeDescriptor(descriptorPath, original);
  try {
    const supervisor = new LocalServiceSupervisor({ installId: original.installId });
    expect(await supervisor.current({ service: "chat", descriptorPath, requestTimeoutMs: 100 })).toBeUndefined();
    expect(readServiceRuntimeDescriptor(descriptorPath)?.instanceId).toBe("successor");
  } finally { release(); await server.stop(true); rmSync(root, { recursive: true, force: true }); }
});
