import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OWNERSHIP_MARKER,
  readOwnershipManifest,
  resolveProductPaths,
} from "@chatgpt-tela/product-lifecycle";
import { prepareProfileOwnership } from "./profile-ownership";

describe("CLI profile ownership preparation", () => {
  test("simultaneous fresh slots retain both browser registrations and shared metadata", async () => {
    const home = mkdtempSync(join(tmpdir(), "tela-profile-own-"));
    const productPaths = resolveProductPaths({ platform: "darwin", home, environment: { HOME: home } });
    try {
      const results = await Promise.all([1, 2].map(slot => prepareProfileOwnership({
        slot,
        productPaths,
        productVersion: "0.0.0",
        platform: "darwin",
        homeDirectory: home,
        environment: { HOME: home },
      })));
      const one = results[0]!;
      const two = results[1]!;
      expect(one.browserProfile.state).toBe("created-owned");
      expect(two.browserProfile.state).toBe("created-owned");
      expect(existsSync(join(one.profile.userDataDir, OWNERSHIP_MARKER))).toBe(true);
      expect(existsSync(join(two.profile.userDataDir, OWNERSHIP_MARKER))).toBe(true);
      const resources = readOwnershipManifest(productPaths.installManifest)?.resources ?? [];
      expect(resources).toContainEqual({ kind: "directory", id: "browser-profile:1", owner: "codex",
        path: one.profile.userDataDir, dataClass: "browser-profile" });
      expect(resources).toContainEqual({ kind: "directory", id: "browser-profile:2", owner: "codex",
        path: two.profile.userDataDir, dataClass: "browser-profile" });
      expect(resources).toContainEqual({ kind: "directory", id: "account-bindings", owner: "codex",
        path: join(one.profile.profileRoot, "account-bindings"), dataClass: "state" });
      expect(resources.filter(resource => resource.kind === "directory" && resource.id.startsWith("browser-profile:")).length).toBe(2);
      expect(resources.some(resource => resource.kind === "directory" && resource.path === one.profile.profileRoot)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("legacy cookie/account state stays external and unchanged", async () => {
    const home = mkdtempSync(join(tmpdir(), "tela-profile-legacy-"));
    const productPaths = resolveProductPaths({ platform: "darwin", home, environment: { HOME: home } });
    const profileRoot = join(home, "Library", "Application Support", "ChatGPT Tela");
    const browser = join(profileRoot, "Canary-Profile1");
    const bindings = join(profileRoot, "account-bindings");
    mkdirSync(browser, { recursive: true });
    mkdirSync(bindings, { recursive: true });
    writeFileSync(join(browser, "Cookies"), "legacy-cookie-state");
    writeFileSync(join(bindings, "Profile1.json"), "legacy-binding-state");
    try {
      const result = await prepareProfileOwnership({
        slot: 1,
        productPaths,
        productVersion: "0.0.0",
        platform: "darwin",
        homeDirectory: home,
        environment: { HOME: home },
      });
      expect(result.browserProfile.state).toBe("external-existing");
      expect(result.accountBindings.state).toBe("external-existing");
      expect(readFileSync(join(browser, "Cookies"), "utf8")).toBe("legacy-cookie-state");
      expect(readFileSync(join(bindings, "Profile1.json"), "utf8")).toBe("legacy-binding-state");
      expect(readOwnershipManifest(productPaths.installManifest)?.resources).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
