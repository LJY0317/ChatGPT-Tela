import { expect, test } from "bun:test";
import { observeDiagnosticEvents } from "@chatgpt-tela/core";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CodexShutdownNotStartedError, startCodexService } from "./controller";
import type { CodexNativeTargetAdapter } from "./native-target";

test("refused default Desktop cleanup keeps authenticated child, route and service until explicit successful stop", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-stop-receipt-")), state = join(root, "stop.json");
  writeFileSync(state, JSON.stringify({ refuse: true }));
  let active = false, closes = 0, parentQuits = 0, nativeBusy = false;
  let desktopPid = 123, nativeUnavailable = false;
  const closedSlots: number[] = [];
  let onClosed = (_slot: number) => {};
  let onNativeRead = () => {};
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { const slot = Number(new URL(request.url).searchParams.get("slot") ?? 1); closedSlots.push(slot); onClosed(slot); closes++; active = false; return new Response(null, { status: 204 }); } });
  const appServer = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response(null, { status: 400 }); },
    websocket: { message(socket, data) {
      socket.subscribe("status");
      const request = JSON.parse(String(data));
      if (request.id === undefined) return;
      if (nativeUnavailable) {
        socket.send(JSON.stringify({ id: request.id, error: { code: -32603, message: "obsolete Native endpoint" } })); return;
      }
      socket.send(JSON.stringify({ id: request.id, result: request.method === "thread/loaded/list"
        ? { data: nativeBusy ? ["owned-thread"] : [], nextCursor: null }
        : request.method === "thread/read" ? { thread: { id: "owned-thread", status: { type: "active" } } } : {} }));
      if (request.method === "thread/read") onNativeRead();
    } },
  });
  const supervision = resolve(import.meta.dir, "../../../apps/profile-runtime/src/supervision.ts");
  const preview = resolve(import.meta.dir, "../../../apps/profile-runtime/src/bridge-preview-server.ts");
  const mcp = resolve(import.meta.dir, "../../mcp/src/http-server.ts");
  const child = join(root, "child.ts");
  writeFileSync(child, `import {readFileSync} from 'node:fs';
import {createProfileSupervisorLifecycle} from ${JSON.stringify(supervision)};
import {startProfileBridgePreviewServer} from ${JSON.stringify(preview)};
import {startCodexBridgeMcpHttpServer} from ${JSON.stringify(mcp)};
const slot=Number(process.env.CHATGPT_TELA_PRODUCT_PROFILE_SLOT);
const lifecycle=await createProfileSupervisorLifecycle();
const mcp=await startCodexBridgeMcpHttpServer({bridge:{inventory(){return []},async invoke(){throw Error('unused')}},authentication:{kind:'bearer',token:process.env.CHATGPT_TELA_PRODUCT_INTERNAL_MCP_TOKEN}});
const preview=await startProfileBridgePreviewServer({slot,bearerToken:process.env.CHATGPT_TELA_PRODUCT_UI_TOKEN,async observe(){return{activeSurfaceCount:0}},webState(){return{contractVersion:1,slot,webState:"ready",webModelIds:[]}},async waitForWeb(){},shutdownReadiness(){return JSON.parse(readFileSync(process.env.FIXTURE_STATE,'utf8')).busy?'blocked':'ready'},async shutdownProfile(){const state=JSON.parse(readFileSync(process.env.FIXTURE_STATE,'utf8'));if(state.refuse||state.refuseSlot===slot)throw Error('synthetic normal quit refusal');await fetch(process.env.FIXTURE_CLOSED);return{responsesRouteFingerprint:'a'.repeat(64)}}});
await lifecycle.publishReady({stage:'product-profile-ready',runtimeProcessId:process.pid,slot,routeId:process.env.CHATGPT_TELA_PRODUCT_ROUTE_ID,targetId:slot===1?'default':'fixture-'+slot,nativeTargetKind:'default-desktop',targetProcessId:123,nativeReady:true,webState:'preparing',profileId:'fixture',internalMcpUrl:mcp.endpointUrl.href,bridgePreviewUrl:preview.endpoint.href,terminalEndpoint:process.env.FIXTURE_APP_SERVER_ENDPOINT,responsesUrl:'http://127.0.0.1:1234/',responsesRouteFingerprint:'a'.repeat(64)});
await lifecycle.shutdownRequested;await preview.close();await mcp.stop();lifecycle.dispose();`);
  const built = await Bun.build({ entrypoints: [child], target: "bun", outdir: root, naming: "child.mjs" });
  expect(built.success).toBe(true);
  const target = { slot: 1, adapterKind: "default-desktop" as const, id: "default", displayName: "Fixture", state: "stopped", managed: true };
  // The real default adapter intentionally has no app-server endpoint.
  const session = () => ({ targetId: "default", state: active ? "restart-required" : "available",
    ...(active ? { desktopProcessId: desktopPid } : {}) });
  const adapter: CodexNativeTargetAdapter = {
    kind: "default-desktop", async profiles() { return [{ target, session: session() }]; },
    async resolve() { return { target, session: session() }; }, async session() { return session(); },
    async quit() { parentQuits++; active = false; return session(); },
    profileRuntimeEnvironment() { active = true; return { FIXTURE_STATE: state, FIXTURE_CLOSED: closed.url.href,
      FIXTURE_APP_SERVER_ENDPOINT: `ws://127.0.0.1:${appServer.port}/` }; },
  };
  const service = await startCodexService({ config: {}, profileRuntimeCommand: [process.execPath, join(root, "child.mjs")],
    nativeTargetAdapter: adapter, webDelegationCapacity: async () => ({ total: { used: 0 }, uncertain: 0 }) });
  try {
    const started = await service.startProfile(1);
    expect(await service.shutdownReadiness()).toBe("ready");
    nativeBusy = true;
    let scanned!: () => void;
    const scan = new Promise<void>(resolve => { scanned = resolve; });
    onNativeRead = scanned;
    const waiting = service.waitForShutdownReadiness();
    await scan;
    nativeBusy = false;
    appServer.publish("status", JSON.stringify({ method: "thread/status/changed", params: { threadId: "owned-thread", status: { type: "idle" } } }));
    await waiting;
    onNativeRead = () => {};
    expect(active).toBe(true); expect(closes).toBe(0); expect(parentQuits).toBe(0);
    const failures: Record<string, unknown>[] = [];
    const unobserve = observeDiagnosticEvents(row => { if (row.stage === "shutdown_wait_failed") failures.push(row); });
    try {
      writeFileSync(state, JSON.stringify({ refuse: true, busy: true }));
      await expect(service.waitForShutdownReadiness()).rejects.toBeInstanceOf(CodexShutdownNotStartedError);
      expect(failures).toMatchObject([{ phase: "final_readiness", abort_observed: false }]);
    } finally { unobserve?.(); writeFileSync(state, JSON.stringify({ refuse: true })); }


    // The replaced Desktop is independent; an obsolete Native endpoint must
    // not veto maintenance, while this runtime's outstanding Web work still does.
    nativeUnavailable = true;
    expect(await service.shutdownReadiness()).toBe("blocked");
    await expect(service.waitForShutdownReadiness()).rejects.toThrow("obsolete Native endpoint");
    desktopPid = 456;
    try {
      expect((await service.profiles())[0]?.controlState).toBe("orphaned");
      expect(await service.shutdownReadiness()).toBe("ready");
      await service.waitForShutdownReadiness();
      expect(active).toBe(true); expect(parentQuits).toBe(0); expect(closes).toBe(0);
      writeFileSync(state, JSON.stringify({ refuse: true, busy: true }));
      expect(await service.shutdownReadiness()).toBe("blocked");
      await expect(service.waitForShutdownReadiness()).rejects.toBeInstanceOf(CodexShutdownNotStartedError);
    } finally {
      desktopPid = 123; nativeUnavailable = false;
      writeFileSync(state, JSON.stringify({ refuse: true }));
    }

    await expect(service.close()).rejects.toThrow("Profile normal shutdown was not acknowledged");
    expect(service.activeProfileCount).toBe(1); expect(active).toBe(true); expect(closes).toBe(0); expect(parentQuits).toBe(0);
    expect((await service.profiles())[0]?.controlState).toBe("running");
    expect((await service.profiles())[0]?.childProcessId).toBe(started.childProcessId);
    expect(await service.terminalSession(1)).toMatchObject({
      endpoint: `ws://127.0.0.1:${appServer.port}/`,
      runtimeProcessId: started.childProcessId,
      responsesRouteFingerprint: started.responsesRouteFingerprint,
    });
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
    // A failed first profile must leave later profiles untouched, rather than
    // continuing a shutdown which can no longer install the update.
    const activeSlots = new Set<number>();
    const targets = [target, { ...target, slot: 2, id: "fixture-2" }];
    const multiSession = (id: string) => {
      const slot = targets.find(t => t.id === id)!.slot;
      return { targetId: id, state: activeSlots.has(slot) ? "restart-required" : "available",
        ...(activeSlots.has(slot) ? { desktopProcessId: 123 } : {}) };
    };
    const multiple = await startCodexService({ config: {}, profileRuntimeCommand: [process.execPath, join(root, "child.mjs")],
      nativeTargetAdapter: { ...adapter,
        async profiles() { return targets.map(target => ({ target, session: multiSession(target.id) })); },
        async resolve(slot) { const target = targets[slot - 1]!; return { target, session: multiSession(target.id) }; },
        async session(id) { return multiSession(id); },
        async quit(id) { activeSlots.delete(targets.find(t => t.id === id)!.slot); return multiSession(id); },
        profileRuntimeEnvironment(target) {
          activeSlots.add(target.slot);
          return { FIXTURE_STATE: state, FIXTURE_CLOSED: closed.url.href + '?slot=' + target.slot,
            FIXTURE_APP_SERVER_ENDPOINT: `ws://127.0.0.1:${appServer.port}/` };
        },
      } });
    onClosed = slot => { activeSlots.delete(slot); };
    try {
      await multiple.startProfile(1); await multiple.startProfile(2);
      closedSlots.length = 0;
      writeFileSync(state, JSON.stringify({ refuse: true }));
      await expect(multiple.close()).rejects.toThrow("Profile normal shutdown was not acknowledged");
      expect(multiple.activeProfileCount).toBe(2);
      expect(closedSlots).toEqual([]);
      expect(activeSlots.size).toBe(2);
      writeFileSync(state, JSON.stringify({ refuseSlot: 2 }));
      const priorSecond = (await multiple.profiles()).find(p => p.slot === 2)!.childProcessId;
      await expect(multiple.close()).rejects.toThrow("Profile normal shutdown was not acknowledged");
      expect(closedSlots).toEqual([1]);
      expect(multiple.activeProfileCount).toBe(2);
      expect(activeSlots.size).toBe(2);
      expect((await multiple.profiles()).find(p => p.slot === 2)!.childProcessId).toBe(priorSecond);
      writeFileSync(state, JSON.stringify({ refuse: false }));
      await multiple.close();
      expect(closedSlots).toEqual([1, 2, 1]);
    } finally {
      writeFileSync(state, JSON.stringify({ refuse: false })); await multiple.close();
    }
    // Official updates may replace or close Desktop while Tela's exact runtime
    // remains alive. Only that runtime's work and cleanup receipt govern its stop.
    for (const replacementPid of [456, undefined]) {
      let replaced = false;
      const replacementSession = async () => replaced
        ? { targetId: "default", state: replacementPid ? "restart-required" : "available",
            ...(replacementPid ? { desktopProcessId: replacementPid } : {}) }
        : session();
      const detached = await startCodexService({ config: {},
        profileRuntimeCommand: [process.execPath, join(root, "child.mjs")],
        nativeTargetAdapter: { ...adapter,
          async profiles() { return [{ target, session: await replacementSession() }]; },
          session: replacementSession,
          async quit() { throw Error("replacement app must not be quit"); },
        } });
      try {
        await detached.startProfile(1);
        replaced = true;
        expect((await detached.profiles())[0]?.controlState).toBe("orphaned");
        nativeBusy = true;
        expect(await detached.shutdownReadiness()).toBe("blocked");
        await expect(detached.close()).rejects.toBeInstanceOf(CodexShutdownNotStartedError);
        expect(detached.activeProfileCount).toBe(1);
        nativeBusy = false;
        writeFileSync(state, JSON.stringify({ busy: true }));
        expect(await detached.shutdownReadiness()).toBe("blocked");
        writeFileSync(state, JSON.stringify({ refuse: false }));
        expect(await detached.shutdownReadiness()).toBe("ready");
        await detached.close();
        expect(detached.activeProfileCount).toBe(0);
        expect(parentQuits).toBe(0);
      } finally {
        nativeBusy = false; writeFileSync(state, JSON.stringify({ refuse: false }));
        await detached.close();
      }
    }
  } finally {
    writeFileSync(state, JSON.stringify({ refuse: false }));
    await service.close(); await closed.stop(true); await appServer.stop(true); rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
