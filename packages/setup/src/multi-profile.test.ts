import { describe, expect, test } from "bun:test";
import type {
  MultiProfileControlResult,
  MultiProfileControlRunner,
} from "./multi-profile";
import {
  MultiProfileControlClient,
  multiProfileCommandFromEnvironment,
} from "./multi-profile";

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
      id: "local.codex-multi-profile-launcher.profile2",
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
  test("discovers managed targets only through the public versioned JSON contract", async () => {
    const runner = new FixtureRunner();
    runner.results.push(result(targetsContract()));
    const client = new MultiProfileControlClient({ command: ["/opt/bin/codex-profile"], runner });

    const targets = await client.targets();

    expect(targets).toEqual([{
      id: "local.codex-multi-profile-launcher.profile2",
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
      command: ["/opt/bin/codex-profile"],
      arguments: ["targets", "--json"],
    }]);
  });

  test("launch passes only route metadata on argv and keeps the credential in child environment", async () => {
    const runner = new FixtureRunner();
    runner.results.push(result(targetsContract()));
    runner.results.push(result({
      contractVersion: 1,
      targetID: "local.codex-multi-profile-launcher.profile2",
      state: "ready",
      endpoint: "ws://127.0.0.1:19002",
      responsesRouteFingerprint: "a".repeat(64),
    }));
    const client = new MultiProfileControlClient({ command: ["/opt/bin/codex-profile"], runner });
    const secret = "s".repeat(48);

    const runtime = await client.launchManagedTarget({
      targetId: "local.codex-multi-profile-launcher.profile2",
      responsesBaseUrl: "http://127.0.0.1:18741/",
      responsesEnvKey: "CHATGPT_TELA_RUNTIME_TOKEN",
      responsesToken: secret,
    });

    expect(runtime.session).toEqual({
      targetId: "local.codex-multi-profile-launcher.profile2",
      state: "ready",
      endpoint: "ws://127.0.0.1:19002/",
      responsesRouteFingerprint: "a".repeat(64),
    });
    expect(runner.calls[1]?.arguments).toEqual([
      "launch-target",
      "--target",
      "local.codex-multi-profile-launcher.profile2",
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
    const client = new MultiProfileControlClient({ command: ["codex-profile"], runner });

    await expect(client.launchManagedTarget({
      targetId: "default",
      responsesBaseUrl: "http://127.0.0.1:18741/v1",
      responsesEnvKey: "CHATGPT_TELA_RUNTIME_TOKEN",
      responsesToken: "s".repeat(48),
    })).rejects.toThrow("stock/default ChatGPT must use ChatGPT Tela's native single-profile path");
    expect(runner.calls).toHaveLength(1);
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
    const client = new MultiProfileControlClient({ command: ["codex-profile"], runner });

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
    const client = new MultiProfileControlClient({ command: ["codex-profile"], runner });

    const session = await client.quitTarget("default");

    expect(session).toEqual({ targetId: "default", state: "available" });
    expect(runner.calls).toEqual([{
      command: ["codex-profile"],
      arguments: ["quit-target", "--target", "default", "--json"],
    }]);
  });

  test("fails closed on unsupported contracts, remote app-server endpoints, or missing route proof", async () => {
    const badContract = new FixtureRunner();
    badContract.results.push(result({ contractVersion: 2, targets: [] }));
    await expect(new MultiProfileControlClient({ command: ["codex-profile"], runner: badContract }).targets())
      .rejects.toThrow("unsupported Multi-Profile contract version");

    const remote = new FixtureRunner();
    remote.results.push(result(targetsContract()));
    remote.results.push(result({
      contractVersion: 1,
      targetID: "local.codex-multi-profile-launcher.profile2",
      state: "ready",
      endpoint: "ws://192.0.2.5:19002",
      responsesRouteFingerprint: "a".repeat(64),
    }));
    await expect(new MultiProfileControlClient({ command: ["codex-profile"], runner: remote }).launchManagedTarget({
      targetId: "local.codex-multi-profile-launcher.profile2",
      responsesBaseUrl: "http://127.0.0.1:18741/v1",
      responsesEnvKey: "CHATGPT_TELA_RUNTIME_TOKEN",
      responsesToken: "s".repeat(48),
    })).rejects.toThrow("loopback ws://");

    const missingProof = new FixtureRunner();
    missingProof.results.push(result(targetsContract()));
    missingProof.results.push(result({
      contractVersion: 1,
      targetID: "local.codex-multi-profile-launcher.profile2",
      state: "ready",
      endpoint: "ws://127.0.0.1:19002",
    }));
    await expect(new MultiProfileControlClient({ command: ["codex-profile"], runner: missingProof }).launchManagedTarget({
      targetId: "local.codex-multi-profile-launcher.profile2",
      responsesBaseUrl: "http://127.0.0.1:18741/v1",
      responsesEnvKey: "CHATGPT_TELA_RUNTIME_TOKEN",
      responsesToken: "s".repeat(48),
    })).rejects.toThrow("did not return a ready routed target session");
  });

  test("launcher integration is explicit opt-in rather than path guessing", () => {
    expect(multiProfileCommandFromEnvironment({})).toBeUndefined();
    expect(multiProfileCommandFromEnvironment({
      CHATGPT_TELA_MULTI_PROFILE_CLI: "/Users/example/Library/Application Support/PluraDesktop/plura-desktop",
    })).toEqual([
      "/Users/example/Library/Application Support/PluraDesktop/plura-desktop",
    ]);
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
    const client = new MultiProfileControlClient({ command: ["codex-profile"], runner });

    await expect(client.launchManagedTarget({
      targetId: "local.codex-multi-profile-launcher.profile2",
      responsesBaseUrl: "http://127.0.0.1:18741/v1",
      responsesEnvKey: "CHATGPT_TELA_RUNTIME_TOKEN",
      responsesToken: secret,
    })).rejects.toThrow(
      "Target is already running with a different Responses route; token=[redacted]",
    );
  });
});
