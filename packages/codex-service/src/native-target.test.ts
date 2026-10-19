import { describe, expect, test } from "bun:test";
import type { MultiProfileTarget, MultiProfileTargetSession } from "@chatgpt-tela/setup";
import {
  CompositeNativeTargetAdapter,
  DefaultDesktopNativeTargetAdapter,
  MultiProfileNativeTargetAdapter,
} from "./native-target";

const targets: readonly MultiProfileTarget[] = [
  {
    id: "default",
    displayName: "ChatGPT",
    role: "default",
    managed: false,
    state: "stopped",
    sessionState: "available",
    sharedAppServerSupported: true,
    responsesRouteSupported: true,
  },
  {
    id: "local.plura-desktop.profile2",
    displayName: "ChatGPT Profile 2",
    role: "managed",
    managed: true,
    profileIndex: 2,
    state: "stopped",
    sessionState: "available",
    sharedAppServerSupported: true,
    responsesRouteSupported: true,
  },
];

function session(targetId: string): MultiProfileTargetSession {
  return {
    targetId,
    state: "available",
    ...(targetId === "default" ? {} : { desktopProcessId: 4321 }),
  };
}

describe("Multi-Profile native-target adapter", () => {
  test("keeps slot mapping inside the optional adapter instead of the Codex core", async () => {
    const adapter = new MultiProfileNativeTargetAdapter({
      launcherCli: "/fixture/plura-desktop",
      client: {
        targets: async () => targets,
        targetSession: async targetId => session(targetId),
        quitTarget: async targetId => session(targetId),
      },
    });
    expect((await adapter.resolve(1)).target).toMatchObject({ slot: 1, adapterKind: "multi-profile", id: "default", managed: false });
    expect((await adapter.resolve(2)).target).toMatchObject({ slot: 2, adapterKind: "multi-profile", id: "local.plura-desktop.profile2", managed: true });
    expect((await adapter.resolve(2)).session.desktopProcessId).toBe(4321);
    expect(adapter.profileRuntimeEnvironment((await adapter.resolve(2)).target)).toEqual({
      CHATGPT_TELA_PRODUCT_NATIVE_TARGET_KIND: "multi-profile",
      CHATGPT_TELA_PRODUCT_TARGET_ID: "local.plura-desktop.profile2",
      CHATGPT_TELA_PRODUCT_LAUNCHER_CLI: "/fixture/plura-desktop",
    });
  });
});

describe("built-in default Desktop native-target adapter", () => {
  test("represents one ordinary account without a Multi-Profile control dependency", async () => {
    let runningPid: number | undefined;
    const adapter = new DefaultDesktopNativeTargetAdapter({
      installation: {
        platform: "darwin",
        chatGptExecutable: "/fixture/ChatGPT",
        codexExecutable: "/fixture/codex",
        codexHome: "/fixture/.codex",
        userDataDir: "/fixture/Codex",
        normalQuitSupported: true,
      },
      processIds: async () => runningPid ? [runningPid] : [],
      normalQuit: async (_installation, pid) => {
        expect(runningPid).toBeDefined();
        expect(pid).toBe(runningPid!);
        runningPid = undefined;
      },
    });
    expect((await adapter.resolve(1))).toMatchObject({
      target: { slot: 1, adapterKind: "default-desktop", id: "default", managed: false },
      session: { targetId: "default", state: "available" },
    });
    await expect(adapter.resolve(2)).rejects.toThrow("Multi-Profile");
    runningPid = 4242;
    expect(await adapter.session("default")).toEqual({
      targetId: "default",
      state: "restart-required",
      desktopProcessId: 4242,
    });
    expect(await adapter.quit("default")).toEqual({ targetId: "default", state: "available" });
    expect(adapter.profileRuntimeEnvironment((await adapter.resolve(1)).target)).toEqual({
      CHATGPT_TELA_PRODUCT_NATIVE_TARGET_KIND: "default-desktop",
      CHATGPT_TELA_PRODUCT_TARGET_ID: "default",
    });
  });
});

describe("composite product native-target adapter", () => {
  test("slot 1 is always built-in default while slot 2+ is optional Multi-Profile", async () => {
    const defaultAdapter = new DefaultDesktopNativeTargetAdapter({
      installation: {
        platform: "darwin",
        chatGptExecutable: "/fixture/ChatGPT",
        codexExecutable: "/fixture/codex",
        codexHome: "/fixture/.codex",
        userDataDir: "/fixture/Codex",
        normalQuitSupported: true,
      },
      processIds: async () => [],
      normalQuit: async () => {},
    });
    const multiProfile = new MultiProfileNativeTargetAdapter({
      launcherCli: "/fixture/plura-desktop",
      client: {
        targets: async () => targets,
        targetSession: async targetId => session(targetId),
        quitTarget: async targetId => session(targetId),
      },
    });
    const adapter = new CompositeNativeTargetAdapter({ defaultDesktop: defaultAdapter, multiProfile });
    expect((await adapter.resolve(1)).target.adapterKind).toBe("default-desktop");
    expect((await adapter.resolve(2)).target).toMatchObject({
      adapterKind: "multi-profile",
      id: "local.plura-desktop.profile2",
      slot: 2,
    });
    expect((await adapter.profiles()).map(item => [item.target.slot, item.target.adapterKind])).toEqual([
      [1, "default-desktop"],
      [2, "multi-profile"],
    ]);
  });

  test("single-profile install exposes only default and gives an actionable extra-profile error", async () => {
    const defaultAdapter = new DefaultDesktopNativeTargetAdapter({
      installation: {
        platform: "darwin",
        chatGptExecutable: "/fixture/ChatGPT",
        codexExecutable: "/fixture/codex",
        codexHome: "/fixture/.codex",
        userDataDir: "/fixture/Codex",
        normalQuitSupported: true,
      },
      processIds: async () => [],
      normalQuit: async () => {},
    });
    const adapter = new CompositeNativeTargetAdapter({ defaultDesktop: defaultAdapter });
    expect((await adapter.profiles()).map(item => item.target.slot)).toEqual([1]);
    await expect(adapter.resolve(2)).rejects.toThrow("optional Multi-Profile adapter");
  });

  test("a missing optional launcher never blocks the built-in default profile", async () => {
    const defaultAdapter = new DefaultDesktopNativeTargetAdapter({
      installation: {
        platform: "darwin",
        chatGptExecutable: "/fixture/ChatGPT",
        codexExecutable: "/fixture/codex",
        codexHome: "/fixture/.codex",
        userDataDir: "/fixture/Codex",
        normalQuitSupported: true,
      },
      processIds: async () => [],
      normalQuit: async () => {},
    });
    const optional = new MultiProfileNativeTargetAdapter({ launcherCli: "/definitely/missing/plura-desktop" });
    const adapter = new CompositeNativeTargetAdapter({ defaultDesktop: defaultAdapter, multiProfile: optional });
    expect((await adapter.resolve(1)).target.adapterKind).toBe("default-desktop");
    expect((await adapter.profiles()).map(item => item.target.slot)).toEqual([1]);
    await expect(adapter.resolve(2)).rejects.toThrow("optional Multi-Profile launcher is unavailable");
  });
});

test("provider failure and later removal preserve the same default owner and exact quit consent", async () => {
  let pid: number | undefined = 111;
  let available = true;
  const quitCalls: unknown[] = [];
  const primary = new DefaultDesktopNativeTargetAdapter({
    installation: { platform: "linux", chatGptExecutable: "/fixture/app", codexExecutable: "/fixture/codex", codexHome: "/fixture/home", userDataDir: "/fixture/data", normalQuitSupported: true },
    processIds: async () => pid ? [pid] : [],
    normalQuit: async (_, actual) => { quitCalls.push(actual); pid = undefined; },
  });
  const optional = new MultiProfileNativeTargetAdapter({ launcherCli: "/fixture/provider", client: {
    targets: async () => { if (!available) throw new Error("provider removed"); return targets; },
    targetSession: async id => session(id), quitTarget: async (id, _, expected) => { quitCalls.push([id, expected]); return session(id); },
  } });
  const combined = new CompositeNativeTargetAdapter({ defaultDesktop: primary, multiProfile: optional });
  expect((await combined.profiles()).map(p => p.target.slot)).toEqual([1, 2]);
  await combined.quit("local.plura-desktop.profile2", undefined, 4321);
  expect(quitCalls).toEqual([["local.plura-desktop.profile2", 4321]]);
  available = false;
  expect((await combined.profiles()).map(p => p.target.slot)).toEqual([1]);
  expect((await combined.resolve(1)).session.desktopProcessId).toBe(111);
  await expect(combined.quit("default", undefined, 222)).rejects.toThrow("changed since confirmation");
  expect(pid).toBe(111);
  await combined.quit("default", undefined, 111);
  expect(quitCalls).toEqual([["local.plura-desktop.profile2", 4321], 111]);
  expect((await new CompositeNativeTargetAdapter({ defaultDesktop: primary }).resolve(1)).session.state).toBe("available");
});

test("normal quit diagnostics distinguish request acceptance from observed exit without app identity", async () => {
  const {mkdtempSync,readFileSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const root=mkdtempSync(join(tmpdir(),'tela-quit-diagnostics-')),file=join(root,'events.jsonl');
  const prior=process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;let pid:number|undefined=7654;
  process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=file;
  const adapter=new DefaultDesktopNativeTargetAdapter({installation:{platform:'darwin',
    chatGptExecutable:'/private-fixture/chat',codexExecutable:'/private-fixture/codex',codexHome:'/private-fixture/home',userDataDir:'/private-fixture/data',normalQuitSupported:true},
    processIds:async()=>pid?[pid]:[],normalQuit:async()=>{pid=undefined;}});
  try{
    await adapter.quit('default',undefined,7654);
    const text=readFileSync(file,'utf8'),rows=text.trim().split('\n').map(l=>JSON.parse(l));
    expect(rows.find(r=>r.stage==='desktop_quit_requested')).toMatchObject({accepted:true});
    expect(rows.find(r=>r.stage==='desktop_quit_observed')).toMatchObject({exit_observed:true,phase:'closed'});
    expect(text).not.toContain('7654');expect(text).not.toContain('private-fixture');
  }finally{if(prior===undefined)delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=prior;rmSync(root,{recursive:true,force:true});}
});
