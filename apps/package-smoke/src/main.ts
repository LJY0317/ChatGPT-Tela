import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readPackagedProductManifest,
  verifyPackagedPayloadSignature,
} from "@chatgpt-tela/product-lifecycle";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const KEY_ID = "ci-ephemeral-ed25519";

function run(command: string, arguments_: readonly string[], cwd = repoRoot): void {
  const result = spawnSync(command, [...arguments_], {
    cwd,
    stdio: "inherit",
    env: process.env,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${arguments_.join(" ")} failed with exit code ${result.status ?? -1}`);
  }
}

function regularFile(path: string, field: string): void {
  if (!existsSync(path)) throw new Error(`${field} is missing: ${path}`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${field} is not a regular file: ${path}`);
}

function executableName(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

function ensureElectronDistribution(): void {
  const electronRoot = join(repoRoot, "node_modules", "electron");
  const distribution = join(electronRoot, "dist");
  if (existsSync(distribution) && lstatSync(distribution).isDirectory() && !lstatSync(distribution).isSymbolicLink()) return;
  const installScript = join(electronRoot, "install.js");
  regularFile(installScript, "official Electron install script");
  run(process.execPath, [installScript]);
  if (!existsSync(distribution) || !lstatSync(distribution).isDirectory() || lstatSync(distribution).isSymbolicLink()) {
    throw new Error("official Electron install script completed without producing a usable distribution");
  }
}

function smokeLauncher(path: string): void {
  const result = spawnSync(path, [], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  if (result.error) throw result.error;
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status !== 1 || !combined.includes("usage: chatgpt-tela service <gateway|chat|codex>")) {
    throw new Error(`packaged launcher did not execute its expected CLI boundary (exit=${result.status ?? -1})`);
  }
}

async function main(): Promise<void> {
  ensureElectronDistribution();
  const root = mkdtempSync(join(tmpdir(), "chatgpt-tela-package-smoke-"));
  const output = join(root, "payload");
  const privateKeyPath = join(root, "release-private.pem");
  const keys = generateKeyPairSync("ed25519");
  writeFileSync(privateKeyPath, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  try {
    const arguments_ = [
      "run",
      "apps/package-build/src/main.ts",
      "--output", output,
      "--version", "0.0.0-ci-smoke",
      "--signing-key", privateKeyPath,
      "--key-id", KEY_ID,
      ...(process.platform === "darwin" ? ["--mac-codesign-identity", "-"] : []),
    ];
    run(process.execPath, arguments_);

    const manifest = readPackagedProductManifest(output);
    if (!manifest.launcher || !manifest.profileRuntime || !manifest.integrity) {
      throw new Error("package smoke payload is missing launcher/profile runtime/integrity metadata");
    }
    if (manifest.integrity.keyId !== KEY_ID) throw new Error("package smoke payload uses the wrong signing key id");
    const signature = verifyPackagedPayloadSignature({ payloadRoot: output, trustedKeys: { [KEY_ID]: keys.publicKey } });

    const launcherPath = join(output, executableName("chatgpt-tela"));
    regularFile(launcherPath, "packaged launcher");
    for (const service of ["gateway", "chat", "codex"] as const) {
      regularFile(join(output, "services", executableName(service)), `packaged ${service} service`);
    }
    regularFile(join(output, ...manifest.profileRuntime.entrypoint.split("/")), "packaged profile runtime entrypoint");
    regularFile(join(output, ...manifest.profileRuntime.executable.split("/")), "packaged Electron executable");
    smokeLauncher(launcherPath);

    console.log(JSON.stringify({
      platform: process.platform,
      productVersion: manifest.productVersion,
      payloadFingerprint: signature.payloadFingerprint,
      launcher: manifest.launcher.executable,
      services: manifest.services,
      profileRuntime: manifest.profileRuntime,
      verified: true,
    }, null, 2));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
