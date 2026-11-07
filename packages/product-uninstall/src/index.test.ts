import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  createOwnershipManifest,
  prepareOwnedDirectory,
  acquireProductActivity, releaseProductActivity, productActivityPath,
  resolveProductPaths,
  writeOwnershipManifest,
  withPackagedTransitionOwner,
  packagedUninstallJournalPath,
  type OwnedResource,
} from "@chatgpt-tela/product-lifecycle";
import { runProductUninstall } from "./index";
import { editOfficialCodexProviderFile } from "@chatgpt-tela/default-desktop-target";
import { startUninstallCheckpoint, writeUninstallCheckpoint } from "./coordination";

async function binaryFixture(root: string, externalMetadata = false, installId = "install-uninstall-fixture") {
  const home = join(root, "home");
  mkdirSync(home);
  const options = { platform: "linux" as const, home, environment: {} };
  const paths = resolveProductPaths(options);
  const manifest = createOwnershipManifest("1.0.0", new Date("2026-09-29T00:00:00.000Z"), installId);
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

test("owned Desktop provider register, re-register and selected uninstall restore in an isolated HOME", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-provider-uninstall-"));
  try {
    const installId = randomUUID();
    const { home, paths, options } = await binaryFixture(root, false, installId);
    const codex = join(home, ".codex"); mkdirSync(codex);
    const configPath = join(codex, "config.toml");
    const original = 'model_provider = "openai"\nmodel = "user-choice"\n# existing comment\n';
    writeFileSync(configPath, original, { mode: 0o640 });
    const capability = "a".repeat(48);
    const owner = { configPath, installId: "install-uninstall-fixture",
      baseUrl: `http://127.0.0.1:18744/${capability}/v1` };
    // The installed ownership fixture uses a non-UUID ID, whereas provider
    // registration intentionally requires an actual install receipt UUID.
    const registration = { ...owner, installId };
    const product = { version: 1, publicMcpAbi: "stable", exposure: {
      kind: "existing-https", publicUrl: "https://example.test/mcp", localPort: 18743,
      authentication: "none", allowUnauthenticatedPublicEndpoint: true,
    }, appOwnedResponses: [{ slot: 1, port: 18744, capability }] };
    mkdirSync(paths.configRoot, { recursive: true });
    writeFileSync(join(paths.configRoot, "product-v1.json"), JSON.stringify(product));
    expect(editOfficialCodexProviderFile({ ...registration, action: "register", mode: "apply" })).toBe(true);
    expect(editOfficialCodexProviderFile({ ...registration, action: "register", mode: "apply" })).toBe(false);
    const registered = readFileSync(configPath, "utf8");
    const selected = registered.replace('model_provider = "openai"', 'model_provider = "chatgpt_tela_local"');
    writeFileSync(configPath, selected, { mode: 0o640 });
    expect((await runProductUninstall({ mode: "dry-run", ...options })).providerRestore)
      .toMatchObject({ status: "planned" });
    expect(readFileSync(configPath, "utf8")).toBe(selected);
    const activityPath = productActivityPath(paths.runtimeRoot, "profile-setup", "1");
    const activity = acquireProductActivity({ path: activityPath, installId, kind: "profile-setup", scope: "1" });
    try {
      const rejected = await runProductUninstall({ mode: "apply", ...options });
      expect(rejected).toMatchObject({ applied: false, status: "uninstall-blocked", failedCount: 1 });
      expect(readFileSync(configPath, "utf8")).toBe(selected);
      expect(existsSync(paths.binaryRoot)).toBe(true);
    } finally { releaseProductActivity({ path: activityPath, expected: activity }); }
    const applied = await runProductUninstall({ mode: "apply", ...options });
    expect(applied.providerRestore).toMatchObject({ status: "restored" });
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect((await runProductUninstall({ mode: "apply", ...options })).providerRestore)
      .toMatchObject({ status: "already-absent" });
    expect(readFileSync(configPath, "utf8")).toBe(original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("uninstall detaches and removes the install-owned startup catalog after restoring the Desktop config", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-catalog-uninstall-"));
  try {
    const installId = randomUUID();
    const fixture = await binaryFixture(root, false, installId);
    const catalogDirectory = join(fixture.paths.stateRoot, "install", "desktop-model-catalog");
    await prepareOwnedDirectory({ manifestPath: fixture.paths.installManifest, installId,
      productVersion: "1.0.0", resource: { kind: "directory", id: "app-owned-desktop-model-catalog",
        owner: "product", path: catalogDirectory, dataClass: "config" } });
    const catalogPath = join(catalogDirectory, "models.json");
    writeFileSync(catalogPath, JSON.stringify({ models: [{ id: "native" }, { id: "web" }] }), { mode: 0o600 });
    mkdirSync(join(fixture.home, ".codex"));
    const configPath = join(fixture.home, ".codex", "config.toml");
    const original = 'model_provider = "openai"\nmodel = "native-choice"\n# preserve me\n';
    writeFileSync(configPath, original);
    const capability = "c".repeat(48);
    mkdirSync(fixture.paths.configRoot, { recursive: true });
    writeFileSync(join(fixture.paths.configRoot, "product-v1.json"), JSON.stringify({ version: 1,
      publicMcpAbi: "stable", exposure: { kind: "existing-https", publicUrl: "https://example.test/mcp",
        localPort: 18743, authentication: "none", allowUnauthenticatedPublicEndpoint: true },
      appOwnedResponses: [{ slot: 1, port: 18744, capability }],
    }));
    const registration = { configPath, installId, baseUrl: `http://127.0.0.1:18744/${capability}/v1`, catalogPath };
    expect(editOfficialCodexProviderFile({ ...registration, action: "register", mode: "apply" })).toBe(true);
    const selected = readFileSync(configPath, "utf8").replace('model_provider = "openai"', 'model_provider = "chatgpt_tela_local"');
    writeFileSync(configPath, selected);
    const dry = await runProductUninstall({ mode: "dry-run", removeData: true, ...fixture.options });
    expect(dry.providerRestore).toMatchObject({ status: "planned", catalogStatus: "removed" });
    expect(readFileSync(configPath, "utf8")).toBe(selected);
    expect(existsSync(catalogPath)).toBe(true);
    const activityPath = productActivityPath(fixture.paths.runtimeRoot, "profile-setup", "1");
    const activity = acquireProductActivity({ path: activityPath, installId, kind: "profile-setup", scope: "1" });
    try {
      const blocked = await runProductUninstall({ mode: "apply", removeData: true, ...fixture.options });
      expect(blocked).toMatchObject({ applied: false, status: "uninstall-blocked" });
      expect(readFileSync(configPath, "utf8")).toBe(selected);
      expect(existsSync(catalogPath)).toBe(true);
    } finally { releaseProductActivity({ path: activityPath, expected: activity }); }
    const applied = await runProductUninstall({ mode: "apply", removeData: true, ...fixture.options });
    expect(applied.providerRestore).toMatchObject({ status: "restored", catalogStatus: "removed" });
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(existsSync(catalogDirectory)).toBe(false);
    expect(applied.manifestRemoved).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("uninstall preserves an owned catalog directory while an edited provider config still references it", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-catalog-preserve-"));
  try {
    const installId = randomUUID();
    const fixture = await binaryFixture(root, false, installId);
    const catalogDirectory = join(fixture.paths.stateRoot, "install", "desktop-model-catalog");
    await prepareOwnedDirectory({ manifestPath: fixture.paths.installManifest, installId,
      productVersion: "1.0.0", resource: { kind: "directory", id: "app-owned-desktop-model-catalog",
        owner: "product", path: catalogDirectory, dataClass: "config" } });
    const catalogPath = join(catalogDirectory, "models.json");
    writeFileSync(catalogPath, JSON.stringify({ models: [{ id: "native" }] }));
    mkdirSync(join(fixture.home, ".codex"));
    const configPath = join(fixture.home, ".codex", "config.toml");
    writeFileSync(configPath, 'model_provider = "openai"\n');
    const capability = "d".repeat(48);
    mkdirSync(fixture.paths.configRoot, { recursive: true });
    writeFileSync(join(fixture.paths.configRoot, "product-v1.json"), JSON.stringify({ version: 1,
      publicMcpAbi: "stable", exposure: { kind: "existing-https", publicUrl: "https://example.test/mcp",
        localPort: 18743, authentication: "none", allowUnauthenticatedPublicEndpoint: true },
      appOwnedResponses: [{ slot: 1, port: 18744, capability }],
    }));
    editOfficialCodexProviderFile({ configPath, installId,
      baseUrl: `http://127.0.0.1:18744/${capability}/v1`, catalogPath, action: "register", mode: "apply" });
    const edited = readFileSync(configPath, "utf8").replace("supports_websockets = false", "supports_websockets = true");
    writeFileSync(configPath, edited);
    const result = await runProductUninstall({ mode: "apply", removeData: true, ...fixture.options });
    expect(result).toMatchObject({ applied: true, providerRestore: { status: "preserved", selected: false }, manifestRemoved: false });
    expect(readFileSync(configPath, "utf8")).toBe(edited);
    expect(existsSync(catalogPath)).toBe(true);
    expect(existsSync(fixture.paths.installManifest)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("uninstall preserves edited external provider and installed resources with an exact reason", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-provider-preserve-"));
  try {
    const installId = randomUUID();
    const { home, paths, options } = await binaryFixture(root, false, installId);
    const capability = "b".repeat(48);
    mkdirSync(join(home, ".codex"));
    const configPath = join(home, ".codex", "config.toml");
    writeFileSync(configPath, 'model_provider = "openai"\n');
    const owner = { configPath, installId,
      baseUrl: `http://127.0.0.1:18744/${capability}/v1` };
    editOfficialCodexProviderFile({ ...owner, action: "register", mode: "apply" });
    writeFileSync(configPath, readFileSync(configPath, "utf8").replace("supports_websockets = false", "supports_websockets = true"));
    mkdirSync(paths.configRoot, { recursive: true });
    writeFileSync(join(paths.configRoot, "product-v1.json"), JSON.stringify({ version: 1,
      publicMcpAbi: "stable", exposure: { kind: "existing-https", publicUrl: "https://example.test/mcp",
        localPort: 18743, authentication: "none", allowUnauthenticatedPublicEndpoint: true },
      appOwnedResponses: [{ slot: 1, port: 18744, capability }],
    }));
    const before = readFileSync(configPath, "utf8");
    expect((await runProductUninstall({ mode: "dry-run", ...options })).providerRestore)
      .toMatchObject({ status: "preserved", reason: expect.stringContaining("ownership or contents changed") });
    const productConfigPath = join(paths.configRoot, "product-v1.json");
    const productConfig = readFileSync(productConfigPath, "utf8");
    rmSync(productConfigPath);
    expect((await runProductUninstall({ mode: "dry-run", ...options })).providerRestore)
      .toMatchObject({ status: "preserved", reason: expect.stringContaining("configuration is missing") });
    writeFileSync(productConfigPath, productConfig);
    const removed = await runProductUninstall({ mode: "apply", removeData: true, ...options });
    expect(removed).toMatchObject({ applied: true, failedCount: 0, preservedCount: 1,
      providerRestore: { status: "preserved", selected: false } });
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(existsSync(paths.binaryRoot)).toBe(false);
    expect(existsSync(paths.installManifest)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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

test("removal resumes only after the OS writer releases, including in the same process", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-uninstall-resume-owner-"));
  try {
    const f = await binaryFixture(root);
    await withPackagedTransitionOwner({ paths: f.paths, installId: "install-uninstall-fixture" }, async () => {
      startUninstallCheckpoint(f.paths, "install-uninstall-fixture");
      const before = readFileSync(packagedUninstallJournalPath(f.paths));
      await expect(runProductUninstall({ mode: "apply", removeData: true, ...f.options })).rejects.toThrow("another installer owns");
      expect(readFileSync(packagedUninstallJournalPath(f.paths))).toEqual(before);
      expect(existsSync(f.paths.binaryRoot)).toBe(true);
    });
    await expect(runProductUninstall({ mode: "apply", removeData: true, ...f.options })).resolves.toMatchObject({ manifestRemoved: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("resumed removal preserves a replaced resource and rejects a foreign checkpoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-uninstall-resume-replaced-"));
  try {
    const f = await binaryFixture(root);
    await withPackagedTransitionOwner({ paths: f.paths, installId: "install-uninstall-fixture" }, async () => {
      startUninstallCheckpoint(f.paths, "install-uninstall-fixture");
    });
    rmSync(f.paths.binaryRoot, { recursive: true });
    mkdirSync(f.paths.binaryRoot); writeFileSync(join(f.paths.binaryRoot, "user.txt"), "external replacement");
    const checkpoint = JSON.parse(readFileSync(packagedUninstallJournalPath(f.paths), "utf8"));
    writeUninstallCheckpoint(f.paths, { ...checkpoint, installId: "other-install" });
    await expect(runProductUninstall({ mode: "apply", removeData: true, ...f.options })).rejects.toThrow("does not match");
    writeUninstallCheckpoint(f.paths, checkpoint);
    expect(await runProductUninstall({ mode: "apply", removeData: true, ...f.options })).toMatchObject({ preservedCount: 1, manifestRemoved: false });
    expect(readFileSync(join(f.paths.binaryRoot, "user.txt"), "utf8")).toBe("external replacement");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a returned shutdown failure can be resolved without deleting its removal checkpoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-uninstall-resume-shutdown-"));
  try {
    const f = await binaryFixture(root), runtime = f.paths.serviceRuntime("chat");
    mkdirSync(runtime, { recursive: true });
    const descriptor = join(runtime, "descriptor.json"); writeFileSync(descriptor, "unreadable descriptor");
    const failed = await runProductUninstall({ mode: "apply", removeData: true, ...f.options });
    expect(failed.shutdownFailures).toMatchObject([{ owner: "chat" }]);
    expect(existsSync(f.paths.binaryRoot)).toBe(true);
    expect(existsSync(packagedUninstallJournalPath(f.paths))).toBe(true);
    // The service's own repair/stop has now settled its unusable descriptor.
    rmSync(descriptor);
    expect(await runProductUninstall({ mode: "apply", removeData: true, ...f.options })).toMatchObject({ manifestRemoved: true });
    expect(existsSync(packagedUninstallJournalPath(f.paths))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const phase of ["finalizing", "removing"] as const) test(`interrupted uninstall ${phase} completes from current ownership`, async () => {
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
    expect(await invoke()).toMatchObject({ manifestRemoved: true,
      ...(phase === "finalizing" ? { resumedMetadataCleanup: true } : {}) });
    expect(existsSync(paths.installManifest)).toBe(false);
    expect(existsSync(join(paths.stateRoot, "install", "coordinator"))).toBe(false);
    expect(existsSync(packagedUninstallJournalPath(paths))).toBe(false);
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
