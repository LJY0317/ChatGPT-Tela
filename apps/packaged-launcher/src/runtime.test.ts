import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProductConfig } from "@chatgpt-tela/product-config";
import {
  applySignedPackagedInstallFromPayload,
  buildPackagedPayload,
  createEd25519PackagedPayloadSigner,
  packagedRepairJournalPath,
  packagedUpgradeJournalPath,
  planSignedPackagedInstallFromPayload,
  resolveProductPaths,
  type ServiceRegistrationCommandResult,
  type ServiceRegistrationCommandRunner,
} from "@chatgpt-tela/product-lifecycle";
import { resolvePackagedServiceLaunch } from "./runtime";

class SystemdFixtureRunner implements ServiceRegistrationCommandRunner {
  readonly loaded = new Set<string>();
  readonly enabled = new Set<string>();

  async run(command: string, arguments_: readonly string[]): Promise<ServiceRegistrationCommandResult> {
    if (command !== "systemctl") throw new Error(`unexpected command ${command}`);
    const unit = arguments_.at(-1) ?? "";
    if (arguments_.includes("show")) {
      const present = this.loaded.has(unit);
      return { exitCode: present ? 0 : 1, stdout: present ? "loaded\n" : "not-found\n", stderr: "" };
    }
    if (arguments_.includes("is-enabled")) {
      const present = this.enabled.has(unit);
      return { exitCode: present ? 0 : 1, stdout: present ? "enabled\n" : "disabled\n", stderr: "" };
    }
    if (arguments_.includes("daemon-reload")) return { exitCode: 0, stdout: "", stderr: "" };
    if (arguments_.includes("enable")) {
      this.loaded.add(unit);
      this.enabled.add(unit);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected systemctl args ${arguments_.join(" ")}`);
  }
}

function buildFixture(root: string) {
  const input = join(root, "input");
  const payload = join(root, "payload");
  mkdirSync(join(input, "electron", "bin"), { recursive: true });
  writeFileSync(join(input, "launcher"), "launcher\n", { mode: 0o755 });
  for (const service of ["gateway", "chat", "codex"] as const) {
    writeFileSync(join(input, service), `${service}\n`, { mode: 0o755 });
  }
  writeFileSync(join(input, "profile-runtime.cjs"), "module.exports = {};\n");
  writeFileSync(join(input, "electron", "bin", "electron"), "electron\n", { mode: 0o755 });
  const keys = generateKeyPairSync("ed25519");
  buildPackagedPayload({
    outputPath: payload,
    productVersion: "1.2.3",
    launcherSourcePath: join(input, "launcher"),
    services: {
      gateway: { executableSourcePath: join(input, "gateway") },
      chat: { executableSourcePath: join(input, "chat") },
      codex: { executableSourcePath: join(input, "codex") },
    },
    profileRuntime: {
      electronBundleSourcePath: join(input, "electron"),
      electronExecutableRelativePath: "bin/electron",
      entrypointSourcePath: join(input, "profile-runtime.cjs"),
    },
    signer: createEd25519PackagedPayloadSigner({ keyId: "launcher-fixture", privateKey: keys.privateKey }),
  });
  return { payload, keys };
}

describe("packaged service launcher", () => {
  test("signed install registers the stable launcher while the launcher resolves the manifest-defined service binary", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-packaged-launcher-"));
    const home = join(root, "home");
    mkdirSync(home);
    const { payload, keys } = buildFixture(root);
    const runner = new SystemdFixtureRunner();
    const pathOptions = { platform: "linux" as const, home, environment: {} };
    try {
      const planned = await planSignedPackagedInstallFromPayload({
        payloadSourcePath: payload,
        trustedKeys: { "launcher-fixture": keys.publicKey },
        ...pathOptions,
        runner,
      });
      expect(planned.blueprint.services.map(service => service.definition)).toEqual(expect.arrayContaining([
        expect.objectContaining({ platform: "linux" }),
      ]));
      await applySignedPackagedInstallFromPayload({
        planned,
        payloadSourcePath: payload,
        trustedKeys: { "launcher-fixture": keys.publicKey },
        ...pathOptions,
        runner,
      });

      const paths = resolveProductPaths(pathOptions);
      writeProductConfig({
        version: 1,
        publicMcpAbi: "stable",
        exposure: {
          kind: "existing-https",
          publicUrl: "https://example.test/chatgpt-tela",
          localPort: 18743,
          authentication: "none",
          allowUnauthenticatedPublicEndpoint: true,
        },
      }, join(paths.configRoot, "product-v1.json"));

      const gateway = resolvePackagedServiceLaunch({
        service: "gateway",
        payloadRoot: paths.binaryRoot,
        launcherExecutablePath: join(paths.binaryRoot, "chatgpt-tela"),
        pathOptions,
      });
      const installedRoot = realpathSync(paths.binaryRoot);
      expect(gateway.executable).toBe(join(installedRoot, "services", "gateway"));
      expect(gateway.arguments).toEqual([]);
      expect(gateway.environment).toMatchObject({
        CHATGPT_TELA_PRODUCT_VERSION: "1.2.3",
        CHATGPT_TELA_GATEWAY_PUBLIC_MCP_URL: "https://example.test/chatgpt-tela",
        CHATGPT_TELA_GATEWAY_LOCAL_MCP_PORT: "18743",
        CHATGPT_TELA_GATEWAY_PUBLIC_MCP_ABI: "stable",
      });
      expect(gateway.environment.CHATGPT_TELA_DIAGNOSTIC_FILE)
        .toBe(join(paths.logsRoot, "gateway.diagnostics.jsonl"));

      const codex = resolvePackagedServiceLaunch({
        service: "codex",
        payloadRoot: paths.binaryRoot,
        launcherExecutablePath: join(paths.binaryRoot, "chatgpt-tela"),
        pathOptions,
      });
      expect(codex.executable).toBe(join(installedRoot, "services", "codex"));
      expect(codex.environment.CHATGPT_TELA_PRODUCT_PROFILE_RUNTIME_EXECUTABLE)
        .toBe(join(installedRoot, "electron", "bin", "electron"));
      expect(codex.environment.CHATGPT_TELA_PRODUCT_PROFILE_RUNTIME_ENTRYPOINT)
        .toBe(join(installedRoot, "runtime", "profile-runtime.cjs"));
      expect(codex.environment.CHATGPT_TELA_PRODUCT_PUBLIC_MCP_ABI).toBe("stable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("launcher refuses a different executable path even when the payload root is otherwise valid", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-packaged-launcher-identity-"));
    const home = join(root, "home");
    mkdirSync(home);
    const { payload, keys } = buildFixture(root);
    const runner = new SystemdFixtureRunner();
    const pathOptions = { platform: "linux" as const, home, environment: {} };
    try {
      const planned = await planSignedPackagedInstallFromPayload({
        payloadSourcePath: payload,
        trustedKeys: { "launcher-fixture": keys.publicKey },
        ...pathOptions,
        runner,
      });
      await applySignedPackagedInstallFromPayload({ planned, payloadSourcePath: payload,
        trustedKeys: { "launcher-fixture": keys.publicKey }, ...pathOptions, runner });
      const paths = resolveProductPaths(pathOptions);
      writeProductConfig({
        version: 1,
        publicMcpAbi: "stable",
        exposure: { kind: "existing-https", publicUrl: "https://example.test/mcp", localPort: 18743,
          authentication: "none", allowUnauthenticatedPublicEndpoint: true },
      }, join(paths.configRoot, "product-v1.json"));
      expect(() => resolvePackagedServiceLaunch({
        service: "chat",
        payloadRoot: paths.binaryRoot,
        launcherExecutablePath: join(paths.binaryRoot, "services", "chat"),
        pathOptions,
      })).toThrow("launcher executable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("launcher refuses to start services while repair or upgrade transition state is incomplete", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-packaged-launcher-transition-"));
    const home = join(root, "home");
    mkdirSync(home);
    const { payload, keys } = buildFixture(root);
    const runner = new SystemdFixtureRunner();
    const pathOptions = { platform: "linux" as const, home, environment: {} };
    try {
      const planned = await planSignedPackagedInstallFromPayload({
        payloadSourcePath: payload,
        trustedKeys: { "launcher-fixture": keys.publicKey },
        ...pathOptions,
        runner,
      });
      await applySignedPackagedInstallFromPayload({ planned, payloadSourcePath: payload,
        trustedKeys: { "launcher-fixture": keys.publicKey }, ...pathOptions, runner });
      const paths = resolveProductPaths(pathOptions);
      writeFileSync(packagedRepairJournalPath(paths), "{}\n");
      expect(() => resolvePackagedServiceLaunch({
        service: "gateway",
        payloadRoot: paths.binaryRoot,
        launcherExecutablePath: join(paths.binaryRoot, "chatgpt-tela"),
        pathOptions,
      })).toThrow("transition journal");
      rmSync(packagedRepairJournalPath(paths));
      writeFileSync(packagedUpgradeJournalPath(paths), "{}\n");
      expect(() => resolvePackagedServiceLaunch({
        service: "gateway",
        payloadRoot: paths.binaryRoot,
        launcherExecutablePath: join(paths.binaryRoot, "chatgpt-tela"),
        pathOptions,
      })).toThrow("transition journal");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
