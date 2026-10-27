import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PACKAGED_PRODUCT_MANIFEST,
  packagedInstallSpecFromPayload,
  parsePackagedProductManifest,
  readPackagedProductManifest,
} from "./packaged-manifest";

function manifest() {
  return {
    version: 1,
    product: "chatgpt-tela",
    productVersion: "1.2.3",
    services: {
      gateway: { executable: "runtime/tela", arguments: ["service", "gateway"] },
      chat: { executable: "runtime/tela", arguments: ["service", "chat"] },
      codex: { executable: "runtime/tela", arguments: ["service", "codex"], environment: { TELA_MODE: "product" } },
    },
  };
}

describe("packaged product manifest", () => {
  test("lifecycle protocol is explicit, launcher-layout-only and refuses unknown versions", () => {
    const base = manifest();
    expect(parsePackagedProductManifest(base).lifecycle).toBeUndefined();
    const signed = { ...base, launcher: { executable: "tela" }, profileRuntime: { executable: "electron", entrypoint: "entry" },
      integrity: { signature: "ed25519-sha256-tree-v1", keyId: "fixture" } };
    expect(parsePackagedProductManifest({ ...signed, lifecycle: { transitionLaunch: 1, sourceCancellation: 1 } }).lifecycle)
      .toEqual({ transitionLaunch: 1, sourceCancellation: 1 });
    for (const lifecycle of [{ transitionLaunch: 2, sourceCancellation: 1 }, { transitionLaunch: 1 },
      { transitionLaunch: 1, sourceCancellation: 1, fallback: true }, []]) {
      expect(() => parsePackagedProductManifest({ ...signed, lifecycle })).toThrow("protocol");
    }
    expect(() => parsePackagedProductManifest({ ...base, lifecycle: { transitionLaunch: 1, sourceCancellation: 1 } }))
      .toThrow("launcher");
  });
  test("Chat storage compatibility is retained in the package manifest rather than inferred from release names", () => {
    const base = manifest();
    expect(parsePackagedProductManifest(base).chatProcessStore).toBeUndefined();
    expect(parsePackagedProductManifest({ ...base, chatProcessStore: { readVersions: [1, 2], writeVersion: 2 } }).chatProcessStore)
      .toEqual({ readVersions: [1, 2], writeVersion: 2 });
    expect(() => parsePackagedProductManifest({ ...base, chatProcessStore: { readVersions: [1], writeVersion: 2 } }))
      .toThrow("compatibility");
  });
  test("parses exactly three portable service entrypoints and converts them to install spec", () => {
    const parsed = parsePackagedProductManifest(manifest());
    expect(parsed.productVersion).toBe("1.2.3");
    expect(parsed.services.codex.executable).toBe("runtime/tela");
    const root = mkdtempSync(join(tmpdir(), "tela-package-manifest-"));
    try {
      writeFileSync(join(root, PACKAGED_PRODUCT_MANIFEST), `${JSON.stringify(manifest())}\n`);
      expect(() => packagedInstallSpecFromPayload(root)).toThrow("required file is missing");
      mkdirSync(join(root, "runtime")); writeFileSync(join(root, "runtime/tela"), "fixture");
      const spec = packagedInstallSpecFromPayload(root);
      expect(spec.services.map(service => service.service)).toEqual(["gateway", "chat", "codex"]);
      expect(spec.productVersion).toBe("1.2.3");
      expect(readPackagedProductManifest(root)).toEqual(parsed);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects missing services, unknown fields, unsafe paths, and multiline arguments", () => {
    const base = manifest();
    expect(() => parsePackagedProductManifest({ ...base, services: { gateway: base.services.gateway } })).toThrow("exactly");
    expect(() => parsePackagedProductManifest({ ...base, surprise: true })).toThrow("unknown fields");
    expect(() => parsePackagedProductManifest({ ...base,
      services: { ...base.services, chat: { ...base.services.chat, executable: "../foreign" } } })).toThrow("unsafe");
    expect(() => parsePackagedProductManifest({ ...base,
      services: { ...base.services, chat: { ...base.services.chat, arguments: ["bad\narg"] } } })).toThrow("invalid");
  });

  test("launcher layout is all-or-none and permits portable nested executables", () => {
    const base = manifest();
    const signed = {
      ...base,
      launcher: { executable: "chatgpt-tela" },
      profileRuntime: { executable: "electron/Electron.app/Contents/MacOS/Electron", entrypoint: "runtime/profile-runtime.cjs" },
      menuBar: { executable: "ui/chatgpt-tela-menu-bar" },
      integrity: { signature: "ed25519-sha256-tree-v1", keyId: "release-key" },
    };
    expect(Object.hasOwn(parsePackagedProductManifest(signed), "integrity")).toBe(false);
    expect(parsePackagedProductManifest(signed).menuBar?.executable).toBe("ui/chatgpt-tela-menu-bar");
    const root = mkdtempSync(join(tmpdir(), "tela-package-menu-bar-"));
    try {
      for (const path of [...Object.values(signed.services).map(service => service.executable),
        signed.launcher.executable, signed.profileRuntime.executable, signed.profileRuntime.entrypoint, signed.menuBar.executable]) {
        const target = join(root, path);
        mkdirSync(join(target, ".."), { recursive: true }); writeFileSync(target, "fixture");
      }
      writeFileSync(join(root, PACKAGED_PRODUCT_MANIFEST), `${JSON.stringify(signed)}\n`);
      expect(packagedInstallSpecFromPayload(root).menuBar).toEqual({
        executableRelativePath: "chatgpt-tela",
        arguments: ["menu-bar"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expect(() => parsePackagedProductManifest({ ...base, launcher: signed.launcher })).toThrow("declared together");
    expect(parsePackagedProductManifest({ ...signed, launcher: { executable: "Contents/MacOS/chatgpt-tela" } }).launcher)
      .toEqual({ executable: "Contents/MacOS/chatgpt-tela" });
  });

  test("manifest file must be a real regular file", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-package-manifest-file-"));
    try {
      mkdirSync(join(root, PACKAGED_PRODUCT_MANIFEST));
      expect(() => readPackagedProductManifest(root)).toThrow("unsafe");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
