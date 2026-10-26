import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPackagedPayload, resolveProductPaths, readOwnershipManifest, prepareOwnedDirectory,
  packagedUpgradeJournalPath, readPackagedUpgradeJournal, readPackagedProductManifest, planPackagedUpgradeFromPayload, PackagedServiceShutdownNotStartedError,
  type PackagedUpgradeJournal, type ServiceRegistrationCommandRunner } from "@chatgpt-tela/product-lifecycle";
import { runPackagedLifecycleCommand } from "./lifecycle";
import { cleanupMaintenanceWindow, runMaintenanceCommand, stageMaintenanceWindow, resolveMaintenanceWindowSource } from "./maintenance";
import { registerTemporaryFixtureCleanup } from "../../../tests/support/temporary-fixtures";

const removeFixture = registerTemporaryFixtureCleanup();

class FakeManager implements ServiceRegistrationCommandRunner {
  readonly loaded = new Set<string>();
  readonly running = new Set<string>();
  async run(command: string, args: readonly string[]) {
    if (command !== "systemctl") throw new Error("Only fake systemctl is allowed");
    const unit = args.at(-1)!;
    if (args.includes("is-active")) return { exitCode: this.running.has(unit) ? 0 : 3, stdout: this.running.has(unit) ? "active\n" : "inactive\n", stderr: "" };
    if (args.includes("is-enabled")) return { exitCode: this.loaded.has(unit) ? 0 : 1,
      stdout: this.loaded.has(unit) ? "enabled\n" : "disabled\n", stderr: "" };
    if (args.includes("show")) return { exitCode: this.loaded.has(unit) ? 0 : 1,
      stdout: this.loaded.has(unit) ? "loaded\n" : "not-found\n", stderr: "" };
    if (args.includes("enable")) this.loaded.add(unit);
    else if (args.includes("disable")) this.loaded.delete(unit);
    else if (args.includes("stop")) this.running.delete(unit);
    else if (args.includes("start")) this.running.add(unit);
    else if (!args.includes("daemon-reload") && !args.includes("stop") && !args.includes("start")) throw new Error("Unexpected fake manager operation");
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

function fixture(root: string, supportsCancellation = true) {
  const input = join(root, "input"), home = join(root, "home");
  mkdirSync(join(input, "electron", "bin"), { recursive: true }); mkdirSync(home);
  for (const name of ["launcher", "gateway", "chat", "codex", "menu-bar"]) writeFileSync(join(input, name), name, { mode: 0o755 });
  writeFileSync(join(input, "electron/bin/electron"), "electron", { mode: 0o755 });
  writeFileSync(join(input, "profile.cjs"), "module.exports={};");

  const build = (version: string) => {
    const payload = join(root, version);
    buildPackagedPayload({ outputPath: payload, productVersion: version, launcherSourcePath: join(input, "launcher"),
      menuBarSourcePath: join(input, "menu-bar"),
      ...(supportsCancellation ? { lifecycle: { transitionLaunch: 1 as const, sourceCancellation: 1 as const } } : {}),
      services: { gateway: { executableSourcePath: join(input, "gateway") }, chat: { executableSourcePath: join(input, "chat") }, codex: { executableSourcePath: join(input, "codex") } },
      profileRuntime: { electronBundleSourcePath: join(input, "electron"), electronExecutableRelativePath: "bin/electron", entrypointSourcePath: join(input, "profile.cjs") },});
    return payload;
  };
  return { home, first: build("1.0.0"), second: build("2.0.0"), runner: new FakeManager() };
}

test("review -> repair -> upgrade -> keep-data removal uses fake OS manager and preserves unrelated data", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-maintenance-test-"));
  try {
    const f = fixture(root), options = { platform: "linux" as const, home: f.home, environment: {}, runner: f.runner, executingBinaryPath: join(root, "external-launcher") };
    await runPackagedLifecycleCommand(["install", "--apply", "--payload", f.first, ], options);
    const paths = resolveProductPaths(options), ownership = readOwnershipManifest(paths.installManifest)!;
    await prepareOwnedDirectory({ manifestPath: paths.installManifest, installId: ownership.installId, productVersion: ownership.productVersion,
      resource: { kind: "directory", id: "product-config", owner: "product", path: paths.configRoot, dataClass: "config" } });
    writeFileSync(join(paths.configRoot, "saved-settings.json"), "preserve settings");
    const binary = ownership.resources.find(r => r.kind === "directory" && r.id === "product-binaries")!;
    if (binary.kind !== "directory") throw new Error("missing fixture binary");
    const sentinel = join(f.home, "project.txt"); writeFileSync(sentinel, "untouched project");
    const damaged = join(binary.path, "services/chat"); writeFileSync(damaged, "damaged");
    const repairArgs = ["--payload", f.first, ];
    const reviewed = await runMaintenanceCommand(["maintenance", "review", "repair", ...repairArgs], options) as any;
    expect(readFileSync(damaged, "utf8")).toBe("damaged");
    const sourceBinary = join(f.first, "services/chat");
    const originalBytes = readFileSync(sourceBinary); writeFileSync(sourceBinary, "changed package");
    await expect(runMaintenanceCommand(["maintenance", "apply", "repair", ...repairArgs, "--review-token", reviewed.reviewToken], options)).rejects.toThrow("changed");
    expect(readFileSync(damaged, "utf8")).toBe("damaged"); writeFileSync(sourceBinary, originalBytes);
    const fresh = await runMaintenanceCommand(["maintenance", "review", "repair", ...repairArgs], options) as any;
    expect((await runMaintenanceCommand(["maintenance", "apply", "repair", ...repairArgs, "--review-token", fresh.reviewToken], options) as any).success).toBe(true);
    expect(readFileSync(damaged, "utf8")).toBe("chat");
    const updateArgs = ["--payload", f.second, ];
    const update = await runMaintenanceCommand(["maintenance", "review", "upgrade", ...updateArgs], options) as any;
    expect(update.fromVersion).toBe("1.0.0"); expect(update.toVersion).toBe("2.0.0");
    expect((await runMaintenanceCommand(["maintenance", "apply", "upgrade", ...updateArgs, "--review-token", update.reviewToken], options) as any).success).toBe(true);
    const removal = await runMaintenanceCommand(["maintenance", "review", "uninstall"], options) as any;
    expect(removal.resources.some((r: any) => r.action === "preserve")).toBe(true);
    await expect(runMaintenanceCommand(["maintenance", "apply", "uninstall", "--review-token", removal.reviewToken], { ...options, executingBinaryPath: join(binary.path, "chatgpt-tela") })).rejects.toThrow("separately extracted");
    const removed = await runMaintenanceCommand(["maintenance", "apply", "uninstall", "--review-token", removal.reviewToken], options) as any;
    expect(removed.success).toBe(true); expect(removed.preservedCount).toBeGreaterThan(0);
    expect(existsSync(binary.path)).toBe(false); expect(readFileSync(sentinel, "utf8")).toBe("untouched project");
    expect(readFileSync(join(paths.configRoot, "saved-settings.json"), "utf8")).toBe("preserve settings");
    expect(removed.accountCleanup).toMatchObject({ status: "not-performed" });
    // Reinstall uses retained Tela data; it must not require erasing settings or user projects.
    await runPackagedLifecycleCommand(["install", "--apply", "--payload", f.second], options);
    expect(readOwnershipManifest(paths.installManifest)?.productVersion).toBe("2.0.0");
    expect(readFileSync(join(paths.configRoot, "saved-settings.json"), "utf8")).toBe("preserve settings");
    expect(readFileSync(sentinel, "utf8")).toBe("untouched project");
  } finally { removeFixture(root); }
});

test("apply requires review and rejects unknown/ambiguous operation arguments", async () => {
  await expect(runMaintenanceCommand(["maintenance", "apply", "uninstall"])).rejects.toThrow("review");
  await expect(runMaintenanceCommand(["maintenance", "review", "uninstall", "--everything"])).rejects.toThrow("only accepts");
  await expect(runMaintenanceCommand(["maintenance", "review", "upgrade"])).rejects.toThrow("explicit package");
});

test("maintenance review and apply surface a newly blocked shutdown without stopping services", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-maintenance-shutdown-readiness-"));
  try {
    const f = fixture(root), options = { platform: "linux" as const, home: f.home, environment: {}, runner: f.runner };
    await runPackagedLifecycleCommand(["install", "--apply", "--payload", f.first], options);
    const paths = resolveProductPaths(options);
    for (const service of ["gateway", "codex", "chat"] as const) f.runner.running.add(`chatgpt-tela-${service}.service`);
    let mode: "none" | "late" | "always" = "none", checks = 0;
    const liveOptions = { ...options, async prepareShutdownService(service: "gateway" | "codex" | "chat") {
      if (service !== "chat") return;
      checks++;
      if (mode === "always" || mode === "late" && checks >= 3) throw new PackagedServiceShutdownNotStartedError(service);
    }, async shutdownService(service: "gateway" | "codex" | "chat") {
      if (service === "chat") throw new PackagedServiceShutdownNotStartedError(service);
      f.runner.running.delete(`chatgpt-tela-${service}.service`);
    } };
    const args = ["--payload", f.second];
    const directReview = await runPackagedLifecycleCommand(["upgrade", "--dry-run", ...args], liveOptions) as any;
    expect(directReview.shutdownBlockers).toEqual([]);
    const reviewed = await runMaintenanceCommand(["maintenance", "review", "upgrade", ...args], liveOptions) as any;
    expect(reviewed.blockers).toEqual([]);

    mode = "late";
    const applied = await runMaintenanceCommand(["maintenance", "apply", "upgrade", ...args,
      "--review-token", reviewed.reviewToken], liveOptions) as any;
    expect(applied).toMatchObject({ success: false, failedCount: 0,
      blockers: ["chat: not ready to stop. Finish active work or check the service status before maintenance."] });
    expect(f.runner.running).toEqual(new Set(["chatgpt-tela-gateway.service", "chatgpt-tela-codex.service", "chatgpt-tela-chat.service"]));
    expect(readOwnershipManifest(paths.installManifest)?.productVersion).toBe("1.0.0");
    expect(readPackagedUpgradeJournal(packagedUpgradeJournalPath(paths))).toBeUndefined();

    mode = "none";
    const raceReview = await runMaintenanceCommand(["maintenance", "review", "upgrade", ...args], liveOptions) as any;
    const raceApply = await runMaintenanceCommand(["maintenance", "apply", "upgrade", ...args,
      "--review-token", raceReview.reviewToken], liveOptions) as any;
    expect(raceApply).toMatchObject({ success: false, failedCount: 0, productVersion: "1.0.0" });
    expect(raceApply.blockers[0]).toContain("The previous version was restored and previously running services were resumed.");
    expect(f.runner.running).toEqual(new Set(["chatgpt-tela-gateway.service", "chatgpt-tela-codex.service", "chatgpt-tela-chat.service"]));
    expect(readOwnershipManifest(paths.installManifest)?.productVersion).toBe("1.0.0");
    expect(readPackagedUpgradeJournal(packagedUpgradeJournalPath(paths))).toBeUndefined();

    mode = "always";
    const directBlocked = await runPackagedLifecycleCommand(["upgrade", "--dry-run", ...args], liveOptions) as any;
    expect(directBlocked.shutdownBlockers).toEqual(["chat: not ready to stop. Finish active work or check the service status before maintenance."]);
    const blockedReview = await runMaintenanceCommand(["maintenance", "review", "upgrade", ...args], liveOptions) as any;
    expect(blockedReview.blockers).toEqual(["chat: not ready to stop. Finish active work or check the service status before maintenance."]);
  } finally { removeFixture(root); }
});

test("temporary maintenance binaries clean up only their exact owned snapshot", () => {
  const source = mkdtempSync(join(tmpdir(), "tela-maintenance-source-"));
  let staged: string | undefined;
  try {
    writeFileSync(join(source, "launcher"), "launcher"); writeFileSync(join(source, "ui"), "ui");
    staged = stageMaintenanceWindow({ launcher: join(source, "launcher"), ui: join(source, "ui") });
    writeFileSync(join(staged, "unrelated.txt"), "preserve");
    if (process.platform === "win32") {
      // This temporary signed UI is macOS-only. Windows has no POSIX uid proof;
      // its cleanup gate must refuse ownership rather than delete the directory.
      expect(() => cleanupMaintenanceWindow(staged!)).toThrow("unsafe maintenance ownership");
      return;
    }
    expect(() => cleanupMaintenanceWindow(staged!)).toThrow("unknown files"); expect(existsSync(staged)).toBe(true);
    rmSync(join(staged, "unrelated.txt")); cleanupMaintenanceWindow(staged); expect(existsSync(staged)).toBe(false); staged = undefined;
  } finally { if (staged) removeFixture(staged); removeFixture(source); }
});


test("damaged installation stages only a same-version repair source", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-maintenance-source-test-"));
  try {
    const f = fixture(root), options = { platform: "linux" as const, home: f.home, environment: {}, runner: f.runner };
    await runPackagedLifecycleCommand(["install", "--apply", "--payload", f.first, ], options);
    const resolveSource = (payload: string) => resolveMaintenanceWindowSource("unused", "unused", ["--payload", payload, ], options);
    expect((await resolveSource(f.first)).ui).toBe(realpathSync(join(f.first, readPackagedProductManifest(f.first).menuBar!.executable)));
    await expect(resolveSource(f.second)).rejects.toThrow();
    const manifestPath = join(f.first, "chatgpt-tela-package-v1.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")); delete manifest.menuBar;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(resolveSource(f.first)).rejects.toThrow();
    expect(readOwnershipManifest(resolveProductPaths(options).installManifest)?.productVersion).toBe("1.0.0");
  } finally { removeFixture(root); }
});

test("explicit remove-data plan removes only owned settings and preserves a project", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-maintenance-remove-test-"));
  try {
    const f = fixture(root), options = { platform: "linux" as const, home: f.home, environment: {}, runner: f.runner, executingBinaryPath: join(root, "external-launcher") };
    await runPackagedLifecycleCommand(["install", "--apply", "--payload", f.first, ], options);
    const paths = resolveProductPaths(options), o = readOwnershipManifest(paths.installManifest)!;
    await prepareOwnedDirectory({manifestPath:paths.installManifest,installId:o.installId,productVersion:o.productVersion,
      resource:{kind:"directory",id:"product-config",owner:"product",path:paths.configRoot,dataClass:"config"}});
    writeFileSync(join(paths.configRoot,"settings.json"),"owned");
    writeFileSync(join(f.home,"project.txt"),"project");
    const review = await runMaintenanceCommand(["maintenance","review","uninstall","--remove-data"],options) as any;
    expect(existsSync(paths.configRoot)).toBe(true);
    expect(review.resources.find((r:any)=>r.name==="product-config").action).toBe("remove");
    expect((await runMaintenanceCommand(["maintenance","apply","uninstall","--remove-data","--review-token",review.reviewToken],options) as any).success).toBe(true);
    expect(existsSync(paths.configRoot)).toBe(false);
    expect(readFileSync(join(f.home,"project.txt"),"utf8")).toBe("project");
  } finally { removeFixture(root); }
});

for (const supported of [true, false]) test(`maintenance cancellation review binds source/checkpoint and supports recovery staging: ${supported}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-maintenance-cancel-"));
  try {
    const f = fixture(root, supported), options = { platform: "linux" as const, home: f.home, environment: {}, runner: f.runner };
    await runPackagedLifecycleCommand(["install", "--apply", "--payload", f.first, ], options);
    const paths = resolveProductPaths(options), manifest = readFileSync(paths.installManifest);
    f.runner.running.add("chatgpt-tela-chat.service");
    // Model a settled pre-replacement process interruption. Normal upgrades now
    // recover automatically, so a refused shutdown is no longer a journal fixture.
    const plan = await planPackagedUpgradeFromPayload({ ...options, payloadSourcePath: f.second,});
    const journalPath = packagedUpgradeJournalPath(paths);
    const checkpoint: PackagedUpgradeJournal = {
      version: 1, installId: plan.installId, fromVersion: plan.fromVersion, toVersion: plan.toVersion,
      sourcePayloadFingerprint: plan.sourcePayload.payloadFingerprint, targetPayloadFingerprint: plan.targetPayloadFingerprint,
      phase: "quiescing", resumeServices: ["chat"], quiescedServices: ["gateway"], resumedServices: [],
      stopEvidenceVersion: 1, pendingStop: null,
    };
    writeFileSync(journalPath, JSON.stringify(checkpoint));
    const journal = readFileSync(journalPath);
    const status = await runMaintenanceCommand(["maintenance", "status"], options) as any;
    expect(status.pendingTransition).toBe("upgrade");
    expect(status.cancellationReviewAvailable).toBe(true);
    const args = ["--payload", f.first, ];
    if (!supported) {
      await expect(runMaintenanceCommand(["maintenance", "review", "cancel-upgrade", ...args], options)).rejects.toThrow("does not declare");
      expect(readFileSync(journalPath)).toEqual(journal);
      expect(readFileSync(paths.installManifest)).toEqual(manifest);
      return;
    }
    const reviewed = await runMaintenanceCommand(["maintenance", "review", "cancel-upgrade", ...args], options) as any;
    expect(reviewed.resources).toEqual([{ name: "Tela files", action: "preserve" }, { name: "chat", action: "restore-if-stopped" }]);
    expect(reviewed.interruptedConnections).toBe(false);
    expect(reviewed.toVersion).toBe("1.0.0");
    expect(readFileSync(journalPath)).toEqual(journal);
    const source = await resolveMaintenanceWindowSource("unused", "unused", ["--operation", "cancel-upgrade", ...args], options);
    expect(source.launcher).toBe(realpathSync(join(f.first, "chatgpt-tela")));
    expect(source.ui).toBe(realpathSync(join(f.first, readPackagedProductManifest(f.first).menuBar!.executable)));
    expect((await resolveMaintenanceWindowSource("unused", "unused", ["--operation", "upgrade", "--payload", f.second, ], options)).launcher)
      .toBe(realpathSync(join(f.second, "chatgpt-tela")));
    // Same phase/version/service list, but changed quiescence must invalidate review.
    writeFileSync(journalPath, JSON.stringify({ ...readPackagedUpgradeJournal(journalPath), quiescedServices: [] }));
    const changed = readFileSync(journalPath);
    await expect(runMaintenanceCommand(["maintenance", "apply", "cancel-upgrade", ...args, "--review-token", reviewed.reviewToken], options)).rejects.toThrow("changed");
    expect(readFileSync(journalPath)).toEqual(changed);
    expect(readFileSync(paths.installManifest)).toEqual(manifest);
    const fresh = await runMaintenanceCommand(["maintenance", "review", "cancel-upgrade", ...args], options) as any;
    expect((await runMaintenanceCommand(["maintenance", "apply", "cancel-upgrade", ...args, "--review-token", fresh.reviewToken], options) as any).success).toBe(true);
    expect(f.runner.running.has("chatgpt-tela-chat.service")).toBe(true);
    expect(readPackagedUpgradeJournal(journalPath)).toBeUndefined();
    expect(readFileSync(paths.installManifest)).toEqual(manifest);
  } finally { removeFixture(root); }
});


test("prepared update survives removal of its source and uses the existing reviewed lifecycle", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-prepared-update-"));
  try {
    const f = fixture(root), options = { platform: "linux" as const, home: f.home, environment: {}, runner: f.runner };
    await runPackagedLifecycleCommand(["install", "--apply", "--payload", f.first], options);
    await runMaintenanceCommand(["maintenance", "stage-update", "--payload", f.second], options);
    rmSync(join(f.second, "services", "chat"));
    await expect(runMaintenanceCommand(["maintenance", "stage-update", "--payload", f.second], options)).rejects.toThrow();
    rmSync(f.second, { recursive: true });
    const status = await runMaintenanceCommand(["maintenance", "status"], options) as any;
    expect(status.update.productVersion).toBe("2.0.0");
    expect(status.update.payload.startsWith(resolveProductPaths(options).cacheRoot)).toBe(true);
    const args = ["--payload", status.update.payload];
    const review = await runMaintenanceCommand(["maintenance", "review", "upgrade", ...args], options) as any;
    expect((await runMaintenanceCommand(["maintenance", "apply", "upgrade", ...args, "--review-token", review.reviewToken], options) as any).success).toBe(true);
    expect((await runMaintenanceCommand(["maintenance", "status"], options) as any).update).toBeNull();
    await runMaintenanceCommand(["maintenance", "stage-update", "--payload", f.first], options);
    const removal = await runMaintenanceCommand(["maintenance", "review", "uninstall"], options) as any;
    await runMaintenanceCommand(["maintenance", "apply", "uninstall", "--review-token", removal.reviewToken], options);
    expect(existsSync(resolveProductPaths(options).cacheRoot + "/updates")).toBe(false);
  } finally { removeFixture(root); }
});
