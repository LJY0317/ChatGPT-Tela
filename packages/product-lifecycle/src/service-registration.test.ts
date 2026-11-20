import { systemdUnitFixture } from "../../../tests/support/systemd-unit";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOwnershipManifest,
  readOwnershipManifest,
  writeOwnershipManifest,
} from "./ownership";
import {
  recordServiceRegistrationOwnership,
  reserveServiceRegistrationOwnership,
  ServiceRegistrationInstaller,
  ServiceRegistrationManager,
  serviceRegistrationResourceForDefinition,
  type ServiceRegistrationCommandResult,
  type ServiceRegistrationCommandRunner,
} from "./service-registration";

class LinuxFixtureRunner implements ServiceRegistrationCommandRunner {
  constructor(readonly definitionPath?: string) {}
  loaded = true;
  enabled = true;
  readonly calls: Array<readonly [string, readonly string[]]> = [];
  reloadFails = false;
  removedDefinition?: { path: string; active: string; dropIns?: string };
  reachable = true;

  async run(command: string, arguments_: readonly string[]): Promise<ServiceRegistrationCommandResult> {
    this.calls.push([command, [...arguments_]]);
    if (command !== "systemctl") throw new Error(`unexpected command ${command}`);
    if (arguments_.includes("show")) {
      if (!this.reachable) return { exitCode: 1, stdout: "", stderr: "user manager is unreachable" };
      const cached = this.removedDefinition;
      return systemdUnitFixture(cached?.path ?? (this.loaded ? this.definitionPath : undefined), cached?.active, cached?.dropIns);
    }
    if (arguments_.includes("is-enabled")) {
      return { exitCode: this.enabled ? 0 : 1, stdout: this.enabled ? "enabled\n" : "disabled\n", stderr: "" };
    }
    if (arguments_.includes("disable")) {
      this.loaded = false;
      this.enabled = false;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (arguments_.includes("daemon-reload")) {
      if (this.reloadFails) return { exitCode: 1, stdout: "", stderr: "reload fixture failure" };
      if (this.removedDefinition) this.loaded = false;
      delete this.removedDefinition;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected systemctl args ${arguments_.join(" ")}`);
  }
}

class WindowsFixtureRunner implements ServiceRegistrationCommandRunner {
  exists = true;
  running = true;
  currentUser = true;
  hasTrigger = false;
  readonly calls: Array<readonly [string, readonly string[]]> = [];
  executable = "C:\\Program Files\\ChatGPT Tela\\tela.exe";
  arguments = "service codex";
  workingDirectory = "C:\\Program Files\\ChatGPT Tela";

  async run(command: string, arguments_: readonly string[]): Promise<ServiceRegistrationCommandResult> {
    this.calls.push([command, [...arguments_]]);
    if (command === "powershell.exe") {
      const script = Buffer.from(arguments_[3] ?? "", "base64").toString("utf16le");
      if (script.includes("Unregister-ScheduledTask")) {
        this.running = false;
        this.exists = false;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (script.includes("Register-ScheduledTask")) {
        this.exists = true;
        this.running = false;
        const encoded = /FromBase64String\('([^']+)'\)/.exec(script)?.[1] ?? "";
        const { values } = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
        [ , this.executable, this.arguments, this.workingDirectory ] = values;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (script.includes("Get-ScheduledTask")) {
        if (!this.exists) return { exitCode: 3, stdout: "", stderr: "" };
        return {
          exitCode: 0,
          stdout: JSON.stringify({ name: "ChatGPTTelaCodex", taskPath: "\\", executable: this.executable,
            arguments: this.arguments, workingDirectory: this.workingDirectory,
            logonType: "Interactive", runLevel: "Limited", enabled: true,
            currentUser: this.currentUser, hasTrigger: this.hasTrigger }),
          stderr: "",
        };
      }
    }
    throw new Error(`unexpected fixture command ${command} ${arguments_.join(" ")}`);
  }
}

class LinuxInstallFixtureRunner implements ServiceRegistrationCommandRunner {
  constructor(readonly definitionPath: string) {}
  loaded = false;
  enabled = false;
  readonly calls: Array<readonly [string, readonly string[]]> = [];

  async run(command: string, arguments_: readonly string[]): Promise<ServiceRegistrationCommandResult> {
    this.calls.push([command, [...arguments_]]);
    if (command !== "systemctl") throw new Error(`unexpected command ${command}`);
    if (arguments_.includes("show")) {
      return systemdUnitFixture(this.loaded ? this.definitionPath : undefined);
    }
    if (arguments_.includes("is-enabled")) {
      return { exitCode: this.enabled ? 0 : 1, stdout: this.enabled ? "enabled\n" : "disabled\n", stderr: "" };
    }
    if (arguments_.includes("daemon-reload")) return { exitCode: 0, stdout: "", stderr: "" };
    if (arguments_.includes("enable")) {
      this.loaded = true;
      this.enabled = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected systemctl args ${arguments_.join(" ")}`);
  }
}

describe("service registration ownership", () => {
  test("macOS refuses a same-label loaded job from another install root and accepts physical aliases", async () => {
    // This is a synthetic launchd runner. Windows has no process.getuid();
    // provide a fixture-only uid so the cross-platform test reaches the
    // launchd identity check rather than failing closed before its mock call.
    const needsFixtureUid = typeof process.getuid !== "function";
    if (needsFixtureUid) Object.defineProperty(process, "getuid", { value: () => 501, configurable: true });
    const root = mkdtempSync(join(tmpdir(), "tela-launchd-root-proof-"));
    const manifestPath = join(root, "ownership.json");
    const definitionPath = join(root, "expected.plist");
    const foreignPath = join(root, "foreign.plist");
    const aliasPath = join(root, "alias.plist");
    const markerPath = join(root, "marker.json");
    const definition = { platform: "darwin" as const, content: "fixture-definition" };
    const manifest = createOwnershipManifest("1.2.3");
    const resource = serviceRegistrationResourceForDefinition({
      resourceId: "codex-service", owner: "codex", registrationId: "fixture.same-label",
      markerPath, definitionPath, definition,
    });
    let loadedPath = foreignPath;
    const calls: string[] = [];
    const runner: ServiceRegistrationCommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args[0]}`);
        if (args[0] !== "print") throw new Error("fixture must never mutate system services");
        return { exitCode: 0, stdout: `job = {\n path = ${loadedPath}\n state = running\n coalition = {\n path = ${definitionPath}\n }\n}\n`, stderr: "" };
      },
    };
    try {
      writeOwnershipManifest(manifestPath, manifest);
      writeFileSync(definitionPath, definition.content);
      writeFileSync(foreignPath, definition.content);
      symlinkSync(definitionPath, aliasPath);
      await reserveServiceRegistrationOwnership({ manifestPath, installId: manifest.installId,
        productVersion: manifest.productVersion, resource });
      const current = readOwnershipManifest(manifestPath)!;
      const manager = new ServiceRegistrationManager({ platform: "darwin", runner });
      const installer = new ServiceRegistrationInstaller({ platform: "darwin", runner });
      expect(await manager.observe(resource, current)).toBe("unknown");
      expect((await manager.release(resource, current)).removed).toBe(false);
      await expect(installer.install({ manifestPath, manifest: current, resource, definition })).rejects.toThrow();
      expect(existsSync(markerPath)).toBe(true);
      expect(readFileSync(definitionPath, "utf8")).toBe(definition.content);
      expect(readFileSync(foreignPath, "utf8")).toBe(definition.content);
      expect(calls.every(call => call.endsWith(" print"))).toBe(true);
      loadedPath = aliasPath;
      expect(await manager.observe(resource, current)).toBe("owned");
      expect(await installer.observeReady(resource, current)).toBe("owned");
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (needsFixtureUid) Reflect.deleteProperty(process, "getuid");
    }
  });

  test("packaged Linux install reserves ownership before writing and enables without starting", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-service-install-linux-"));
    const manifestPath = join(root, "ownership-v1.json");
    const definitionPath = join(root, "systemd", "chatgpt-tela-chat.service");
    const markerPath = join(root, "markers", "chat.json");
    const definition = { platform: "linux" as const,
      content: "[Unit]\nDescription=ChatGPT Tela Chat\n[Service]\nExecStart=/fixture/tela chat\n[Install]\nWantedBy=default.target\n" };
    const runner = new LinuxInstallFixtureRunner(definitionPath);
    const manifest = createOwnershipManifest("1.2.3");
    writeOwnershipManifest(manifestPath, manifest);
    const resource = serviceRegistrationResourceForDefinition({
      resourceId: "chat-service",
      owner: "chat",
      registrationId: "chatgpt-tela-chat.service",
      markerPath,
      definitionPath,
      definition,
    });
    try {
      const installer = new ServiceRegistrationInstaller({ platform: "linux", runner });
      expect(await installer.observeReady(resource, manifest)).toBe("missing");
      expect((await installer.install({ manifestPath, manifest, resource, definition })).created).toBe(true);
      const current = readOwnershipManifest(manifestPath)!;
      expect(current.resources).toContainEqual(resource);
      expect(await installer.observeReady(resource, current)).toBe("owned");
      expect(readFileSync(definitionPath, "utf8")).toBe(definition.content);
      expect(runner.calls.some(([, args]) => args.includes("enable") && !args.includes("--now"))).toBe(true);
      expect(runner.calls.some(([, args]) => args.includes("start") || args.includes("--now"))).toBe(false);
      expect((await installer.install({ manifestPath, manifest: current, resource, definition })).created).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("interrupted service ownership intent resumes instead of orphaning the registration", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-service-install-resume-"));
    const manifestPath = join(root, "ownership-v1.json");
    const definitionPath = join(root, "systemd", "chatgpt-tela-codex.service");
    const markerPath = join(root, "markers", "codex.json");
    const definition = { platform: "linux" as const,
      content: "[Service]\nExecStart=/fixture/tela codex\n[Install]\nWantedBy=default.target\n" };
    const runner = new LinuxInstallFixtureRunner(definitionPath);
    const manifest = createOwnershipManifest("1.2.3");
    writeOwnershipManifest(manifestPath, manifest);
    const resource = serviceRegistrationResourceForDefinition({
      resourceId: "codex-service", owner: "codex", registrationId: "chatgpt-tela-codex.service",
      markerPath, definitionPath, definition,
    });
    try {
      await reserveServiceRegistrationOwnership({ manifestPath, installId: manifest.installId,
        productVersion: manifest.productVersion, resource });
      const current = readOwnershipManifest(manifestPath)!;
      const installer = new ServiceRegistrationInstaller({ platform: "linux", runner });
      expect(await installer.observeReady(resource, current)).toBe("missing");
      expect((await installer.install({ manifestPath, manifest: current, resource, definition })).created).toBe(true);
      expect(await installer.observeReady(resource, readOwnershipManifest(manifestPath)!)).toBe("owned");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Linux install retries an exact loaded-but-disabled unit without starting it", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-service-install-enable-retry-"));
    const manifestPath = join(root, "ownership-v1.json");
    const definitionPath = join(root, "systemd", "chatgpt-tela-gateway.service");
    const markerPath = join(root, "markers", "gateway.json");
    const definition = { platform: "linux" as const,
      content: "[Service]\nExecStart=/fixture/tela gateway\n[Install]\nWantedBy=default.target\n" };
    const runner = new LinuxInstallFixtureRunner(definitionPath);
    const manifest = createOwnershipManifest("1.2.3");
    writeOwnershipManifest(manifestPath, manifest);
    const resource = serviceRegistrationResourceForDefinition({
      resourceId: "gateway-service", owner: "gateway", registrationId: "chatgpt-tela-gateway.service",
      markerPath, definitionPath, definition,
    });
    try {
      await reserveServiceRegistrationOwnership({ manifestPath, installId: manifest.installId,
        productVersion: manifest.productVersion, resource });
      mkdirSync(join(root, "systemd"), { recursive: true });
      writeFileSync(definitionPath, definition.content, { flag: "wx" });
      runner.loaded = true;
      runner.enabled = false;
      const current = readOwnershipManifest(manifestPath)!;
      const installer = new ServiceRegistrationInstaller({ platform: "linux", runner });
      expect(await installer.observeReady(resource, current)).toBe("missing");
      expect((await installer.install({ manifestPath, manifest: current, resource, definition })).created).toBe(true);
      expect(runner.enabled).toBe(true);
      expect(runner.calls.some(([, args]) => args.includes("enable"))).toBe(true);
      expect(runner.calls.some(([, args]) => args.includes("start") || args.includes("--now"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an orphaned service marker never recreates manifest authority implicitly", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-service-orphan-marker-"));
    const manifestPath = join(root, "ownership-v1.json");
    const definitionPath = join(root, "systemd", "chatgpt-tela-chat.service");
    const markerPath = join(root, "markers", "chat.json");
    const definition = { platform: "linux" as const,
      content: "[Service]\nExecStart=/fixture/tela chat\n[Install]\nWantedBy=default.target\n" };
    const runner = new LinuxInstallFixtureRunner(definitionPath);
    const manifest = createOwnershipManifest("1.2.3");
    writeOwnershipManifest(manifestPath, manifest);
    const resource = serviceRegistrationResourceForDefinition({
      resourceId: "chat-service", owner: "chat", registrationId: "chatgpt-tela-chat.service",
      markerPath, definitionPath, definition,
    });
    try {
      await reserveServiceRegistrationOwnership({ manifestPath, installId: manifest.installId,
        productVersion: manifest.productVersion, resource });
      const current = readOwnershipManifest(manifestPath)!;
      writeOwnershipManifest(manifestPath, Object.freeze({ ...current, resources: Object.freeze([]) }));
      const orphaned = readOwnershipManifest(manifestPath)!;
      const installer = new ServiceRegistrationInstaller({ platform: "linux", runner });
      expect(await installer.observeReady(resource, orphaned)).toBe("ownership-drift");
      await expect(installer.install({ manifestPath, manifest: orphaned, resource, definition })).rejects.toThrow("ownership-drift");
      expect(runner.calls.some(([, args]) => args.includes("enable"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("packaged service install preserves a foreign file occupying the definition path", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-service-install-foreign-"));
    const manifestPath = join(root, "ownership-v1.json");
    const definitionPath = join(root, "chatgpt-tela-gateway.service");
    const markerPath = join(root, "marker.json");
    const definition = { platform: "linux" as const, content: "desired\n" };
    const manifest = createOwnershipManifest("1.2.3");
    writeOwnershipManifest(manifestPath, manifest);
    writeFileSync(definitionPath, "foreign\n");
    const resource = serviceRegistrationResourceForDefinition({
      resourceId: "gateway-service", owner: "gateway", registrationId: "chatgpt-tela-gateway.service",
      markerPath, definitionPath, definition,
    });
    const runner = new LinuxInstallFixtureRunner(definitionPath);
    try {
      const installer = new ServiceRegistrationInstaller({ platform: "linux", runner });
      expect(await installer.observeReady(resource, manifest)).toBe("ownership-drift");
      await expect(installer.install({ manifestPath, manifest, resource, definition })).rejects.toThrow("ownership-drift");
      expect(readFileSync(definitionPath, "utf8")).toBe("foreign\n");
      expect(runner.calls.some(([, args]) => args.includes("enable"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("packaged Windows install creates a dormant per-user scheduled task from precomputed ownership evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-service-install-windows-"));
    const manifestPath = join(root, "ownership-v1.json");
    const markerPath = join(root, "codex-marker.json");
    const manifest = createOwnershipManifest("1.2.3");
    writeOwnershipManifest(manifestPath, manifest);
    const runner = new WindowsFixtureRunner();
    runner.exists = false;
    runner.running = false;
    const definition = { platform: "win32" as const,
      executable: "C:\\Program Files\\ChatGPT Tela\\tela.exe", arguments: "service codex",
      workingDirectory: "C:\\Program Files\\ChatGPT Tela" };
    const resource = serviceRegistrationResourceForDefinition({
      resourceId: "codex-service", owner: "codex", registrationId: "ChatGPTTelaCodex", markerPath, definition,
    });
    try {
      const installer = new ServiceRegistrationInstaller({ platform: "win32", runner });
      expect(await installer.observeReady(resource, manifest)).toBe("missing");
      expect((await installer.install({ manifestPath, manifest, resource, definition })).created).toBe(true);
      expect(runner.exists).toBe(true);
      expect(runner.running).toBe(false);
      expect(runner.executable).toBe(definition.executable);
      expect(runner.arguments).toBe(definition.arguments);
      expect(await installer.observeReady(resource, readOwnershipManifest(manifestPath)!)).toBe("owned");
      const registration = runner.calls.map(([, args]) => Buffer.from(args[3] ?? "", "base64").toString("utf16le"))
        .find(script => script.includes("Register-ScheduledTask"));
      expect(registration).toContain("-ExecutionTimeLimit ([TimeSpan]::Zero)");
      expect(registration).toContain("-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries");
      expect(registration).toContain("-Settings $settings");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("legacy registration ids remain non-destructive without exact install evidence", async () => {
    const manifest = createOwnershipManifest("0.0.0");
    const manager = new ServiceRegistrationManager({ platform: "linux", runner: new LinuxFixtureRunner() });
    expect(await manager.observe({
      kind: "service-registration",
      id: "legacy-chat",
      owner: "chat",
      registrationId: "chatgpt-tela-chat.service",
    }, manifest)).toBe("unknown");
  });

  test("records and removes one exact Linux user service without touching another registration", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-service-linux-"));
    const manifestPath = join(root, "ownership-v1.json");
    const definitionPath = join(root, "chatgpt-tela-chat.service");
    const markerPath = join(root, "markers", "chat.json");
    const runner = new LinuxFixtureRunner(definitionPath);
    const manifest = createOwnershipManifest("0.0.0");
    writeOwnershipManifest(manifestPath, manifest);
    writeFileSync(definitionPath, "[Service]\nExecStart=/fixture/tela chat\n");
    try {
      const resource = await recordServiceRegistrationOwnership({
        manifestPath,
        installId: manifest.installId,
        productVersion: manifest.productVersion,
        resourceId: "chat-service",
        owner: "chat",
        registrationId: "chatgpt-tela-chat.service",
        platform: "linux",
        markerPath,
        definitionPath,
        runner,
      });
      const manager = new ServiceRegistrationManager({ platform: "linux", runner });
      const installed = readOwnershipManifest(manifestPath)!;
      const installer = new ServiceRegistrationInstaller({ platform: "linux", runner });
      expect(await manager.observe(resource, installed)).toBe("owned");
      const alternate = join(root, "other", resource.registrationId);
      mkdirSync(join(root, "other"));
      writeFileSync(alternate, readFileSync(definitionPath));
      for (const loaded of [
        { path: alternate, active: "inactive" },
        { path: definitionPath, active: "inactive", dropIns: "/fixture/user-override.conf" },
      ]) {
        runner.removedDefinition = loaded;
        expect(await installer.observeReady(resource, installed)).toBe("unknown");
        expect(await manager.observe(resource, installed)).toBe("unknown");
        expect((await manager.release(resource, installed)).removed).toBe(false);
      }
      expect(runner.calls.some(([, args]) => args.includes("disable"))).toBe(false);
      delete runner.removedDefinition;
      expect((await manager.release(resource, installed)).removed).toBe(true);
      expect(runner.calls.some(([, args]) => args.includes("disable") && args.includes("chatgpt-tela-chat.service"))).toBe(true);
      expect(runner.calls.some(([, args]) => args.includes("daemon-reload"))).toBe(true);
      expect(() => readFileSync(definitionPath)).toThrow();
      expect(() => readFileSync(markerPath)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Linux removal resumes after deleting the unit file without repeating a stop", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-service-linux-remove-resume-"));
    const manifestPath = join(root, "ownership-v1.json");
    const definitionPath = join(root, "chatgpt-tela-chat.service");
    const markerPath = join(root, "marker.json");
    const runner = new LinuxFixtureRunner(definitionPath);
    const manifest = createOwnershipManifest("0.0.0");
    writeOwnershipManifest(manifestPath, manifest);
    writeFileSync(definitionPath, "[Service]\nExecStart=/fixture/tela chat\n");
    try {
      const resource = await recordServiceRegistrationOwnership({
        manifestPath, installId: manifest.installId, productVersion: manifest.productVersion,
        resourceId: "chat-service", owner: "chat", registrationId: "chatgpt-tela-chat.service",
        platform: "linux", markerPath, definitionPath, runner,
      });
      const installed = readOwnershipManifest(manifestPath)!;
      const manager = new ServiceRegistrationManager({ platform: "linux", runner });
      runner.reloadFails = true;
      await expect(manager.release(resource, installed)).rejects.toThrow("daemon-reload failed");
      expect(existsSync(definitionPath)).toBe(false);
      expect(existsSync(markerPath)).toBe(true);
      runner.reloadFails = false;

      for (const cached of [
        { path: definitionPath, active: "active" },
        { path: join(root, "foreign.service"), active: "inactive" },
        { path: definitionPath, active: "inactive", dropIns: "/fixture/override.conf" },
      ]) {
        runner.removedDefinition = cached;
        expect(await manager.observe(resource, installed, "remove")).toBe("unknown");
        expect((await manager.release(resource, installed)).removed).toBe(false);
      }
      runner.reachable = false;
      expect((await manager.release(resource, installed)).removed).toBe(false);
      expect(existsSync(markerPath)).toBe(true);

      runner.reachable = true;
      runner.removedDefinition = { path: definitionPath, active: "inactive" };
      runner.loaded = true;
      expect(await manager.observe(resource, installed)).toBe("ownership-drift");
      expect(await manager.observe(resource, installed, "remove")).toBe("owned");
      expect((await manager.release(resource, installed)).removed).toBe(true);
      expect(existsSync(markerPath)).toBe(false);
      expect(runner.calls.filter(([, args]) => args.includes("disable"))).toHaveLength(1);
      expect(runner.calls.filter(([, args]) => args.includes("daemon-reload"))).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("definition drift is preserved and never reaches the service manager removal command", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-service-drift-"));
    const manifestPath = join(root, "ownership-v1.json");
    const definitionPath = join(root, "chatgpt-tela-gateway.service");
    const markerPath = join(root, "marker.json");
    const runner = new LinuxFixtureRunner(definitionPath);
    const manifest = createOwnershipManifest("0.0.0");
    writeOwnershipManifest(manifestPath, manifest);
    writeFileSync(definitionPath, "original\n");
    try {
      const resource = await recordServiceRegistrationOwnership({
        manifestPath,
        installId: manifest.installId,
        productVersion: manifest.productVersion,
        resourceId: "gateway-service",
        owner: "gateway",
        registrationId: "chatgpt-tela-gateway.service",
        platform: "linux",
        markerPath,
        definitionPath,
        runner,
      });
      writeFileSync(definitionPath, "foreign replacement\n");
      runner.calls.length = 0;
      const manager = new ServiceRegistrationManager({ platform: "linux", runner });
      expect(await manager.observe(resource, readOwnershipManifest(manifestPath)!)).toBe("ownership-drift");
      expect((await manager.release(resource, readOwnershipManifest(manifestPath)!)).removed).toBe(false);
      expect(runner.calls.some(([, args]) => args.includes("disable"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ownership marker drift blocks removal even when the service definition is unchanged", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-service-marker-drift-"));
    const manifestPath = join(root, "ownership-v1.json");
    const definitionPath = join(root, "chatgpt-tela-chat.service");
    const markerPath = join(root, "marker.json");
    const runner = new LinuxFixtureRunner(definitionPath);
    const manifest = createOwnershipManifest("0.0.0");
    writeOwnershipManifest(manifestPath, manifest);
    writeFileSync(definitionPath, "[Service]\nExecStart=/fixture/tela chat\n");
    try {
      const resource = await recordServiceRegistrationOwnership({
        manifestPath,
        installId: manifest.installId,
        productVersion: manifest.productVersion,
        resourceId: "chat-service",
        owner: "chat",
        registrationId: "chatgpt-tela-chat.service",
        platform: "linux",
        markerPath,
        definitionPath,
        runner,
      });
      const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
      writeFileSync(markerPath, `${JSON.stringify({ ...marker, installId: "foreign-install" })}\n`);
      runner.calls.length = 0;
      const manager = new ServiceRegistrationManager({ platform: "linux", runner });
      expect(await manager.observe(resource, readOwnershipManifest(manifestPath)!)).toBe("ownership-drift");
      expect((await manager.release(resource, readOwnershipManifest(manifestPath)!)).removed).toBe(false);
      expect(runner.calls.some(([, args]) => args.includes("disable"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("install recording never overwrites a foreign marker path", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-service-marker-collision-"));
    const manifestPath = join(root, "ownership-v1.json");
    const definitionPath = join(root, "chatgpt-tela-chat.service");
    const markerPath = join(root, "marker.json");
    const manifest = createOwnershipManifest("0.0.0");
    writeOwnershipManifest(manifestPath, manifest);
    writeFileSync(definitionPath, "[Service]\nExecStart=/fixture/tela chat\n");
    writeFileSync(markerPath, `${JSON.stringify({ version: 1, installId: "foreign", resourceId: "foreign",
      registrationId: "foreign.service", platform: "linux", definitionFingerprint: "a".repeat(64) })}\n`);
    try {
      await expect(recordServiceRegistrationOwnership({
        manifestPath,
        installId: manifest.installId,
        productVersion: manifest.productVersion,
        resourceId: "chat-service",
        owner: "chat",
        registrationId: "chatgpt-tela-chat.service",
        platform: "linux",
        markerPath,
        definitionPath,
        runner: new LinuxFixtureRunner(),
      })).rejects.toThrow("occupied");
      expect((JSON.parse(readFileSync(markerPath, "utf8")) as { installId: string }).installId).toBe("foreign");
      expect(readOwnershipManifest(manifestPath)?.resources).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Windows registration fingerprint is captured from the live per-user task and re-proven before deletion", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-service-windows-"));
    const manifestPath = join(root, "ownership-v1.json");
    const markerPath = join(root, "codex-marker.json");
    const runner = new WindowsFixtureRunner();
    const manifest = createOwnershipManifest("0.0.0");
    writeOwnershipManifest(manifestPath, manifest);
    try {
      const resource = await recordServiceRegistrationOwnership({
        manifestPath,
        installId: manifest.installId,
        productVersion: manifest.productVersion,
        resourceId: "codex-service",
        owner: "codex",
        registrationId: "ChatGPTTelaCodex",
        platform: "win32",
        markerPath,
        runner,
      });
      const manager = new ServiceRegistrationManager({ platform: "win32", runner });
      expect(await manager.observe(resource, readOwnershipManifest(manifestPath)!)).toBe("owned");
      expect((await manager.release(resource, readOwnershipManifest(manifestPath)!)).removed).toBe(true);
      expect(runner.exists).toBe(false);
      expect(runner.running).toBe(false);
      expect(runner.calls.some(([, args]) => Buffer.from(args[3] ?? "", "base64").toString("utf16le").includes("Unregister-ScheduledTask"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Windows scheduled-task drift blocks stop and deletion", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-service-windows-drift-"));
    const manifestPath = join(root, "ownership-v1.json");
    const markerPath = join(root, "codex-marker.json");
    const runner = new WindowsFixtureRunner();
    const manifest = createOwnershipManifest("0.0.0");
    writeOwnershipManifest(manifestPath, manifest);
    try {
      const resource = await recordServiceRegistrationOwnership({
        manifestPath,
        installId: manifest.installId,
        productVersion: manifest.productVersion,
        resourceId: "codex-service",
        owner: "codex",
        registrationId: "ChatGPTTelaCodex",
        platform: "win32",
        markerPath,
        runner,
      });
      const installed = readOwnershipManifest(manifestPath)!;
      runner.calls.length = 0;
      const manager = new ServiceRegistrationManager({ platform: "win32", runner });
      runner.currentUser = false;
      expect(await manager.observe(resource, installed)).toBe("ownership-drift");
      expect((await manager.release(resource, installed)).removed).toBe(false);
      runner.currentUser = true;
      runner.hasTrigger = true;
      expect(await manager.observe(resource, installed)).toBe("ownership-drift");
      expect((await manager.release(resource, installed)).removed).toBe(false);
      runner.hasTrigger = false;
      runner.executable = "C:\\Other\\foreign.exe";
      expect(await manager.observe(resource, installed)).toBe("ownership-drift");
      expect((await manager.release(resource, installed)).removed).toBe(false);
      expect(runner.calls.some(([, args]) => Buffer.from(args[3] ?? "", "base64").toString("utf16le").includes("Stop-ScheduledTask"))).toBe(false);
      expect(runner.calls.some(([, args]) => Buffer.from(args[3] ?? "", "base64").toString("utf16le").includes("Unregister-ScheduledTask"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
