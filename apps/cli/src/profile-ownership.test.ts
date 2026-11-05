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

  test("changing a profile root retains both owned locations and never adopts an unmarked third root", async () => {
    const home = mkdtempSync(join(tmpdir(), "tela-profile-relocation-"));
    const productPaths = resolveProductPaths({ platform: "darwin", home, environment: {} });
    const prepare = (root: string) => prepareProfileOwnership({
      slot: 1, productPaths, productVersion: "0.0.0", profileRoot: root,
    });
    const firstRoot = join(home, "first");
    const secondRoot = join(home, "second");
    const externalRoot = join(home, "external");
    try {
      const first = await prepare(firstRoot);
      writeFileSync(join(first.profile.userDataDir, "saved-state"), "owned first location");
      const second = await prepare(secondRoot);
      expect(second.browserProfile.state).toBe("created-owned");
      expect(second.accountBindings.state).toBe("created-owned");
      expect(second.browserProfile.resource.id).not.toBe(first.browserProfile.resource.id);
      expect(second.accountBindings.resource.id).not.toBe(first.accountBindings.resource.id);
      expect((await prepare(secondRoot)).browserProfile.state).toBe("already-owned");
      expect((await prepare(firstRoot)).browserProfile.state).toBe("already-owned");
      expect(readFileSync(join(first.profile.userDataDir, "saved-state"), "utf8")).toBe("owned first location");
      for (const result of [first, second]) {
        expect(existsSync(join(result.profile.userDataDir, OWNERSHIP_MARKER))).toBe(true);
        expect(existsSync(join(result.profile.profileRoot, "account-bindings", OWNERSHIP_MARKER))).toBe(true);
      }
      mkdirSync(join(externalRoot, "Canary-Profile1"), { recursive: true });
      mkdirSync(join(externalRoot, "account-bindings"));
      writeFileSync(join(externalRoot, "Canary-Profile1", "saved-state"), "unowned user data");
      const external = await prepare(externalRoot);
      expect(external.browserProfile.state).toBe("external-existing");
      expect(external.accountBindings.state).toBe("external-existing");
      expect(readFileSync(join(external.profile.userDataDir, "saved-state"), "utf8")).toBe("unowned user data");
      const resources = readOwnershipManifest(productPaths.installManifest)!.resources;
      expect(resources.filter(resource => resource.kind === "directory" && resource.dataClass === "browser-profile").length).toBe(2);
      expect(resources.some(resource => resource.kind === "directory" && resource.path.startsWith(externalRoot))).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
