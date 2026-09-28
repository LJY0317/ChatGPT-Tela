import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PRODUCT_PREFERENCES,
  parseProductPreferences,
  readProductPreferences,
  resolveProductPreferencesPath,
  writeProductPreferences,
} from "./preferences";

describe("product preferences", () => {
  test("default is approval automation off when the file is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-preferences-default-"));
    try {
      const path = resolveProductPreferencesPath({ platform: "linux", home: root, environment: {} });
      expect(readProductPreferences(path)).toEqual(DEFAULT_PRODUCT_PREFERENCES);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("recognized_once persists without any endpoint, account, or secret material", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-preferences-write-"));
    try {
      const path = join(root, "preferences-v1.json");
      writeProductPreferences({ version: 1, approvalAutomation: "recognized_once" }, path);
      expect(readProductPreferences(path)).toEqual({ version: 1, approvalAutomation: "recognized_once" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("unknown fields and persistent/full-access modes fail closed", () => {
    expect(() => parseProductPreferences({ version: 1, approvalAutomation: "always" })).toThrow("approval automation");
    expect(() => parseProductPreferences({ version: 1, approvalAutomation: "off", secret: "x" })).toThrow("unknown fields");
  });

  test("preferences file must remain a regular non-symlink file", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-preferences-safe-"));
    const target = join(root, "target.json");
    const link = join(root, "preferences-v1.json");
    writeFileSync(target, JSON.stringify(DEFAULT_PRODUCT_PREFERENCES));
    symlinkSync(target, link);
    try { expect(() => readProductPreferences(link)).toThrow("unsafe"); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("directory at preferences path is rejected", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-preferences-directory-"));
    const path = join(root, "preferences-v1.json");
    mkdirSync(path);
    try { expect(() => readProductPreferences(path)).toThrow("unsafe"); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
});
