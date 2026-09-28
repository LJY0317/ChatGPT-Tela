import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPackagedPayload } from "./packaged-build";
import { packagedInstallSpecFromPayload, readPackagedProductManifest } from "./packaged-manifest";
import { createEd25519PackagedPayloadSigner, verifyPackagedPayloadSignature } from "./packaged-signature";

function fixture(root: string) {
  const input = join(root, "input");
  mkdirSync(join(input, "electron", "bin"), { recursive: true });
  writeFileSync(join(input, "launcher"), "launcher\n", { mode: 0o755 });
  for (const service of ["gateway", "chat", "codex"] as const) {
    writeFileSync(join(input, service), `${service}\n`, { mode: 0o755 });
  }
  writeFileSync(join(input, "profile-runtime.cjs"), "module.exports = {};\n");
  writeFileSync(join(input, "electron", "bin", "electron"), "electron\n", { mode: 0o755 });
  return input;
}

describe("signed packaged payload builder", () => {
  test("stages a multi-file launcher/services/profile-runtime layout and signs its tree fingerprint", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-packaged-build-"));
    const input = fixture(root);
    const output = join(root, "output");
    const keys = generateKeyPairSync("ed25519");
    const signer = createEd25519PackagedPayloadSigner({ keyId: "release-fixture", privateKey: keys.privateKey });
    try {
      const built = buildPackagedPayload({
        outputPath: output,
        productVersion: "1.2.3",
        launcherSourcePath: join(input, "launcher"),
        services: {
          gateway: { executableSourcePath: join(input, "gateway") },
          chat: { executableSourcePath: join(input, "chat") },
          codex: { executableSourcePath: join(input, "codex") },
        },
        profileRuntime: {
          electronBundleSourcePath: join(input, "electron"),
          electronExecutableRelativePath: "bin/electron",
          entrypointSourcePath: join(input, "profile-runtime.cjs"),
        },
        signer,
      });
      expect(built.manifest.launcher?.executable).toBe("chatgpt-tela");
      expect(built.manifest.services.gateway.executable).toBe("services/gateway");
      expect(built.manifest.profileRuntime).toEqual({
        executable: "electron/bin/electron",
        entrypoint: "runtime/profile-runtime.cjs",
      });
      expect(existsSync(join(output, "services", "gateway"))).toBe(true);
      expect(existsSync(join(output, "runtime", "profile-runtime.cjs"))).toBe(true);
      expect(verifyPackagedPayloadSignature({ payloadRoot: output, trustedKeys: { "release-fixture": keys.publicKey } }))
        .toEqual(built.signature);
      const spec = packagedInstallSpecFromPayload(output);
      expect(spec.services).toEqual([
        { service: "gateway", executableRelativePath: "chatgpt-tela", arguments: ["service", "gateway"] },
        { service: "chat", executableRelativePath: "chatgpt-tela", arguments: ["service", "chat"] },
        { service: "codex", executableRelativePath: "chatgpt-tela", arguments: ["service", "codex"] },
      ]);
      expect(readPackagedProductManifest(output).integrity?.keyId).toBe("release-fixture");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("signature verification fails after any signed payload byte changes", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-packaged-signature-drift-"));
    const input = fixture(root);
    const output = join(root, "output");
    const keys = generateKeyPairSync("ed25519");
    try {
      buildPackagedPayload({
        outputPath: output,
        productVersion: "1.2.3",
        launcherSourcePath: join(input, "launcher"),
        services: {
          gateway: { executableSourcePath: join(input, "gateway") },
          chat: { executableSourcePath: join(input, "chat") },
          codex: { executableSourcePath: join(input, "codex") },
        },
        profileRuntime: {
          electronBundleSourcePath: join(input, "electron"),
          electronExecutableRelativePath: "bin/electron",
          entrypointSourcePath: join(input, "profile-runtime.cjs"),
        },
        signer: createEd25519PackagedPayloadSigner({ keyId: "release-fixture", privateKey: keys.privateKey }),
      });
      writeFileSync(join(output, "services", "chat"), "tampered\n");
      expect(() => verifyPackagedPayloadSignature({ payloadRoot: output, trustedKeys: { "release-fixture": keys.publicKey } }))
        .toThrow("fingerprint");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("internal Electron symlinks are preserved while cyclic/escaping links are rejected", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "tela-packaged-symlink-"));
    const input = fixture(root);
    const keys = generateKeyPairSync("ed25519");
    try {
      symlinkSync("loop", join(input, "electron", "bin", "loop"));
      expect(() => buildPackagedPayload({
        outputPath: join(root, "bad-cycle"),
        productVersion: "1.2.3",
        launcherSourcePath: join(input, "launcher"),
        services: {
          gateway: { executableSourcePath: join(input, "gateway") },
          chat: { executableSourcePath: join(input, "chat") },
          codex: { executableSourcePath: join(input, "codex") },
        },
        profileRuntime: {
          electronBundleSourcePath: join(input, "electron"),
          electronExecutableRelativePath: "bin/electron",
          entrypointSourcePath: join(input, "profile-runtime.cjs"),
        },
        signer: createEd25519PackagedPayloadSigner({ keyId: "release-fixture", privateKey: keys.privateKey }),
      })).toThrow();
      rmSync(join(input, "electron", "bin", "loop"));
      symlinkSync("bin", join(input, "electron", "electron-copy"));
      const output = join(root, "good");
      buildPackagedPayload({
        outputPath: output,
        productVersion: "1.2.3",
        launcherSourcePath: join(input, "launcher"),
        services: {
          gateway: { executableSourcePath: join(input, "gateway") },
          chat: { executableSourcePath: join(input, "chat") },
          codex: { executableSourcePath: join(input, "codex") },
        },
        profileRuntime: {
          electronBundleSourcePath: join(input, "electron"),
          electronExecutableRelativePath: "bin/electron",
          entrypointSourcePath: join(input, "profile-runtime.cjs"),
        },
        signer: createEd25519PackagedPayloadSigner({ keyId: "release-fixture", privateKey: keys.privateKey }),
      });
      expect(lstatSync(join(output, "electron", "electron-copy")).isSymbolicLink()).toBe(true);
      rmSync(join(input, "electron", "electron-copy"), { force: true });
      const outside = join(root, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "x"), "x");
      symlinkSync(outside, join(input, "electron", "escape"));
      expect(() => buildPackagedPayload({
        outputPath: join(root, "escape-output"),
        productVersion: "1.2.3",
        launcherSourcePath: join(input, "launcher"),
        services: {
          gateway: { executableSourcePath: join(input, "gateway") },
          chat: { executableSourcePath: join(input, "chat") },
          codex: { executableSourcePath: join(input, "codex") },
        },
        profileRuntime: {
          electronBundleSourcePath: join(input, "electron"),
          electronExecutableRelativePath: "bin/electron",
          entrypointSourcePath: join(input, "profile-runtime.cjs"),
        },
        signer: createEd25519PackagedPayloadSigner({ keyId: "release-fixture", privateKey: keys.privateKey }),
      })).toThrow("symlink");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
