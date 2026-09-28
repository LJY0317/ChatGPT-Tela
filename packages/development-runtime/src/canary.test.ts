import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { BrowserWindowConstructorOptions } from "electron";
import type { ElectronBrowserWindowLike } from "@chatgpt-tela/electron-host";
import type { WebConversationProvider } from "@chatgpt-tela/chatgpt";
import type {
  TunnelClientCommandResult,
  TunnelClientCommandRunner,
} from "@chatgpt-tela/mcp";
import {
  MultiProfileControlClient,
  type MultiProfileControlResult,
  type MultiProfileControlRunner,
} from "@chatgpt-tela/setup";
import {
  loadDevelopmentCanaryConfig,
  loadDevelopmentCanaryPreflightConfig,
  startDevelopmentCanary,
} from "./canary";
import {
  bindChatGptTelaAccount,
  resolveChatGptTelaBrowserProfile,
} from "./browser-profile";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "chatgpt-tela-canary-test-"));
}

function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const value = server.port;
  if (typeof value !== "number") throw new Error("fixture failed to allocate TCP port");
  void server.stop(true);
  return value;
}

class FakeWindow implements ElectronBrowserWindowLike {
  destroyed = false;
  readonly webContents = {
    executeJavaScript: async () => 0,
    isDestroyed: () => this.destroyed,
  };
  async loadURL(): Promise<void> {}
  show(): void {}
  hide(): void {}
  isDestroyed(): boolean { return this.destroyed; }
  destroy(): void { this.destroyed = true; }
}

class FixtureMultiProfileRunner implements MultiProfileControlRunner {
  readonly results: MultiProfileControlResult[] = [];
  readonly calls: Array<{ arguments: readonly string[]; environment?: Readonly<Record<string, string>> }> = [];

  async run(_command: readonly [string, ...string[]], input: {
    readonly arguments: readonly string[];
    readonly environment?: Readonly<Record<string, string>>;
  }): Promise<MultiProfileControlResult> {
    this.calls.push({
      arguments: [...input.arguments],
      ...(input.environment ? { environment: { ...input.environment } } : {}),
    });
    const result = this.results.shift();
    if (!result) throw new Error("fixture Multi-Profile runner has no result");
    return result;
  }
}

function multiResult(value: unknown): MultiProfileControlResult {
  return { stdout: JSON.stringify(value), stderr: "", exitCode: 0 };
}

class FixtureTunnelRunner implements TunnelClientCommandRunner {
  readonly results: TunnelClientCommandResult[] = [];
  readonly calls: Array<{ arguments: readonly string[]; environment: Readonly<Record<string, string>> }> = [];

  async run(input: {
    readonly executable: string;
    readonly arguments: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
  }): Promise<TunnelClientCommandResult> {
    this.calls.push({
      arguments: [...input.arguments],
      environment: { ...input.environment },
    });
    const result = this.results.shift();
    if (!result) throw new Error("fixture tunnel-client runner has no result");
    return result;
  }
}

function tunnelResult(value: unknown): TunnelClientCommandResult {
  return { stdout: JSON.stringify(value), stderr: "", exitCode: 0 };
}

function capabilityProvider(ready: boolean): WebConversationProvider {
  return {
    async observeCapabilities() {
      return ready
        ? {
            state: "proven" as const,
            value: { observed: new Set(["composer", "send"]) },
            evidence: ["fixture-ready"],
          }
        : {
            state: "probable" as const,
            value: { observed: new Set<string>() },
            evidence: ["fixture-not-ready"],
          };
    },
    async submitTurn() { throw new Error("not used by readiness fixture"); },
    async observeTurn() { throw new Error("not used by readiness fixture"); },
    async armToolContinuation() { throw new Error("not used by readiness fixture"); },
    async waitForTurnEvent() { throw new Error("not used by readiness fixture"); },
  };
}

const FIXTURE_ACCOUNT = "a".repeat(64);
const FIXTURE_CONTAINER = "b".repeat(64);

function bindFixtureAccount(root: string, slot = 1, fingerprint = FIXTURE_ACCOUNT): void {
  bindChatGptTelaAccount(resolveChatGptTelaBrowserProfile({ slot, profileRoot: root }), fingerprint);
}

const fixtureAccountIdentityObserver = async () => ({
  accountFingerprint: FIXTURE_ACCOUNT,
  containerFingerprint: FIXTURE_CONTAINER,
  accountStructure: "personal" as const,
});

describe("development canary configuration", () => {
  test("preflight config needs no runtime or MCP bearer secrets", () => {
    const root = scratch();
    try {
      const config = loadDevelopmentCanaryPreflightConfig({
        CHATGPT_TELA_CANARY_CODEX_HOME: root,
        CHATGPT_TELA_CANARY_PROFILE_SLOT: "1",
        CHATGPT_TELA_CANARY_CONNECTOR_NAME: "ChatGPT Tela Development",
        CHATGPT_TELA_PROFILE_ROOT: root,
        CHATGPT_TELA_CANARY_RESPONSES_PORT: "18741",
        CHATGPT_TELA_CANARY_MCP_LOCAL_PORT: "18742",
        CHATGPT_TELA_CANARY_MCP_PUBLIC_URL: "https://chatgpt-tela.example.ts.net/mcp",
        CHATGPT_TELA_CANARY_MCP_PUBLIC_AUTH: "bearer",
      });
      expect(config.responsesPort).toBe(18741);
      expect(config.mcpAbi).toBe("development");
      expect(config.browserProfile.slot).toBe(1);
      expect(config.chatGptTelaProfileId).toBe("Profile1-ChatGPT-Tela");
      expect(config.browserUserDataDir).toBe(join(root, "Canary-Profile1"));
      expect(config.mcp.kind).toBe("existing-https");
      if (config.mcp.kind !== "existing-https") throw new Error("expected existing HTTPS preflight config");
      expect(config.mcp.authentication).toBe("bearer");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("requires an explicit Codex profile/home and keeps secrets only in environment input", () => {
    const root = scratch();
    try {
      const config = loadDevelopmentCanaryConfig({
        CHATGPT_TELA_CANARY_CODEX_HOME: root,
        CHATGPT_TELA_CANARY_PROFILE_SLOT: "1",
        CHATGPT_TELA_CANARY_CONNECTOR_NAME: "ChatGPT Tela Development",
        CHATGPT_TELA_PROFILE_ROOT: root,
        CHATGPT_TELA_CANARY_RESPONSES_PORT: "18741",
        CHATGPT_TELA_CANARY_RESPONSES_TOKEN: "r".repeat(48),
        CHATGPT_TELA_CANARY_MCP_LOCAL_PORT: "18742",
        CHATGPT_TELA_CANARY_MCP_PUBLIC_URL: "https://chatgpt-tela.example.ts.net/mcp",
        CHATGPT_TELA_CANARY_MCP_PUBLIC_AUTH: "bearer",
        CHATGPT_TELA_CANARY_MCP_BEARER_TOKEN: "x".repeat(48),
      });

      expect(config.nativeProfile).toEqual({
        kind: "stock",
        codexHome: root,
        sqliteHome: root,
      });
      expect(config.chatGptTelaProfileId).toBe("Profile1-ChatGPT-Tela");
      expect(config.browserUserDataDir).toBe(join(root, "Canary-Profile1"));
      expect(config.contextCacheDir).toBe(join(root, "Canary-Profile1", "context-checkpoints"));
      expect(config.webContextBudgetTokens).toBeUndefined();
      expect(config.webTurnTimeoutMs).toBe(120_000);
      expect(config.responsesPort).toBe(18741);
      expect(config.mcpAbi).toBe("development");
      expect(config.mcp.kind).toBe("existing-https");
      if (config.mcp.kind !== "existing-https") throw new Error("expected existing HTTPS MCP config");
      expect(config.mcp.publicUrl.href).toBe("https://chatgpt-tela.example.ts.net/mcp");
      expect(config.mcp.authentication.kind).toBe("bearer");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("runtime secrets may come from private bounded files without entering the canary environment", () => {
    const root = scratch();
    const responsesFile = join(root, "responses.token");
    const mcpFile = join(root, "mcp.token");
    writeFileSync(responsesFile, `${"r".repeat(48)}\n`, { mode: 0o600 });
    writeFileSync(mcpFile, `${"m".repeat(48)}\n`, { mode: 0o600 });
    try {
      const config = loadDevelopmentCanaryConfig({
        CHATGPT_TELA_CANARY_CODEX_HOME: root,
        CHATGPT_TELA_CANARY_PROFILE_SLOT: "1",
        CHATGPT_TELA_CANARY_CONNECTOR_NAME: "ChatGPT Tela Development",
        CHATGPT_TELA_PROFILE_ROOT: root,
        CHATGPT_TELA_CANARY_RESPONSES_PORT: "18741",
        CHATGPT_TELA_CANARY_RESPONSES_TOKEN_FILE: responsesFile,
        CHATGPT_TELA_CANARY_MCP_LOCAL_PORT: "18742",
        CHATGPT_TELA_CANARY_MCP_PUBLIC_URL: "https://chatgpt-tela.example.ts.net/mcp",
        CHATGPT_TELA_CANARY_MCP_PUBLIC_AUTH: "bearer",
        CHATGPT_TELA_CANARY_MCP_BEARER_TOKEN_FILE: mcpFile,
      });

      expect(config.responsesToken).toBe("r".repeat(48));
      expect(config.mcp.kind).toBe("existing-https");
      if (config.mcp.kind !== "existing-https" || config.mcp.authentication.kind !== "bearer") {
        throw new Error("expected bearer MCP config");
      }
      expect(config.mcp.authentication.token).toBe("m".repeat(48));
      expect(config.mcp.authentication.secretReference)
        .toBe("file:CHATGPT_TELA_CANARY_MCP_BEARER_TOKEN_FILE");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("secret files fail closed on ambiguity, symlinks, broad permissions, or multiline contents", () => {
    const root = scratch();
    const good = join(root, "good.token");
    const link = join(root, "linked.token");
    const broad = join(root, "broad.token");
    const multiline = join(root, "multiline.token");
    writeFileSync(good, `${"s".repeat(48)}\n`, { mode: 0o600 });
    symlinkSync(good, link);
    writeFileSync(broad, "b".repeat(48), { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(broad, 0o644);
    writeFileSync(multiline, `${"x".repeat(32)}\n${"y".repeat(32)}\n`, { mode: 0o600 });
    const base = {
      CHATGPT_TELA_CANARY_CODEX_HOME: root,
      CHATGPT_TELA_CANARY_PROFILE_SLOT: "1",
      CHATGPT_TELA_CANARY_CONNECTOR_NAME: "ChatGPT Tela Development",
      CHATGPT_TELA_PROFILE_ROOT: root,
      CHATGPT_TELA_CANARY_RESPONSES_PORT: "18741",
      CHATGPT_TELA_CANARY_MCP_LOCAL_PORT: "18742",
      CHATGPT_TELA_CANARY_MCP_PUBLIC_URL: "https://chatgpt-tela.example.ts.net/mcp",
      CHATGPT_TELA_CANARY_MCP_PUBLIC_AUTH: "bearer",
      CHATGPT_TELA_CANARY_MCP_BEARER_TOKEN: "m".repeat(48),
    };
    try {
      expect(() => loadDevelopmentCanaryConfig({
        ...base,
        CHATGPT_TELA_CANARY_RESPONSES_TOKEN: "r".repeat(48),
        CHATGPT_TELA_CANARY_RESPONSES_TOKEN_FILE: good,
      })).toThrow("accepts only one");
      expect(() => loadDevelopmentCanaryConfig({
        ...base,
        CHATGPT_TELA_CANARY_RESPONSES_TOKEN_FILE: link,
      })).toThrow("regular non-symlink file");
      if (process.platform !== "win32") {
        expect(() => loadDevelopmentCanaryConfig({
          ...base,
          CHATGPT_TELA_CANARY_RESPONSES_TOKEN_FILE: broad,
        })).toThrow("group or world permissions");
      }
      expect(() => loadDevelopmentCanaryConfig({
        ...base,
        CHATGPT_TELA_CANARY_RESPONSES_TOKEN_FILE: multiline,
      })).toThrow("exactly one non-empty secret line");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not guess the default Native profile and requires explicit opt-in for public no-auth MCP", () => {
    expect(() => loadDevelopmentCanaryConfig({})).toThrow("CHATGPT_TELA_CANARY_PROFILE_SLOT");

    const root = scratch();
    try {
      const base = {
        CHATGPT_TELA_CANARY_CODEX_HOME: root,
        CHATGPT_TELA_CANARY_PROFILE_SLOT: "1",
        CHATGPT_TELA_CANARY_CONNECTOR_NAME: "ChatGPT Tela Development",
        CHATGPT_TELA_PROFILE_ROOT: root,
        CHATGPT_TELA_CANARY_RESPONSES_PORT: "18741",
        CHATGPT_TELA_CANARY_RESPONSES_TOKEN: "r".repeat(48),
        CHATGPT_TELA_CANARY_MCP_LOCAL_PORT: "18742",
        CHATGPT_TELA_CANARY_MCP_PUBLIC_URL: "https://public.example.test/mcp",
        CHATGPT_TELA_CANARY_MCP_PUBLIC_AUTH: "none",
      };
      expect(() => loadDevelopmentCanaryConfig(base)).toThrow("requires CHATGPT_TELA_CANARY_ALLOW_UNAUTHENTICATED_PUBLIC_MCP=1");
      const allowed = loadDevelopmentCanaryConfig({
        ...base,
        CHATGPT_TELA_CANARY_ALLOW_UNAUTHENTICATED_PUBLIC_MCP: "1",
      });
      expect(allowed.mcp.kind).toBe("existing-https");
      if (allowed.mcp.kind !== "existing-https") throw new Error("expected existing HTTPS MCP config");
      expect(allowed.mcp.authentication.kind).toBe("none");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("development canary rejects the product public ABI selector", () => {
    const root = scratch();
    try {
      const base = {
        CHATGPT_TELA_CANARY_CODEX_HOME: root,
        CHATGPT_TELA_CANARY_PROFILE_SLOT: "1",
        CHATGPT_TELA_CANARY_CONNECTOR_NAME: "ChatGPT Tela",
        CHATGPT_TELA_PROFILE_ROOT: root,
        CHATGPT_TELA_CANARY_RESPONSES_PORT: "18741",
        CHATGPT_TELA_CANARY_MCP_LOCAL_PORT: "18742",
        CHATGPT_TELA_CANARY_MCP_PUBLIC_URL: "https://chatgpt-tela.example.ts.net/stable",
        CHATGPT_TELA_CANARY_MCP_PUBLIC_AUTH: "bearer",
      };
      expect(loadDevelopmentCanaryPreflightConfig(base).mcpAbi).toBe("development");
      expect(() => loadDevelopmentCanaryPreflightConfig({
        ...base,
        CHATGPT_TELA_CANARY_MCP_ABI: "stable",
      })).toThrow("must be development");
      expect(() => loadDevelopmentCanaryPreflightConfig({
        ...base,
        CHATGPT_TELA_CANARY_MCP_ABI: "v2",
      })).toThrow("must be development");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("legacy Codex config-mutation flags are rejected", () => {
    const root = scratch();
    const base = {
      CHATGPT_TELA_CANARY_CODEX_HOME: root,
      CHATGPT_TELA_CANARY_PROFILE_SLOT: "1",
      CHATGPT_TELA_CANARY_CONNECTOR_NAME: "ChatGPT Tela Development",
      CHATGPT_TELA_PROFILE_ROOT: root,
      CHATGPT_TELA_CANARY_RESPONSES_PORT: "18741",
      CHATGPT_TELA_CANARY_RESPONSES_TOKEN: "r".repeat(48),
      CHATGPT_TELA_CANARY_MCP_LOCAL_PORT: "18742",
      CHATGPT_TELA_CANARY_MCP_PUBLIC_URL: "https://chatgpt-tela.example.ts.net/mcp",
      CHATGPT_TELA_CANARY_MCP_PUBLIC_AUTH: "bearer",
      CHATGPT_TELA_CANARY_MCP_BEARER_TOKEN: "x".repeat(48),
    };
    try {
      expect(() => loadDevelopmentCanaryConfig({
        ...base,
        CHATGPT_TELA_CANARY_INSTALL_CODEX_ROUTE: "1",
      })).toThrow("no longer supported");
      expect(() => loadDevelopmentCanaryConfig({
        ...base,
        CHATGPT_TELA_CANARY_ROUTE_STATE_DIR: join(root, "canary-state"),
      })).toThrow("no longer supported");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Multi-Profile mode is explicit, needs only the public control CLI/target, and forbids config mutation", () => {
    const root = scratch();
    const controlCli = join(root, "plura-desktop");
    writeFileSync(controlCli, "fixture\n");
    const base = {
      CHATGPT_TELA_CANARY_NATIVE_MODE: "multi-profile",
      CHATGPT_TELA_PLURA_DESKTOP_CLI: controlCli,
      CHATGPT_TELA_CANARY_PLURA_DESKTOP_TARGET: "local.plura-desktop.profile2",
      CHATGPT_TELA_CANARY_PROFILE_SLOT: "2",
      CHATGPT_TELA_CANARY_CONNECTOR_NAME: "ChatGPT Tela Development",
      CHATGPT_TELA_PROFILE_ROOT: root,
      CHATGPT_TELA_CANARY_RESPONSES_PORT: "18741",
      CHATGPT_TELA_CANARY_RESPONSES_TOKEN: "r".repeat(48),
      CHATGPT_TELA_CANARY_MCP_LOCAL_PORT: "18742",
      CHATGPT_TELA_CANARY_MCP_PUBLIC_URL: "https://chatgpt-tela.example.ts.net/mcp",
      CHATGPT_TELA_CANARY_MCP_PUBLIC_AUTH: "bearer",
      CHATGPT_TELA_CANARY_MCP_BEARER_TOKEN: "x".repeat(48),
    };
    try {
      const config = loadDevelopmentCanaryConfig(base);
      expect(config.nativeProfile).toEqual({
        kind: "multi-profile",
        controlCli,
        targetId: "local.plura-desktop.profile2",
      });
      expect(() => loadDevelopmentCanaryConfig({
        ...base,
        CHATGPT_TELA_CANARY_INSTALL_CODEX_ROUTE: "1",
      })).toThrow("no longer supported");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Multi-Profile target slot cannot reuse another ChatGPT Tela account profile", () => {
    const root = scratch();
    const controlCli = join(root, "plura-desktop");
    writeFileSync(controlCli, "fixture\n");
    try {
      expect(() => loadDevelopmentCanaryPreflightConfig({
        CHATGPT_TELA_CANARY_NATIVE_MODE: "multi-profile",
        CHATGPT_TELA_PLURA_DESKTOP_CLI: controlCli,
        CHATGPT_TELA_CANARY_PLURA_DESKTOP_TARGET: "local.plura-desktop.profile2",
        CHATGPT_TELA_CANARY_PROFILE_SLOT: "1",
        CHATGPT_TELA_CANARY_CONNECTOR_NAME: "ChatGPT Tela Development",
        CHATGPT_TELA_PROFILE_ROOT: root,
        CHATGPT_TELA_CANARY_RESPONSES_PORT: "18741",
        CHATGPT_TELA_CANARY_MCP_LOCAL_PORT: "18742",
        CHATGPT_TELA_CANARY_MCP_PUBLIC_URL: "https://chatgpt-tela.example.ts.net/mcp",
        CHATGPT_TELA_CANARY_MCP_PUBLIC_AUTH: "bearer",
      })).toThrow("must use CHATGPT_TELA_CANARY_PROFILE_SLOT=2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("canary Web turn deadline is bounded and may be explicitly overridden", () => {
    const root = scratch();
    const base = {
      CHATGPT_TELA_CANARY_CODEX_HOME: root,
      CHATGPT_TELA_CANARY_PROFILE_SLOT: "1",
      CHATGPT_TELA_CANARY_CONNECTOR_NAME: "ChatGPT Tela Development",
      CHATGPT_TELA_PROFILE_ROOT: root,
      CHATGPT_TELA_CANARY_RESPONSES_PORT: "18741",
      CHATGPT_TELA_CANARY_RESPONSES_TOKEN: "r".repeat(48),
      CHATGPT_TELA_CANARY_MCP_LOCAL_PORT: "18742",
      CHATGPT_TELA_CANARY_MCP_PUBLIC_URL: "https://chatgpt-tela.example.ts.net/mcp",
      CHATGPT_TELA_CANARY_MCP_PUBLIC_AUTH: "bearer",
      CHATGPT_TELA_CANARY_MCP_BEARER_TOKEN: "x".repeat(48),
    };
    try {
      expect(() => loadDevelopmentCanaryConfig({
        ...base,
        CHATGPT_TELA_CANARY_WEB_TURN_TIMEOUT_MS: "0",
      })).toThrow("must be a positive integer");
      expect(loadDevelopmentCanaryConfig({
        ...base,
        CHATGPT_TELA_CANARY_WEB_TURN_TIMEOUT_MS: "1500",
      }).webTurnTimeoutMs).toBe(1500);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("OpenAI Secure MCP Tunnel mode needs an explicit tunnel-client, tunnel id, and runtime key but no public URL", () => {
    const root = scratch();
    const tunnelClient = join(root, "tunnel-client");
    writeFileSync(tunnelClient, "fixture\n");
    try {
      const config = loadDevelopmentCanaryConfig({
        CHATGPT_TELA_CANARY_CODEX_HOME: root,
        CHATGPT_TELA_CANARY_PROFILE_SLOT: "1",
        CHATGPT_TELA_CANARY_CONNECTOR_NAME: "ChatGPT Tela Development",
        CHATGPT_TELA_PROFILE_ROOT: root,
        CHATGPT_TELA_CANARY_RESPONSES_PORT: "18741",
        CHATGPT_TELA_CANARY_RESPONSES_TOKEN: "r".repeat(48),
        CHATGPT_TELA_CANARY_MCP_LOCAL_PORT: "18742",
        CHATGPT_TELA_CANARY_MCP_EXPOSURE: "openai-secure-tunnel",
        CHATGPT_TELA_TUNNEL_CLIENT: tunnelClient,
        CHATGPT_TELA_CANARY_OPENAI_TUNNEL_ID: "tunnel_0123456789abcdef0123456789abcdef",
        CHATGPT_TELA_CANARY_OPENAI_TUNNEL_RUNTIME_API_KEY: "k".repeat(48),
      });

      expect(config.mcp).toEqual({
        kind: "openai-secure-tunnel",
        localPort: 18742,
        tunnelClient,
        runtimeAlias: "chatgpt-tela-canary",
        tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
        runtimeApiKey: "k".repeat(48),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Web context budget is optional transport policy and must be a positive integer when set", () => {
    const root = scratch();
    const base = {
      CHATGPT_TELA_CANARY_CODEX_HOME: root,
      CHATGPT_TELA_CANARY_PROFILE_SLOT: "1",
      CHATGPT_TELA_CANARY_CONNECTOR_NAME: "ChatGPT Tela Development",
      CHATGPT_TELA_PROFILE_ROOT: root,
      CHATGPT_TELA_CANARY_RESPONSES_PORT: "18741",
      CHATGPT_TELA_CANARY_RESPONSES_TOKEN: "r".repeat(48),
      CHATGPT_TELA_CANARY_MCP_LOCAL_PORT: "18742",
      CHATGPT_TELA_CANARY_MCP_PUBLIC_URL: "https://chatgpt-tela.example.ts.net/mcp",
      CHATGPT_TELA_CANARY_MCP_PUBLIC_AUTH: "bearer",
      CHATGPT_TELA_CANARY_MCP_BEARER_TOKEN: "x".repeat(48),
    };
    try {
      expect(() => loadDevelopmentCanaryConfig({
        ...base,
        CHATGPT_TELA_CANARY_WEB_CONTEXT_BUDGET_TOKENS: "0",
      })).toThrow("must be a positive integer");
      expect(loadDevelopmentCanaryConfig({
        ...base,
        CHATGPT_TELA_CANARY_WEB_CONTEXT_BUDGET_TOKENS: "4096",
      }).webContextBudgetTokens).toBe(4096);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Responses and MCP listeners cannot claim the same loopback port", () => {
    const root = scratch();
    try {
      expect(() => loadDevelopmentCanaryConfig({
        CHATGPT_TELA_CANARY_CODEX_HOME: root,
        CHATGPT_TELA_CANARY_PROFILE_SLOT: "1",
        CHATGPT_TELA_CANARY_CONNECTOR_NAME: "ChatGPT Tela Development",
        CHATGPT_TELA_PROFILE_ROOT: root,
        CHATGPT_TELA_CANARY_RESPONSES_PORT: "18741",
        CHATGPT_TELA_CANARY_RESPONSES_TOKEN: "r".repeat(48),
        CHATGPT_TELA_CANARY_MCP_LOCAL_PORT: "18741",
        CHATGPT_TELA_CANARY_MCP_PUBLIC_URL: "https://chatgpt-tela.example.ts.net/mcp",
        CHATGPT_TELA_CANARY_MCP_PUBLIC_AUTH: "bearer",
        CHATGPT_TELA_CANARY_MCP_BEARER_TOKEN: "x".repeat(48),
      })).toThrow("must be different");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("development canary runtime", () => {
  test("proves the configured public MCP route before reporting the canary ready", async () => {
    const root = scratch();
    const originalConfig = 'model = "gpt-5.6-codex"\n';
    writeFileSync(join(root, "config.toml"), originalConfig);
    const responsesPort = freePort();
    const localMcpPort = freePort();
    const token = "b".repeat(48);
    const config = loadDevelopmentCanaryConfig({
      CHATGPT_TELA_CANARY_CODEX_HOME: root,
      CHATGPT_TELA_CANARY_PROFILE_SLOT: "1",
      CHATGPT_TELA_CANARY_CONNECTOR_NAME: "ChatGPT Tela Development",
      CHATGPT_TELA_PROFILE_ROOT: root,
      CHATGPT_TELA_CANARY_RESPONSES_PORT: String(responsesPort),
      CHATGPT_TELA_CANARY_RESPONSES_TOKEN: "r".repeat(48),
      CHATGPT_TELA_CANARY_MCP_LOCAL_PORT: String(localMcpPort),
      CHATGPT_TELA_CANARY_MCP_PUBLIC_URL: "https://chatgpt-tela-canary.invalid/mcp",
      CHATGPT_TELA_CANARY_MCP_PUBLIC_AUTH: "bearer",
      CHATGPT_TELA_CANARY_MCP_BEARER_TOKEN: token,
    });
    const created: BrowserWindowConstructorOptions[] = [];

    const rewriteFetch: FetchLike = async (input, init) => {
      const original = input instanceof Request ? input : new Request(input, init);
      const localUrl = new URL(original.url);
      localUrl.protocol = "http:";
      localUrl.hostname = "127.0.0.1";
      localUrl.port = String(localMcpPort);
      return fetch(new Request(localUrl, original));
    };

    let canary;
    try {
      bindFixtureAccount(root);
      canary = await startDevelopmentCanary(config, {
        fetch: rewriteFetch,
        provider: capabilityProvider(true),
        accountIdentityObserver: fixtureAccountIdentityObserver,
        electron: {
          async loadRuntime() {
            class RuntimeWindow extends FakeWindow {
              constructor(options: BrowserWindowConstructorOptions) {
                super();
                created.push(options);
              }
            }
            return {
              app: {
                setPath() {},
                async whenReady() {},
              },
              BrowserWindow: RuntimeWindow,
            };
          },
        },
      });

      expect(canary.runtime.mcp.kind).toBe("http-exposure");
      if (canary.runtime.mcp.kind !== "http-exposure") throw new Error("expected HTTP exposure mode");
      if (canary.runtime.mcp.exposure.publicEndpoint.kind !== "https") throw new Error("expected HTTPS endpoint");
      expect(canary.runtime.mcp.exposure.publicEndpoint.url.href).toBe("https://chatgpt-tela-canary.invalid/mcp");
      expect(canary.runtime.responses.port).toBe(responsesPort);
      expect(canary.nativeProfile.kind).toBe("stock");
      if (canary.nativeProfile.kind !== "stock") throw new Error("expected stock canary");
      expect(canary.nativeProfile.processRoute.envKey).toBe("CHATGPT_TELA_CANARY_RESPONSES_TOKEN");
      expect(canary.nativeProfile.processRoute.arguments[0]).toBe("--ignore-user-config");
      expect(canary.nativeProfile.processRoute.arguments.join(" "))
        .toContain(`base_url=\"http://127.0.0.1:${responsesPort}/v1\"`);
      expect(readFileSync(join(root, "config.toml"), "utf8")).toBe(originalConfig);
      expect(canary.mcpAbi).toBe("development");
      expect(canary.mcpSchemaFingerprint)
        .toBe("cff62bee1aeca5d887522df6b6685418fba8d895638ca2abad726c2ff9d367cd");
      expect(created).toHaveLength(1);
      await canary.stop();
      expect(readFileSync(join(root, "config.toml"), "utf8")).toBe(originalConfig);
    } finally {
      await canary?.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ChatGPT readiness failure leaves stock Codex config untouched", async () => {
    const root = scratch();
    const originalConfig = 'model = "gpt-5.6-codex"\n';
    writeFileSync(join(root, "config.toml"), originalConfig);
    const responsesPort = freePort();
    const localMcpPort = freePort();
    const token = "b".repeat(48);
    const config = loadDevelopmentCanaryConfig({
      CHATGPT_TELA_CANARY_CODEX_HOME: root,
      CHATGPT_TELA_CANARY_PROFILE_SLOT: "1",
      CHATGPT_TELA_CANARY_CONNECTOR_NAME: "ChatGPT Tela Development",
      CHATGPT_TELA_PROFILE_ROOT: root,
      CHATGPT_TELA_CANARY_RESPONSES_PORT: String(responsesPort),
      CHATGPT_TELA_CANARY_RESPONSES_TOKEN: "r".repeat(48),
      CHATGPT_TELA_CANARY_MCP_LOCAL_PORT: String(localMcpPort),
      CHATGPT_TELA_CANARY_MCP_PUBLIC_URL: "https://chatgpt-tela-canary.invalid/mcp",
      CHATGPT_TELA_CANARY_MCP_PUBLIC_AUTH: "bearer",
      CHATGPT_TELA_CANARY_MCP_BEARER_TOKEN: token,
    });
    const rewriteFetch: FetchLike = async (input, init) => {
      const original = input instanceof Request ? input : new Request(input, init);
      const localUrl = new URL(original.url);
      localUrl.protocol = "http:";
      localUrl.hostname = "127.0.0.1";
      localUrl.port = String(localMcpPort);
      return fetch(new Request(localUrl, original));
    };

    try {
      await expect(startDevelopmentCanary(config, {
        fetch: rewriteFetch,
        provider: capabilityProvider(false),
        electron: {
          async loadRuntime() {
            return {
              app: { setPath() {}, async whenReady() {} },
              BrowserWindow: FakeWindow as unknown as new (options: BrowserWindowConstructorOptions) => FakeWindow,
            };
          },
        },
      })).rejects.toThrow("ChatGPT profile readiness is not proven: probable");
      expect(readFileSync(join(root, "config.toml"), "utf8")).toBe(originalConfig);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("managed profile uses only the public launcher contract and keeps Tela alive until the target quits", async () => {
    const root = scratch();
    const controlCli = join(root, "plura-desktop");
    writeFileSync(controlCli, "fixture\n");
    const responsesPort = freePort();
    const localMcpPort = freePort();
    const mcpToken = "b".repeat(48);
    const responsesToken = "r".repeat(48);
    const targetId = "local.plura-desktop.profile2";
    const routeFingerprint = "a".repeat(64);
    const config = loadDevelopmentCanaryConfig({
      CHATGPT_TELA_CANARY_NATIVE_MODE: "multi-profile",
      CHATGPT_TELA_PLURA_DESKTOP_CLI: controlCli,
      CHATGPT_TELA_CANARY_PLURA_DESKTOP_TARGET: targetId,
      CHATGPT_TELA_CANARY_PROFILE_SLOT: "2",
      CHATGPT_TELA_CANARY_CONNECTOR_NAME: "ChatGPT Tela Development",
      CHATGPT_TELA_PROFILE_ROOT: root,
      CHATGPT_TELA_CANARY_RESPONSES_PORT: String(responsesPort),
      CHATGPT_TELA_CANARY_RESPONSES_TOKEN: responsesToken,
      CHATGPT_TELA_CANARY_MCP_LOCAL_PORT: String(localMcpPort),
      CHATGPT_TELA_CANARY_MCP_PUBLIC_URL: "https://chatgpt-tela-canary.invalid/mcp",
      CHATGPT_TELA_CANARY_MCP_PUBLIC_AUTH: "bearer",
      CHATGPT_TELA_CANARY_MCP_BEARER_TOKEN: mcpToken,
    });
    const runner = new FixtureMultiProfileRunner();
    runner.results.push(multiResult({
      contractVersion: 1,
      platform: "macos",
      targets: [{
        id: targetId,
        displayName: "ChatGPT Profile 2",
        role: "managed",
        managed: true,
        state: "stopped",
        sessionState: "available",
        sharedAppServerSupported: true,
        responsesRouteSupported: true,
      }],
    }));
    runner.results.push(multiResult({
      contractVersion: 1,
      targetID: targetId,
      state: "ready",
      endpoint: "ws://127.0.0.1:19002",
      responsesRouteFingerprint: routeFingerprint,
    }));
    runner.results.push(multiResult({
      contractVersion: 1,
      targetID: targetId,
      state: "ready",
      endpoint: "ws://127.0.0.1:19002",
      responsesRouteFingerprint: routeFingerprint,
    }));
    runner.results.push(multiResult({
      contractVersion: 1,
      targetID: targetId,
      state: "stopped",
    }));
    const multiProfileClient = new MultiProfileControlClient({ command: [controlCli], runner });
    const rewriteFetch: FetchLike = async (input, init) => {
      const original = input instanceof Request ? input : new Request(input, init);
      const localUrl = new URL(original.url);
      localUrl.protocol = "http:";
      localUrl.hostname = "127.0.0.1";
      localUrl.port = String(localMcpPort);
      return fetch(new Request(localUrl, original));
    };

    let canary;
    try {
      bindFixtureAccount(root, 2);
      canary = await startDevelopmentCanary(config, {
        fetch: rewriteFetch,
        multiProfileClient,
        provider: capabilityProvider(true),
        accountIdentityObserver: fixtureAccountIdentityObserver,
        electron: {
          async loadRuntime() {
            return {
              app: { setPath() {}, async whenReady() {} },
              BrowserWindow: FakeWindow as unknown as new (options: BrowserWindowConstructorOptions) => FakeWindow,
            };
          },
        },
      });

      expect(canary.nativeProfile).toEqual({
        kind: "multi-profile",
        targetId,
        endpoint: "ws://127.0.0.1:19002/",
        responsesRouteFingerprint: routeFingerprint,
      });
      expect(runner.calls[1]?.arguments).toContain("launch-target");
      expect(runner.calls[1]?.environment).toEqual({
        CHATGPT_TELA_CANARY_RESPONSES_TOKEN: responsesToken,
      });
      expect(runner.calls[1]?.arguments.join(" ")).not.toContain(responsesToken);

      await expect(canary.stop()).rejects.toThrow("quit ChatGPT Profile 2 normally");
      const portStillOwned = await fetch(new URL("responses", canary.runtime.responses.baseUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${responsesToken}`, "content-type": "application/json" },
        body: "{}",
      });
      expect(portStillOwned.status).not.toBe(0);

      await canary.stop();
    } finally {
      if (canary) {
        try { await canary.stop(); } catch {}
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Secure MCP Tunnel canary owns only the official local tunnel runtime, not a public ingress", async () => {
    const root = scratch();
    const tunnelClient = join(root, "tunnel-client");
    writeFileSync(tunnelClient, "fixture\n");
    const responsesPort = freePort();
    const localMcpPort = freePort();
    const runtimeKey = "k".repeat(48);
    const tunnelId = "tunnel_0123456789abcdef0123456789abcdef";
    const config = loadDevelopmentCanaryConfig({
      CHATGPT_TELA_CANARY_CODEX_HOME: root,
      CHATGPT_TELA_CANARY_PROFILE_SLOT: "1",
      CHATGPT_TELA_CANARY_CONNECTOR_NAME: "ChatGPT Tela Development",
      CHATGPT_TELA_PROFILE_ROOT: root,
      CHATGPT_TELA_CANARY_RESPONSES_PORT: String(responsesPort),
      CHATGPT_TELA_CANARY_RESPONSES_TOKEN: "r".repeat(48),
      CHATGPT_TELA_CANARY_MCP_LOCAL_PORT: String(localMcpPort),
      CHATGPT_TELA_CANARY_MCP_EXPOSURE: "openai-secure-tunnel",
      CHATGPT_TELA_TUNNEL_CLIENT: tunnelClient,
      CHATGPT_TELA_CANARY_OPENAI_TUNNEL_ID: tunnelId,
      CHATGPT_TELA_CANARY_OPENAI_TUNNEL_RUNTIME_API_KEY: runtimeKey,
    });
    const runner = new FixtureTunnelRunner();
    runner.results.push(tunnelResult({ alias: "chatgpt-tela-canary" }));
    runner.results.push(tunnelResult({
      alias: "chatgpt-tela-canary",
      tunnel_id: tunnelId,
      process_running: true,
      healthy: true,
      ready: true,
      control_plane_poll_health: { ok: true },
    }));
    runner.results.push(tunnelResult({ alias: "chatgpt-tela-canary", stopped: true }));

    bindFixtureAccount(root);
    const canary = await startDevelopmentCanary(config, {
      tunnelClientRunner: runner,
      provider: capabilityProvider(true),
      accountIdentityObserver: fixtureAccountIdentityObserver,
      electron: {
        async loadRuntime() {
          return {
            app: { setPath() {}, async whenReady() {} },
            BrowserWindow: FakeWindow as unknown as new (options: BrowserWindowConstructorOptions) => FakeWindow,
          };
        },
      },
    });
    try {
      expect(canary.runtime.mcp.kind).toBe("http-exposure");
      if (canary.runtime.mcp.kind !== "http-exposure") throw new Error("expected HTTP exposure mode");
      expect(canary.runtime.mcp.exposure.local.authentication).toBe("none");
      expect(canary.runtime.mcp.exposure.publicEndpoint).toEqual({
        kind: "openai-secure-tunnel",
        tunnelId,
        authentication: { kind: "openai-tunnel" },
      });
      expect(runner.calls[0]?.arguments).toContain("runtimes");
      expect(runner.calls[0]?.arguments).toContain("connect");
      expect(runner.calls[0]?.arguments).toContain(`env:CHATGPT_TELA_OPENAI_TUNNEL_RUNTIME_API_KEY`);
      expect(runner.calls[0]?.arguments.join(" ")).not.toContain(runtimeKey);
      expect(runner.calls[0]?.environment).toEqual({
        CHATGPT_TELA_OPENAI_TUNNEL_RUNTIME_API_KEY: runtimeKey,
      });
    } finally {
      await canary.stop();
      rmSync(root, { recursive: true, force: true });
    }
    expect(runner.calls.at(-1)?.arguments.slice(0, 3)).toEqual([
      "runtimes",
      "stop",
      "chatgpt-tela-canary",
    ]);
  });
});
