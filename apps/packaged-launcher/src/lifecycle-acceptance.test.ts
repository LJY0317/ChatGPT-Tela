import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPackagedPayload, prepareOwnedDirectory, CURRENT_PACKAGED_LIFECYCLE,
  readOwnershipManifest, resolveProductPaths, packagedUninstallJournalPath, withPackagedTransitionOwner,
  type ServiceRegistrationCommandResult, type ServiceRegistrationCommandRunner,
  PackagedServiceShutdownNotStartedError, packagedUpgradeJournalPath,
} from "@chatgpt-tela/product-lifecycle";
import { runProductUninstall } from "@chatgpt-tela/product-uninstall";
import { runPackagedLifecycleCommand } from "./lifecycle";
import { runPackagedChatCommand } from "./chat";
import { runPackagedServicesCommand } from "./services";
import { readConfigurationInput, runPackagedBootstrapCommand } from "./bootstrap";
import { resolveChatGptTelaBrowserProfile } from "@chatgpt-tela/development-runtime/browser-profile";
import { registerTemporaryFixtureCleanup } from "../../../tests/support/temporary-fixtures";

const removeFixture = registerTemporaryFixtureCleanup();

/** No real service manager, profile, credential store or user installation is used. */
class LifecycleServices implements ServiceRegistrationCommandRunner {
  readonly loaded = new Set<string>();
  readonly running = new Set<string>();
  readonly calls: string[][] = [];
  failStopFor: string | undefined;
  async run(command: string, args: readonly string[]): Promise<ServiceRegistrationCommandResult> {
    this.calls.push([...args]);
    if (command !== "systemctl") throw new Error("fixture refused an external command");
    const unit = args.at(-1)!;
    const result = (stdout = "", exitCode = 0) => ({ stdout, exitCode, stderr: "" });
    if (args.includes("show")) return result(this.loaded.has(unit) ? "loaded\n" : "not-found\n", this.loaded.has(unit) ? 0 : 1);
    if (args.includes("is-enabled")) return result(this.loaded.has(unit) ? "enabled\n" : "disabled\n", this.loaded.has(unit) ? 0 : 1);
    if (args.includes("is-active")) return result(this.running.has(unit) ? "active\n" : "inactive\n", this.running.has(unit) ? 0 : 3);
    if (args.includes("daemon-reload")) return result();
    if (args.includes("enable")) { this.loaded.add(unit); return result(); }
    if (args.includes("disable")) { this.loaded.delete(unit); this.running.delete(unit); return result(); }
    if (args.includes("start")) { this.running.add(unit); return result(); }
    if (args.includes("stop") && unit === this.failStopFor) return result("", 1);
    if (args.includes("stop")) { this.running.delete(unit); return result(); }
    throw new Error("fixture refused an unknown lifecycle operation");
  }
}

test("install -> update -> keep-data removal -> reinstall -> complete removal preserves external ChatGPT state", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-lifecycle-acceptance-"));
  try {
    const home = join(root, "home");
    const input = join(root, "input");
    mkdirSync(home); mkdirSync(join(input, "electron"), { recursive: true });

    writeFileSync(join(input, "electron", "electron"), "fixture", { mode: 0o755 });
    writeFileSync(join(input, "runtime.cjs"), "module.exports = {};\n");
    const payload = (version: string) => {
      writeFileSync(join(input, "launcher"), `launcher ${version}`, { mode: 0o755 });
      const outputPath = join(root, version);
      buildPackagedPayload({ outputPath, productVersion: version, lifecycle: CURRENT_PACKAGED_LIFECYCLE,
        launcherSourcePath: join(input, "launcher"),
        services: Object.fromEntries(["gateway", "chat", "codex"].map(service => [service,
          { executableSourcePath: join(input, "launcher") }])) as Record<"gateway" | "chat" | "codex", { executableSourcePath: string }>,
        profileRuntime: { electronBundleSourcePath: join(input, "electron"),
          electronExecutableRelativePath: "electron", entrypointSourcePath: join(input, "runtime.cjs"), setupEntrypointSourcePath: join(input, "runtime.cjs") },
      });
      return outputPath;
    };
    const first = payload("1.0.0"), next = payload("1.0.1");
    const runner = new LifecycleServices();
    const shutdownService = async (service: "gateway" | "chat" | "codex") => {
      const unit = `chatgpt-tela-${service}.service`;
      if (unit === runner.failStopFor) throw new Error("synthetic service shutdown refused");
      runner.running.delete(unit);
    };
    const options = { platform: "linux" as const, home, environment: {}, runner, shutdownService };
    const paths = resolveProductPaths(options);
    // Synthetic external state, never read or write the real app or its private databases.
    const external = [join(home, "official-app"), join(home, "default-config.toml"), join(home, "native-conversation.txt"), join(home, "user-project.txt")];
    for (const path of external) writeFileSync(path, "external fixture: preserve exactly\n");
    const execute = (command: string, mode: "dry-run" | "apply", source: string) => runPackagedLifecycleCommand(
      [command, `--${mode}`, ], { ...options, defaultPayloadRoot: source });
    await execute("install", "dry-run", first);
    expect(existsSync(paths.installManifest)).toBe(false);
    const installed = await execute("install", "apply", first) as { verify: { ready: boolean } };
    expect(installed.verify.ready).toBe(true);
    const manifest = readOwnershipManifest(paths.installManifest)!;
    const configFile = join(root, "product-config.json");
    writeFileSync(configFile, JSON.stringify({ version: 1, publicMcpAbi: "stable", exposure: {
      kind: "existing-https", publicUrl: "https://example.test/mcp", localPort: 18743,
      authentication: "none", allowUnauthenticatedPublicEndpoint: true,
    } }));
    const bootstrap = { payloadRoot: paths.binaryRoot, pathOptions: options };
    expect(await runPackagedBootstrapCommand(["bootstrap-status"], bootstrap)).toEqual({ configuration: "missing" });
    await expect(runPackagedBootstrapCommand(["configure", "--stdin", "--if-missing"], {
      ...bootstrap, configurationInput: '{"version":1,"exposure":{}}',
    })).rejects.toThrow();
    expect(existsSync(join(paths.configRoot, "product-v1.json"))).toBe(false);
    const controls = { ...bootstrap, runner, shutdownService };
    const project = join(root,"approved-project"); mkdirSync(project); writeFileSync(join(project,"notes.txt"),"user data");
    expect((await runPackagedChatCommand(["chat","roots"],bootstrap)).roots).toEqual([]);
    const approved = await runPackagedChatCommand(["chat","allow-root","--path",project],bootstrap);
    expect(approved.roots).toEqual([realpathSync(project)]); expect(approved.applied).toBe(false);
    expect((await runPackagedChatCommand(["chat","allow-root","--path",project],bootstrap)).roots).toHaveLength(1);
    expect((await runPackagedChatCommand(["chat","disallow-root","--path",project],bootstrap)).roots).toEqual([]);
    expect(readFileSync(join(project,"notes.txt"),"utf8")).toBe("user data");
    await expect(runPackagedChatCommand(["chat","allow-root","--path","relative"],bootstrap)).rejects.toThrow("absolute");

    await withPackagedTransitionOwner({ paths, installId: manifest.installId }, async () => {
      const calls = runner.calls.length;
      await expect(runPackagedServicesCommand(["services", "start"], controls)).rejects.toThrow("another installer owns");
      expect(runner.calls).toHaveLength(calls);
    });
    const removalCheckpoint = packagedUninstallJournalPath(paths);
    writeFileSync(removalCheckpoint, "unfinished removal");
    try {
      const calls = runner.calls.length;
      await expect(runPackagedServicesCommand(["services", "start"], controls)).rejects.toThrow("uninstall is incomplete");
      expect(runner.calls).toHaveLength(calls);
    } finally { rmSync(removalCheckpoint); }
    expect((await runPackagedServicesCommand(["services", "start"], controls)).success).toBe(true);
    expect(runner.running.size).toBe(3);
    const codexRegistration = manifest.resources.find(resource => resource.id === "codex-service");
    if (codexRegistration?.kind !== "service-registration") throw new Error("fixture registration missing");
    const definitionPath = codexRegistration.identity!.definitionPath!;
    const definition = readFileSync(definitionPath, "utf8");
    writeFileSync(definitionPath, "foreign definition");
    const peerProofBefore = runner.calls.length;
    expect(await runPackagedServicesCommand(["services","restart","chat"],controls)).toMatchObject({success:true,services:[{service:"chat",state:"running"}]});
    const chatRegistration = manifest.resources.find(resource => resource.id === "chat-service");
    if (chatRegistration?.kind !== "service-registration") throw new Error("missing Chat registration");
    const peerMutations = runner.calls.slice(peerProofBefore).filter(args=>args.includes("start") || args.includes("stop"));
    expect(peerMutations.length).toBeGreaterThan(0);
    expect(peerMutations.every(args=>args.at(-1)===chatRegistration.registrationId)).toBe(true);
    expect(runner.running.size).toBe(3);
    const before = runner.calls.length;
    await expect(runPackagedServicesCommand(["services", "stop"], controls)).rejects.toThrow("ownership");
    expect(runner.running.size).toBe(3);
    expect(runner.calls.slice(before).every(args => !args.includes("stop") && !args.includes("start"))).toBe(true);
    writeFileSync(definitionPath, definition);
    runner.failStopFor = codexRegistration.registrationId;
    const partial = await runPackagedServicesCommand(["services", "stop"], controls);
    expect(partial.success).toBe(false);
    expect(partial.services).toEqual([{ service: "gateway", state: "running" }, { service: "codex", state: "failed" }]);
    expect(partial.restoredServices).toEqual(["gateway"]);
    expect(partial.restoreFailures).toEqual([]);
    expect(runner.running.size).toBe(3);
    runner.failStopFor = undefined;
    expect((await runPackagedServicesCommand(["services", "stop"], controls)).success).toBe(true);
    expect(runner.running.size).toBe(0);
    expect(runner.loaded.size).toBe(3);
    await expect(runPackagedServicesCommand(["services", "restart"], controls)).rejects.toThrow("usage");
    const configurationInput = readFileSync(configFile, "utf8");
    expect(await runPackagedBootstrapCommand(["configure", "--stdin", "--if-missing"], {
      ...bootstrap, configurationInput,
    })).toMatchObject({ configured: true });
    expect(await runPackagedBootstrapCommand(["bootstrap-status"], bootstrap)).toEqual({
      configuration: "configured", publicUrl: "https://example.test/mcp",
    });
    const productConfig = readFileSync(join(paths.configRoot, "product-v1.json"), "utf8");
    await expect(runPackagedBootstrapCommand(["configure", "--stdin", "--if-missing"], {
      ...bootstrap, configurationInput: configurationInput.replace("18743", "18744"),
    })).rejects.toThrow("preserved");
    expect(readFileSync(join(paths.configRoot, "product-v1.json"), "utf8")).toBe(productConfig);
    // Operator file configuration remains supported through the same parser/ownership boundary.
    await runPackagedBootstrapCommand(["configure", "--file", configFile], bootstrap);
    writeFileSync(join(paths.logsRoot, "fixture.log"), "synthetic diagnostic\n");
    writeFileSync(join(paths.serviceState("chat"), "fixture-state.txt"), "synthetic chat state\n");
    const setupProfile = resolveChatGptTelaBrowserProfile({ slot: 1, platform: "linux", homeDirectory: home, environment: {} });
    await runPackagedBootstrapCommand(["setup"], { ...bootstrap, launchSetup: async launch => {
      expect(launch.arguments[0]).toBe(realpathSync(join(paths.binaryRoot, "runtime/profile-setup.cjs")));
      expect(launch.environment.CHATGPT_TELA_PROFILE_SETUP_REVEAL).toBe("1");
      const removal = await runProductUninstall({ ...options, mode: "dry-run", removeData: true, serviceRegistrationRunner: runner });
      expect(removal.activityBlockers).toEqual(["profile 1 setup is active"]);
      writeFileSync(join(setupProfile.userDataDir, "login-fixture.txt"), "synthetic login state\n");
      return 0;
    } });
    await expect(runPackagedBootstrapCommand(["setup", "--slot", "1"], { ...bootstrap, launchSetup: async () => { throw new Error("fixture setup failed"); } })).rejects.toThrow("fixture setup failed");
    const afterFailure = await runProductUninstall({ ...options, mode: "dry-run", removeData: true, serviceRegistrationRunner: runner });
    expect(afterFailure.activityBlockers).toEqual([]);
    const browser = join(paths.serviceState("codex"), "browser-fixture");
    for (const resource of [
      { kind: "directory" as const, id: "product-config", owner: "product" as const, path: paths.configRoot, dataClass: "config" as const },
      { kind: "directory" as const, id: "browser-fixture", owner: "codex" as const, path: browser, dataClass: "browser-profile" as const },
    ]) await prepareOwnedDirectory({ manifestPath: paths.installManifest, installId: manifest.installId, productVersion: manifest.productVersion, resource });
    const preferences = join(paths.configRoot, "preferences-v1.json");
    const prefs = '{"version":1,"approvalAutomation":"off","workProfileConnections":["fixture.target"]}\n';
    writeFileSync(preferences, prefs);
    const binding = join(browser, "binding-fixture.txt");
    writeFileSync(binding, "synthetic login binding\n");
    const assertSaved = () => {
      expect(readFileSync(join(paths.configRoot, "product-v1.json"), "utf8")).toBe(productConfig);
      expect(readFileSync(join(setupProfile.userDataDir, "login-fixture.txt"), "utf8")).toBe("synthetic login state\n");
      expect(readFileSync(preferences, "utf8")).toBe(prefs);
      expect(readFileSync(binding, "utf8")).toBe("synthetic login binding\n");
      for (const path of external) expect(readFileSync(path, "utf8")).toBe("external fixture: preserve exactly\n");
      expect(readOwnershipManifest(paths.installManifest)?.installId).toBe(manifest.installId);
    };
    // Upgrade exercises quiesce and restoration while preserving registration identity.
    for (const unit of runner.loaded) runner.running.add(unit);
    await execute("upgrade", "dry-run", next);
    assertSaved();
    expect(readOwnershipManifest(paths.installManifest)?.productVersion).toBe("1.0.0");
    const upgrade = ["upgrade", "--apply", "--payload", next, ];
    await expect(runPackagedLifecycleCommand(upgrade, { ...options, async prepareShutdownService(service) {
      if (service === "chat") throw new PackagedServiceShutdownNotStartedError(service);
    } })).rejects.toBeInstanceOf(PackagedServiceShutdownNotStartedError);
    expect(runner.running.size).toBe(3);
    expect(existsSync(packagedUpgradeJournalPath(paths))).toBe(false);
    await expect(runPackagedLifecycleCommand(upgrade, { ...options, async shutdownService(service) {
      if (service === "chat") throw new PackagedServiceShutdownNotStartedError(service);
      await shutdownService(service);
    } })).rejects.toMatchObject({ recoveryState: "source-restored" });
    expect(runner.running.size).toBe(3);
    expect(existsSync(packagedUpgradeJournalPath(paths))).toBe(false);
    expect(readOwnershipManifest(paths.installManifest)?.productVersion).toBe("1.0.0");
    assertSaved();
    await execute("upgrade", "apply", next);
    expect(readOwnershipManifest(paths.installManifest)?.productVersion).toBe("1.0.1");
    expect(runner.running.size).toBe(3);
    assertSaved();
    const uninstall = (mode: "dry-run" | "apply", removeData: boolean) => runProductUninstall({
      ...options, mode, removeData, serviceRegistrationRunner: runner,
      executingBinaryPath: join(next, "chatgpt-tela"),
    });
    await uninstall("dry-run", false);
    expect(existsSync(paths.binaryRoot)).toBe(true);
    const kept = await uninstall("apply", false);
    expect(kept).toMatchObject({ failedCount: 0, manifestRemoved: false });
    expect(existsSync(paths.binaryRoot)).toBe(false);
    expect(runner.loaded.size).toBe(0);
    assertSaved();
    const reinstalled = await execute("install", "apply", next) as { verify: { ready: boolean } };
    expect(reinstalled.verify.ready).toBe(true);
    assertSaved();
    await uninstall("dry-run", true);
    assertSaved();
    const removed = await uninstall("apply", true);
    expect(removed).toMatchObject({ failedCount: 0, preservedCount: 0, manifestRemoved: true });
    for (const path of [paths.binaryRoot, paths.configRoot, paths.cacheRoot, paths.logsRoot,
      paths.serviceState("chat"), browser, setupProfile.userDataDir, paths.installManifest]) expect(existsSync(path)).toBe(false);
    expect(runner.loaded.size).toBe(0);
    for (const path of external) expect(readFileSync(path, "utf8")).toBe("external fixture: preserve exactly\n");
  } finally { removeFixture(root); }
});

test("UI configuration input counts bytes and stops an oversized stream before parsing", async () => {
  async function* chunks() { yield Buffer.from("{"); yield '"version":1}'; }
  expect(await readConfigurationInput(chunks())).toBe('{"version":1}');
  let consumed = 0;
  async function* oversized() {
    consumed++; yield "é".repeat(33_000);
    consumed++; yield "never consumed";
  }
  await expect(readConfigurationInput(oversized())).rejects.toThrow("size limit");
  expect(consumed).toBe(1);
});
