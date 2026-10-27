import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProductConfig } from "@chatgpt-tela/product-config";
import {
  applyPackagedInstallFromPayload,
  buildPackagedPayload,
  packagedRepairJournalPath,
  packagedUpgradeJournalPath,
  planPackagedInstallFromPayload,
  resolveProductPaths,
  readOwnershipManifest,
  observeInstalledPackagedPayload,
  type ServiceRegistrationCommandResult,
  type ServiceRegistrationCommandRunner,
} from "@chatgpt-tela/product-lifecycle";
import { payloadRootForLauncherExecutable, resolvePackagedServiceLaunch } from "./runtime";
import { runPackagedServicesCommand } from "./services";
import { registerTemporaryFixtureCleanup } from "../../../tests/support/temporary-fixtures";

const removeFixture = registerTemporaryFixtureCleanup();

class SystemdFixtureRunner implements ServiceRegistrationCommandRunner {
  readonly loaded = new Set<string>();
  readonly enabled = new Set<string>();
  readonly running = new Set<string>();

  async run(command: string, arguments_: readonly string[]): Promise<ServiceRegistrationCommandResult> {
    if (command !== "systemctl") throw new Error(`unexpected command ${command}`);
    const unit = arguments_.at(-1) ?? "";
    if (arguments_.includes("is-active")) return { exitCode: this.running.has(unit) ? 0 : 3,
      stdout: this.running.has(unit) ? "active\n" : "inactive\n", stderr: "" };
    if (arguments_.includes("start")) { this.running.add(unit); return { exitCode: 0, stdout: "", stderr: "" }; }
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

function buildFixture(root: string, withFilePublisher = false) {
  const input = join(root, "input");
  const payload = join(root, "payload");
  mkdirSync(join(input, "electron", "bin"), { recursive: true });
  writeFileSync(join(input, "launcher"), "launcher\n", { mode: 0o755 });
  for (const service of ["gateway", "chat", "codex"] as const) {
    writeFileSync(join(input, service), `${service}\n`, { mode: 0o755 });
  }
  writeFileSync(join(input, "profile-runtime.cjs"), "module.exports = {};\n");
  writeFileSync(join(input, "electron", "bin", "electron"), "electron\n", { mode: 0o755 });

  buildPackagedPayload({
    outputPath: payload,
    productVersion: "1.2.3",
    launcherSourcePath: join(input, "launcher"),
    ...(withFilePublisher ? { workspaceFilesSourcePath: join(input, "chat") } : {}),
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
  });
  return { payload };
}

test("a failed service stop leaves later peers alone and restores only acknowledged running peers", async () => {
  for (const [gatewayRunning, restoreFails] of [[true, false], [false, false], [true, true]] as const) {
    const root = mkdtempSync(join(tmpdir(), "tela-service-stop-settlement-")), home = join(root, "home");
    mkdirSync(home); const { payload } = buildFixture(root), runner = new SystemdFixtureRunner();
    const pathOptions = { platform: "linux" as const, home, environment: {} };
    try {
      const planned = await planPackagedInstallFromPayload({ payloadSourcePath: payload, ...pathOptions, runner });
      await applyPackagedInstallFromPayload({ planned, payloadSourcePath: payload, ...pathOptions, runner });
      const units = Object.fromEntries(planned.blueprint.services.map(row => [row.service, row.resource.registrationId]));
      for (const id of Object.values(units)) runner.running.add(id);
      if (!gatewayRunning) runner.running.delete(units.gateway!);
      const calls: string[] = [];
      const result = await runPackagedServicesCommand(["services", "stop"], {
        payloadRoot: resolveProductPaths(pathOptions).binaryRoot, pathOptions, runner,
        async shutdownService(service) {
          calls.push(`stop:${service}`);
          if (service === "codex") throw Error("private quit failure detail");
          runner.running.delete(units[service]!);
        },
        async waitUntilReady(service) { calls.push(`restore:${service}`); if (restoreFails) throw Error("private readiness failure detail"); },
      });
      expect(result.success).toBe(false);
      expect(calls).toEqual(gatewayRunning ? ["stop:gateway", "stop:codex", "restore:gateway"] : ["stop:codex"]);
      expect(runner.running.has(units.chat!)).toBe(true);
      expect(runner.running.has(units.codex!)).toBe(true);
      expect(result).toMatchObject({ restoredServices: gatewayRunning && !restoreFails ? ["gateway"] : [],
        restoreFailures: restoreFails ? ["gateway"] : [] });
      expect(result.services.find(row => row.service === "gateway")?.state)
        .toBe(!gatewayRunning ? "stopped" : restoreFails ? "failed" : "running");
      expect(JSON.stringify(result)).not.toContain("private");
    } finally { removeFixture(root); }
  }
});

test("launcher discovers one app root from a real macOS executable and its external symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "tela-bundle-launcher-"));
  try {
    const app = join(root, "Tela.app"), directory = join(app, "Contents/MacOS");
    mkdirSync(directory, { recursive: true });
    const executable = join(directory, "chatgpt-tela"), link = join(root, "launcher");
    writeFileSync(executable, "launcher"); symlinkSync(executable, link);
    expect(payloadRootForLauncherExecutable(executable)).toBe(realpathSync(app));
    expect(payloadRootForLauncherExecutable(link)).toBe(realpathSync(app));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

describe("packaged service launcher", () => {
  test("only the recorded service can start at a proven final update or repair checkpoint", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-launch-restoration-")), home = join(root, "home"); mkdirSync(home);
    const { payload } = buildFixture(root), runner = new SystemdFixtureRunner();
    const pathOptions = { platform: "linux" as const, home, environment: {} };
    try {
      const planned = await planPackagedInstallFromPayload({ payloadSourcePath: payload, ...pathOptions, runner });
      await applyPackagedInstallFromPayload({ planned, payloadSourcePath: payload, ...pathOptions, runner });
      const paths = resolveProductPaths(pathOptions), ownership = readOwnershipManifest(paths.installManifest)!;
      const resource = ownership.resources.find(value => value.kind === "directory" && value.id === "product-binaries")!;
      if (resource.kind !== "directory") throw new Error("fixture binary resource missing");
      const observed = observeInstalledPackagedPayload(resource, ownership);
      if (observed.state !== "owned") throw new Error("fixture payload not owned");
      const config = { version: 1 as const, publicMcpAbi: "stable" as const, exposure: { kind: "existing-https" as const,
        publicUrl: "https://example.test/tela", localPort: 18743, authentication: "none" as const,
        allowUnauthenticatedPublicEndpoint: true as const } };
      const launch = (service: "chat" | "gateway") => resolvePackagedServiceLaunch({ service, payloadRoot: paths.binaryRoot,
        pathOptions, productConfig: config });
      const upgrade = { version: 1, installId: ownership.installId, fromVersion: "1.0.0", toVersion: ownership.productVersion,
        sourcePayloadFingerprint: "a".repeat(64), targetPayloadFingerprint: observed.receipt.payloadFingerprint,
        phase: "manifest-updated", resumeServices: ["chat"], quiescedServices: ["gateway", "codex", "chat"], resumedServices: [] };
      const saveUpgrade = (changes: object = {}) => writeFileSync(packagedUpgradeJournalPath(paths), JSON.stringify({ ...upgrade, ...changes }));
      for (const phase of ["prepared", "quiescing", "quiesced", "payload-replacing", "payload-installed"]) {
        saveUpgrade({ phase }); expect(() => launch("chat")).toThrow("transition journal");
      }
      saveUpgrade(); expect(launch("chat").service).toBe("chat");
      expect(() => launch("gateway")).toThrow("transition journal");
      for (const changes of [{ installId: "foreign" }, { toVersion: "1.2.4" }, { targetPayloadFingerprint: "0".repeat(64) },
        { quiescedServices: ["chat"] }]) {
        saveUpgrade(changes); expect(() => launch("chat")).toThrow("transition journal");
      }
      const restoring = { phase: "restoring-source", fromVersion: ownership.productVersion,
        sourcePayloadFingerprint: observed.receipt.payloadFingerprint, quiescedServices: ["gateway"] };
      saveUpgrade(restoring); expect(launch("chat").service).toBe("chat");
      expect(() => launch("gateway")).toThrow("transition journal");
      for (const changes of [{ fromVersion: "0.0.0" }, { sourcePayloadFingerprint: "0".repeat(64) }, { installId: "foreign" }]) {
        saveUpgrade({ ...restoring, ...changes }); expect(() => launch("chat")).toThrow("transition journal");
      }
      saveUpgrade(); writeFileSync(packagedRepairJournalPath(paths), "{}");
      expect(() => launch("chat")).toThrow("transition journal");
      rmSync(packagedUpgradeJournalPath(paths));
      const repair = { version: 1, installId: ownership.installId, productVersion: ownership.productVersion,
        targetPayloadFingerprint: observed.receipt.payloadFingerprint, phase: "repaired", controlledServices: ["chat"],
        repairServices: ["chat"], resumeServices: ["chat"], quiescedServices: ["chat"], repairedResources: ["product-binaries"], resumedServices: [] };
      const saveRepair = (changes: object = {}) => writeFileSync(packagedRepairJournalPath(paths), JSON.stringify({ ...repair, ...changes }));
      saveRepair(); expect(launch("chat").service).toBe("chat"); expect(() => launch("gateway")).toThrow("transition journal");
      for (const changes of [{ phase: "repairing" }, { installId: "foreign" }, { productVersion: "1.2.4" },
        { targetPayloadFingerprint: "0".repeat(64) }, { quiescedServices: [] }, { controlledServices: [] }]) {
        saveRepair(changes); expect(() => launch("chat")).toThrow("transition journal");
      }
      writeFileSync(packagedRepairJournalPath(paths), " ".repeat(16 * 1024 + 1));
      expect(() => launch("chat")).toThrow("transition journal");
      rmSync(packagedRepairJournalPath(paths));
      const foreign = join(root, "foreign-journal"); writeFileSync(foreign, JSON.stringify(repair));
      symlinkSync(foreign, packagedRepairJournalPath(paths));
      expect(() => launch("chat")).toThrow("transition journal");
    } finally { removeFixture(root); }
  });
  test("install registers the stable launcher while the launcher resolves the manifest-defined service binary", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-packaged-launcher-"));
    const home = join(root, "home");
    mkdirSync(home);
    const { payload } = buildFixture(root, true);
    const runner = new SystemdFixtureRunner();
    const pathOptions = { platform: "linux" as const, home, environment: {} };
    try {
      const planned = await planPackagedInstallFromPayload({
        payloadSourcePath: payload,
        ...pathOptions,
        runner,
      });
      expect(planned.blueprint.services.map(service => service.definition)).toEqual(expect.arrayContaining([
        expect.objectContaining({ platform: "linux" }),
      ]));
      await applyPackagedInstallFromPayload({
        planned,
        payloadSourcePath: payload,
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

      const chat = resolvePackagedServiceLaunch({ service: "chat", payloadRoot: paths.binaryRoot, pathOptions });
      expect(chat.environment.CHATGPT_TELA_WORKSPACE_FILES_EXECUTABLE).toBe(join(installedRoot, "helpers", `tela-workspace-files${process.platform === "win32" ? ".exe" : ""}`));
      expect(gateway.environment.CHATGPT_TELA_WORKSPACE_FILES_EXECUTABLE).toBeUndefined();

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
      mkdirSync(paths.serviceState("chat"), { recursive: true });
      writeFileSync(join(paths.serviceState("chat"), "process-operations-v1.json"), JSON.stringify({ version: 2, operations: [] }));
      expect(() => resolvePackagedServiceLaunch({ service: "chat", payloadRoot: paths.binaryRoot, pathOptions })).toThrow("cannot read");
      expect(() => resolvePackagedServiceLaunch({ service: "codex", payloadRoot: paths.binaryRoot, pathOptions })).not.toThrow();
      expect(() => resolvePackagedServiceLaunch({ service: "gateway", payloadRoot: paths.binaryRoot, pathOptions })).not.toThrow();
    } finally {
      removeFixture(root);
    }
  });

  test("launcher refuses a different executable path even when the payload root is otherwise valid", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-packaged-launcher-identity-"));
    const home = join(root, "home");
    mkdirSync(home);
    const { payload } = buildFixture(root);
    const runner = new SystemdFixtureRunner();
    const pathOptions = { platform: "linux" as const, home, environment: {} };
    try {
      const planned = await planPackagedInstallFromPayload({
        payloadSourcePath: payload,
        ...pathOptions,
        runner,
      });
      await applyPackagedInstallFromPayload({ planned, payloadSourcePath: payload, ...pathOptions, runner });
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
      removeFixture(root);
    }
  });

  test("launcher refuses to start services while repair or upgrade transition state is incomplete", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-packaged-launcher-transition-"));
    const home = join(root, "home");
    mkdirSync(home);
    const { payload } = buildFixture(root);
    const runner = new SystemdFixtureRunner();
    const pathOptions = { platform: "linux" as const, home, environment: {} };
    try {
      const planned = await planPackagedInstallFromPayload({
        payloadSourcePath: payload,
        ...pathOptions,
        runner,
      });
      await applyPackagedInstallFromPayload({ planned, payloadSourcePath: payload, ...pathOptions, runner });
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
      removeFixture(root);
    }
  });
});
