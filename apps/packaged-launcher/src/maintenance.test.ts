import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildPackagedPayload, resolveProductPaths, readOwnershipManifest, prepareOwnedDirectory,
  readPackagedProductManifest, PackagedServiceShutdownNotStartedError, type ServiceRegistrationCommandRunner } from "@chatgpt-tela/product-lifecycle";
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

function fixture(root: string) {
  const input = join(root, "input"), home = join(root, "home");
  mkdirSync(join(input, "electron", "bin"), { recursive: true }); mkdirSync(home);
  for (const name of ["launcher", "gateway", "chat", "codex", "menu-bar", "maintenance"]) writeFileSync(join(input, name), name, { mode: 0o755 });
  writeFileSync(join(input, "electron/bin/electron"), "electron", { mode: 0o755 });
  writeFileSync(join(input, "profile.cjs"), "module.exports={};");

  const build = (version: string) => {
    const payload = join(root, version);
    buildPackagedPayload({ outputPath: payload, productVersion: version, launcherSourcePath: join(input, "launcher"),
      menuBarSourcePath: join(input, "menu-bar"),
      maintenanceUISourcePath: join(input, "maintenance"),
      services: { gateway: { executableSourcePath: join(input, "gateway") }, chat: { executableSourcePath: join(input, "chat") }, codex: { executableSourcePath: join(input, "codex") } },
      profileRuntime: { electronBundleSourcePath: join(input, "electron"), electronExecutableRelativePath: "bin/electron", entrypointSourcePath: join(input, "profile.cjs") },});
    return payload;
  };
  return { home, first: build("1.0.0"), second: build("2.0.0"), runner: new FakeManager() };
}

test("review -> repair -> keep-data removal uses fake OS manager and preserves unrelated data", async () => {
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
  await expect(runMaintenanceCommand(["maintenance", "review", "repair"])).rejects.toThrow("explicit package");
  for (const operation of ["upgrade", "cancel-upgrade"]) {
    await expect(runMaintenanceCommand(["maintenance", "review", operation])).rejects.toThrow("usage:");
  }
});

test("repair refusal leaves running services and damaged files unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-maintenance-blocked-repair-"));
  try {
    const f = fixture(root), options = { platform: "linux" as const, home: f.home, environment: {}, runner: f.runner };
    await runPackagedLifecycleCommand(["install", "--apply", "--payload", f.first], options);
    const paths = resolveProductPaths(options), owner = readOwnershipManifest(paths.installManifest)!;
    const binary = owner.resources.find(r => r.kind === "directory" && r.id === "product-binaries")!;
    if (binary.kind !== "directory") throw Error("fixture binaries missing");
    const damaged = join(binary.path, "services/chat"); writeFileSync(damaged, "damaged");
    f.runner.running.add("chatgpt-tela-chat.service");
    let stops = 0;
    const blocked = { ...options,
      async prepareShutdownService(service: "gateway" | "codex" | "chat") { throw new PackagedServiceShutdownNotStartedError(service); },
      async shutdownService() { stops++; },
    };
    const args = ["--payload", f.first];
    const review = await runMaintenanceCommand(["maintenance", "review", "repair", ...args], blocked) as any;
    const result = await runMaintenanceCommand(["maintenance", "apply", "repair", ...args, "--review-token", review.reviewToken], blocked) as any;
    expect(result.success).toBe(false); expect(result.blockers.length).toBeGreaterThan(0);
    expect(stops).toBe(0); expect(f.runner.running.has("chatgpt-tela-chat.service")).toBe(true);
    expect(readFileSync(damaged, "utf8")).toBe("damaged");
  } finally { removeFixture(root); }
});

test("temporary maintenance binaries clean up only their exact owned snapshot", () => {
  const source = mkdtempSync(join(tmpdir(), "tela-maintenance-source-"));
  let staged: string | undefined;
  try {
    const ui = join(source, "Helper.app/Contents/MacOS/helper");
    mkdirSync(dirname(ui), { recursive: true });
    writeFileSync(join(source, "launcher"), "launcher"); writeFileSync(ui, "ui");
    writeFileSync(join(source, "Helper.app/Contents/Info.plist"), "app metadata");
    staged = stageMaintenanceWindow({ launcher: join(source, "launcher"), ui });
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
    expect((await resolveSource(f.first)).ui).toBe(realpathSync(join(f.first, readPackagedProductManifest(f.first).menuBar!.maintenanceExecutable!)));
    await expect(resolveSource(f.second)).rejects.toThrow();
    const manifestPath = join(f.first, "chatgpt-tela-package-v1.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")); delete manifest.menuBar.maintenanceExecutable;
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
