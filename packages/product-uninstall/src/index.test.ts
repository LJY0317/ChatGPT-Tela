import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOwnershipManifest,
  prepareOwnedDirectory,
  resolveProductPaths,
  writeOwnershipManifest,
  withPackagedTransitionOwner,
  packagedUninstallJournalPath,
  type OwnedResource,
} from "@chatgpt-tela/product-lifecycle";
import { runProductUninstall } from "./index";
import { startUninstallCheckpoint, writeUninstallCheckpoint } from "./coordination";

async function binaryFixture(root: string, externalMetadata = false) {
  const home = join(root, "home");
  mkdirSync(home);
  const options = { platform: "linux" as const, home, environment: {} };
  const paths = resolveProductPaths(options);
  const manifest = createOwnershipManifest("1.0.0", new Date("2026-09-29T00:00:00.000Z"), "install-uninstall-fixture");
  writeOwnershipManifest(paths.installManifest, manifest);
  const resource: Extract<OwnedResource, { kind: "directory" }> = Object.freeze({
    kind: "directory",
    id: "product-binaries",
    owner: "product",
    path: paths.binaryRoot,
    dataClass: "binary",
    ...(externalMetadata ? { metadataRoot: join(paths.stateRoot, "install", "application") } : {}),
  });
  await prepareOwnedDirectory({
    manifestPath: paths.installManifest,
    installId: manifest.installId,
    productVersion: manifest.productVersion,
    resource,
  });
  return { home, paths, options };
}

for (const unknown of [false, true]) test(`binary removal owns external metadata and preserves unknown files (${unknown})`, async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-binary-metadata-uninstall-"));
  try {
    const f = await binaryFixture(root, true), metadata = join(f.paths.stateRoot, "install", "application");
    if (unknown) writeFileSync(join(metadata, "unowned.txt"), "preserve");
    const result = await runProductUninstall({ mode: "apply", removeData: true, ...f.options });
    expect(existsSync(f.paths.binaryRoot)).toBe(unknown);
    expect(existsSync(metadata)).toBe(unknown);
    if (unknown) expect(readFileSync(join(metadata, "unowned.txt"), "utf8")).toBe("preserve");
    else expect(result.manifestRemoved).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("uninstall cannot remove binaries or start shutdown under another transition owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-uninstall-competing-"));
  try {
    const f = await binaryFixture(root);
    await withPackagedTransitionOwner({ paths: f.paths, installId: "install-uninstall-fixture" }, async () => {
      await expect(runProductUninstall({ mode: "apply", removeData: true, ...f.options })).rejects.toThrow("another installer owns");
      expect(existsSync(f.paths.binaryRoot)).toBe(true);
      expect(existsSync(packagedUninstallJournalPath(f.paths))).toBe(false);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const phase of ["finalizing", "removing"] as const) test(`interrupted uninstall ${phase} reconciles only proven metadata cleanup`, async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-uninstall-interrupted-")), home = join(root, "home"); mkdirSync(home);
  const options = { platform: "linux" as const, home, environment: {} }, paths = resolveProductPaths(options);
  const manifest = createOwnershipManifest("fixture"); writeOwnershipManifest(paths.installManifest, manifest);
  const child = Bun.spawn([process.execPath, "--eval", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
  expect(await child.exited).toBe(0);
  try {
    await withPackagedTransitionOwner({ paths, installId: manifest.installId }, async () => {
      const checkpoint = startUninstallCheckpoint(paths, manifest.installId);
      writeUninstallCheckpoint(paths, { ...checkpoint, phase, ownerPid: child.pid });
    });
    let serviceCalls = 0;
    const invoke = () => runProductUninstall({ mode: "apply", removeData: true, ...options,
      serviceRegistrationRunner: { async run() { serviceCalls++; throw new Error("service actions forbidden"); } } });
    if (phase === "finalizing") {
      expect(await invoke()).toMatchObject({ manifestRemoved: true, resumedMetadataCleanup: true });
      expect(existsSync(paths.installManifest)).toBe(false);
      expect(existsSync(join(paths.stateRoot, "install", "coordinator"))).toBe(false);
      expect(existsSync(packagedUninstallJournalPath(paths))).toBe(false);
    } else {
      const before = readFileSync(packagedUninstallJournalPath(paths));
      await expect(invoke()).rejects.toThrow("reconcile its effects");
      expect(readFileSync(packagedUninstallJournalPath(paths))).toEqual(before);
      expect(existsSync(paths.installManifest)).toBe(true);
    }
    expect(serviceCalls).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const state of ["live", "unknown-claim"] as const) test(`uninstall finalization preserves ${state} ownership`, async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-uninstall-live-finalizer-")), home = join(root, "home"); mkdirSync(home);
  const options = { platform: "linux" as const, home, environment: {} }, paths = resolveProductPaths(options);
  const manifest = createOwnershipManifest("fixture"); writeOwnershipManifest(paths.installManifest, manifest);
  const child = Bun.spawn([process.execPath, "--eval", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
  expect(await child.exited).toBe(0);
  try {
    await withPackagedTransitionOwner({ paths, installId: manifest.installId }, async () => {
      const checkpoint = startUninstallCheckpoint(paths, manifest.installId);
      writeUninstallCheckpoint(paths, { ...checkpoint, phase: "finalizing", ownerPid: state === "live" ? process.pid : child.pid });
    });
    const claim = `${packagedUninstallJournalPath(paths)}.finalizing`;
    if (state === "unknown-claim") { mkdirSync(claim); writeFileSync(join(claim, "evidence"), "preserve"); }
    await expect(runProductUninstall({ mode: "apply", removeData: true, ...options })).rejects.toThrow(state === "live" ? "still active" : "already claimed");
    if (state === "unknown-claim") expect(readFileSync(join(claim, "evidence"), "utf8")).toBe("preserve");
    expect(existsSync(paths.installManifest)).toBe(true);
    expect(await runProductUninstall({ mode: "dry-run", removeData: true, ...options })).toMatchObject({ status: "uninstall-incomplete", destructiveActions: 0 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

describe("shared product uninstall runtime", () => {
  test("self-removal guard resolves physical aliases before service-manager access", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-uninstall-alias-"));
    try {
      const fixture = await binaryFixture(root);
      let calls = 0;
      await expect(runProductUninstall({ mode: "apply", removeData: true, ...fixture.options,
        executingBinaryPath: join(realpathSync(fixture.paths.binaryRoot), "chatgpt-tela"),
        serviceRegistrationRunner: { async run() { calls++; throw new Error("service access forbidden"); } },
      })).rejects.toThrow("separately extracted package copy");
      expect(calls).toBe(0);
      expect(existsSync(fixture.paths.binaryRoot)).toBe(true);
      expect(existsSync(fixture.paths.installManifest)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("reports a missing install without creating state", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-uninstall-missing-"));
    const home = join(root, "home");
    mkdirSync(home);
    try {
      const result = await runProductUninstall({ mode: "dry-run", platform: "linux", home, environment: {} });
      expect(result).toMatchObject({ status: "not-installed-by-manifest", destructiveActions: 0 });
      expect(existsSync(resolveProductPaths({ platform: "linux", home, environment: {} }).installManifest)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dry-run is non-mutating and apply removes an exact marker-owned binary directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-uninstall-binary-"));
    try {
      const fixture = await binaryFixture(root);
      const dryRun = await runProductUninstall({ mode: "dry-run", ...fixture.options });
      expect(dryRun).toMatchObject({ dryRun: true, removableCount: 1, preservedCount: 0 });
      expect(existsSync(fixture.paths.binaryRoot)).toBe(true);

      const applied = await runProductUninstall({ mode: "apply", removeData: true, ...fixture.options });
      expect(applied).toMatchObject({ applied: true, removedCount: 1, failedCount: 0, manifestRemoved: true });
      expect(existsSync(fixture.paths.binaryRoot)).toBe(false);
      expect(existsSync(fixture.paths.installManifest)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("apply refuses self-removal before mutating an installed binary root", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-uninstall-self-"));
    try {
      const fixture = await binaryFixture(root);
      const executingBinaryPath = join(fixture.paths.binaryRoot, "chatgpt-tela");
      await expect(runProductUninstall({
        mode: "apply",
        removeData: true,
        executingBinaryPath,
        ...fixture.options,
      })).rejects.toThrow("separately extracted package copy");
      expect(existsSync(fixture.paths.binaryRoot)).toBe(true);
      expect(existsSync(fixture.paths.installManifest)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("uninstall preserves recovery state and ownership manifest when an import is pending", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-uninstall-import-"));
  try {
    const fixture = await binaryFixture(root);
    await prepareOwnedDirectory({ manifestPath: fixture.paths.installManifest, installId: "install-uninstall-fixture", productVersion: "1.0.0",
      resource: { kind: "directory", id: "chat-state", owner: "chat", dataClass: "state", path: fixture.paths.serviceState("chat") } });
    const journal = join(fixture.paths.serviceState("chat"), "imports-v2", "a".repeat(64));
    mkdirSync(journal, { recursive: true }); writeFileSync(join(journal, "pending.json"), "private recovery record");
    const dry = await runProductUninstall({ mode: "dry-run", removeData: true, ...fixture.options }) as { steps: { resourceId: string; action: string }[] };
    expect(dry.steps.find(step => step.resourceId === "chat-state")?.action).toBe("preserve");
    const applied = await runProductUninstall({ mode: "apply", removeData: true, ...fixture.options });
    expect(applied).toMatchObject({ manifestRemoved: false, fileImportRecoveryPending: true });
    expect(existsSync(join(journal, "pending.json"))).toBe(true);
    expect(existsSync(fixture.paths.installManifest)).toBe(true);
    expect(existsSync(fixture.paths.binaryRoot)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Tela removal preserves optional provider and official profile resources", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-independent-removal-"));
  try {
    const fixture = await binaryFixture(root);
    const external = [join(fixture.home, "PluraDesktop", "launcher"), join(fixture.home, "profiles", "profile2", "fixture-state"), join(fixture.home, "official", "ChatGPT"), join(fixture.home, "official", "config.toml")];
    for (const path of external) { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, "external-owned-fixture"); }
    let systemCalls = 0;
    const runner = { async run(): Promise<never> { systemCalls++; throw new Error("no OS mutations permitted"); } };
    await runProductUninstall({ mode: "dry-run", removeData: true, ...fixture.options, serviceRegistrationRunner: runner });
    const applied = await runProductUninstall({ mode: "apply", removeData: true, ...fixture.options, serviceRegistrationRunner: runner });
    expect(applied.applied).toBe(true);
    expect(existsSync(fixture.paths.binaryRoot)).toBe(false);
    for (const path of external) expect(readFileSync(path, "utf8")).toBe("external-owned-fixture");
    expect(systemCalls).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
