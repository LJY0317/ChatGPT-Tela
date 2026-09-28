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
    id: "local.profile2",
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
  return { targetId, state: "available" };
}

describe("Multi-Profile native-target adapter", () => {
  test("keeps slot mapping inside the optional adapter instead of the Codex core", async () => {
    const adapter = new MultiProfileNativeTargetAdapter({
      launcherCli: "/fixture/codex-profile",
      client: {
        targets: async () => targets,
        targetSession: async targetId => session(targetId),
        quitTarget: async targetId => session(targetId),
      },
    });
    expect((await adapter.resolve(1)).target).toMatchObject({ slot: 1, adapterKind: "multi-profile", id: "default", managed: false });
    expect((await adapter.resolve(2)).target).toMatchObject({ slot: 2, adapterKind: "multi-profile", id: "local.profile2", managed: true });
    expect(adapter.profileRuntimeEnvironment((await adapter.resolve(2)).target)).toEqual({
      CHATGPT_TELA_PRODUCT_NATIVE_TARGET_KIND: "multi-profile",
      CHATGPT_TELA_PRODUCT_TARGET_ID: "local.profile2",
      CHATGPT_TELA_PRODUCT_LAUNCHER_CLI: "/fixture/codex-profile",
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
      launcherCli: "/fixture/codex-profile",
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
      id: "local.profile2",
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
