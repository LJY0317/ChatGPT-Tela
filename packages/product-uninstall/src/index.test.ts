import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOwnershipManifest,
  prepareOwnedDirectory,
  resolveProductPaths,
  writeOwnershipManifest,
  type OwnedResource,
} from "@chatgpt-tela/product-lifecycle";
import { runProductUninstall } from "./index";

async function binaryFixture(root: string) {
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
  });
  await prepareOwnedDirectory({
    manifestPath: paths.installManifest,
    installId: manifest.installId,
    productVersion: manifest.productVersion,
    resource,
  });
  return { home, paths, options };
}

describe("shared product uninstall runtime", () => {
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
