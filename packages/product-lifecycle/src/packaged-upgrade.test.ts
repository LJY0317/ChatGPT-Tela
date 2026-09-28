import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPackagedInstallFromPayload, planPackagedInstallFromPayload } from "./packaged-install";
import { PACKAGED_PRODUCT_MANIFEST } from "./packaged-manifest";
import {
  applyPackagedUpgradeFromPayload,
  packagedUpgradeJournalPath,
  planPackagedUpgradeFromPayload,
  readPackagedUpgradeJournal,
  type PackagedUpgradeServiceController,
} from "./packaged-upgrade";
import { applyPackagedUpgradeWithPlatformServices } from "./packaged-service-controller";
import { readOwnershipManifest } from "./ownership";
import type { ServiceRegistrationCommandResult, ServiceRegistrationCommandRunner } from "./service-registration";
import type { TelaServiceId } from "./layout";

class SystemdUpgradeRunner implements ServiceRegistrationCommandRunner {
  readonly loaded = new Set<string>();
  readonly enabled = new Set<string>();
  readonly running = new Set<string>();

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
    if (arguments_.includes("is-active")) {
      const active = this.running.has(unit);
      return active ? { exitCode: 0, stdout: "active\n", stderr: "" }
        : { exitCode: 3, stdout: "inactive\n", stderr: "" };
    }
    if (arguments_.includes("daemon-reload")) return { exitCode: 0, stdout: "", stderr: "" };
    if (arguments_.includes("enable")) {
      this.loaded.add(unit);
      this.enabled.add(unit);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (arguments_.includes("stop")) {
      this.running.delete(unit);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (arguments_.includes("start")) {
      this.running.add(unit);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected systemctl arguments: ${arguments_.join(" ")}`);
  }
}

class UpgradeServices implements PackagedUpgradeServiceController {
  readonly states = new Map<TelaServiceId, "running" | "stopped">();
  readonly events: string[] = [];
  failResumeOnce: TelaServiceId | undefined;

  constructor(running: readonly TelaServiceId[]) {
    for (const service of ["gateway", "chat", "codex"] as const) this.states.set(service, running.includes(service) ? "running" : "stopped");
  }

  async inspect(service: TelaServiceId): Promise<"running" | "stopped"> {
    return this.states.get(service)!;
  }

  async quiesce(service: TelaServiceId): Promise<void> {
    this.events.push(`stop:${service}`);
    this.states.set(service, "stopped");
  }

  async resume(service: TelaServiceId): Promise<void> {
    this.events.push(`start:${service}`);
    if (this.failResumeOnce === service) {
      this.failResumeOnce = undefined;
      throw new Error(`fixture resume failure: ${service}`);
    }
    this.states.set(service, "running");
  }
}

function createPayload(root: string, version: string, content: string, gatewayArgument = "gateway"): string {
  const payload = join(root, `payload-${version.replaceAll(".", "-")}-${gatewayArgument}`);
  mkdirSync(payload, { recursive: true });
  writeFileSync(join(payload, "tela"), content, { mode: 0o755 });
  const manifest = {
    version: 1,
    product: "chatgpt-tela",
    productVersion: version,
    services: {
      gateway: { executable: "tela", arguments: ["service", gatewayArgument] },
      chat: { executable: "tela", arguments: ["service", "chat"] },
      codex: { executable: "tela", arguments: ["service", "codex"] },
    },
  };
  writeFileSync(join(payload, PACKAGED_PRODUCT_MANIFEST), `${JSON.stringify(manifest)}\n`);
  return payload;
}

async function installV1(root: string, home: string, runner: SystemdUpgradeRunner): Promise<string> {
  const payload = createPayload(root, "1.0.0", "v1\n");
  const planned = await planPackagedInstallFromPayload({ payloadSourcePath: payload, platform: "linux", home, environment: {}, runner });
  const result = await applyPackagedInstallFromPayload({ planned, payloadSourcePath: payload, platform: "linux", home, environment: {}, runner });
  expect(result.verify.ready).toBe(true);
  return payload;
}

describe("packaged upgrade journal", () => {
  test("concrete Linux service controller drives quiesce and restore through the upgrade journal", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-upgrade-platform-controller-"));
    const home = join(root, "home");
    mkdirSync(home);
    const runner = new SystemdUpgradeRunner();
    try {
      await installV1(root, home, runner);
      const target = createPayload(root, "2.0.0", "v2\n");
      const plan = await planPackagedUpgradeFromPayload({ payloadSourcePath: target, platform: "linux", home, environment: {}, runner });
      const gateway = plan.targetBlueprint.services.find(service => service.service === "gateway")!.resource.registrationId;
      const chat = plan.targetBlueprint.services.find(service => service.service === "chat")!.resource.registrationId;
      runner.running.add(gateway);
      runner.running.add(chat);
      const result = await applyPackagedUpgradeWithPlatformServices({ plan, payloadSourcePath: target,
        platform: "linux", home, environment: {}, runner });
      expect(result.resumedServices).toEqual(["chat", "gateway"]);
      expect(runner.running.has(gateway)).toBe(true);
      expect(runner.running.has(chat)).toBe(true);
      expect(readOwnershipManifest(plan.targetBlueprint.paths.installManifest)?.productVersion).toBe("2.0.0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("quiesces all services, replaces exact payload, commits version, and restores only prior running services", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-upgrade-"));
    const home = join(root, "home");
    mkdirSync(home);
    const runner = new SystemdUpgradeRunner();
    try {
      await installV1(root, home, runner);
      const target = createPayload(root, "2.0.0", "v2\n");
      const plan = await planPackagedUpgradeFromPayload({ payloadSourcePath: target, platform: "linux", home, environment: {}, runner });
      const services = new UpgradeServices(["gateway", "chat"]);
      const result = await applyPackagedUpgradeFromPayload({ plan, payloadSourcePath: target, services,
        platform: "linux", home, environment: {}, runner });
      expect(result).toMatchObject({ fromVersion: "1.0.0", toVersion: "2.0.0", resumedServices: ["chat", "gateway"] });
      expect(services.events).toEqual([
        "stop:gateway", "stop:codex", "stop:chat",
        "start:chat", "start:gateway",
      ]);
      expect(services.states.get("gateway")).toBe("running");
      expect(services.states.get("chat")).toBe("running");
      expect(services.states.get("codex")).toBe("stopped");
      const manifest = readOwnershipManifest(plan.targetBlueprint.paths.installManifest)!;
      expect(manifest.productVersion).toBe("2.0.0");
      expect(readFileSync(join(plan.targetBlueprint.paths.binaryRoot, "tela"), "utf8")).toBe("v2\n");
      expect(existsSync(packagedUpgradeJournalPath(plan.targetBlueprint.paths))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resume failure leaves a target-version journal and a retry completes only outstanding restarts", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-upgrade-resume-"));
    const home = join(root, "home");
    mkdirSync(home);
    const runner = new SystemdUpgradeRunner();
    try {
      await installV1(root, home, runner);
      const target = createPayload(root, "2.0.0", "v2\n");
      const plan = await planPackagedUpgradeFromPayload({ payloadSourcePath: target, platform: "linux", home, environment: {}, runner });
      const services = new UpgradeServices(["gateway", "chat", "codex"]);
      services.failResumeOnce = "gateway";
      await expect(applyPackagedUpgradeFromPayload({ plan, payloadSourcePath: target, services,
        platform: "linux", home, environment: {}, runner })).rejects.toThrow("fixture resume failure");
      const journalPath = packagedUpgradeJournalPath(plan.targetBlueprint.paths);
      const journal = readPackagedUpgradeJournal(journalPath)!;
      expect(journal.phase).toBe("manifest-updated");
      expect(journal.resumedServices).toEqual(["chat", "codex"]);
      expect(readOwnershipManifest(plan.targetBlueprint.paths.installManifest)?.productVersion).toBe("2.0.0");

      services.events.length = 0;
      const replanned = await planPackagedUpgradeFromPayload({ payloadSourcePath: target, platform: "linux",
        home, environment: {}, runner });
      expect(replanned).toMatchObject({ fromVersion: "1.0.0", toVersion: "2.0.0" });
      const completed = await applyPackagedUpgradeFromPayload({ plan: replanned, payloadSourcePath: target, services,
        platform: "linux", home, environment: {}, runner });
      expect(completed.resumedServices).toEqual(["chat", "codex", "gateway"]);
      expect(services.events).toEqual(["start:gateway"]);
      expect(existsSync(journalPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("service definition changes and current payload drift fail before an upgrade journal is created", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-upgrade-drift-"));
    const home = join(root, "home");
    mkdirSync(home);
    const runner = new SystemdUpgradeRunner();
    try {
      await installV1(root, home, runner);
      const changedDefinition = createPayload(root, "2.0.0", "v2\n", "gateway-new");
      await expect(planPackagedUpgradeFromPayload({ payloadSourcePath: changedDefinition, platform: "linux",
        home, environment: {}, runner })).rejects.toThrow("stable service registration identity");

      const target = createPayload(root, "2.0.0", "v2-other\n");
      const installedBinary = join(home, ".local", "share", "chatgpt-tela", "bin", "tela");
      writeFileSync(installedBinary, "foreign drift\n");
      await expect(planPackagedUpgradeFromPayload({ payloadSourcePath: target, platform: "linux",
        home, environment: {}, runner })).rejects.toThrow("cannot be proven exact");
      const paths = (await import("./layout")).resolveProductPaths({ platform: "linux", home, environment: {} });
      expect(existsSync(packagedUpgradeJournalPath(paths))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
