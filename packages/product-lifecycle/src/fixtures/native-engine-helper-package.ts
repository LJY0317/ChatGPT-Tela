import { strict as assert } from "node:assert";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPackagedPayload } from "../packaged-build";
import { createEd25519PackagedPayloadSigner, verifyPackagedPayloadSignature } from "../packaged-signature";
import { nativeEngineFileSha256, nativeEngineHelperName } from "../native-engine";

function fixture(root: string) {
  const input = join(root, "input");
  mkdirSync(join(input, "electron", "bin"), { recursive: true });
  writeFileSync(join(input, "launcher"), "launcher\n", { mode: 0o755 });
  for (const service of ["gateway", "chat", "codex"] as const) {
    writeFileSync(join(input, service), `${service}\n`, { mode: 0o755 });
  }
  writeFileSync(join(input, "profile-runtime.cjs"), "module.exports = {};\n");
  writeFileSync(join(input, "menu-bar"), "menu-bar\n", { mode: 0o755 });
  writeFileSync(join(input, "electron", "bin", "electron"), "electron\n", { mode: 0o755 });
  return input;
}

// Bun test workers cannot reliably spawn child processes; this is a standalone probe.
if (process.platform !== "win32") {

  const root = mkdtempSync(join(tmpdir(), "tela-engine-package-helper-"));
  try {
    const input = fixture(root);
    const engine = join(input, "engine");
    writeFileSync(engine, '#!/bin/sh\nprintf "codex-cli 0.159.0\\n"\n', { mode: 0o755 });
    const helper = join(input, nativeEngineHelperName(process.platform));
    const keys = generateKeyPairSync("ed25519");
    const common = {
      productVersion: "1.2.3", launcherSourcePath: join(input, "launcher"),
      services: {
        gateway: { executableSourcePath: join(input, "gateway") },
        chat: { executableSourcePath: join(input, "chat") },
        codex: { executableSourcePath: join(input, "codex") },
      },
      profileRuntime: { electronBundleSourcePath: join(input, "electron"),
        electronExecutableRelativePath: "bin/electron", entrypointSourcePath: join(input, "profile-runtime.cjs") },
      nativeEngine: { executableSourcePath: engine, version: "0.159.0", sha256: nativeEngineFileSha256(engine),
        platform: process.platform as "darwin" | "linux", architecture: process.arch as "arm64" | "x64",
        upstreamCommit: "a".repeat(40), patchSha256: "b".repeat(64), capabilities: ["model-local-compaction-v1"] as const },
      signer: createEd25519PackagedPayloadSigner({ keyId: "helper-fixture", privateKey: keys.privateKey }),
    };
    assert.throws(() => buildPackagedPayload({ ...common, outputPath: join(root, "missing") }), /helper source/);
    writeFileSync(helper, "helper", { mode: 0o755 });
    const built = buildPackagedPayload({ ...common, outputPath: join(root, "complete") });
    const installedHelper = join(built.outputPath, "native-engine", nativeEngineHelperName(process.platform));
    assert.equal(readFileSync(installedHelper, "utf8"), "helper");
    assert.notEqual(lstatSync(installedHelper).mode & 0o111, 0);
    verifyPackagedPayloadSignature({ payloadRoot: built.outputPath, trustedKeys: { "helper-fixture": keys.publicKey } });
    writeFileSync(installedHelper, "tampered");
    assert.throws(() => verifyPackagedPayloadSignature({ payloadRoot: built.outputPath, trustedKeys: { "helper-fixture": keys.publicKey } }));
  } finally { rmSync(root, { recursive: true, force: true }); }
  console.log(JSON.stringify({ pass: true, missingHelperRejected: true, helperSigned: true }));
}
