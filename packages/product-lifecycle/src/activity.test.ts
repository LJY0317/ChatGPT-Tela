import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  acquireProductActivity,
  observeProductActivity,
  productActivityPath,
  releaseProductActivity,
} from "./activity";

describe("product activity lease", () => {
  test("one live profile setup blocks a duplicate owner until exact release", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-activity-"));
    const path = productActivityPath(root, "profile-setup", "1");
    try {
      const record = acquireProductActivity({ path, installId: "install-1", kind: "profile-setup", scope: "1" });
      expect(observeProductActivity({ path, installId: "install-1", kind: "profile-setup", scope: "1" })).toBe("active");
      expect(() => acquireProductActivity({ path, installId: "install-1", kind: "profile-setup", scope: "1" }))
        .toThrow("already active");
      releaseProductActivity({ path, expected: record });
      expect(observeProductActivity({ path, installId: "install-1", kind: "profile-setup", scope: "1" })).toBe("missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("foreign activity state is preserved instead of overwritten", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-activity-drift-"));
    const path = productActivityPath(root, "profile-setup", "1");
    try {
      const record = acquireProductActivity({ path, installId: "foreign", kind: "profile-setup", scope: "1" });
      expect(observeProductActivity({ path, installId: "install-1", kind: "profile-setup", scope: "1" })).toBe("drift");
      expect(() => acquireProductActivity({ path, installId: "install-1", kind: "profile-setup", scope: "1" }))
        .toThrow("different ownership");
      releaseProductActivity({ path, expected: record });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("malformed lock state fails closed instead of being overwritten", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-activity-unsafe-"));
    const path = productActivityPath(root, "profile-setup", "1");
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "not-json", { flag: "wx" });
      expect(() => acquireProductActivity({ path, installId: "install-1", kind: "profile-setup", scope: "1" })).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
