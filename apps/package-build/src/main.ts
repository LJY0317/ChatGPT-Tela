import { assembleMacApplication } from "../../../packages/product-lifecycle/src/mac-application";
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  buildPackagedPayload,
  CURRENT_PACKAGED_LIFECYCLE,
  CURRENT_CHAT_PROCESS_STORE_COMPATIBILITY,
  type PackagedProductManifest,
} from "@chatgpt-tela/product-lifecycle";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
type PackagePlatform = "darwin" | "win32" | "linux";
type PackageArch = "arm64" | "x64";

function target(): { platform: PackagePlatform; arch: PackageArch } {
  const platform = option("--target-platform") ?? process.platform;
  const arch = option("--target-arch") ?? process.arch;
  if ((platform !== "darwin" && platform !== "win32" && platform !== "linux")
    || (arch !== "arm64" && arch !== "x64")) {
    throw Error(`unsupported package target: ${platform}/${arch}`);
  }
  return { platform, arch };
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function requiredOption(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function runBun(arguments_: readonly string[]): void {
  execFileSync(process.execPath, [...arguments_], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
}

function compileExecutable(entrypoint: string, output: string, platform: PackagePlatform, arch: PackageArch): void {
  const targetArgs = platform === process.platform && arch === process.arch
    ? [] : [`--target=bun-${platform === "win32" ? "windows" : platform}-${arch}`];
  runBun(["build", entrypoint, "--compile", ...targetArgs, `--outfile=${output}`]);
}

function electronExecutableRelativePath(platform: PackagePlatform): string {
  if (platform === "darwin") return "Electron.app/Contents/MacOS/Electron";
  return platform === "win32" ? "electron.exe" : "electron";
}

function verifyWorkspaceHelper(path: string, platform: PackagePlatform, arch: PackageArch): void {
  if (platform === "darwin") {
    // macOS assembly already requires a matching macOS host. lipo handles universal helpers.
    const result = spawnSync("/usr/bin/lipo", ["-verify_arch", arch === "x64" ? "x86_64" : arch, resolve(path)]);
    if (result.error) throw result.error;
    if (result.status === 0) return;
  } else {
    const descriptor = openSync(path, "r");
    const header = Buffer.alloc(64);
    try {
      if (readSync(descriptor, header, 0, header.length, 0) === header.length) {
        if (platform === "linux") {
          const elf64LittleEndian = header.subarray(0, 6).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]));
          const machine = header.readUInt16LE(18); // ELF e_machine
          if (elf64LittleEndian && machine === (arch === "arm64" ? 183 : 62)) return;
        } else if (header.toString("ascii", 0, 2) === "MZ") {
          const peOffset = header.readUInt32LE(0x3c);
          const pe = Buffer.alloc(6);
          if (readSync(descriptor, pe, 0, pe.length, peOffset) === pe.length && pe.readUInt32LE(0) === 0x00004550
            && pe.readUInt16LE(4) === (arch === "arm64" ? 0xaa64 : 0x8664)) return;
        }
      }
    } finally {
      closeSync(descriptor);
    }
  }
  throw Error(`Workspace files helper must be built for ${platform}/${arch}`);
}

async function electronDistribution(platform: PackagePlatform, arch: PackageArch, temporary: string): Promise<string> {
  const root = resolve(repoRoot, "node_modules", "electron");
  if (platform !== process.platform || arch !== process.arch) {
    // Use Electron's pinned official downloader and extractor without modifying
    // the local host's node_modules/electron/dist or its executable pointer.
    const requireElectron = createRequire(realpathSync(join(root, "install.js")));
    const { downloadArtifact } = requireElectron("@electron/get") as {
      downloadArtifact: (options: { artifactName: "electron"; version: string; platform: PackagePlatform;
        arch: PackageArch; checksums: Record<string, string> }) => Promise<string>;
    };
    const { extract } = requireElectron("@electron-internal/extract-zip") as { extract: (zip: string, options: { dir: string }) => Promise<void> };
    const { version } = requireElectron("./package.json") as { version: string };
    const zip = await downloadArtifact({ artifactName: "electron", version, platform, arch,
      checksums: requireElectron("./checksums.json") });
    const destination = join(temporary, "electron-distribution");
    mkdirSync(destination);
    await extract(zip, { dir: destination });
    return destination;
  }
  const distribution = join(root, "dist");
  if (!existsSync(distribution)) {
    // Bun may install the npm wrapper without running Electron's official
    // download script. Package from this checkout's pinned dependency.
    execFileSync(process.execPath, [join(root, "install.js")], { cwd: repoRoot, stdio: "inherit" });
  }
  if (!existsSync(distribution) || !lstatSync(distribution).isDirectory() || lstatSync(distribution).isSymbolicLink()) {
    throw new Error("Electron distribution is missing after the official electron/install.js postinstall");
  }
  return distribution;
}

function macCodesign(outputPath: string, identity: string, manifest: PackagedProductManifest): void {
  const sign = (path: string, flags: readonly string[] = []) => {
    execFileSync("/usr/bin/codesign", ["--force", ...flags, "--sign", identity, path], {
      stdio: "inherit",
    });
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", "--deep", "--verbose=2", path], {
      stdio: "inherit",
    });
  };
  for (const executable of new Set([manifest.launcher!.executable, ...Object.values(manifest.services).map(service => service.executable)])) {
    sign(join(outputPath, executable));
  }
  const menuBarApp = join(outputPath, "ui", "ChatGPT Tela.app");
  const sparkle = join(menuBarApp, "Contents/Frameworks/Sparkle.framework");
  if (existsSync(sparkle)) {
    // This app does not use Sparkle's sandbox XPC services. Trim them before signing.
    // Follow Sparkle's explicit inside-out signing contract, never --deep re-sign it.
    rmSync(join(sparkle, "Versions/B/XPCServices"), { recursive: true, force: true });
    rmSync(join(sparkle, "XPCServices"), { force: true });
    for (const helper of ["Autoupdate", "Updater.app"]) sign(join(sparkle, "Versions/B", helper), ["--options", "runtime"]);
    sign(sparkle, ["--options", "runtime"]);
  }
  if (existsSync(menuBarApp)) sign(menuBarApp);
  const maintenanceApp = join(outputPath, "ui", "Tela Maintenance.app");
  if (existsSync(maintenanceApp)) sign(maintenanceApp);
  const workspaceFiles = join(outputPath, "helpers", "tela-workspace-files");
  if (existsSync(workspaceFiles)) sign(workspaceFiles);
  sign(join(outputPath, "electron", "Electron.app"), ["--deep"]);
}

async function main(): Promise<void> {
  const { platform, arch } = target();
  const outputPath = resolve(requiredOption("--output"));
  const productVersion = requiredOption("--version");
  const macApp = platform === "darwin";
  if (macApp && (process.platform !== "darwin" || arch !== process.arch)) {
    throw Error("macOS app assembly/signing requires a matching macOS build host");
  }
  if (macApp && !outputPath.endsWith(".app")) throw Error("macOS package builds require a .app output");
  const appOptions = macApp ? { buildVersion: requiredOption("--build-number"), feedURL: requiredOption("--update-feed-url"), publicKey: requiredOption("--update-public-key") } : undefined;
  const macCodesignIdentity = macApp ? option("--mac-codesign-identity") ?? "-" : undefined;
  const workspaceFilesSourcePath = option("--workspace-files");
  if (workspaceFilesSourcePath) verifyWorkspaceHelper(workspaceFilesSourcePath, platform, arch);
  const temporary = mkdtempSync(join(tmpdir(), "chatgpt-tela-package-build-"));
  try {
    const electronBundle = await electronDistribution(platform, arch, temporary);
    const executableExtension = platform === "win32" ? ".exe" : "";
    const launcher = join(temporary, `chatgpt-tela${executableExtension}`);
    const profileRuntime = join(temporary, "profile-runtime.cjs");
    const profileSetup = join(temporary, "profile-setup.cjs");
    const menuBar = macApp ? join(temporary, "chatgpt-tela-menu-bar") : undefined;

    compileExecutable("apps/packaged-launcher/src/entrypoint.ts", launcher, platform, arch);
    runBun(["build", "apps/profile-runtime/src/main.ts", "--target=node", "--format=cjs", "--external", "electron",
      `--outfile=${profileRuntime}`]);
    runBun(["build", "apps/profile-setup/src/main.ts", "--target=node", "--format=cjs", "--external", "electron",
      `--outfile=${profileSetup}`]);
    if (menuBar) {
      runBun(["run", "apps/menu-bar-macos/build.ts", "--output", menuBar]);
    }

    const notices = join(temporary, "third-party-notices");
    mkdirSync(notices);
    copyFileSync(join(repoRoot, "LICENSE"), join(notices, "ChatGPT-Tela.txt"));
    // Other platforms retain the complete Electron distribution, including its notices.
    for (const name of macApp ? ["LICENSE", "LICENSES.chromium.html"] : []) {
      copyFileSync(join(electronBundle, name), join(notices, name === "LICENSE" ? "Electron.txt" : name));
    }
    if (menuBar) copyFileSync(join(temporary, "Sparkle-LICENSE.txt"), join(notices, "Sparkle.txt"));
    let built = buildPackagedPayload({
      outputPath,
      noticesSourcePath: notices,
      productVersion,
      chatProcessStore: CURRENT_CHAT_PROCESS_STORE_COMPATIBILITY,
      lifecycle: CURRENT_PACKAGED_LIFECYCLE,
      launcherSourcePath: launcher,
      services: {
        gateway: { executableSourcePath: launcher, arguments: ["--tela-daemon", "gateway"] },
        chat: { executableSourcePath: launcher, arguments: ["--tela-daemon", "chat"] },
        codex: { executableSourcePath: launcher, arguments: ["--tela-daemon", "codex"] },
      },
      profileRuntime: {
        electronBundleSourcePath: electronBundle,
        electronExecutableRelativePath: electronExecutableRelativePath(platform),
        entrypointSourcePath: profileRuntime,
        setupEntrypointSourcePath: profileSetup,
      },
      ...(menuBar ? { menuBarSourcePath: menuBar, menuBarFrameworkSourcePath: join(temporary, "Sparkle.framework"), menuBarLocalizationSourcePath: join(temporary, "TelaLocalizations.bundle"), maintenanceUISourcePath: join(temporary, "chatgpt-tela-maintenance") } : {}),
      ...(workspaceFilesSourcePath ? { workspaceFilesSourcePath } : {}),
      ...(macCodesignIdentity
        ? { finalizeStagedPayload: ({ outputPath: staged, manifest }) => macCodesign(staged, macCodesignIdentity, manifest) }
        : {}),
    });

    if (appOptions) built = assembleMacApplication({ payloadPath: outputPath, ...appOptions, finalizeBundle(appPath) {
      execFileSync("/usr/bin/codesign", ["--force", "--sign", macCodesignIdentity!, appPath], { stdio: "inherit" });
      execFileSync("/usr/bin/codesign", ["--verify", "--strict", "--deep", appPath], { stdio: "inherit" });
    } });

    console.log(JSON.stringify({
      outputPath: built.outputPath,
      productVersion: built.manifest.productVersion,
      payloadFingerprint: built.payloadFingerprint,
      services: built.manifest.services,
      launcher: built.manifest.launcher,
      profileRuntime: built.manifest.profileRuntime,
      menuBar: built.manifest.menuBar,
      workspaceFiles: built.manifest.workspaceFiles,
    }, null, 2));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
