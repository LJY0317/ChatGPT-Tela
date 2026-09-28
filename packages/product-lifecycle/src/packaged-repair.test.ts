import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPackagedInstallFromPayload, planPackagedInstallFromPayload } from "./packaged-install";
import { PACKAGED_PRODUCT_MANIFEST } from "./packaged-manifest";
import {
  applyPackagedRepairFromPayload,
  planSignedPackagedRepairFromPayload,
  planPackagedRepairFromPayload,
  readPackagedRepairJournal,
  type PackagedRepairServiceController,
} from "./packaged-repair";
import { packagedRepairJournalPath, packagedUpgradeJournalPath } from "./packaged-transition";
import { planPackagedUpgradeFromPayload } from "./packaged-upgrade";
import type { TelaServiceId } from "./layout";
import type { ServiceRegistrationCommandResult, ServiceRegistrationCommandRunner } from "./service-registration";

class SystemdRepairRunner implements ServiceRegistrationCommandRunner {
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
    if (arguments_.includes("is-active")) return { exitCode: 3, stdout: "inactive\n", stderr: "" };
    if (arguments_.includes("stop") || arguments_.includes("start")) return { exitCode: 0, stdout: "", stderr: "" };
    throw new Error(`unexpected systemctl arguments: ${arguments_.join(" ")}`);
  }
}

class RepairServices implements PackagedRepairServiceController {
  readonly states = new Map<TelaServiceId, "running" | "stopped">();
  readonly events: string[] = [];
  failResumeOnce: TelaServiceId | undefined;

  constructor(running: readonly TelaServiceId[]) {
    for (const service of ["gateway", "chat", "codex"] as const) {
      this.states.set(service, running.includes(service) ? "running" : "stopped");
    }
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

function createPayload(root: string, version = "1.0.0", bytes = "healthy\n"): string {
  const payload = join(root, `payload-${version.replaceAll(".", "-")}`);
  mkdirSync(payload, { recursive: true });
  writeFileSync(join(payload, "tela"), bytes, { mode: 0o755 });
  writeFileSync(join(payload, PACKAGED_PRODUCT_MANIFEST), `${JSON.stringify({
    version: 1,
    product: "chatgpt-tela",
    productVersion: version,
    services: {
      gateway: { executable: "tela", arguments: ["service", "gateway"] },
      chat: { executable: "tela", arguments: ["service", "chat"] },
      codex: { executable: "tela", arguments: ["service", "codex"] },
    },
  })}\n`);
  return payload;
}

async function installFixture(root: string, runner: SystemdRepairRunner) {
  const home = join(root, "home");
  mkdirSync(home);
  const payload = createPayload(root);
  const planned = await planPackagedInstallFromPayload({ payloadSourcePath: payload, platform: "linux", home, environment: {}, runner });
  const installed = await applyPackagedInstallFromPayload({ planned, payloadSourcePath: payload,
    platform: "linux", home, environment: {}, runner });
  expect(installed.verify.ready).toBe(true);
  return { home, payload, blueprint: planned.blueprint };
}

describe("same-version packaged repair", () => {
  test("healthy install plans keep and applies without quiescing anything", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-repair-healthy-"));
    const runner = new SystemdRepairRunner();
    try {
      const f = await installFixture(root, runner);
      const plan = await planPackagedRepairFromPayload({ payloadSourcePath: f.payload, platform: "linux",
        home: f.home, environment: {}, runner });
      expect(plan.payload.action).toBe("keep");
      expect(plan.services.map(service => service.action)).toEqual(["keep", "keep", "keep"]);
      const services = new RepairServices(["gateway"]);
      const result = await applyPackagedRepairFromPayload({ plan, payloadSourcePath: f.payload, services,
        platform: "linux", home: f.home, environment: {}, runner });
      expect(result.payload).toBe("kept");
      expect(result.services.every(service => service.outcome === "kept")).toBe(true);
      expect(services.events).toEqual([]);
      expect(existsSync(packagedRepairJournalPath(f.blueprint.paths))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("exact payload byte drift quiesces exact services, repairs bytes, and resumes only prior running services", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-repair-payload-"));
    const runner = new SystemdRepairRunner();
    try {
      const f = await installFixture(root, runner);
      writeFileSync(join(f.blueprint.paths.binaryRoot, "tela"), "damaged\n");
      const plan = await planPackagedRepairFromPayload({ payloadSourcePath: f.payload, platform: "linux",
        home: f.home, environment: {}, runner });
      expect(plan.payload).toMatchObject({ action: "repair", observation: "repairable" });
      const services = new RepairServices(["gateway", "chat"]);
      const result = await applyPackagedRepairFromPayload({ plan, payloadSourcePath: f.payload, services,
        platform: "linux", home: f.home, environment: {}, runner });
      expect(result).toMatchObject({ payload: "repaired", resumedServices: ["chat", "gateway"] });
      expect(readFileSync(join(f.blueprint.paths.binaryRoot, "tela"), "utf8")).toBe("healthy\n");
      expect(services.events).toEqual([
        "stop:gateway", "stop:codex", "stop:chat",
        "start:chat", "start:gateway",
      ]);
      expect(services.states.get("codex")).toBe("stopped");
      expect(existsSync(packagedRepairJournalPath(f.blueprint.paths))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resume failure leaves a durable journal and retry resumes only the outstanding service", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-repair-resume-"));
    const runner = new SystemdRepairRunner();
    try {
      const f = await installFixture(root, runner);
      writeFileSync(join(f.blueprint.paths.binaryRoot, "tela"), "damaged\n");
      const plan = await planPackagedRepairFromPayload({ payloadSourcePath: f.payload, platform: "linux",
        home: f.home, environment: {}, runner });
      const services = new RepairServices(["gateway", "chat"]);
      services.failResumeOnce = "gateway";
      await expect(applyPackagedRepairFromPayload({ plan, payloadSourcePath: f.payload, services,
        platform: "linux", home: f.home, environment: {}, runner })).rejects.toThrow("fixture resume failure");
      const journal = readPackagedRepairJournal(packagedRepairJournalPath(f.blueprint.paths));
      expect(journal).toMatchObject({ phase: "repaired", resumedServices: ["chat"] });
      services.events.length = 0;
      const retried = await applyPackagedRepairFromPayload({ plan, payloadSourcePath: f.payload, services,
        platform: "linux", home: f.home, environment: {}, runner });
      expect(retried.resumedServices).toEqual(["chat", "gateway"]);
      expect(services.events).toEqual(["start:gateway"]);
      expect(existsSync(packagedRepairJournalPath(f.blueprint.paths))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing service registration repairs independently while healthy payload stays untouched", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-repair-service-"));
    const runner = new SystemdRepairRunner();
    try {
      const f = await installFixture(root, runner);
      const chat = f.blueprint.services.find(service => service.service === "chat")!;
      runner.loaded.delete(chat.resource.registrationId);
      runner.enabled.delete(chat.resource.registrationId);
      rmSync(chat.resource.identity!.definitionPath!, { force: true });
      const plan = await planPackagedRepairFromPayload({ payloadSourcePath: f.payload, platform: "linux",
        home: f.home, environment: {}, runner });
      expect(plan.payload.action).toBe("keep");
      expect(plan.services.find(service => service.service === "chat")?.action).toBe("repair");
      const services = new RepairServices([]);
      const result = await applyPackagedRepairFromPayload({ plan, payloadSourcePath: f.payload, services,
        platform: "linux", home: f.home, environment: {}, runner });
      expect(result.payload).toBe("kept");
      expect(result.services.find(service => service.service === "chat")?.outcome).toBe("repaired");
      expect(services.events).toEqual([]);
      expect(existsSync(chat.resource.identity!.definitionPath!)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("foreign service definition drift is preserved and blocks payload byte repair", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-repair-drift-"));
    const runner = new SystemdRepairRunner();
    try {
      const f = await installFixture(root, runner);
      const gateway = f.blueprint.services.find(service => service.service === "gateway")!;
      writeFileSync(gateway.resource.identity!.definitionPath!, "foreign replacement\n");
      writeFileSync(join(f.blueprint.paths.binaryRoot, "tela"), "damaged\n");
      const plan = await planPackagedRepairFromPayload({ payloadSourcePath: f.payload, platform: "linux",
        home: f.home, environment: {}, runner });
      expect(plan.services.find(service => service.service === "gateway")?.action).toBe("preserve");
      expect(plan.payload.action).toBe("preserve");
      const services = new RepairServices(["gateway"]);
      const result = await applyPackagedRepairFromPayload({ plan, payloadSourcePath: f.payload, services,
        platform: "linux", home: f.home, environment: {}, runner });
      expect(result.payload).toBe("preserved");
      expect(readFileSync(join(f.blueprint.paths.binaryRoot, "tela"), "utf8")).toBe("damaged\n");
      expect(readFileSync(gateway.resource.identity!.definitionPath!, "utf8")).toBe("foreign replacement\n");
      expect(services.events).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keep plan never escalates into repair after later damage", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-repair-nonescalating-"));
    const runner = new SystemdRepairRunner();
    try {
      const f = await installFixture(root, runner);
      const plan = await planPackagedRepairFromPayload({ payloadSourcePath: f.payload, platform: "linux",
        home: f.home, environment: {}, runner });
      writeFileSync(join(f.blueprint.paths.binaryRoot, "tela"), "damaged-after-plan\n");
      const services = new RepairServices(["gateway"]);
      const result = await applyPackagedRepairFromPayload({ plan, payloadSourcePath: f.payload, services,
        platform: "linux", home: f.home, environment: {}, runner });
      expect(result.payload).toBe("preserved");
      expect(readFileSync(join(f.blueprint.paths.binaryRoot, "tela"), "utf8")).toBe("damaged-after-plan\n");
      expect(services.events).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("repair and upgrade journals are mutually exclusive", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-repair-conflict-"));
    const runner = new SystemdRepairRunner();
    try {
      const f = await installFixture(root, runner);
      mkdirSync(join(f.blueprint.paths.stateRoot, "install"), { recursive: true });
      writeFileSync(packagedUpgradeJournalPath(f.blueprint.paths), "{}\n");
      await expect(planPackagedRepairFromPayload({ payloadSourcePath: f.payload, platform: "linux",
        home: f.home, environment: {}, runner })).rejects.toThrow("other packaged transition");
      rmSync(packagedUpgradeJournalPath(f.blueprint.paths));
      writeFileSync(packagedRepairJournalPath(f.blueprint.paths), "{}\n");
      const v2 = createPayload(root, "2.0.0", "v2\n");
      await expect(planPackagedUpgradeFromPayload({ payloadSourcePath: v2, platform: "linux",
        home: f.home, environment: {}, runner })).rejects.toThrow("other packaged transition");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("signed repair entrypoint refuses an unsigned same-version payload before planning", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-repair-signature-"));
    const runner = new SystemdRepairRunner();
    try {
      const f = await installFixture(root, runner);
      await expect(planSignedPackagedRepairFromPayload({
        payloadSourcePath: f.payload,
        trustedKeys: {},
        platform: "linux",
        home: f.home,
        environment: {},
        runner,
      })).rejects.toThrow("signed payload integrity");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
