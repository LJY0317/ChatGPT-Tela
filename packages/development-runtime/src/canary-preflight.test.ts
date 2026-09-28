import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { BrowserWindowConstructorOptions } from "electron";
import type { ElectronBrowserWindowLike } from "@chatgpt-tela/electron-host";
import type { WebConversationProvider } from "@chatgpt-tela/chatgpt";
import {
  MultiProfileControlClient,
  type MultiProfileControlResult,
  type MultiProfileControlRunner,
} from "@chatgpt-tela/setup";
import { loadDevelopmentCanaryPreflightConfig } from "./canary";
import { preflightDevelopmentCanary } from "./canary-preflight";
import {
  bindChatGptTelaAccount,
  resolveChatGptTelaBrowserProfile,
} from "./browser-profile";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "chatgpt-tela-preflight-test-"));
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

function electronRuntime() {
  return {
    async loadRuntime() {
      return {
        app: { setPath() {}, async whenReady() {} },
        BrowserWindow: class extends FakeWindow {
          constructor(_options: BrowserWindowConstructorOptions) { super(); }
        },
      };
    },
  };
}

function readinessProvider(ready: boolean): Pick<WebConversationProvider, "observeCapabilities"> {
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
  };
}

const FIXTURE_ACCOUNT = "a".repeat(64);
const fixtureAccountIdentityObserver = async () => ({ accountFingerprint: FIXTURE_ACCOUNT });

function bindFixtureAccount(root: string, slot: number): void {
  bindChatGptTelaAccount(resolveChatGptTelaBrowserProfile({ slot, profileRoot: root }), FIXTURE_ACCOUNT);
}

class FixtureMultiProfileRunner implements MultiProfileControlRunner {
  readonly calls: string[][] = [];
  readonly results: MultiProfileControlResult[] = [];

  async run(
    _command: readonly [string, ...string[]],
    input: { readonly arguments: readonly string[] },
  ): Promise<MultiProfileControlResult> {
    this.calls.push([...input.arguments]);
    const result = this.results.shift();
    if (!result) throw new Error("fixture result missing");
    return result;
  }
}

function jsonResult(value: unknown): MultiProfileControlResult {
  return { stdout: JSON.stringify(value), stderr: "", exitCode: 0 };
}

describe("development canary preflight", () => {
  test("stock preflight proves non-mutating prerequisites and leaves Codex config byte-identical", async () => {
    const root = scratch();
    const configPath = join(root, "config.toml");
    const original = 'model = "gpt-5.6-codex"\n';
    writeFileSync(configPath, original);
    try {
      const config = loadDevelopmentCanaryPreflightConfig({
        CHATGPT_TELA_CANARY_CODEX_HOME: root,
        CHATGPT_TELA_CANARY_PROFILE_SLOT: "1",
        CHATGPT_TELA_PROFILE_ROOT: root,
        CHATGPT_TELA_CANARY_RESPONSES_PORT: String(freePort()),
        CHATGPT_TELA_CANARY_MCP_LOCAL_PORT: String(freePort()),
        CHATGPT_TELA_CANARY_MCP_PUBLIC_URL: "https://chatgpt-tela.example.test/mcp",
        CHATGPT_TELA_CANARY_MCP_PUBLIC_AUTH: "bearer",
      });
      bindFixtureAccount(root, 1);

      const result = await preflightDevelopmentCanary(config, {
        provider: readinessProvider(true),
        accountIdentityObserver: fixtureAccountIdentityObserver,
        electron: electronRuntime(),
      });

      expect(result.ready).toBe(true);
      expect(result.checks.find(check => check.id === "stock-process-route")?.status).toBe("pass");
      expect(result.checks.find(check => check.id === "chatgpt-readiness")?.status).toBe("pass");
      expect(readFileSync(configPath, "utf8")).toBe(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unprepared ChatGPT profile is the only blocked check when other stock prerequisites pass", async () => {
    const root = scratch();
    let windowsCreated = 0;
    writeFileSync(join(root, "config.toml"), 'model = "gpt-5.6-codex"\n');
    try {
      const config = loadDevelopmentCanaryPreflightConfig({
        CHATGPT_TELA_CANARY_CODEX_HOME: root,
        CHATGPT_TELA_CANARY_PROFILE_SLOT: "1",
        CHATGPT_TELA_PROFILE_ROOT: root,
        CHATGPT_TELA_CANARY_RESPONSES_PORT: String(freePort()),
        CHATGPT_TELA_CANARY_MCP_LOCAL_PORT: String(freePort()),
        CHATGPT_TELA_CANARY_MCP_PUBLIC_URL: "https://chatgpt-tela.example.test/mcp",
        CHATGPT_TELA_CANARY_MCP_PUBLIC_AUTH: "bearer",
      });

      const result = await preflightDevelopmentCanary(config, {
        provider: readinessProvider(false),
        electron: {
          async loadRuntime() {
            return {
              app: { setPath() {}, async whenReady() {} },
              BrowserWindow: class extends FakeWindow {
                constructor(_options: BrowserWindowConstructorOptions) {
                  super();
                  windowsCreated += 1;
                }
              },
            };
          },
        },
      });
      const blocked = result.checks.filter(check => check.status === "blocked");
      expect(result.ready).toBe(false);
      expect(blocked.map(check => check.id)).toEqual(["chatgpt-readiness"]);
      expect(windowsCreated).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("managed preflight reads the public contract but never launches or reroutes the target", async () => {
    const root = scratch();
    const cli = join(root, "codex-profile");
    writeFileSync(cli, "fixture\n");
    const runner = new FixtureMultiProfileRunner();
    runner.results.push(jsonResult({
      contractVersion: 1,
      targets: [{
        id: "local.codex-multi-profile-launcher.profile2",
        displayName: "ChatGPT Profile 2",
        managed: true,
        role: "managed",
        state: "running",
        sessionState: "ready",
        sharedAppServerSupported: true,
        responsesRouteSupported: true,
      }],
    }));
    runner.results.push(jsonResult({
      contractVersion: 1,
      targetID: "local.codex-multi-profile-launcher.profile2",
      state: "ready",
      endpoint: "ws://127.0.0.1:55123",
    }));
    try {
      const config = loadDevelopmentCanaryPreflightConfig({
        CHATGPT_TELA_CANARY_NATIVE_MODE: "multi-profile",
        CHATGPT_TELA_MULTI_PROFILE_CLI: cli,
        CHATGPT_TELA_CANARY_MULTI_PROFILE_TARGET: "local.codex-multi-profile-launcher.profile2",
        CHATGPT_TELA_CANARY_PROFILE_SLOT: "2",
        CHATGPT_TELA_PROFILE_ROOT: root,
        CHATGPT_TELA_CANARY_RESPONSES_PORT: String(freePort()),
        CHATGPT_TELA_CANARY_MCP_LOCAL_PORT: String(freePort()),
        CHATGPT_TELA_CANARY_MCP_PUBLIC_URL: "https://chatgpt-tela.example.test/mcp",
        CHATGPT_TELA_CANARY_MCP_PUBLIC_AUTH: "bearer",
      });
      bindFixtureAccount(root, 2);
      const client = new MultiProfileControlClient({ command: [cli], runner });
      const result = await preflightDevelopmentCanary(config, {
        provider: readinessProvider(true),
        accountIdentityObserver: fixtureAccountIdentityObserver,
        electron: electronRuntime(),
        multiProfileClient: client,
      });

      expect(result.ready).toBe(false);
      expect(result.checks.find(check => check.id === "managed-target-contract")?.status).toBe("pass");
      expect(result.checks.find(check => check.id === "managed-target-restart-boundary")?.status).toBe("blocked");
      expect(runner.calls).toEqual([
        ["targets", "--json"],
        ["target-session", "--target", "local.codex-multi-profile-launcher.profile2", "--json"],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
