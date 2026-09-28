import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOwnershipManifest } from "./ownership";
import {
  applyPackagedInstall,
  applyPackagedInstallFromPayload,
  createPackagedInstallBlueprint,
  planPackagedInstall,
  planPackagedInstallFromPayload,
  windowsCommandLineArgument,
} from "./packaged-install";
import { PACKAGED_PRODUCT_MANIFEST } from "./packaged-manifest";
import { packagedRepairJournalPath, packagedUpgradeJournalPath } from "./packaged-transition";
import type { ServiceRegistrationCommandResult, ServiceRegistrationCommandRunner } from "./service-registration";

class SystemdFixtureRunner implements ServiceRegistrationCommandRunner {
  readonly loaded = new Set<string>();
  readonly enabled = new Set<string>();
  readonly calls: Array<readonly [string, readonly string[]]> = [];

  async run(command: string, arguments_: readonly string[]): Promise<ServiceRegistrationCommandResult> {
    this.calls.push([command, [...arguments_]]);
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

class LaunchctlFixtureRunner implements ServiceRegistrationCommandRunner {
  readonly loaded = new Set<string>();
  readonly running = new Set<string>();
  readonly calls: Array<readonly [string, readonly string[]]> = [];

  async run(command: string, arguments_: readonly string[]): Promise<ServiceRegistrationCommandResult> {
    this.calls.push([command, [...arguments_]]);
    if (command !== "/bin/launchctl") throw new Error(`unexpected command ${command}`);
    if (arguments_[0] === "print") {
      const registrationId = (arguments_[1] ?? "").split("/").at(-1) ?? "";
      const present = this.loaded.has(registrationId);
      return { exitCode: present ? 0 : 1, stdout: present ? "loaded\n" : "", stderr: "" };
    }
    if (arguments_[0] === "bootstrap") {
      const definitionPath = arguments_[2] ?? "";
      const registrationId = definitionPath.split("/").at(-1)?.replace(/\.plist$/, "") ?? "";
      if (!registrationId) return { exitCode: 2, stdout: "", stderr: "missing registration" };
      this.loaded.add(registrationId);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (arguments_[0] === "kickstart") {
      const registrationId = (arguments_[1] ?? "").split("/").at(-1) ?? "";
      if (!this.loaded.has(registrationId)) return { exitCode: 3, stdout: "", stderr: "not loaded" };
      this.running.add(registrationId);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected launchctl args ${arguments_.join(" ")}`);
  }
}

function fixture(root: string) {
  const source = join(root, "payload");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "tela"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return {
    productVersion: "1.2.3",
    payloadSourcePath: source,
    services: (["gateway", "chat", "codex"] as const).map(service => ({
      service,
      executableRelativePath: "tela",
      arguments: ["service", service],
    })),
  };
}

describe("packaged product install", () => {
  const darwinLifecycleTest = process.platform === "win32" ? test.skip : test;
  test("payload manifest is the authoritative high-level install contract", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-packaged-manifest-install-"));
    const home = join(root, "home");
    const payload = join(root, "payload");
    mkdirSync(home);
    mkdirSync(payload);
    writeFileSync(join(payload, "tela"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const packageManifest = {
      version: 1,
      product: "chatgpt-tela",
      productVersion: "1.2.3",
      services: Object.fromEntries((["gateway", "chat", "codex"] as const).map(service => [service,
        { executable: "tela", arguments: ["service", service] }])),
    };
    writeFileSync(join(payload, PACKAGED_PRODUCT_MANIFEST), `${JSON.stringify(packageManifest)}\n`);
    const runner = new SystemdFixtureRunner();
    try {
      const planned = await planPackagedInstallFromPayload({ payloadSourcePath: payload, platform: "linux",
        home, environment: {}, runner });
      expect(planned.plan.createCount).toBe(4);
      const applied = await applyPackagedInstallFromPayload({ planned, payloadSourcePath: payload, platform: "linux",
        home, environment: {}, runner });
      expect(applied.verify.ready).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("changing the package manifest after plan invalidates manifest-driven apply", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-packaged-manifest-drift-"));
    const home = join(root, "home");
    const payload = join(root, "payload");
    mkdirSync(home);
    mkdirSync(payload);
    writeFileSync(join(payload, "tela"), "fixture", { mode: 0o755 });
    const manifestPath = join(payload, PACKAGED_PRODUCT_MANIFEST);
    const packageManifest = {
      version: 1,
      product: "chatgpt-tela",
      productVersion: "1.2.3",
      services: Object.fromEntries((["gateway", "chat", "codex"] as const).map(service => [service,
        { executable: "tela", arguments: ["service", service] }])),
    };
    writeFileSync(manifestPath, `${JSON.stringify(packageManifest)}\n`);
    const runner = new SystemdFixtureRunner();
    try {
      const planned = await planPackagedInstallFromPayload({ payloadSourcePath: payload, platform: "linux",
        home, environment: {}, runner });
      packageManifest.services.gateway!.arguments.push("changed");
      writeFileSync(manifestPath, `${JSON.stringify(packageManifest)}\n`);
      await expect(applyPackagedInstallFromPayload({ planned, payloadSourcePath: payload, platform: "linux",
        home, environment: {}, runner })).rejects.toThrow();
      expect(existsSync(planned.blueprint.paths.installManifest)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dry plan is non-mutating, apply creates exact payload plus three dormant user services, verify is ready", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-packaged-install-"));
    const home = join(root, "home");
    mkdirSync(home);
    const spec = fixture(root);
    const runner = new SystemdFixtureRunner();
    try {
      const planned = await planPackagedInstall({ spec, platform: "linux", home, environment: {}, runner });
      expect(planned.plan.createCount).toBe(4);
      expect(planned.plan.keepCount).toBe(0);
      expect(existsSync(planned.blueprint.paths.installManifest)).toBe(false);
      expect(existsSync(planned.blueprint.paths.binaryRoot)).toBe(false);
      expect(planned.blueprint.services.every(service => !existsSync(service.resource.identity!.definitionPath!))).toBe(true);

      const applied = await applyPackagedInstall({ planned, spec, platform: "linux", home, environment: {}, runner });
      expect(applied.apply.createdCount).toBe(4);
      expect(applied.apply.failedCount).toBe(0);
      expect(applied.verify.ready).toBe(true);
      expect(readOwnershipManifest(planned.blueprint.paths.installManifest)?.resources).toHaveLength(4);
      expect(runner.calls.some(([, args]) => args.includes("enable") && !args.includes("--now"))).toBe(true);
      expect(runner.calls.some(([, args]) => args.includes("start") || args.includes("--now"))).toBe(false);

      const second = await planPackagedInstall({ spec, platform: "linux", home, environment: {}, runner });
      expect(second.plan.keepCount).toBe(4);
      expect(second.plan.createCount).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("payload bytes changing after plan invalidates apply before install manifest creation", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-packaged-plan-drift-"));
    const home = join(root, "home");
    mkdirSync(home);
    const spec = fixture(root);
    const runner = new SystemdFixtureRunner();
    try {
      const planned = await planPackagedInstall({ spec, platform: "linux", home, environment: {}, runner });
      writeFileSync(join(spec.payloadSourcePath, "tela"), "changed after plan\n");
      await expect(applyPackagedInstall({ planned, spec, platform: "linux", home, environment: {}, runner }))
        .rejects.toThrow("payload bytes changed");
      expect(existsSync(planned.blueprint.paths.installManifest)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("foreign service definition is preserved while independent resources still install", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-packaged-foreign-service-"));
    const home = join(root, "home");
    mkdirSync(home);
    const spec = fixture(root);
    const runner = new SystemdFixtureRunner();
    try {
      const blueprint = createPackagedInstallBlueprint({ spec, platform: "linux", home, environment: {} });
      const chat = blueprint.services.find(service => service.service === "chat")!;
      mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
      writeFileSync(chat.resource.identity!.definitionPath!, "foreign unit\n");
      const planned = await planPackagedInstall({ spec, platform: "linux", home, environment: {}, runner });
      expect(planned.plan.steps.find(step => step.resourceId === "chat-service")?.action).toBe("preserve");
      const applied = await applyPackagedInstall({ planned, spec, platform: "linux", home, environment: {}, runner });
      expect(applied.apply.createdCount).toBe(3);
      expect(applied.apply.preservedCount).toBe(1);
      expect(applied.verify.ready).toBe(false);
      expect(readFileSync(chat.resource.identity!.definitionPath!, "utf8")).toBe("foreign unit\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("install planning and apply refuse incomplete repair or upgrade transitions", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-packaged-install-transition-"));
    const home = join(root, "home");
    mkdirSync(home);
    const spec = fixture(root);
    const runner = new SystemdFixtureRunner();
    try {
      const planned = await planPackagedInstall({ spec, platform: "linux", home, environment: {}, runner });
      mkdirSync(join(planned.blueprint.paths.stateRoot, "install"), { recursive: true });
      writeFileSync(packagedRepairJournalPath(planned.blueprint.paths), "{}\n");
      await expect(planPackagedInstall({ spec, platform: "linux", home, environment: {}, runner }))
        .rejects.toThrow("transition journal");
      await expect(applyPackagedInstall({ planned, spec, platform: "linux", home, environment: {}, runner }))
        .rejects.toThrow("transition journal");
      rmSync(packagedRepairJournalPath(planned.blueprint.paths));
      writeFileSync(packagedUpgradeJournalPath(planned.blueprint.paths), "{}\n");
      await expect(planPackagedInstall({ spec, platform: "linux", home, environment: {}, runner }))
        .rejects.toThrow("transition journal");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("service definitions stay platform-native and Windows command-line quoting is deterministic", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-packaged-blueprint-"));
    const source = join(root, "payload");
    mkdirSync(source);
    writeFileSync(join(source, "tela.exe"), "fixture");
    const spec = {
      productVersion: "1.2.3",
      payloadSourcePath: source,
      services: (["gateway", "chat", "codex"] as const).map(service => ({
        service,
        executableRelativePath: "tela.exe",
        arguments: ["service", service, "space value"],
      })),
    };
    try {
      const windows = createPackagedInstallBlueprint({ spec, platform: "win32", home: "C:\\Users\\test",
        environment: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local", APPDATA: "C:\\Users\\test\\AppData\\Roaming" } });
      expect(windows.services.every(service => service.resource.identity?.definitionPath === undefined)).toBe(true);
      expect((windows.services[0]!.definition as { arguments: string }).arguments).toContain('"space value"');
      expect(windowsCommandLineArgument('C:\\Program Files\\Tela\\tela.exe')).toBe('"C:\\Program Files\\Tela\\tela.exe"');

      const macSource = join(root, "mac-payload");
      mkdirSync(macSource);
      writeFileSync(join(macSource, "tela"), "fixture", { mode: 0o755 });
      writeFileSync(join(macSource, "menu-bar"), "fixture", { mode: 0o755 });
      const macSpec = {
        productVersion: "1.2.3",
        payloadSourcePath: macSource,
        menuBar: { executableRelativePath: "tela", arguments: ["menu-bar"] },
        services: (["gateway", "chat", "codex"] as const).map(service => ({
          service,
          executableRelativePath: "tela",
          arguments: ["service", service, "a&b"],
          environment: { TELA_FIXTURE: "x<y" },
        })),
      };
      const mac = createPackagedInstallBlueprint({ spec: macSpec, platform: "darwin",
        home: "/Users/test", environment: {} });
      const plist = (mac.services[0]!.definition as { content: string }).content;
      expect(plist).toContain("<key>RunAtLoad</key>\n    <false/>");
      expect(plist).toContain("a&amp;b");
      expect(plist).toContain("x&lt;y");
      expect(mac.menuBar?.resource).toMatchObject({
        kind: "service-registration",
        owner: "product",
        registrationId: "com.openai.chatgpt-tela.menu-bar",
      });
      const menuPlist = (mac.menuBar!.definition as { content: string }).content;
      expect(menuPlist).toContain("<key>RunAtLoad</key>\n    <true/>");
      expect(menuPlist).toContain("<key>LimitLoadToSessionType</key>\n    <string>Aqua</string>");
      expect(menuPlist).toContain("<string>menu-bar</string>");
      expect(mac.desiredResources.some(resource => resource.id === "menu-bar-registration")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  darwinLifecycleTest("macOS install owns and bootstraps the menu bar LaunchAgent separately from three backend services", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-packaged-menu-bar-install-"));
    const home = join(root, "home");
    const source = join(root, "payload");
    mkdirSync(home);
    mkdirSync(source);
    writeFileSync(join(source, "tela"), "fixture", { mode: 0o755 });
    writeFileSync(join(source, "menu-bar"), "fixture", { mode: 0o755 });
    const spec = {
      productVersion: "1.2.3",
      payloadSourcePath: source,
      menuBar: { executableRelativePath: "menu-bar" },
      services: (["gateway", "chat", "codex"] as const).map(service => ({
        service,
        executableRelativePath: "tela",
        arguments: ["service", service],
      })),
    };
    const runner = new LaunchctlFixtureRunner();
    try {
      const planned = await planPackagedInstall({ spec, platform: "darwin", home, environment: {}, runner });
      expect(planned.plan.createCount).toBe(5);
      expect(planned.blueprint.menuBar?.resource.owner).toBe("product");
      const applied = await applyPackagedInstall({ planned, spec, platform: "darwin", home, environment: {}, runner });
      expect(applied.apply.createdCount).toBe(5);
      expect(applied.verify.ready).toBe(true);
      expect(readOwnershipManifest(planned.blueprint.paths.installManifest)?.resources)
        .toEqual(expect.arrayContaining([expect.objectContaining({
          id: "menu-bar-registration",
          owner: "product",
          registrationId: "com.openai.chatgpt-tela.menu-bar",
        })]));
      expect(runner.calls.some(([command, args]) => command === "/bin/launchctl"
        && args[0] === "bootstrap"
        && args[2]?.endsWith("com.openai.chatgpt-tela.menu-bar.plist"))).toBe(true);
      expect(runner.calls.some(([command, args]) => command === "/bin/launchctl"
        && args[0] === "kickstart"
        && args[1]?.endsWith("/com.openai.chatgpt-tela.menu-bar"))).toBe(true);
      expect(runner.running.has("com.openai.chatgpt-tela.menu-bar")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
