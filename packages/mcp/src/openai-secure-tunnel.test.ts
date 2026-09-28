import { describe, expect, test } from "bun:test";
import type { DevelopmentMcpHttpServer } from "./http-server";
import {
  OpenAiSecureMcpTunnelExposure,
  type TunnelClientCommandResult,
  type TunnelClientCommandRunner,
} from "./openai-secure-tunnel";

class FixtureRunner implements TunnelClientCommandRunner {
  readonly calls: Array<{
    executable: string;
    arguments: readonly string[];
    environment: Readonly<Record<string, string>>;
  }> = [];
  readonly results: TunnelClientCommandResult[] = [];

  async run(input: {
    readonly executable: string;
    readonly arguments: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
  }): Promise<TunnelClientCommandResult> {
    this.calls.push({
      executable: input.executable,
      arguments: [...input.arguments],
      environment: { ...input.environment },
    });
    const result = this.results.shift();
    if (!result) throw new Error("fixture tunnel-client runner has no result");
    return result;
  }
}

function localServer(authentication: "none" | "bearer" = "none"): DevelopmentMcpHttpServer {
  return {
    hostname: "127.0.0.1",
    port: 18742,
    endpointUrl: new URL("http://127.0.0.1:18742/mcp"),
    authentication,
    ...(authentication === "bearer" ? { bearerToken: "b".repeat(48) } : {}),
    activeSessionCount: 0,
    async stop() {},
  };
}

function ok(stdout: unknown = {}): TunnelClientCommandResult {
  return { stdout: JSON.stringify(stdout), stderr: "", exitCode: 0 };
}

function status(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    alias: "chatgpt-tela-dev",
    tunnel_id: "tunnel_0123456789abcdef0123456789abcdef",
    process_running: true,
    healthy: true,
    ready: true,
    ui_url: "http://127.0.0.1:32123/ui",
    control_plane_poll_health: { ok: true },
    ...overrides,
  };
}

describe("OpenAI Secure MCP Tunnel exposure", () => {
  test("uses tunnel-client native runtime lifecycle and keeps the runtime key out of argv", async () => {
    const runner = new FixtureRunner();
    runner.results.push(ok({ alias: "chatgpt-tela-dev" }));
    runner.results.push(ok(status()));
    runner.results.push(ok({ alias: "chatgpt-tela-dev", stopped: true }));
    const secret = "rk_" + "s".repeat(48);
    const exposure = new OpenAiSecureMcpTunnelExposure({
      tunnelClient: "/opt/openai/tunnel-client",
      alias: "chatgpt-tela-dev",
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeApiKey: secret,
      local: localServer(),
      runner,
    });

    const endpoint = await exposure.prepare();
    expect(endpoint).toEqual({
      kind: "openai-secure-tunnel",
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      authentication: { kind: "openai-tunnel" },
    });
    expect(await exposure.verify(endpoint)).toEqual({ ready: true });
    await exposure.stop();
    await exposure.stop();

    expect(runner.calls.map(call => call.arguments.slice(0, 2))).toEqual([
      ["runtimes", "connect"],
      ["runtimes", "status"],
      ["runtimes", "stop"],
    ]);
    const connect = runner.calls[0]!;
    expect(connect.arguments).toContain("env:CHATGPT_TELA_OPENAI_TUNNEL_RUNTIME_API_KEY");
    expect(connect.arguments).toContain("http://127.0.0.1:18742/mcp");
    expect(connect.arguments.join(" ")).not.toContain(secret);
    expect(connect.environment).toEqual({
      CHATGPT_TELA_OPENAI_TUNNEL_RUNTIME_API_KEY: secret,
    });
  });

  test("structured status fails readiness when control-plane polling is unhealthy", async () => {
    const runner = new FixtureRunner();
    runner.results.push(ok({}));
    runner.results.push(ok(status({ control_plane_poll_health: { ok: false } })));
    runner.results.push(ok({}));
    const exposure = new OpenAiSecureMcpTunnelExposure({
      tunnelClient: "/opt/openai/tunnel-client",
      alias: "chatgpt-tela-dev",
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeApiKey: "r".repeat(48),
      local: localServer(),
      runner,
    });

    const endpoint = await exposure.prepare();
    expect(await exposure.verify(endpoint)).toEqual({
      ready: false,
      detail: "process_running=true healthy=true ready=true control_plane_poll_healthy=false",
    });
    await exposure.stop();
  });

  test("rejects a locally bearer-protected server rather than pretending runtimes connect forwards its secret", () => {
    expect(() => new OpenAiSecureMcpTunnelExposure({
      tunnelClient: "/opt/openai/tunnel-client",
      alias: "chatgpt-tela-dev",
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeApiKey: "r".repeat(48),
      local: localServer("bearer"),
    })).toThrow("must delegate ingress authentication to the tunnel");
  });

  test("requires a Tela-owned alias and exact tunnel status identity", async () => {
    expect(() => new OpenAiSecureMcpTunnelExposure({
      tunnelClient: "/opt/openai/tunnel-client",
      alias: "someone-else",
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeApiKey: "r".repeat(48),
      local: localServer(),
    })).toThrow("namespaced");

    const runner = new FixtureRunner();
    runner.results.push(ok({}));
    runner.results.push(ok(status({ tunnel_id: "tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })));
    runner.results.push(ok({}));
    const exposure = new OpenAiSecureMcpTunnelExposure({
      tunnelClient: "/opt/openai/tunnel-client",
      alias: "chatgpt-tela-dev",
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeApiKey: "r".repeat(48),
      local: localServer(),
      runner,
    });
    const endpoint = await exposure.prepare();
    await expect(exposure.verify(endpoint)).rejects.toThrow("does not belong to the owned alias/tunnel");
    await exposure.stop();
  });

  test("command failures redact the runtime key", async () => {
    const runner = new FixtureRunner();
    const secret = "r".repeat(48);
    runner.results.push({ stdout: "", stderr: `auth failed: ${secret}`, exitCode: 1 });
    const exposure = new OpenAiSecureMcpTunnelExposure({
      tunnelClient: "/opt/openai/tunnel-client",
      alias: "chatgpt-tela-dev",
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeApiKey: secret,
      local: localServer(),
      runner,
    });

    await expect(exposure.prepare()).rejects.toThrow("auth failed: [redacted]");
  });
});
