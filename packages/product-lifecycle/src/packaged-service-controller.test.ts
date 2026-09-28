import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPackagedInstallBlueprint } from "./packaged-install";
import { PackagedPlatformServiceController } from "./packaged-service-controller";
import type { ServiceRegistrationCommandResult, ServiceRegistrationCommandRunner } from "./service-registration";
import type { TelaServiceId } from "./layout";

function blueprint(root: string, platform: "darwin" | "linux" | "win32") {
  const source = join(root, `payload-${platform}`);
  mkdirSync(source);
  writeFileSync(join(source, platform === "win32" ? "tela.exe" : "tela"), "fixture", { mode: 0o755 });
  const executable = platform === "win32" ? "tela.exe" : "tela";
  return createPackagedInstallBlueprint({
    spec: {
      productVersion: "1.0.0",
      payloadSourcePath: source,
      services: (["gateway", "chat", "codex"] as const).map(service => ({
        service,
        executableRelativePath: executable,
        arguments: ["service", service],
      })),
    },
    platform,
    home: platform === "win32" ? "C:\\Users\\test" : platform === "darwin" ? "/Users/test" : "/home/test",
    environment: platform === "win32"
      ? { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local", APPDATA: "C:\\Users\\test\\AppData\\Roaming" }
      : {},
  });
}

class LinuxRunner implements ServiceRegistrationCommandRunner {
  readonly state = new Map<string, "running" | "stopped">();
  readonly calls: string[] = [];
  async run(command: string, arguments_: readonly string[]): Promise<ServiceRegistrationCommandResult> {
    this.calls.push(`${command} ${arguments_.join(" ")}`);
    if (command !== "systemctl") throw new Error("unexpected Linux fixture command");
    const id = arguments_.at(-1)!;
    const state = this.state.get(id) ?? "stopped";
    if (arguments_.includes("is-active")) return state === "running"
      ? { exitCode: 0, stdout: "active\n", stderr: "" }
      : { exitCode: 3, stdout: "inactive\n", stderr: "" };
    if (arguments_.includes("stop")) { this.state.set(id, "stopped"); return { exitCode: 0, stdout: "", stderr: "" }; }
    if (arguments_.includes("start")) { this.state.set(id, "running"); return { exitCode: 0, stdout: "", stderr: "" }; }
    throw new Error("unexpected systemctl fixture arguments");
  }
}

class WindowsRunner implements ServiceRegistrationCommandRunner {
  readonly state = new Map<string, "running" | "stopped">();
  readonly calls: string[] = [];
  async run(command: string, arguments_: readonly string[]): Promise<ServiceRegistrationCommandResult> {
    this.calls.push(`${command} ${arguments_.join(" ")}`);
    if (command !== "powershell.exe") throw new Error("unexpected Windows fixture command");
    const script = arguments_[3] ?? "";
    const id = arguments_.at(-1)!;
    if (script.includes("Stop-ScheduledTask")) { this.state.set(id, "stopped"); return { exitCode: 0, stdout: "", stderr: "" }; }
    if (script.includes("Start-ScheduledTask")) { this.state.set(id, "running"); return { exitCode: 0, stdout: "", stderr: "" }; }
    return { exitCode: 0, stdout: this.state.get(id) === "running" ? "Running\n" : "Ready\n", stderr: "" };
  }
}

class DarwinRunner implements ServiceRegistrationCommandRunner {
  readonly state = new Map<string, "running" | "stopped">();
  readonly calls: string[] = [];
  async run(command: string, arguments_: readonly string[]): Promise<ServiceRegistrationCommandResult> {
    this.calls.push(`${command} ${arguments_.join(" ")}`);
    if (command !== "/bin/launchctl") throw new Error("unexpected macOS fixture command");
    const target = arguments_.at(-1)!;
    if (arguments_[0] === "kill") { this.state.set(target, "stopped"); return { exitCode: 0, stdout: "", stderr: "" }; }
    if (arguments_[0] === "kickstart") { this.state.set(target, "running"); return { exitCode: 0, stdout: "", stderr: "" }; }
    const state = this.state.get(target) ?? "stopped";
    return { exitCode: 0, stdout: `service = {\n\tstate = ${state === "running" ? "running" : "not running"}\n}\n`, stderr: "" };
  }
}

function registration(blueprintValue: ReturnType<typeof blueprint>, service: TelaServiceId): string {
  return blueprintValue.services.find(entry => entry.service === service)!.resource.registrationId;
}

describe("packaged platform service controller", () => {
  test("Linux uses user service stop/start without disabling the registration", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-service-control-linux-"));
    try {
      const built = blueprint(root, "linux");
      const runner = new LinuxRunner();
      runner.state.set(registration(built, "gateway"), "running");
      const controller = new PackagedPlatformServiceController({ blueprint: built, runner, transitionTimeoutMs: 100 });
      expect(await controller.inspect("gateway")).toBe("running");
      await controller.quiesce("gateway");
      expect(await controller.inspect("gateway")).toBe("stopped");
      await controller.resume("gateway");
      expect(await controller.inspect("gateway")).toBe("running");
      expect(runner.calls.some(call => call.includes("systemctl --user stop"))).toBe(true);
      expect(runner.calls.some(call => call.includes("systemctl --user start"))).toBe(true);
      expect(runner.calls.some(call => call.includes("disable"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("Windows uses per-user scheduled-task stop/start and verifies final state", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-service-control-win-"));
    try {
      const built = blueprint(root, "win32");
      const runner = new WindowsRunner();
      runner.state.set(registration(built, "chat"), "running");
      const controller = new PackagedPlatformServiceController({ blueprint: built, runner, transitionTimeoutMs: 100 });
      await controller.quiesce("chat");
      await controller.resume("chat");
      expect(await controller.inspect("chat")).toBe("running");
      expect(runner.calls.some(call => call.includes("Stop-ScheduledTask"))).toBe(true);
      expect(runner.calls.some(call => call.includes("Start-ScheduledTask"))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("macOS keeps the LaunchAgent registered while using kill/kickstart for process lifecycle", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-service-control-mac-"));
    try {
      const built = blueprint(root, "darwin");
      const runner = new DarwinRunner();
      const target = `gui/501/${registration(built, "codex")}`;
      runner.state.set(target, "running");
      const controller = new PackagedPlatformServiceController({ blueprint: built, runner, userId: 501, transitionTimeoutMs: 100 });
      await controller.quiesce("codex");
      expect(await controller.inspect("codex")).toBe("stopped");
      await controller.resume("codex");
      expect(await controller.inspect("codex")).toBe("running");
      expect(runner.calls.some(call => call.includes("launchctl kill SIGTERM"))).toBe(true);
      expect(runner.calls.some(call => call.includes("launchctl kickstart"))).toBe(true);
      expect(runner.calls.some(call => call.includes("bootout"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("transitional/ambiguous service states fail closed", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-service-control-ambiguous-"));
    try {
      const built = blueprint(root, "linux");
      const runner: ServiceRegistrationCommandRunner = {
        async run() { return { exitCode: 0, stdout: "activating\n", stderr: "" }; },
      };
      const controller = new PackagedPlatformServiceController({ blueprint: built, runner, transitionTimeoutMs: 100 });
      await expect(controller.inspect("gateway")).rejects.toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
