import { describe, expect, test } from "bun:test";
import type {
  MultiProfileControlResult,
  MultiProfileControlRunner,
} from "./multi-profile";
import { MultiProfileControlClient } from "./multi-profile";

class FixtureRunner implements MultiProfileControlRunner {
  readonly calls: Array<{
    command: readonly string[];
    arguments: readonly string[];
    environment?: Readonly<Record<string, string>>;
  }> = [];
  readonly results: MultiProfileControlResult[] = [];

  async run(command: readonly [string, ...string[]], input: {
    readonly arguments: readonly string[];
    readonly environment?: Readonly<Record<string, string>>;
  }): Promise<MultiProfileControlResult> {
    this.calls.push({
      command: [...command],
      arguments: [...input.arguments],
      ...(input.environment ? { environment: { ...input.environment } } : {}),
    });
    const result = this.results.shift();
    if (!result) throw new Error("fixture runner has no result");
    return result;
  }
}

function result(value: unknown, exitCode = 0): MultiProfileControlResult {
  return { stdout: JSON.stringify(value), stderr: "", exitCode };
}

function targetsContract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: 1,
    platform: "macos",
    targets: [{
      id: "local.plura-desktop.profile2",
      displayName: "ChatGPT Profile 2",
      role: "managed",
      managed: true,
      state: "stopped",
      sessionState: "available",
      sharedAppServerSupported: true,
      responsesRouteSupported: true,
      profileIndex: 2,
      ...overrides,
    }],
  };
}

describe("optional Multi-Profile control client", () => {
  test("engine selection requires advertised support and an exact live engine byte identity", async () => {
    const engine = { executable: "/fixture/codex", sha256: "e".repeat(64) };
    for (const returnedHash of [undefined, "f".repeat(64), engine.sha256]) {
      const runner = new FixtureRunner();
      runner.results.push(result(targetsContract({ engineOverrideSupported: true })));
      runner.results.push(result({ contractVersion: 1, targetID: "local.plura-desktop.profile2", state: "ready",
        endpoint: "ws://127.0.0.1:12345", responsesRouteFingerprint: "a".repeat(64),
        ...(returnedHash ? { engineOverrideSha256: returnedHash } : {}),
      }));
      const client = new MultiProfileControlClient({ command: ["plura-desktop"], runner });
      const launched = client.launchRoutedTarget({ targetId: "local.plura-desktop.profile2",
        responsesBaseUrl: "http://127.0.0.1:12346/v1", responsesEnvKey: "TELA_TOKEN",
        responsesToken: "t".repeat(64), nativeEngine: engine });
      if (returnedHash === engine.sha256) expect((await launched).session.engineOverrideSha256).toBe(engine.sha256);
      else await expect(launched).rejects.toThrow("engine identity");
      expect(runner.calls[1]?.environment).toMatchObject({ CODEX_EXECUTABLE: engine.executable, CODEX_EXECUTABLE_SHA256: engine.sha256 });
    }
    const runner = new FixtureRunner(); runner.results.push(result(targetsContract()));
    const client = new MultiProfileControlClient({ command: ["plura-desktop"], runner });
    await expect(client.launchRoutedTarget({ targetId: "local.plura-desktop.profile2", responsesBaseUrl: "http://127.0.0.1:12346/v1",
      responsesEnvKey: "TELA_TOKEN", responsesToken: "t".repeat(64), nativeEngine: engine })).rejects.toThrow("engine selection");
    expect(runner.calls.length).toBe(1);
  });
  test("discovers managed targets only through the public versioned JSON contract", async () => {
    const runner = new FixtureRunner();
    runner.results.push(result(targetsContract()));
    const client = new MultiProfileControlClient({ command: ["/opt/bin/plura-desktop"], runner });

    const targets = await client.targets();

    expect(targets).toEqual([{
      id: "local.plura-desktop.profile2",
      displayName: "ChatGPT Profile 2",
      role: "managed",
      managed: true,
      state: "stopped",
      sessionState: "available",
      sharedAppServerSupported: true,
      responsesRouteSupported: true,
      profileIndex: 2,
    }]);
    expect(runner.calls).toEqual([{
      command: ["/opt/bin/plura-desktop"],
      arguments: ["targets", "--json"],
    }]);
  });

  test("launch passes only route metadata on argv and keeps the credential in child environment", async () => {
    const runner = new FixtureRunner();
    runner.results.push(result(targetsContract()));
    runner.results.push(result({
      contractVersion: 1,
      targetID: "local.plura-desktop.profile2",
      state: "ready",
      endpoint: "ws://127.0.0.1:19002",
      responsesRouteFingerprint: "a".repeat(64),
      desktopProcessID: 4321,
    }));
    const client = new MultiProfileControlClient({ command: ["/opt/bin/plura-desktop"], runner });
    const secret = "s".repeat(48);

    const runtime = await client.launchManagedTarget({
      targetId: "local.plura-desktop.profile2",
      responsesBaseUrl: "http://127.0.0.1:18741/",
      responsesEnvKey: "CHATGPT_TELA_RUNTIME_TOKEN",
      responsesToken: secret,
    });

    expect(runtime.session).toEqual({
      targetId: "local.plura-desktop.profile2",
      state: "ready",
      endpoint: "ws://127.0.0.1:19002/",
      responsesRouteFingerprint: "a".repeat(64),
      desktopProcessId: 4321,
    });
    expect(runner.calls[1]?.arguments).toEqual([
      "launch-target",
      "--target",
      "local.plura-desktop.profile2",
      "--responses-base-url",
      "http://127.0.0.1:18741/v1",
      "--responses-env-key",
      "CHATGPT_TELA_RUNTIME_TOKEN",
      "--json",
    ]);
    expect(runner.calls[1]?.arguments.join(" ")).not.toContain(secret);
    expect(runner.calls[1]?.environment).toEqual({ CHATGPT_TELA_RUNTIME_TOKEN: secret });
  });

  test("never routes the public default target through the optional launcher adapter", async () => {
    const runner = new FixtureRunner();
    runner.results.push(result(targetsContract({
      id: "default",
      displayName: "ChatGPT",
      role: "default",
      managed: false,
    })));
    const client = new MultiProfileControlClient({ command: ["plura-desktop"], runner });

    await expect(client.launchManagedTarget({
      targetId: "default",
      responsesBaseUrl: "http://127.0.0.1:18741/v1",
      responsesEnvKey: "CHATGPT_TELA_RUNTIME_TOKEN",
      responsesToken: "s".repeat(48),
    })).rejects.toThrow("stock/default ChatGPT must use ChatGPT Tela's native single-profile path");
    expect(runner.calls).toHaveLength(1);
  });

  test("a routed child receives its own header capability rather than the launching turn's", async () => {
    const runner = new FixtureRunner();
    runner.results.push(result(targetsContract()));
    runner.results.push(result({
      contractVersion: 1, targetID: "local.plura-desktop.profile2", state: "ready",
      endpoint: "ws://127.0.0.1:19002", responsesRouteFingerprint: "a".repeat(64),
    }));
    const client = new MultiProfileControlClient({ command: ["plura-desktop"], runner });
    const before = process.env.OPENAI_ORGANIZATION;
    process.env.OPENAI_ORGANIZATION = "other-turn-capability";
    try {
      await client.launchRoutedTarget({
        targetId: "local.plura-desktop.profile2",
        responsesBaseUrl: "http://127.0.0.1:18741/v1",
        responsesEnvKey: "LOCAL_TOKEN", responsesToken: "s".repeat(48),
        runtimeHeaderName: "OpenAI-Organization",
      });
      expect(runner.calls[1]?.environment).toEqual({
        LOCAL_TOKEN: "s".repeat(48), OPENAI_ORGANIZATION: "s".repeat(48),
      });
      expect(process.env.OPENAI_ORGANIZATION).toBe("other-turn-capability");
    } finally {
      if (before === undefined) delete process.env.OPENAI_ORGANIZATION;
      else process.env.OPENAI_ORGANIZATION = before;
    }
  });

  test("composite Profile 2 requires overlay capability and exact ready-session proof", async () => {
    const secret = "s".repeat(48);
    const launch = {
      targetId: "local.plura-desktop.profile2",
      responsesBaseUrl: "http://127.0.0.1:18741/v1",
      responsesEnvKey: "LOCAL_TOKEN",
      responsesToken: secret,
      runtimeHeaderName: "X-Local-Runtime-Token",
      modelListOverlay: {
        url: "http://127.0.0.1:18741/model-list-overlay",
        envKey: "LOCAL_TOKEN",
        token: secret,
      },
    } as const;
    const unsupported = new FixtureRunner();
    unsupported.results.push(result(targetsContract()));
    await expect(new MultiProfileControlClient({ command: ["plura-desktop"], runner: unsupported })
      .launchRoutedTarget(launch)).rejects.toThrow("model-list overlay contract");
    expect(unsupported.calls).toHaveLength(1);

    const runner = new FixtureRunner();
    runner.results.push(result(targetsContract({ modelListOverlaySupported: true })));
    runner.results.push(result({
      contractVersion: 1,
      targetID: launch.targetId,
      state: "ready",
      endpoint: "ws://127.0.0.1:19002",
      responsesRouteFingerprint: "a".repeat(64),
      modelListOverlayFingerprint: "b".repeat(64),
    }));
    const runtime = await new MultiProfileControlClient({ command: ["plura-desktop"], runner })
      .launchRoutedTarget(launch);
    expect(runtime.session.modelListOverlayFingerprint).toBe("b".repeat(64));
    expect(runner.calls[1]?.arguments).toContain("--responses-runtime-header-name");
    expect(runner.calls[1]?.arguments).toContain("--model-list-overlay-url");
    expect(runner.calls[1]?.arguments.join(" ")).not.toContain(secret);
    expect(runner.calls[1]?.environment).toEqual({ LOCAL_TOKEN: secret });
  });

  test("routed launch preserves its validated Desktop PID without a second inventory command", async () => {
    const runner = new FixtureRunner();
    runner.results.push(result(targetsContract()));
    runner.results.push(result({contractVersion:1,targetID:"local.plura-desktop.profile2",state:"ready",
      endpoint:"ws://127.0.0.1:19002",responsesRouteFingerprint:"a".repeat(64),desktopProcessID:321,
    }));
    const runtime = await new MultiProfileControlClient({command:["plura-desktop"],runner}).launchRoutedTarget({
      targetId:"local.plura-desktop.profile2",responsesBaseUrl:"http://127.0.0.1:12346/v1",
      responsesEnvKey:"LOCAL_TOKEN",responsesToken:"s".repeat(48),
    });
    expect(runtime.session.desktopProcessId).toBe(321);
    expect(runner.calls.map(call=>call.arguments[0])).toEqual(["targets","launch-target"]);
  });

  test("product routed-target API accepts the canonical default target", async () => {
    const runner = new FixtureRunner();
    runner.results.push(result(targetsContract({
      id: "default",
      displayName: "ChatGPT",
      role: "default",
      managed: false,
    })));
    runner.results.push(result({
      contractVersion: 1,
      targetID: "default",
      state: "ready",
      endpoint: "ws://127.0.0.1:19001",
      responsesRouteFingerprint: "b".repeat(64),
    }));
    const client = new MultiProfileControlClient({ command: ["plura-desktop"], runner });

    const runtime = await client.launchRoutedTarget({
      targetId: "default",
      responsesBaseUrl: "http://127.0.0.1:18741/v1",
      responsesEnvKey: "CHATGPT_TELA_RUNTIME_TOKEN",
      responsesToken: "s".repeat(48),
    });

    expect(runtime.target.managed).toBe(false);
    expect(runtime.session.targetId).toBe("default");
    expect(runner.calls[1]?.arguments).toEqual([
      "launch-target",
      "--target",
      "default",
      "--responses-base-url",
      "http://127.0.0.1:18741/v1",
      "--responses-env-key",
      "CHATGPT_TELA_RUNTIME_TOKEN",
      "--json",
    ]);
  });

  test("quit uses the public normal-target lifecycle contract", async () => {
    const runner = new FixtureRunner();
    runner.results.push(result({
      contractVersion: 1,
      targetID: "default",
      state: "available",
    }));
    const client = new MultiProfileControlClient({ command: ["plura-desktop"], runner });

    const session = await client.quitTarget("default");

    expect(session).toEqual({ targetId: "default", state: "available" });
    expect(runner.calls).toEqual([{
      command: ["plura-desktop"],
      arguments: ["quit-target", "--target", "default", "--json"],
    }]);
  });

  test("confirmed quit passes the exact observed Desktop PID to its lifecycle owner", async () => {
    const runner = new FixtureRunner();
    runner.results.push(result({ contractVersion: 1, targetID: "default", state: "available" }));
    const client = new MultiProfileControlClient({ command: ["plura-desktop"], runner });
    await client.quitTarget("default", undefined, 123);
    expect(runner.calls[0]?.arguments).toEqual(["quit-target", "--target", "default", "--expected-desktop-pid", "123", "--json"]);
    await expect(client.quitTarget("default", undefined, 0)).rejects.toThrow("Invalid expected");
    expect(runner.calls).toHaveLength(1);
  });

  test("fails closed on unsupported contracts, remote app-server endpoints, or missing route proof", async () => {
    const badContract = new FixtureRunner();
    badContract.results.push(result({ contractVersion: 2, targets: [] }));
    await expect(new MultiProfileControlClient({ command: ["plura-desktop"], runner: badContract }).targets())
      .rejects.toThrow("unsupported Multi-Profile contract version");

    const remote = new FixtureRunner();
    remote.results.push(result(targetsContract()));
    remote.results.push(result({
      contractVersion: 1,
      targetID: "local.plura-desktop.profile2",
      state: "ready",
      endpoint: "ws://192.0.2.5:19002",
      responsesRouteFingerprint: "a".repeat(64),
    }));
    await expect(new MultiProfileControlClient({ command: ["plura-desktop"], runner: remote }).launchManagedTarget({
      targetId: "local.plura-desktop.profile2",
      responsesBaseUrl: "http://127.0.0.1:18741/v1",
      responsesEnvKey: "CHATGPT_TELA_RUNTIME_TOKEN",
      responsesToken: "s".repeat(48),
    })).rejects.toThrow("loopback ws://");

    const missingProof = new FixtureRunner();
    missingProof.results.push(result(targetsContract()));
    missingProof.results.push(result({
      contractVersion: 1,
      targetID: "local.plura-desktop.profile2",
      state: "ready",
      endpoint: "ws://127.0.0.1:19002",
    }));
    await expect(new MultiProfileControlClient({ command: ["plura-desktop"], runner: missingProof }).launchManagedTarget({
      targetId: "local.plura-desktop.profile2",
      responsesBaseUrl: "http://127.0.0.1:18741/v1",
      responsesEnvKey: "CHATGPT_TELA_RUNTIME_TOKEN",
      responsesToken: "s".repeat(48),
    })).rejects.toThrow("did not return a ready routed target session");
  });

  test("preserves Plura Desktop's optional foreground process observation", async () => {
    const runner = new FixtureRunner();
    runner.results.push(result({
      contractVersion: 1,
      targetID: "local.plura-desktop.profile2",
      state: "restart-required",
      desktopProcessID: 4321,
    }));
    const client = new MultiProfileControlClient({ command: ["plura-desktop"], runner });
    expect(await client.targetSession("local.plura-desktop.profile2")).toEqual({
      targetId: "local.plura-desktop.profile2",
      state: "restart-required",
      desktopProcessId: 4321,
    });
  });

  test("rejects invalid Plura Desktop process observations", async () => {
    const runner = new FixtureRunner();
    runner.results.push(result({
      contractVersion: 1,
      targetID: "local.plura-desktop.profile2",
      state: "restart-required",
      desktopProcessID: 0,
    }));
    await expect(new MultiProfileControlClient({ command: ["plura-desktop"], runner })
      .targetSession("local.plura-desktop.profile2"))
      .rejects.toThrow("desktop process id");
  });

  test("control failures preserve actionable stderr while redacting the routed bearer", async () => {
    const runner = new FixtureRunner();
    const secret = "s".repeat(48);
    runner.results.push(result(targetsContract()));
    runner.results.push({
      stdout: "",
      stderr: `Target is already running with a different Responses route; token=${secret}`,
      exitCode: 1,
    });
    const client = new MultiProfileControlClient({ command: ["plura-desktop"], runner });

    await expect(client.launchManagedTarget({
      targetId: "local.plura-desktop.profile2",
      responsesBaseUrl: "http://127.0.0.1:18741/v1",
      responsesEnvKey: "CHATGPT_TELA_RUNTIME_TOKEN",
      responsesToken: secret,
    })).rejects.toThrow(
      "Target is already running with a different Responses route; token=[redacted]",
    );
  });
});
