import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureOwnershipManifest } from "./ownership-store";
import { OWNERSHIP_MARKER, parseOwnedResource, readOwnershipManifest, writeOwnershipManifest } from "./ownership";
import { PACKAGED_PAYLOAD_RECEIPT, PackagedPayloadManager, packagedPayloadFingerprint } from "./packaged-payload";

function fixture(root: string): { source: string; target: string } {
  const source = join(root, "source");
  const target = join(root, "installed", "bin");
  mkdirSync(join(source, "lib"), { recursive: true });
  writeFileSync(join(source, "chatgpt-tela"), "#!/bin/sh\necho tela\n", { mode: 0o755 });
  writeFileSync(join(source, "lib", "runtime.js"), "export const ready = true;\n");
  return { source, target };
}

describe("packaged binary payload ownership", () => {
  test("keeps the existing receipt digest across empty, chunk-sized and trailing bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-payload-stream-"));
    try {
      for (const [name, data] of [
        ["a-empty", Buffer.alloc(0)],
        ["b-exact", Buffer.alloc(1024 * 1024, 97)],
        ["c-tail", Buffer.alloc(2 * 1024 * 1024 + 7, 98)],
        ["d-short", Buffer.from("last")],
      ] as const) writeFileSync(join(root, name), data, { mode: 0o600 });
      // Captured from the pre-streaming implementation; existing receipts must remain valid.
      const digest = "0261f3c62431ebe4cf6db03a9489ce376ca9ceac6b278421eba3630d73b45151";
      expect(packagedPayloadFingerprint(root)).toBe(digest);
      const changed = Buffer.alloc(2 * 1024 * 1024 + 7, 98);
      changed[changed.length - 1] = 99;
      writeFileSync(join(root, "c-tail"), changed);
      expect(packagedPayloadFingerprint(root)).not.toBe(digest);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("copies, receipts, and verifies one exact marker-owned payload", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-payload-"));
    try {
      const { source, target } = fixture(root);
      const manifestPath = join(root, "state", "ownership-v1.json");
      const manifest = await ensureOwnershipManifest({ path: manifestPath, productVersion: "1.2.3" });
      const manager = new PackagedPayloadManager({
        manifestPath,
        installId: manifest.installId,
        spec: { sourcePath: source, productVersion: "1.2.3",
          resource: { kind: "directory", id: "product-binaries", owner: "product", path: target, dataClass: "binary" } },
      });
      expect(manager.observe(manifest)).toBe("missing");
      expect((await manager.install(manifest)).created).toBe(true);
      const current = readOwnershipManifest(manifestPath)!;
      expect(manager.observe(current)).toBe("owned");
      expect(packagedPayloadFingerprint(target, { target: true })).toBe(packagedPayloadFingerprint(source));
      expect(existsSync(join(target, OWNERSHIP_MARKER))).toBe(true);
      expect(existsSync(join(target, PACKAGED_PAYLOAD_RECEIPT))).toBe(true);
      expect((await manager.install(current)).created).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== "darwin")("external records preserve an installed app's real code signature", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-signed-app-record-"));
    try {
      const source = join(root, "source.app"), target = join(root, "installed.app"), metadataRoot = join(root, "state/app");
      mkdirSync(join(source, "Contents/MacOS"), { recursive: true });
      copyFileSync("/bin/echo", join(source, "Contents/MacOS/probe"));
      writeFileSync(join(source, "Contents/Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>probe</string><key>CFBundleIdentifier</key><string>org.chatgpt-tela.signature-fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
      execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", source], { stdio: "pipe" });
      const manifestPath = join(root, "state/ownership-v1.json");
      const manifest = await ensureOwnershipManifest({ path: manifestPath, productVersion: "1.2.3" });
      const resource = { kind: "directory" as const, id: "product-binaries", owner: "product" as const, path: target, dataClass: "binary" as const, metadataRoot };
      expect(() => parseOwnedResource({ ...resource, metadataRoot: join(target, "..metadata") })).toThrow("overlap");
      const manager = new PackagedPayloadManager({ manifestPath, installId: manifest.installId, spec: { sourcePath: source, productVersion: "1.2.3", resource } });
      await manager.install(manifest);
      expect(manager.observe(readOwnershipManifest(manifestPath)!)).toBe("owned");
      execFileSync("/usr/bin/codesign", ["--verify", "--strict", target], { stdio: "pipe" });
      expect(packagedPayloadFingerprint(target)).toBe(packagedPayloadFingerprint(source));
      expect(existsSync(join(target, OWNERSHIP_MARKER))).toBe(false);
      expect(existsSync(join(target, PACKAGED_PAYLOAD_RECEIPT))).toBe(false);
      expect(existsSync(join(metadataRoot, PACKAGED_PAYLOAD_RECEIPT))).toBe(true);
      // Missing receipt can be rebuilt without changing any signed app bytes.
      rmSync(join(metadataRoot, PACKAGED_PAYLOAD_RECEIPT));
      await manager.install(readOwnershipManifest(manifestPath)!);
      execFileSync("/usr/bin/codesign", ["--verify", "--strict", target], { stdio: "pipe" });
      expect(manager.observe(readOwnershipManifest(manifestPath)!)).toBe("owned");
      // A second install cannot overwrite the external ownership record, even if the app is absent.
      rmSync(target, { recursive: true });
      const otherPath = join(root, "other/ownership.json");
      const other = await ensureOwnershipManifest({ path: otherPath, productVersion: "1.2.3" });
      const otherManager = new PackagedPayloadManager({ manifestPath: otherPath, installId: other.installId, spec: { sourcePath: source, productVersion: "1.2.3", resource } });
      const before = readFileSync(join(metadataRoot, ".chatgpt-tela-owner.json"), "utf8");
      await expect(otherManager.install(other)).rejects.toThrow("ownership-drift");
      expect(readFileSync(join(metadataRoot, ".chatgpt-tela-owner.json"), "utf8")).toBe(before);
      expect(existsSync(target)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("repairs an interrupted copy only inside the exact owned binary directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-payload-repair-"));
    try {
      const { source, target } = fixture(root);
      const manifestPath = join(root, "state", "ownership-v1.json");
      const manifest = await ensureOwnershipManifest({ path: manifestPath, productVersion: "1.2.3" });
      const manager = new PackagedPayloadManager({
        manifestPath,
        installId: manifest.installId,
        spec: { sourcePath: source, productVersion: "1.2.3",
          resource: { kind: "directory", id: "product-binaries", owner: "product", path: target, dataClass: "binary" } },
      });
      await manager.install(manifest);
      rmSync(join(target, PACKAGED_PAYLOAD_RECEIPT));
      writeFileSync(join(target, "partial.tmp"), "interrupted");
      expect(manager.observe(readOwnershipManifest(manifestPath)!)).toBe("missing");
      expect((await manager.install(readOwnershipManifest(manifestPath)!)).created).toBe(true);
      expect(existsSync(join(target, "partial.tmp"))).toBe(false);
      expect(manager.observe(readOwnershipManifest(manifestPath)!)).toBe("owned");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("completed payload drift is preserved instead of overwritten", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-payload-drift-"));
    try {
      const { source, target } = fixture(root);
      const manifestPath = join(root, "state", "ownership-v1.json");
      const manifest = await ensureOwnershipManifest({ path: manifestPath, productVersion: "1.2.3" });
      const manager = new PackagedPayloadManager({
        manifestPath,
        installId: manifest.installId,
        spec: { sourcePath: source, productVersion: "1.2.3",
          resource: { kind: "directory", id: "product-binaries", owner: "product", path: target, dataClass: "binary" } },
      });
      await manager.install(manifest);
      writeFileSync(join(target, "chatgpt-tela"), "foreign replacement\n");
      const current = readOwnershipManifest(manifestPath)!;
      expect(manager.observe(current)).toBe("ownership-drift");
      await expect(manager.install(current)).rejects.toThrow("cannot be repaired");
      expect(readFileSync(join(target, "chatgpt-tela"), "utf8")).toBe("foreign replacement\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("repair restores byte drift only when the exact install marker and receipt still prove ownership", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-payload-byte-repair-"));
    try {
      const { source, target } = fixture(root);
      const manifestPath = join(root, "state", "ownership-v1.json");
      const manifest = await ensureOwnershipManifest({ path: manifestPath, productVersion: "1.2.3" });
      const manager = new PackagedPayloadManager({
        manifestPath,
        installId: manifest.installId,
        spec: { sourcePath: source, productVersion: "1.2.3",
          resource: { kind: "directory", id: "product-binaries", owner: "product", path: target, dataClass: "binary" } },
      });
      await manager.install(manifest);
      writeFileSync(join(target, "chatgpt-tela"), "damaged\n");
      const drifted = readOwnershipManifest(manifestPath)!;
      expect(manager.observe(drifted)).toBe("ownership-drift");
      expect(manager.observeRepair(drifted)).toBe("repairable");
      expect(await manager.repair(drifted)).toMatchObject({ repaired: true });
      expect(readFileSync(join(target, "chatgpt-tela"), "utf8")).toBe("#!/bin/sh\necho tela\n");
      expect(manager.observeRepair(readOwnershipManifest(manifestPath)!)).toBe("owned");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an orphaned exact marker never recreates manifest authority implicitly", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-payload-orphan-marker-"));
    try {
      const { source, target } = fixture(root);
      const manifestPath = join(root, "state", "ownership-v1.json");
      const manifest = await ensureOwnershipManifest({ path: manifestPath, productVersion: "1.2.3" });
      const manager = new PackagedPayloadManager({
        manifestPath,
        installId: manifest.installId,
        spec: { sourcePath: source, productVersion: "1.2.3",
          resource: { kind: "directory", id: "product-binaries", owner: "product", path: target, dataClass: "binary" } },
      });
      await manager.install(manifest);
      const current = readOwnershipManifest(manifestPath)!;
      writeOwnershipManifest(manifestPath, Object.freeze({ ...current, resources: Object.freeze([]) }));
      const orphaned = readOwnershipManifest(manifestPath)!;
      expect(manager.observe(orphaned)).toBe("ownership-drift");
      await expect(manager.install(orphaned)).rejects.toThrow();
      expect(existsSync(join(target, OWNERSHIP_MARKER))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reserved ownership filenames are rejected", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-payload-invalid-"));
    try {
      const source = join(root, "source");
      mkdirSync(source);
      writeFileSync(join(source, OWNERSHIP_MARKER), "forbidden");
      expect(() => packagedPayloadFingerprint(source)).toThrow("reserved");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("payload fingerprint rejects absolute and escaping symlinks", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "tela-payload-unsafe-link-"));
    try {
      const source = join(root, "source");
      mkdirSync(source);
      symlinkSync("/tmp", join(source, "absolute"));
      expect(() => packagedPayloadFingerprint(source)).toThrow("absolute");
      rmSync(join(source, "absolute"));
      writeFileSync(join(root, "outside"), "outside");
      symlinkSync("../outside", join(source, "escape"));
      expect(() => packagedPayloadFingerprint(source)).toThrow("escapes");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("safe internal relative symlinks are fingerprinted and preserved on install", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "tela-payload-symlink-"));
    try {
      const { source, target } = fixture(root);
      symlinkSync("runtime.js", join(source, "lib", "runtime-link.js"));
      const manifestPath = join(root, "state", "ownership-v1.json");
      const manifest = await ensureOwnershipManifest({ path: manifestPath, productVersion: "1.2.3" });
      const manager = new PackagedPayloadManager({
        manifestPath,
        installId: manifest.installId,
        spec: { sourcePath: source, productVersion: "1.2.3",
          resource: { kind: "directory", id: "product-binaries", owner: "product", path: target, dataClass: "binary" } },
      });
      await manager.install(manifest);
      const installedLink = join(target, "lib", "runtime-link.js");
      expect(lstatSync(installedLink).isSymbolicLink()).toBe(true);
      expect(readlinkSync(installedLink)).toBe("runtime.js");
      expect(manager.observe(readOwnershipManifest(manifestPath)!)).toBe("owned");
      rmSync(installedLink);
      symlinkSync("../../outside", installedLink);
      expect(manager.observe(readOwnershipManifest(manifestPath)!)).toBe("unsafe");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
