import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readOwnershipManifest,
} from "./ownership";
import {
  ensureOwnershipManifest,
} from "./ownership-store";
import { OWNERSHIP_MARKER } from "./ownership";
import { prepareOwnedDirectory } from "./directory-registration";

describe("persistent owned directory preparation", () => {
  test("creates and records a new browser profile before another runtime writes into it", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-owned-dir-"));
    const manifestPath = join(root, "state", "install", "ownership-v1.json");
    const profile = join(root, "Canary-Profile1");
    try {
      const manifest = await ensureOwnershipManifest({ path: manifestPath, productVersion: "0.0.0" });
      const result = await prepareOwnedDirectory({
        manifestPath,
        installId: manifest.installId,
        productVersion: manifest.productVersion,
        resource: { kind: "directory", id: "browser-profile:1", owner: "product", path: profile,
          dataClass: "browser-profile" },
      });
      expect(result.state).toBe("created-owned");
      expect(existsSync(join(profile, OWNERSHIP_MARKER))).toBe(true);
      expect(readOwnershipManifest(manifestPath)?.resources).toContainEqual(result.resource);
      expect((await prepareOwnedDirectory({
        manifestPath,
        installId: manifest.installId,
        productVersion: manifest.productVersion,
        resource: result.resource,
      })).state).toBe("already-owned");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("pre-existing unmarked browser data is usable but never silently adopted", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-owned-dir-legacy-"));
    const manifestPath = join(root, "state", "install", "ownership-v1.json");
    const profile = join(root, "Canary-Profile1");
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "Cookies"), "legacy-user-state");
    try {
      const manifest = await ensureOwnershipManifest({ path: manifestPath, productVersion: "0.0.0" });
      const result = await prepareOwnedDirectory({
        manifestPath,
        installId: manifest.installId,
        productVersion: manifest.productVersion,
        resource: { kind: "directory", id: "browser-profile:1", owner: "product", path: profile,
          dataClass: "browser-profile" },
      });
      expect(result.state).toBe("external-existing");
      expect(readFileSync(join(profile, "Cookies"), "utf8")).toBe("legacy-user-state");
      expect(existsSync(join(profile, OWNERSHIP_MARKER))).toBe(false);
      expect(readOwnershipManifest(manifestPath)?.resources).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("foreign or orphaned ownership markers are never overwritten", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-owned-dir-foreign-"));
    const manifestPath = join(root, "state", "install", "ownership-v1.json");
    const profile = join(root, "Canary-Profile1");
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, OWNERSHIP_MARKER), JSON.stringify({ version: 1, installId: "foreign", resourceId: "foreign" }));
    try {
      const manifest = await ensureOwnershipManifest({ path: manifestPath, productVersion: "0.0.0" });
      await expect(prepareOwnedDirectory({
        manifestPath,
        installId: manifest.installId,
        productVersion: manifest.productVersion,
        resource: { kind: "directory", id: "browser-profile:1", owner: "product", path: profile,
          dataClass: "browser-profile" },
      })).rejects.toThrow("different install");
      expect((JSON.parse(readFileSync(join(profile, OWNERSHIP_MARKER), "utf8")) as { installId: string }).installId)
        .toBe("foreign");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
