import { withPackagedTransitionOwner } from "./transition-owner";
import { retainPackagedRecoveryArtifact, reviewPackagedRecoveryArtifact } from "./recovery-artifact";
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { cancelSignedPackagedUpgrade } from "./packaged-upgrade";
import { createEd25519PackagedPayloadSigner, writePackagedPayloadSignature } from "./packaged-signature";
import { assertPackagedLaunchAdmission } from "./packaged-launch-admission";
import { observeInstalledPackagedPayload } from "./packaged-payload";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPackagedInstallFromPayload, planPackagedInstallFromPayload } from "./packaged-install";
import { PACKAGED_PRODUCT_MANIFEST } from "./packaged-manifest";
import {
  applyPackagedUpgradeFromPayload,
  applySignedPackagedUpgradeWithRecovery,
  applySignedPackagedUpgradeFromPayload,
  packagedUpgradeJournalPath,
  planPackagedUpgradeFromPayload,
  readPackagedUpgradeJournal,
  type PackagedUpgradeServiceController,
} from "./packaged-upgrade";
import { applyPackagedUpgradeWithPlatformServices } from "./packaged-service-controller";
import { readOwnershipManifest } from "./ownership";
import type { ServiceRegistrationCommandResult, ServiceRegistrationCommandRunner } from "./service-registration";
import type { TelaServiceId } from "./layout";
import { resolveProductPaths } from "./layout";
import { PackagedServiceShutdownNotStartedError } from "./service-shutdown";

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

async function recoveryFixture() {
  const root = mkdtempSync(join(tmpdir(), "tela-owned-recovery-")), home = join(root, "home"); mkdirSync(home);
  const runner = new SystemdUpgradeRunner(), options = { platform: "linux" as const, home, environment: {}, runner };
  const keys = generateKeyPairSync("ed25519"), trustedKeys = { fixture: keys.publicKey };
  const source = createPayload(root, "1.0.0", "source"), target = createPayload(root, "2.0.0", "target");
  for (const path of [source, target]) {
    const manifest = JSON.parse(readFileSync(join(path, PACKAGED_PRODUCT_MANIFEST), "utf8"));
    Object.assign(manifest, { launcher: { executable: "tela" }, profileRuntime: { executable: "tela", entrypoint: "tela" },
      lifecycle: { transitionLaunch: 1, sourceCancellation: 1 }, integrity: { signature: "ed25519-sha256-tree-v1", keyId: "fixture" } });
    writeFileSync(join(path, PACKAGED_PRODUCT_MANIFEST), JSON.stringify(manifest));
    writePackagedPayloadSignature({ payloadRoot: path, signer: createEd25519PackagedPayloadSigner({ keyId: "fixture", privateKey: keys.privateKey }) });
  }
  const planned = await planPackagedInstallFromPayload({ payloadSourcePath: source, ...options });
  await applyPackagedInstallFromPayload({ planned, payloadSourcePath: source, ...options });
  const plan = await planPackagedUpgradeFromPayload({ payloadSourcePath: target, ...options });
  return { root, source, target, plan, trustedKeys, options, services: new UpgradeServices(["gateway", "chat", "codex"]) };
}

test("a known participant blocker refuses the complete upgrade before any stop or journal", async () => {
  const f = await recoveryFixture();
  try {
    const services: PackagedUpgradeServiceController = { ...f.services,
      inspect: f.services.inspect.bind(f.services), quiesce: f.services.quiesce.bind(f.services), resume: f.services.resume.bind(f.services),
      async prepare() { throw new PackagedServiceShutdownNotStartedError("chat"); },
    };
    await expect(applySignedPackagedUpgradeFromPayload({ plan: f.plan, payloadSourcePath: f.target,
      trustedKeys: f.trustedKeys, services, ...f.options })).rejects.toBeInstanceOf(PackagedServiceShutdownNotStartedError);
    expect(f.services.events).toEqual([]);
    expect(readPackagedUpgradeJournal(packagedUpgradeJournalPath(f.plan.targetBlueprint.paths))).toBeUndefined();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a late no-admission receipt restores stopped peers and leaves the refusing service running", async () => {
  const f = await recoveryFixture();
  try {
    const original = f.services.quiesce.bind(f.services);
    f.services.quiesce = async service => {
      if (service === "chat") throw new PackagedServiceShutdownNotStartedError(service);
      await original(service);
    };
    // Restoration must use the persisted acknowledgement, not an in-memory settlement guess.
    f.services.settleQuiescence = async () => false;
    await expect(applySignedPackagedUpgradeFromPayload({ plan: f.plan, payloadSourcePath: f.target,
      trustedKeys: f.trustedKeys, services: f.services, ...f.options })).rejects.toMatchObject({ recoveryState: "source-restored" });
    expect(f.services.events).toEqual(["stop:gateway", "stop:codex", "start:codex", "start:gateway"]);
    expect([...f.services.states.values()]).toEqual(["running", "running", "running"]);
    expect(readPackagedUpgradeJournal(packagedUpgradeJournalPath(f.plan.targetBlueprint.paths))).toBeUndefined();
    expect(readOwnershipManifest(f.plan.targetBlueprint.paths.installManifest)?.productVersion).toBe("1.0.0");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("ordinary signed upgrade snapshots the installed source and restores without an operator recovery path", async () => {
  const f = await recoveryFixture();
  try {
    rmSync(f.source, { recursive: true }); // No dependency on the original download/workspace.
    const paths = f.plan.targetBlueprint.paths;
    expect(reviewPackagedRecoveryArtifact(f.plan, f.trustedKeys).origin).toBe("installed");
    expect(existsSync(join(paths.stateRoot, "install", "recovery"))).toBe(false);
    const original = f.services.quiesce.bind(f.services);
    f.services.quiesce = async service => {
      expect(reviewPackagedRecoveryArtifact(f.plan, f.trustedKeys).origin).toBe("retained");
      await original(service);
      if (service === "codex") throw new Error("synthetic stop failed after settlement");
    };
    await expect(applySignedPackagedUpgradeFromPayload({ plan: f.plan, payloadSourcePath: f.target,
      trustedKeys: f.trustedKeys, services: f.services, ...f.options })).rejects.toMatchObject({ recoveryState: "source-restored" });
    expect(readOwnershipManifest(paths.installManifest)?.productVersion).toBe("1.0.0");
    expect(f.services.events).toEqual(["stop:gateway", "stop:codex", "start:codex", "start:gateway"]);
    expect(readPackagedUpgradeJournal(packagedUpgradeJournalPath(paths))).toBeUndefined();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("retained recovery survives an interrupted restoration without a second stop or the original package", async () => {
  const f = await recoveryFixture();
  try {
    const original = f.services.quiesce.bind(f.services);
    f.services.quiesce = async service => { await original(service); if (service === "codex") throw new Error("synthetic stop failure"); };
    f.services.failResumeOnce = "gateway";
    const invoke = () => applySignedPackagedUpgradeFromPayload({ plan: f.plan, payloadSourcePath: f.target,
      trustedKeys: f.trustedKeys, services: f.services, ...f.options });
    await expect(invoke()).rejects.toMatchObject({ recoveryState: "restoration-incomplete" });
    rmSync(f.source, { recursive: true });
    const stops = f.services.events.filter(row => row.startsWith("stop:")).length;
    await expect(invoke()).rejects.toMatchObject({ recoveryState: "source-restored" });
    expect(f.services.events.filter(row => row.startsWith("stop:"))).toHaveLength(stops);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("corrupted retained evidence is preserved and blocks shutdown instead of falling back", async () => {
  const f = await recoveryFixture();
  try {
    const retained = await withPackagedTransitionOwner({ paths: f.plan.targetBlueprint.paths, installId: f.plan.installId },
      () => retainPackagedRecoveryArtifact(f.plan, f.trustedKeys));
    writeFileSync(join(retained.sourcePayloadPath, "tela"), "foreign bytes");
    await expect(applySignedPackagedUpgradeFromPayload({ plan: f.plan, payloadSourcePath: f.target,
      trustedKeys: f.trustedKeys, services: f.services, ...f.options })).rejects.toThrow("fingerprint");
    expect(f.services.events).toEqual([]);
    expect(readFileSync(join(retained.sourcePayloadPath, "tela"), "utf8")).toBe("foreign bytes");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a retained key cannot replace externally supplied release trust", async () => {
  const f = await recoveryFixture();
  try {
    const retained = await withPackagedTransitionOwner({ paths: f.plan.targetBlueprint.paths, installId: f.plan.installId },
      () => retainPackagedRecoveryArtifact(f.plan, f.trustedKeys));
    const path = join(retained.sourcePayloadPath, "..", "trusted-key.pem");
    writeFileSync(path, "unknown key");
    await expect(applySignedPackagedUpgradeFromPayload({ plan: f.plan, payloadSourcePath: f.target,
      trustedKeys: f.trustedKeys, services: f.services, ...f.options })).rejects.toThrow("differs from release authority");
    expect(f.services.events).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("unknown key");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("owned interrupted snapshot staging resumes before any stop was issued", async () => {
  const f = await recoveryFixture();
  try {
    const input = { paths: f.plan.targetBlueprint.paths, installId: f.plan.installId };
    const retained = await withPackagedTransitionOwner(input, () => retainPackagedRecoveryArtifact(f.plan, f.trustedKeys));
    const cache = join(input.paths.stateRoot, "install", "recovery"), pending = join(cache, "pending");
    renameSync(join(cache, "source"), pending);
    const receiptPath = join(pending, "receipt.json"), receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    writeFileSync(receiptPath, JSON.stringify({ ...receipt, phase: "copying" }));
    writeFileSync(join(pending, "payload", "tela"), "partial copy");
    expect(reviewPackagedRecoveryArtifact(f.plan, f.trustedKeys).origin).toBe("installed");
    const restored = await withPackagedTransitionOwner(input, () => retainPackagedRecoveryArtifact(f.plan, f.trustedKeys));
    expect(restored.sourcePayloadPath).toBe(retained.sourcePayloadPath);
    expect(readFileSync(join(restored.sourcePayloadPath, "tela"), "utf8")).toBe("source");
    expect(existsSync(pending)).toBe(false);
    expect(f.services.events).toEqual([]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const evidence of ["pending", "absent"] as const) test(`resumed shutdown ${evidence} evidence remains protected without settlement`, async () => {
  const f = await recoveryFixture();
  try {
    const original = f.services.quiesce.bind(f.services);
    f.services.quiesce = async service => { await original(service); if (service === "codex") throw new Error("interrupted before acknowledgment"); };
    f.services.settleQuiescence = async () => false;
    const invoke = () => applySignedPackagedUpgradeFromPayload({ plan: f.plan, payloadSourcePath: f.target,
      trustedKeys: f.trustedKeys, services: f.services, ...f.options });
    await expect(invoke()).rejects.toMatchObject({ recoveryState: "settlement-required" });
    const path = packagedUpgradeJournalPath(f.plan.targetBlueprint.paths);
    expect(readPackagedUpgradeJournal(path)).toMatchObject({ stopEvidenceVersion: 1, pendingStop: "codex" });
    if (evidence === "absent") {
      const journal = JSON.parse(readFileSync(path, "utf8")); delete journal.stopEvidenceVersion; delete journal.pendingStop;
      writeFileSync(path, JSON.stringify(journal));
    }
    const bytes = readFileSync(path);
    const stops = f.services.events.length;
    await expect(invoke()).rejects.toMatchObject({ recoveryState: "settlement-required" });
    expect(f.services.events).toHaveLength(stops);
    expect(readFileSync(path)).toEqual(bytes);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("an acknowledged durable stop boundary permits source restoration with a fresh controller", async () => {
  const f = await recoveryFixture();
  try {
    const input = { paths: f.plan.targetBlueprint.paths, installId: f.plan.installId };
    await withPackagedTransitionOwner(input, () => retainPackagedRecoveryArtifact(f.plan, f.trustedKeys));
    // A crash after the acknowledgment write, before the next service's intent.
    f.services.states.set("gateway", "stopped");
    const path = packagedUpgradeJournalPath(input.paths);
    writeFileSync(path, JSON.stringify({ version: 1, installId: f.plan.installId, fromVersion: f.plan.fromVersion,
      toVersion: f.plan.toVersion, sourcePayloadFingerprint: f.plan.sourcePayload.payloadFingerprint,
      targetPayloadFingerprint: f.plan.targetPayloadFingerprint, phase: "quiescing",
      resumeServices: ["gateway", "codex", "chat"], quiescedServices: ["gateway"], resumedServices: [],
      stopEvidenceVersion: 1, pendingStop: null }));
    f.services.settleQuiescence = async () => false;
    await expect(applySignedPackagedUpgradeFromPayload({ plan: f.plan, payloadSourcePath: f.target,
      trustedKeys: f.trustedKeys, services: f.services, ...f.options })).rejects.toMatchObject({ recoveryState: "source-restored" });
    expect(f.services.events).toEqual(["start:gateway"]);
    expect(existsSync(path)).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

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

  async settleQuiescence(): Promise<boolean> { return true; }

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
  mkdirSync(join(payload, "native-engine"));
  writeFileSync(join(payload, "native-engine", "codex"), `engine ${content}`, { mode: 0o755 });
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

test("direct upgrade cannot stop services while another transition owns the installation", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-upgrade-competing-owner-")), home = join(root, "home");
  mkdirSync(home); const runner = new SystemdUpgradeRunner();
  try {
    await installV1(root, home, runner);
    const options = { platform: "linux" as const, home, environment: {}, runner };
    const target = createPayload(root, "2.0.0", "v2\n");
    const plan = await planPackagedUpgradeFromPayload({ payloadSourcePath: target, ...options });
    const services = new UpgradeServices(["gateway", "chat", "codex"]);
    await withPackagedTransitionOwner({ paths: plan.targetBlueprint.paths, installId: plan.installId }, async () => {
      await expect(applyPackagedUpgradeFromPayload({ plan, payloadSourcePath: target, services, ...options })).rejects.toThrow("another installer owns");
      expect(services.events).toEqual([]);
      expect(existsSync(packagedUpgradeJournalPath(plan.targetBlueprint.paths))).toBe(false);
      expect(readOwnershipManifest(plan.targetBlueprint.paths.installManifest)?.productVersion).toBe("1.0.0");
      expect(readFileSync(join(plan.targetBlueprint.paths.binaryRoot, "tela"), "utf8")).toBe("v1\n");
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

describe("packaged upgrade journal", () => {
  test("format changes during shutdown are refused before payload replacement and retain the checkpoint", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-upgrade-storage-drain-")), home = join(root, "home");
    mkdirSync(home); const runner = new SystemdUpgradeRunner();
    const options = { platform: "linux" as const, home, environment: {}, runner };
    try {
      await installV1(root, home, runner);
      const target = createPayload(root, "2.0.0", "v2\n"), paths = resolveProductPaths(options);
      mkdirSync(paths.serviceState("chat"), { recursive: true });
      const store = join(paths.serviceState("chat"), "process-operations-v1.json");
      writeFileSync(store, JSON.stringify({ version: 1, operations: [] }));
      const plan = await planPackagedUpgradeFromPayload({ payloadSourcePath: target, ...options });
      const services = new UpgradeServices(["chat"]);
      const original = services.quiesce.bind(services);
      services.quiesce = async service => {
        await original(service);
        if (service === "chat") writeFileSync(store, JSON.stringify({ version: 2, nextSessionId: 1024, operations: [] }));
      };
      // Establish the owned coordinator resource before comparing the protected install bytes.
      await withPackagedTransitionOwner({ paths, installId: plan.installId }, async () => {});
      const binary = readFileSync(join(paths.binaryRoot, "tela")), manifest = readFileSync(paths.installManifest);
      await expect(applyPackagedUpgradeFromPayload({ plan, payloadSourcePath: target, services, ...options })).rejects.toThrow("cannot read");
      expect(readFileSync(join(paths.binaryRoot, "tela"))).toEqual(binary);
      expect(readFileSync(paths.installManifest)).toEqual(manifest);
      expect(readPackagedUpgradeJournal(packagedUpgradeJournalPath(paths))?.phase).toBe("quiesced");
      expect(services.events.filter(event => event.startsWith("start:"))).toEqual([]);
      expect(JSON.parse(readFileSync(store, "utf8")).nextSessionId).toBe(1024);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
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
      const result = await applyPackagedUpgradeWithPlatformServices({ plan, shutdownService: async service => {
        const id = plan.targetBlueprint.services.find(entry => entry.service === service)!.resource.registrationId;
        runner.running.delete(id);
      }, payloadSourcePath: target,
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
      expect(readFileSync(join(plan.targetBlueprint.paths.binaryRoot, "native-engine", "codex"), "utf8")).toBe("engine v2\n");
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

test("isolated upgrade preserves optional provider, official config and external registration", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-upgrade-independent-"));
  const home = join(root, "home"); mkdirSync(home);
  const runner = new SystemdUpgradeRunner();
  try {
    await installV1(root, home, runner);
    const target = createPayload(root, "2.0.0", "v2\n");
    const plan = await planPackagedUpgradeFromPayload({ payloadSourcePath: target, platform: "linux", home, environment: {}, runner });
    const provider = join(home, "PluraDesktop", "launcher");
    const official = join(home, ".codex", "config.toml");
    const integration = join(plan.targetBlueprint.paths.configRoot, "optional-provider-fixture.json");
    for (const path of [provider, official, integration]) {
      mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, "preserved-independent-fixture");
    }
    runner.loaded.add("plura-fixture.service"); runner.running.add("plura-fixture.service");
    const services = new UpgradeServices(["codex"]);
    const result = await applyPackagedUpgradeFromPayload({ plan, payloadSourcePath: target, services,
      platform: "linux", home, environment: {}, runner });
    expect(result.toVersion).toBe("2.0.0");
    for (const path of [provider, official, integration]) expect(readFileSync(path, "utf8")).toBe("preserved-independent-fixture");
    expect(runner.loaded.has("plura-fixture.service")).toBe(true);
    expect(runner.running.has("plura-fixture.service")).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const boundary of ["restore", "interrupted", "replacing", "payload-drift", "store-version", "untrusted-key", "old-launcher"] as const) {
  test(`signed pre-replacement cancellation: ${boundary}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-source-cancel-")), home = join(root, "home");
    mkdirSync(home); const runner = new SystemdUpgradeRunner();
    const options = { platform: "linux" as const, home, environment: {}, runner };
    try {
      const source = createPayload(root, "1.0.0", "source"), keys = generateKeyPairSync("ed25519");
      const sourceManifest = JSON.parse(readFileSync(join(source, PACKAGED_PRODUCT_MANIFEST), "utf8"));
      if (boundary !== "old-launcher") sourceManifest.lifecycle = { transitionLaunch: 1, sourceCancellation: 1 };
      sourceManifest.launcher = { executable: "tela" };
      sourceManifest.profileRuntime = { executable: "tela", entrypoint: "tela" };
      sourceManifest.integrity = { signature: "ed25519-sha256-tree-v1", keyId: "cancel-fixture" };
      writeFileSync(join(source, PACKAGED_PRODUCT_MANIFEST), JSON.stringify(sourceManifest));
      writePackagedPayloadSignature({ payloadRoot: source, signer: createEd25519PackagedPayloadSigner({ keyId: "cancel-fixture", privateKey: keys.privateKey }) });
      const planned = await planPackagedInstallFromPayload({ payloadSourcePath: source, ...options });
      await applyPackagedInstallFromPayload({ planned, payloadSourcePath: source, ...options });
      const target = createPayload(root, "2.0.0", "target"), paths = resolveProductPaths(options);
      const targetManifest = JSON.parse(readFileSync(join(target, PACKAGED_PRODUCT_MANIFEST), "utf8"));
      Object.assign(targetManifest, { launcher: sourceManifest.launcher, profileRuntime: sourceManifest.profileRuntime, integrity: sourceManifest.integrity });
      writeFileSync(join(target, PACKAGED_PRODUCT_MANIFEST), JSON.stringify(targetManifest));
      const plan = await planPackagedUpgradeFromPayload({ payloadSourcePath: target, ...options });
      const services = new UpgradeServices(["chat", "gateway"]), originalStop = services.quiesce.bind(services);
      services.quiesce = async service => {
        if (service === "chat") throw new Error("active owner refuses shutdown");
        await originalStop(service);
      };
      await expect(applyPackagedUpgradeFromPayload({ plan, payloadSourcePath: target, services, ...options })).rejects.toThrow("active owner");
      const journalPath = packagedUpgradeJournalPath(paths);
      const originalResume = services.resume.bind(services);
      services.resume = async service => {
        const ownership = readOwnershipManifest(paths.installManifest)!;
        const resource = ownership.resources.find(resource => resource.id === "product-binaries")!;
        if (resource.kind !== "directory") throw new Error("wrong resource");
        const observed = observeInstalledPackagedPayload(resource, ownership);
        if (observed.state !== "owned") throw new Error("wrong receipt");
        assertPackagedLaunchAdmission({ paths, ownership, receipt: observed.receipt, service });
        await originalResume(service);
      };
      if (boundary === "replacing") writeFileSync(journalPath, JSON.stringify({ ...readPackagedUpgradeJournal(journalPath), phase: "payload-replacing" }));
      if (boundary === "payload-drift") writeFileSync(join(paths.binaryRoot, "tela"), "changed");
      if (boundary === "store-version") {
        mkdirSync(paths.serviceState("chat"), { recursive: true });
        writeFileSync(join(paths.serviceState("chat"), "process-operations-v1.json"), JSON.stringify({ version: 2, nextSessionId: 1024, operations: [] }));
      }
      const journal = readFileSync(journalPath), manifest = readFileSync(paths.installManifest), binary = readFileSync(join(paths.binaryRoot, "tela"));
      const cancel = () => cancelSignedPackagedUpgrade({ ...options, sourcePayloadPath: source, services, trustedKeys: boundary === "untrusted-key" ? {} : { "cancel-fixture": keys.publicKey } });
      if (boundary === "restore" || boundary === "interrupted") {
        if (boundary === "interrupted") {
          services.failResumeOnce = "gateway";
          await expect(cancel()).rejects.toThrow("fixture resume failure");
          expect(readPackagedUpgradeJournal(journalPath)?.phase).toBe("restoring-source");
          expect(readPackagedUpgradeJournal(journalPath)?.resumedServices).toEqual(["chat"]);
          await expect(applyPackagedUpgradeFromPayload({ plan, payloadSourcePath: target, services, ...options })).rejects.toThrow("cancellation must finish");
        }
        expect((await cancel()).restoredServices).toEqual(["chat", "gateway"]);
        expect(existsSync(journalPath)).toBe(false);
        expect(services.events.filter(event => event === "start:chat")).toEqual([]);
        expect(services.events.filter(event => event === "start:codex")).toEqual([]);
        expect(services.states.get("gateway")).toBe("running");
      } else {
        await expect(cancel()).rejects.toThrow();
        expect(readFileSync(journalPath)).toEqual(journal);
        expect(services.events.filter(event => event.startsWith("start:"))).toEqual([]);
      }
      expect(readFileSync(paths.installManifest)).toEqual(manifest);
      expect(readFileSync(join(paths.binaryRoot, "tela"))).toEqual(binary);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

for(const boundary of ['restore','uncertain','untrusted-source','post-replacement','restoration-interrupted'] as const){
 test(`automatic signed upgrade recovery: ${boundary}`,async()=>{
  const root=mkdtempSync(join(tmpdir(),'tela-auto-recover-')),home=join(root,'home');mkdirSync(home);
  const runner=new SystemdUpgradeRunner(),options={platform:'linux' as const,home,environment:{},runner};
  try{
   const keys=generateKeyPairSync('ed25519'),source=createPayload(root,'1.0.0','source'),target=createPayload(root,'2.0.0','target');
   for(const payload of[source,target]){
    const manifest=JSON.parse(readFileSync(join(payload,PACKAGED_PRODUCT_MANIFEST),'utf8'));
    Object.assign(manifest,{launcher:{executable:'tela'},profileRuntime:{executable:'tela',entrypoint:'tela'},lifecycle:{transitionLaunch:1,sourceCancellation:1},integrity:{signature:'ed25519-sha256-tree-v1',keyId:'fixture'}});
    writeFileSync(join(payload,PACKAGED_PRODUCT_MANIFEST),JSON.stringify(manifest));
    writePackagedPayloadSignature({payloadRoot:payload,signer:createEd25519PackagedPayloadSigner({keyId:'fixture',privateKey:keys.privateKey})});
   }
   const planned=await planPackagedInstallFromPayload({payloadSourcePath:source,...options});
   await applyPackagedInstallFromPayload({planned,payloadSourcePath:source,...options});
   const paths=resolveProductPaths(options),plan=await planPackagedUpgradeFromPayload({payloadSourcePath:target,...options});
   const services=new UpgradeServices(['gateway','chat','codex']);
   if(boundary==='post-replacement')services.failResumeOnce='gateway';
   else {const original=services.quiesce.bind(services);services.quiesce=async service=>{await original(service);if(service==='codex')throw Error('fixture shutdown failed after settlement');};}
   if(boundary==='uncertain')services.settleQuiescence=async()=>false;
   if(boundary==='restoration-interrupted')services.failResumeOnce='gateway';
   const invoke=()=>applySignedPackagedUpgradeWithRecovery({plan,payloadSourcePath:target,trustedKeys:{fixture:keys.publicKey},services,...options,
    recovery:{sourcePayloadPath:source,trustedKeys:boundary==='untrusted-source'?{}:{fixture:keys.publicKey}}});
   if(boundary==='untrusted-source'){
    await expect(invoke()).rejects.toThrow('not trusted');expect(services.events).toHaveLength(0);expect(readPackagedUpgradeJournal(packagedUpgradeJournalPath(paths))).toBeUndefined();
   }else if(boundary==='uncertain'){
    await expect(invoke()).rejects.toMatchObject({recoveryState:'settlement-required'});
    expect(readPackagedUpgradeJournal(packagedUpgradeJournalPath(paths))?.phase).toBe('quiescing');
    expect(services.events.filter(x=>x.startsWith('start:'))).toHaveLength(0);
   }else if(boundary==='post-replacement'){
    await expect(invoke()).rejects.toMatchObject({recoveryState:'signed-resume-required'});
    expect(readOwnershipManifest(paths.installManifest)?.productVersion).toBe('2.0.0');
    expect(readFileSync(join(paths.binaryRoot,'tela'),'utf8')).toBe('target');
   }else{
    if(boundary==='restoration-interrupted'){
     await expect(invoke()).rejects.toMatchObject({recoveryState:'restoration-incomplete'});
     expect(readPackagedUpgradeJournal(packagedUpgradeJournalPath(paths))?.phase).toBe('restoring-source');
    }
    const stops=services.events.filter(x=>x.startsWith('stop:')).length;
    await expect(invoke()).rejects.toMatchObject({recoveryState:'source-restored'});
    if(boundary==='restoration-interrupted')expect(services.events.filter(x=>x.startsWith('stop:'))).toHaveLength(stops);
    expect(readPackagedUpgradeJournal(packagedUpgradeJournalPath(paths))).toBeUndefined();
    expect(readOwnershipManifest(paths.installManifest)?.productVersion).toBe('1.0.0');
    expect(readFileSync(join(paths.binaryRoot,'tela'),'utf8')).toBe('source');
    expect([...services.states.values()]).toEqual(['running','running','running']);
    expect(services.events.filter(x=>x==='start:chat')).toHaveLength(0);
   }
  }finally{rmSync(root,{recursive:true,force:true});}
 });
}
