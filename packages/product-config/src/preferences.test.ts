import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approvalDelayMilliseconds,
  DEFAULT_PRODUCT_PREFERENCES,
  parseProductPreferences,
  readProductPreferences,
  resolveProductPreferencesPath,
  writeProductPreferences,
  setWorkProfileConnection,
  armSavedChatAcceptance,
  clearSavedChatAcceptance,
  consumeSavedChatAcceptance,
  savedChatAcceptanceSlot,
} from "./preferences";

describe("product preferences", () => {
  test("default is approval automation off when the file is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-preferences-default-"));
    try {
      const path = resolveProductPreferencesPath({ platform: "linux", home: root, environment: {} });
      expect(readProductPreferences(path)).toEqual(DEFAULT_PRODUCT_PREFERENCES);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("full_access persists without any endpoint, account, or secret material", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-preferences-write-"));
    try {
      const path = join(root, "preferences-v1.json");
      writeProductPreferences({ version: 1, approvalAutomation: "full_access", approvalDelay: "2s" }, path);
      expect(readProductPreferences(path)).toEqual({ version: 1, approvalAutomation: "full_access", approvalDelay: "2s" });
      expect(approvalDelayMilliseconds("2s")).toBe(2_000);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("existing enabled approval preferences normalize to full_access", () => {
    expect(parseProductPreferences({ version: 1, approvalAutomation: "recognized_conversation" }).approvalAutomation)
      .toBe("full_access");
    expect(parseProductPreferences({ version: 1, approvalAutomation: "recognized_once" }).approvalAutomation)
      .toBe("full_access");
  });

  test("unknown fields and unknown modes fail closed", () => {
    expect(() => parseProductPreferences({ version: 1, approvalAutomation: "always" })).toThrow("approval automation");
    expect(() => parseProductPreferences({ version: 1, approvalAutomation: "full_access", approvalDelay: "30s" })).toThrow("approval delay");
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

test("Work connection choices survive reload without replacing approval settings", () => {
  const root = mkdtempSync(join(tmpdir(), "tela-work-choice-"));
  const path = join(root, "preferences-v1.json");
  try {
    writeProductPreferences({ version: 1, approvalAutomation: "full_access", approvalDelay: "2s" }, path);
    setWorkProfileConnection("default", true, path);
    setWorkProfileConnection("local.profile2", true, path);
    setWorkProfileConnection("default", true, path);
    expect(readProductPreferences(path).workProfileConnections).toEqual(["default", "local.profile2"]);
    setWorkProfileConnection("default", false, path);
    expect(readProductPreferences(path)).toEqual({ version: 1, approvalAutomation: "full_access", approvalDelay: "2s", workProfileConnections: ["local.profile2"] });
    expect(() => setWorkProfileConnection("../invalid", true, path)).toThrow("identities");
    expect(readProductPreferences(path).workProfileConnections).toEqual(["local.profile2"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("saved-chat acceptance is exact-slot, 15-minute bounded, and removable without other preference drift", () => {
  const root = mkdtempSync(join(tmpdir(), "tela-saved-chat-lease-"));
  const path = join(root, "preferences-v1.json");
  const now = 1_800_000_000_000;
  try {
    writeProductPreferences({ version: 1, approvalAutomation: "full_access", approvalDelay: "250ms" }, path);
    expect(savedChatAcceptanceSlot(readProductPreferences(path), now)).toBeUndefined();
    armSavedChatAcceptance(2, path, now);
    const lease = readProductPreferences(path);
    expect(lease.savedChatAcceptance).toEqual({ slot: 2, expiresAt: now + 900_000 });
    expect(savedChatAcceptanceSlot(lease, now)).toBe(2);
    expect(savedChatAcceptanceSlot(lease, now + 899_999)).toBe(2);
    expect(savedChatAcceptanceSlot(lease, now + 900_000)).toBeUndefined();
    expect(savedChatAcceptanceSlot(lease, now - 1)).toBeUndefined();
    expect(() => armSavedChatAcceptance(1, path, now)).toThrow("has not expired");
    expect(consumeSavedChatAcceptance(1, path, now)).toBe(false);
    expect(readProductPreferences(path).savedChatAcceptance?.slot).toBe(2);
    expect(consumeSavedChatAcceptance(2, path, now)).toBe(true);
    expect(consumeSavedChatAcceptance(2, path, now)).toBe(false);
    expect(readProductPreferences(path)).toEqual({ version: 1, approvalAutomation: "full_access", approvalDelay: "250ms" });
    armSavedChatAcceptance(1, path, now);
    expect(savedChatAcceptanceSlot(readProductPreferences(path), now)).toBe(1);
    clearSavedChatAcceptance(path);
    expect(readProductPreferences(path).savedChatAcceptance).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("malformed acceptance leases fail closed without broadening preferences", () => {
  for (const savedChatAcceptance of [
    { slot: 0, expiresAt: 1_800_000_000_000 },
    { slot: 100, expiresAt: 1_800_000_000_000 },
    { slot: 2.5, expiresAt: 1_800_000_000_000 },
    { slot: 2, expiresAt: -1 },
    { slot: 2, expiresAt: "tomorrow" },
    { slot: 2, expiresAt: 1_800_000_000_000, cookie: "foreign" },
  ]) {
    expect(() => parseProductPreferences({
      version: 1, approvalAutomation: "off", savedChatAcceptance,
    })).toThrow("lease");
  }
});
