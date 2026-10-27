import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeEngineFileSha256, nativeEngineHelperName, resolveOwnedNativeEngine, verifyNativeEngineArtifact } from "./native-engine";
import { parsePackagedNativeEngine, parsePackagedProductManifest, packagedProductManifestPath, PACKAGED_PRODUCT_MANIFEST } from "./packaged-manifest";
import { resolveProductPaths } from "./layout";
import { ensureOwnershipManifest } from "./ownership-store";
import { readOwnershipManifest } from "./ownership";
import { PackagedPayloadManager, observeInstalledPackagedPayload } from "./packaged-payload";
import { assertPackagedLaunchAdmission } from "./packaged-launch-admission";
import { packagedUpgradeJournalPath } from "./packaged-transition";
import { applyUninstallPlan, FilesystemOwnershipObserver, planUninstall } from "./uninstall";

function metadata(sha256: string) {
  return parsePackagedNativeEngine({ executable: "native-engine/codex", version: "0.159.0", sha256,
    platform: process.platform, architecture: process.arch, upstreamCommit: "a".repeat(40),
    patchSha256: "b".repeat(64), capabilities: ["model-local-compaction-v1"] });
}

test("engine metadata requires a launcher layout, portable paths and explicit supported capability", () => {
  const engine = metadata("c".repeat(64));
  for (const change of [{ executable: "../codex" }, { executable: "/codex" }, { sha256: "bad" },
    { capabilities: ["unknown"] }, { platform: "unknown" }, { upstreamCommit: "bad" }, { surprise: true }]) {
    expect(() => parsePackagedNativeEngine({ ...engine, ...change })).toThrow();
  }
  expect(() => parsePackagedProductManifest({ version: 1, product: "chatgpt-tela", productVersion: "1.0.0",
    nativeEngine: engine, services: Object.fromEntries(["gateway", "chat", "codex"].map(key => [key, { executable: key }])),
  })).toThrow("launcher layout");
});

test("wrong bytes or platform never execute; version mismatch and escaping links fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "tela-engine-artifact-"));
  try {
    mkdirSync(join(root, "native-engine"));
    const executable = join(root, "native-engine/codex");
    writeFileSync(executable, "fixture");
    const helper = join(root, "native-engine", nativeEngineHelperName(process.platform));
    writeFileSync(helper, "helper", { mode: 0o755 });
    const engine = metadata(nativeEngineFileSha256(executable));
    let calls = 0;
    const readVersion = () => { calls++; return "codex-cli 0.159.0"; };
    expect(verifyNativeEngineArtifact({ payloadRoot: root, engine, readVersion }).localCompaction).toBe(true);
    expect(verifyNativeEngineArtifact({ payloadRoot: root, engine, readVersion: () => "codex-cli 0.159.0" }).catalogRefresh).toBeUndefined();
    const seeded = parsePackagedNativeEngine({ ...engine, capabilities: ["model-local-compaction-v1", "model-catalog-refresh-v1", "model-catalog-seed-v1"] });
    const verifiedSeed = verifyNativeEngineArtifact({ payloadRoot: root, engine: seeded, readVersion: () => "codex-cli 0.159.0" });
    expect(verifiedSeed.catalogSeed).toBe(true);
    expect(verifiedSeed.catalogRefresh).toBe(true);
    expect(() => parsePackagedNativeEngine({ ...engine, capabilities: ["model-local-compaction-v1", "model-catalog-seed-v1"] })).toThrow();
    const refreshed = parsePackagedNativeEngine({ ...engine, capabilities: ["model-local-compaction-v1", "model-catalog-refresh-v1"] });
    expect(verifyNativeEngineArtifact({ payloadRoot: root, engine: refreshed, readVersion: () => "codex-cli 0.159.0" }).catalogRefresh).toBe(true);
    expect(() => parsePackagedNativeEngine({ ...engine, capabilities: ["model-catalog-refresh-v1", "model-local-compaction-v1"] })).toThrow();
    expect(() => parsePackagedNativeEngine({ ...engine, capabilities: ["model-local-compaction-v1", "model-catalog-refresh-v1", "model-catalog-refresh-v1"] })).toThrow();
    expect(() => verifyNativeEngineArtifact({ payloadRoot: root, engine, architecture: "foreign", readVersion })).toThrow("mismatch");
    writeFileSync(executable, "replacement");
    expect(() => verifyNativeEngineArtifact({ payloadRoot: root, engine, readVersion })).toThrow("hash");
    expect(calls).toBe(1);
    const replaced = metadata(nativeEngineFileSha256(executable));
    expect(() => verifyNativeEngineArtifact({ payloadRoot: root, engine: replaced, readVersion: () => "codex-cli 0.158.0" })).toThrow("version");
    if (process.platform !== "win32") {
      rmSync(executable);
      symlinkSync("../outside", executable);
      writeFileSync(join(root, "outside"), "replacement");
      expect(() => verifyNativeEngineArtifact({ payloadRoot: root, engine: replaced, readVersion })).toThrow("regular");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const application of [false, true]) test(`owned engine selection survives restoration, detects drift and preserves data (app=${application})`, async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-owned-engine-"));
  try {
    const home = join(root, "home"); mkdirSync(home);
    const pathOptions = { home, environment: {} };
    expect(resolveOwnedNativeEngine(pathOptions)).toBeUndefined();
    const defaults = resolveProductPaths(pathOptions);
    const paths = { ...defaults, binaryRoot: application ? join(home, "Applications/Tela.app") : defaults.binaryRoot };
    const source = join(root, "payload"); mkdirSync(join(source, "native-engine"), { recursive: true });
    const executable = join(source, "native-engine/codex");
    writeFileSync(executable, '#!/bin/sh\nprintf "codex-cli 0.159.0\\n"\n', { mode: 0o755 });
    writeFileSync(join(source, "native-engine", nativeEngineHelperName(process.platform)), "helper", { mode: 0o755 });
    const original = join(root, "official-codex"); writeFileSync(original, "official unchanged");
    const userData = join(home, "conversation"); writeFileSync(userData, "keep conversation");
    if (application) {
      mkdirSync(join(source, "Contents/Resources"), { recursive: true });
      writeFileSync(join(source, "Contents/Info.plist"), "app fixture");
    }
    writeFileSync(packagedProductManifestPath(source), JSON.stringify({ version: 1, product: "chatgpt-tela",
      productVersion: "1.0.0", launcher: { executable: "tela" },
      profileRuntime: { executable: "electron", entrypoint: "runtime.cjs" },
      integrity: { signature: "ed25519-sha256-tree-v1", keyId: "fixture" }, nativeEngine: metadata(nativeEngineFileSha256(executable)),
      services: Object.fromEntries(["gateway", "chat", "codex"].map(key => [key, { executable: key }])),
    }));
    const ownership = await ensureOwnershipManifest({ path: paths.installManifest, productVersion: "1.0.0" });
    const manager = new PackagedPayloadManager({ manifestPath: paths.installManifest, installId: ownership.installId,
      spec: { sourcePath: source, productVersion: "1.0.0", resource: { kind: "directory", id: "product-binaries",
        owner: "product", path: paths.binaryRoot, dataClass: "binary", ...(application ? { metadataRoot: join(paths.stateRoot, "install/application") } : {}) } } });
    await manager.install(ownership);
    const version = { readVersion: () => "codex-cli 0.159.0" };
    const committed = readOwnershipManifest(paths.installManifest)!;
    const binary = committed.resources.find(resource => resource.id === "product-binaries");
    if (binary?.kind !== "directory") throw new Error("fixture binary ownership missing");
    const observed = observeInstalledPackagedPayload(binary, committed);
    if (observed.state !== "owned") throw new Error("fixture payload receipt missing");
    const journalPath = packagedUpgradeJournalPath(paths);
    writeFileSync(journalPath, JSON.stringify({ version: 1, stopEvidenceVersion: 1, pendingStop: null,
      installId: committed.installId, fromVersion: "0.9.0", toVersion: "1.0.0",
      sourcePayloadFingerprint: "a".repeat(64), targetPayloadFingerprint: observed.receipt.payloadFingerprint,
      phase: "manifest-updated", resumeServices: ["chat", "codex", "gateway"],
      quiescedServices: ["gateway", "codex", "chat"], resumedServices: ["chat"],
    }));
    // The actual launcher permits this checkpoint; engine selection must agree.
    assertPackagedLaunchAdmission({ paths, ownership: committed, receipt: observed.receipt, service: "codex" });
    expect(resolveOwnedNativeEngine(pathOptions, version)?.localCompaction).toBe(true);
    const installed = join(paths.binaryRoot, "native-engine/codex");
    const installedHelper = join(paths.binaryRoot, "native-engine", nativeEngineHelperName(process.platform));
    const helperBytes = readFileSync(installedHelper);
    writeFileSync(installedHelper, "foreign helper");
    expect(() => resolveOwnedNativeEngine(pathOptions, version)).toThrow("receipt");
    writeFileSync(installedHelper, helperBytes);
    const bytes = readFileSync(installed);
    writeFileSync(installed, "foreign");
    expect(() => resolveOwnedNativeEngine(pathOptions, version)).toThrow("receipt");
    writeFileSync(installed, bytes);
    rmSync(journalPath);
    const current = readOwnershipManifest(paths.installManifest)!;
    const observer = new FilesystemOwnershipObserver();
    const plan = await planUninstall({ manifest: current, observer, removeData: false });
    expect(plan.steps.find(step => step.resourceId === "product-binaries")?.action).toBe("remove");
    await applyUninstallPlan({ manifest: current, plan, operator: {
      observe: (resource, manifest) => observer.observe(resource, manifest),
      async remove(resource) {
        if (resource.kind !== "directory" || resource.path !== paths.binaryRoot) throw new Error("foreign fixture removal");
        rmSync(resource.path, { recursive: true });
        return { removed: true, detail: "owned fixture removed" };
      },
    } });
    expect(existsSync(installed)).toBe(false);
    expect(existsSync(installedHelper)).toBe(false);
    expect(resolveOwnedNativeEngine(pathOptions)).toBeUndefined();
    expect(readFileSync(original, "utf8")).toBe("official unchanged");
    expect(readFileSync(userData, "utf8")).toBe("keep conversation");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("required code-mode helper fails before engine execution when absent, non-executable or linked", () => {
  const root = mkdtempSync(join(tmpdir(), "tela-engine-helper-"));
  try {
    mkdirSync(join(root, "native-engine"));
    const executable = join(root, "native-engine/codex");
    writeFileSync(executable, "engine");
    const engine = metadata(nativeEngineFileSha256(executable));
    const helper = join(root, "native-engine", nativeEngineHelperName(process.platform));
    let calls = 0;
    const readVersion = () => { calls++; return "codex-cli 0.159.0"; };
    expect(() => verifyNativeEngineArtifact({ payloadRoot: root, engine, readVersion })).toThrow("helper is missing");
    if (process.platform !== "win32") {
      writeFileSync(helper, "helper", { mode: 0o600 });
      expect(() => verifyNativeEngineArtifact({ payloadRoot: root, engine, readVersion })).toThrow("must be executable");
      rmSync(helper);
      writeFileSync(join(root, "foreign-helper"), "helper", { mode: 0o755 });
      symlinkSync("../foreign-helper", helper);
      expect(() => verifyNativeEngineArtifact({ payloadRoot: root, engine, readVersion })).toThrow("regular file");
      rmSync(helper);
    }
    expect(calls).toBe(0);
    writeFileSync(helper, "helper", { mode: 0o755 });
    expect(verifyNativeEngineArtifact({ payloadRoot: root, engine, readVersion }).localCompaction).toBe(true);
    expect(calls).toBe(1);
    expect(nativeEngineHelperName("win32")).toBe("codex-code-mode-host.exe");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
