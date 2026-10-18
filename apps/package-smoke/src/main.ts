
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
  CURRENT_PACKAGED_LIFECYCLE,
  readPackagedProductManifest,
  packagedPayloadFingerprint,
} from "@chatgpt-tela/product-lifecycle";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

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
  const result = spawnSync(path, ["--help"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  if (result.error) throw result.error;
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status !== 0
    || !combined.includes("chatgpt-tela install")
    || !combined.includes("chatgpt-tela uninstall")
    || !combined.includes("chatgpt-tela cancel-upgrade")
  ) {
    throw new Error(`packaged launcher did not execute its expected CLI boundary (exit=${result.status ?? -1})`);
  }
}

async function main(): Promise<void> {
  ensureElectronDistribution();
  const root = mkdtempSync(join(tmpdir(), "chatgpt-tela-package-smoke-"));
  const output = join(root, "payload");

  const workspaceFiles = join(repoRoot, "build", "workspace-files-target", "release", executableName("tela-workspace-files"));
  try {
    const arguments_ = [
      "run",
      "apps/package-build/src/main.ts",
      "--output", output,
      "--version", "0.0.0-ci-smoke",

      ...(existsSync(workspaceFiles) ? ["--workspace-files", workspaceFiles] : []),
      ...(process.platform === "darwin" ? ["--mac-codesign-identity", "-"] : []),
    ];
    run(process.execPath, arguments_);

    const manifest = readPackagedProductManifest(output);
    if (!manifest.launcher || !manifest.profileRuntime) {
      throw new Error("package smoke payload is missing launcher/profile runtime metadata");
    }
    if (manifest.lifecycle?.transitionLaunch !== CURRENT_PACKAGED_LIFECYCLE.transitionLaunch
      || manifest.lifecycle?.sourceCancellation !== CURRENT_PACKAGED_LIFECYCLE.sourceCancellation) {
      throw new Error("package smoke payload is missing the current lifecycle protocol");
    }

    const payloadFingerprint = packagedPayloadFingerprint(output);

    const launcherPath = join(output, executableName("chatgpt-tela"));
    regularFile(launcherPath, "packaged launcher");
    for (const service of ["gateway", "chat", "codex"] as const) {
      regularFile(join(output, "services", executableName(service)), `packaged ${service} service`);
    }
    regularFile(join(output, ...manifest.profileRuntime.entrypoint.split("/")), "packaged profile runtime entrypoint");
    if (!manifest.profileRuntime.setupEntrypoint) throw new Error("package is missing the login setup entrypoint");
    regularFile(join(output, ...manifest.profileRuntime.setupEntrypoint.split("/")), "packaged login setup entrypoint");
    regularFile(join(output, ...manifest.profileRuntime.executable.split("/")), "packaged Electron executable");
    if (process.platform === "darwin") {
      if (!manifest.menuBar) throw new Error("macOS package smoke payload is missing menu bar metadata");
      regularFile(join(output, ...manifest.menuBar.executable.split("/")), "packaged menu bar executable");
    } else if (manifest.menuBar) {
      throw new Error("non-macOS package smoke payload unexpectedly contains menu bar metadata");
    }
    if (existsSync(workspaceFiles)) {
      if (!manifest.workspaceFiles || manifest.workspaceFiles.protocolVersion !== 2) throw new Error("package smoke is missing file publisher metadata");
      const helper = join(output, ...manifest.workspaceFiles.executable.split("/"));
      regularFile(helper, "packaged file publisher");
      const probe = spawnSync(helper, ["--protocol-version"], { encoding: "utf8", timeout: 5000, windowsHide: true });
      if (probe.error || probe.status !== 0 || probe.stdout !== "2\n") throw new Error("packaged file publisher protocol check failed");
      const exportProbe = spawnSync(helper, ["--export-version"], { encoding: "utf8", timeout: 5000, windowsHide: true });
      if (exportProbe.error || exportProbe.status !== 0 || exportProbe.stdout !== "1\n") throw new Error("packaged file export protocol check failed");
    }
    smokeLauncher(launcherPath);
    const lifecycleFixture = join(root, executableName("compiled-lifecycle"));
    run(process.execPath, ["build", "--compile", "apps/package-smoke/src/compiled-lifecycle.ts", "--outfile", lifecycleFixture]);
    if (process.platform === "darwin") {
      run("/usr/bin/codesign", ["--force", "--sign", "-", lifecycleFixture]);
      run("/usr/bin/codesign", ["--verify", "--strict", lifecycleFixture]);
    }
    run(lifecycleFixture, []);

    console.log(JSON.stringify({
      platform: process.platform,
      productVersion: manifest.productVersion,
      payloadFingerprint,
      launcher: manifest.launcher.executable,
      services: manifest.services,
      profileRuntime: manifest.profileRuntime,
      menuBar: manifest.menuBar,
      workspaceFiles: manifest.workspaceFiles,
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
