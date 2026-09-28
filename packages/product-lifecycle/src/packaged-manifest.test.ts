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
  test("parses exactly three portable service entrypoints and converts them to install spec", () => {
    const parsed = parsePackagedProductManifest(manifest());
    expect(parsed.productVersion).toBe("1.2.3");
    expect(parsed.services.codex.executable).toBe("runtime/tela");
    const root = mkdtempSync(join(tmpdir(), "tela-package-manifest-"));
    try {
      writeFileSync(join(root, PACKAGED_PRODUCT_MANIFEST), `${JSON.stringify(manifest())}\n`);
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

  test("signed launcher layout is all-or-none and keeps the launcher at the payload root", () => {
    const base = manifest();
    const signed = {
      ...base,
      launcher: { executable: "chatgpt-tela" },
      profileRuntime: { executable: "electron/Electron.app/Contents/MacOS/Electron", entrypoint: "runtime/profile-runtime.cjs" },
      integrity: { signature: "ed25519-sha256-tree-v1", keyId: "release-key" },
    };
    expect(parsePackagedProductManifest(signed).integrity?.keyId).toBe("release-key");
    expect(() => parsePackagedProductManifest({ ...base, launcher: signed.launcher })).toThrow("declared together");
    expect(() => parsePackagedProductManifest({ ...signed, launcher: { executable: "runtime/chatgpt-tela" } }))
      .toThrow("payload root");
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
