import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createPackagedInstallBlueprint } from "./packaged-install";
import { PackagedPlatformServiceController } from "./packaged-service-controller";
import type { ServiceRegistrationCommandResult, ServiceRegistrationCommandRunner } from "./service-registration";
import type { TelaServiceId } from "./layout";
import { PackagedServiceShutdownNotStartedError } from "./service-shutdown";

function blueprint(root: string, platform: "darwin" | "linux" | "win32") {
  const source = join(root, `payload-${platform}`);
  mkdirSync(source);
  writeFileSync(join(source, platform === "win32" ? "tela.exe" : "tela"), "fixture", { mode: 0o755 });
  const executable = platform === "win32" ? "tela.exe" : "tela";
  const built = createPackagedInstallBlueprint({
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
    home: platform === "win32" ? "C:\\Users\\test" : platform === "darwin" ? join(root, "home") : "/home/test",
    environment: platform === "win32"
      ? { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local", APPDATA: "C:\\Users\\test\\AppData\\Roaming" }
      : {},
  });
  if (platform === "darwin") for (const entry of built.services) {
    const path = entry.resource.identity!.definitionPath!;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "fixture-definition");
  }
  return built;
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
  constructor(readonly built: ReturnType<typeof blueprint>) {}
  readonly state = new Map<string, "running" | "stopped">();
  readonly calls: string[] = [];
  async run(command: string, arguments_: readonly string[]): Promise<ServiceRegistrationCommandResult> {
    this.calls.push(`${command} ${arguments_.join(" ")}`);
    if (command !== "/bin/launchctl") throw new Error("unexpected macOS fixture command");
    const target = arguments_.at(-1)!;
    if (arguments_[0] === "kill") { this.state.set(target, "stopped"); return { exitCode: 0, stdout: "", stderr: "" }; }
    if (arguments_[0] === "kickstart") { this.state.set(target, "running"); return { exitCode: 0, stdout: "", stderr: "" }; }
    const state = this.state.get(target) ?? "stopped";
    return { exitCode: 0, stdout: `service = {\n\tpath = ${this.built.services.find(entry => target.endsWith("/" + entry.resource.registrationId))!.resource.identity!.definitionPath}\n\tstate = ${state === "running" ? "running" : "not running"}\n}\n`, stderr: "" };
  }
}

function registration(blueprintValue: ReturnType<typeof blueprint>, service: TelaServiceId): string {
  return blueprintValue.services.find(entry => entry.service === service)!.resource.registrationId;
}

function fixtureShutdown(built: ReturnType<typeof blueprint>, runner: ServiceRegistrationCommandRunner) {
  return async (service: TelaServiceId) => {
    if (runner instanceof DarwinRunner) runner.state.set(`gui/501/${registration(built, service)}`, "stopped");
    else if (runner instanceof LinuxRunner || runner instanceof WindowsRunner) runner.state.set(registration(built, service), "stopped");
    else throw new Error("unexpected shutdown before identity proof");
  };
}

describe("packaged platform service controller", () => {
  test("macOS never stops or starts a same-label job loaded from another root", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-control-root-proof-"));
    try {
      const built = blueprint(root, "darwin");
      const foreignPath = join(root, "foreign.plist");
      writeFileSync(foreignPath, "fixture-definition");
      const calls: string[] = [];
      const runner: ServiceRegistrationCommandRunner = {
        async run(_command, args) {
          calls.push(args[0]!);
          return { exitCode: 0, stdout: `job = {\n path = ${foreignPath}\n state = running\n}\n`, stderr: "" };
        },
      };
      const controller = new PackagedPlatformServiceController({ blueprint: built, shutdownService: fixtureShutdown(built, runner), runner, userId: 501 });
      await expect(controller.quiesce("codex")).rejects.toThrow("different definition");
      await expect(controller.resume("codex")).rejects.toThrow("different definition");
      expect(calls).toEqual(["print", "print"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("Linux uses authenticated shutdown and OS start without disabling registration", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-service-control-linux-"));
    try {
      const built = blueprint(root, "linux");
      const runner = new LinuxRunner();
      runner.state.set(registration(built, "gateway"), "running");
      const controller = new PackagedPlatformServiceController({ blueprint: built, shutdownService: fixtureShutdown(built, runner), runner, transitionTimeoutMs: 100 });
      expect(await controller.inspect("gateway")).toBe("running");
      await controller.quiesce("gateway");
      expect(await controller.inspect("gateway")).toBe("stopped");
      await controller.resume("gateway");
      expect(await controller.inspect("gateway")).toBe("running");
      expect(runner.calls.some(call => call.includes("systemctl --user stop"))).toBe(false);
      expect(runner.calls.some(call => call.includes("systemctl --user start"))).toBe(true);
      expect(runner.calls.some(call => call.includes("disable"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("Windows uses authenticated shutdown and scheduled-task start with final state proof", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-service-control-win-"));
    try {
      const built = blueprint(root, "win32");
      const runner = new WindowsRunner();
      runner.state.set(registration(built, "chat"), "running");
      const controller = new PackagedPlatformServiceController({ blueprint: built, shutdownService: fixtureShutdown(built, runner), runner, transitionTimeoutMs: 100 });
      await controller.quiesce("chat");
      await controller.resume("chat");
      expect(await controller.inspect("chat")).toBe("running");
      expect(runner.calls.some(call => call.includes("Stop-ScheduledTask"))).toBe(false);
      expect(runner.calls.some(call => call.includes("Start-ScheduledTask"))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("macOS keeps registration and uses authenticated shutdown plus kickstart", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-service-control-mac-"));
    try {
      const built = blueprint(root, "darwin");
      const runner = new DarwinRunner(built);
      const target = `gui/501/${registration(built, "codex")}`;
      runner.state.set(target, "running");
      const controller = new PackagedPlatformServiceController({ blueprint: built, shutdownService: fixtureShutdown(built, runner), runner, userId: 501, transitionTimeoutMs: 100 });
      await controller.quiesce("codex");
      expect(await controller.inspect("codex")).toBe("stopped");
      await controller.resume("codex");
      expect(await controller.inspect("codex")).toBe("running");
      expect(runner.calls.some(call => call.includes("launchctl kill SIGTERM"))).toBe(false);
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
      const controller = new PackagedPlatformServiceController({ blueprint: built, shutdownService: fixtureShutdown(built, runner), runner, transitionTimeoutMs: 100 });
      await expect(controller.inspect("gateway")).rejects.toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("macOS job state ignores coalition states but rejects ambiguous or incomplete job dictionaries", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-service-control-coalition-"));
    try {
      const built = blueprint(root, "darwin");
      let stdout = "";
      const runner: ServiceRegistrationCommandRunner = {
        async run() { return { exitCode: 0, stdout, stderr: "" }; },
      };
      const controller = new PackagedPlatformServiceController({ blueprint: built, shutdownService: fixtureShutdown(built, runner), runner, userId: 501 });
      for (const state of ["running", "not running"]) {
        stdout = `service = {\n path = ${built.services.find(entry => entry.service === "codex")!.resource.identity!.definitionPath}\n state = ${state}\n resource coalition = {\n state = active\n }\n jetsam coalition = {\n state = active\n }\n}\n`;
        expect(await controller.inspect("codex")).toBe(state === "running" ? "running" : "stopped");
      }
      for (const invalid of [
        "service = {\n state = running\n state = not running\n}\n",
        "service = {\n resource coalition = {\n state = active\n }\n}\n",
        "service = {\n state = running\n",
        "service = {\n state = running\n}\nother = {\n state = running\n}\n",
      ]) {
        stdout = invalid;
        await expect(controller.inspect("codex")).rejects.toThrow();
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

test("service refusal never authorizes an OS kill/stop on any platform", async () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    const root = mkdtempSync(join(tmpdir(), "tela-service-refusal-"));
    try {
      const built = blueprint(root, platform);
      const runner = platform === "darwin" ? new DarwinRunner(built) : platform === "linux" ? new LinuxRunner() : new WindowsRunner();
      const target = platform === "darwin" ? `gui/501/${registration(built, "chat")}` : registration(built, "chat");
      runner.state.set(target, "running"); let requests = 0;
      const controller = new PackagedPlatformServiceController({ blueprint: built, runner, userId: 501,
        shutdownService: async () => { requests++; throw new Error("active Chat shutdown refused"); },
      });
      await expect(controller.quiesce("chat")).rejects.toThrow("shutdown refused");
      expect(requests).toBe(1); expect(runner.state.get(target)).toBe("running");
      expect(runner.calls.some(call => /\bkill\b|\bstop\b|Stop-ScheduledTask|bootout/.test(call))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('stop settlement observes eventual registration exit without sending another stop',async()=>{
 const root=mkdtempSync(join(tmpdir(),'tela-stop-settle-'));let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const built=blueprint(root,'linux'),runner=new LinuxRunner(),id=registration(built,'codex');runner.state.set(id,'running');let sends=0;
  const controller=new PackagedPlatformServiceController({blueprint:built,runner,transitionTimeoutMs:500,
   shutdownService:async()=>{sends++;timer=setTimeout(()=>runner.state.set(id,'stopped'),50);throw Error('caller receipt failed');}});
  await expect(controller.quiesce('codex')).rejects.toThrow('receipt failed');
  expect(await controller.settleQuiescence()).toBe(true);expect(sends).toBe(1);
  expect(runner.calls.some(x=>x.includes(' stop '))).toBe(false);
 }finally{if(timer)clearTimeout(timer);rmSync(root,{recursive:true,force:true});}
});

test("an acknowledged no-admission does not leave a pending OS stop on any platform", async () => {
 for (const platform of ["darwin", "linux", "win32"] as const) {
  const root = mkdtempSync(join(tmpdir(), "tela-stop-not-started-"));
  try {
   const built = blueprint(root, platform);
   const runner = platform === "darwin" ? new DarwinRunner(built) : platform === "linux" ? new LinuxRunner() : new WindowsRunner();
   const target = platform === "darwin" ? `gui/501/${registration(built, "chat")}` : registration(built, "chat");
   runner.state.set(target, "running");
   const controller = new PackagedPlatformServiceController({ blueprint: built, runner, userId: 501, transitionTimeoutMs: 100,
    shutdownService: async service => { throw new PackagedServiceShutdownNotStartedError(service); } });
   await expect(controller.quiesce("chat")).rejects.toBeInstanceOf(PackagedServiceShutdownNotStartedError);
   expect(await controller.settleQuiescence()).toBe(false); // No outstanding stop to settle, not a fresh-controller proof.
   expect(runner.state.get(target)).toBe("running");
   expect(runner.calls.some(call => /\bkill\b|\bstop\b|Stop-ScheduledTask|bootout/.test(call))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
 }
});

test('unknown previous stops and deadline-expired live services cannot authorize restoration',async()=>{
 const root=mkdtempSync(join(tmpdir(),'tela-stop-unknown-'));
 try{
  const built=blueprint(root,'linux'),runner=new LinuxRunner(),id=registration(built,'codex');runner.state.set(id,'running');
  const controller=new PackagedPlatformServiceController({blueprint:built,runner,transitionTimeoutMs:100,shutdownService:async()=>{throw Error('refused');}});
  expect(await controller.settleQuiescence()).toBe(false);
  await expect(controller.quiesce('codex')).rejects.toThrow('refused');
  expect(await controller.settleQuiescence()).toBe(false);expect(runner.state.get(id)).toBe('running');
  expect(runner.calls.some(x=>x.includes(' start ')||x.includes(' stop '))).toBe(false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
