import { assembleMacApplication } from "../../../packages/product-lifecycle/src/mac-application";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPackagedPayload,
  CURRENT_PACKAGED_LIFECYCLE,
  parsePackagedNativeEngine,
  CURRENT_CHAT_PROCESS_STORE_COMPATIBILITY,
  type PackagedProductManifest,
} from "@chatgpt-tela/product-lifecycle";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

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

function realRegularFile(path: string, field: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new Error(`${field} is missing: ${absolute}`);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${field} must be a real regular file`);
  return realpathSync(absolute);
}

function runBun(arguments_: readonly string[]): void {
  execFileSync(process.execPath, [...arguments_], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
}

function compileExecutable(entrypoint: string, output: string): void {
  runBun(["build", entrypoint, "--compile", `--outfile=${output}`]);
}

function electronExecutableRelativePath(): string {
  if (process.platform === "darwin") return "Electron.app/Contents/MacOS/Electron";
  if (process.platform === "win32") return "electron.exe";
  if (process.platform === "linux") return "electron";
  throw new Error(`packaged payload build is unsupported on ${process.platform}`);
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
  const nativeEngine = join(outputPath, "native-engine", "codex");
  if (existsSync(nativeEngine)) {
    sign(nativeEngine);
    sign(join(outputPath, "native-engine", "codex-code-mode-host"));
  }
  sign(join(outputPath, "electron", "Electron.app"), ["--deep"]);
}

async function main(): Promise<void> {
  const outputPath = resolve(requiredOption("--output"));
  const productVersion = requiredOption("--version");
  const macApp = process.platform === "darwin";
  if (macApp && !outputPath.endsWith(".app")) throw Error("macOS package builds require a .app output");
  const appOptions = macApp ? { buildVersion: requiredOption("--build-number"), feedURL: requiredOption("--update-feed-url"), publicKey: requiredOption("--update-public-key") } : undefined;
  const macCodesignIdentity = macApp ? option("--mac-codesign-identity") ?? "-" : undefined;
  const workspaceFilesSourcePath = option("--workspace-files");
  const nativeEnginePath = option("--native-engine");
  const nativeEngineMetadataPath = option("--native-engine-metadata");
  if (Boolean(nativeEnginePath) !== Boolean(nativeEngineMetadataPath)) throw new Error("Native engine requires both --native-engine and --native-engine-metadata");
  const nativeEngineMetadata = nativeEngineMetadataPath
    ? parsePackagedNativeEngine(JSON.parse(readFileSync(realRegularFile(nativeEngineMetadataPath, "Native engine metadata"), "utf8")))
    : undefined;

  const electronBundle = resolve(repoRoot, "node_modules", "electron", "dist");
  if (!existsSync(electronBundle) || !lstatSync(electronBundle).isDirectory() || lstatSync(electronBundle).isSymbolicLink()) {
    throw new Error("Electron distribution is missing; run the official electron/install.js postinstall before package build");
  }

  const temporary = mkdtempSync(join(tmpdir(), "chatgpt-tela-package-build-"));
  try {
    const executableExtension = process.platform === "win32" ? ".exe" : "";
    const launcher = join(temporary, `chatgpt-tela${executableExtension}`);
    const profileRuntime = join(temporary, "profile-runtime.cjs");
    const profileSetup = join(temporary, "profile-setup.cjs");
    const menuBar = process.platform === "darwin" ? join(temporary, "chatgpt-tela-menu-bar") : undefined;

    compileExecutable("apps/packaged-launcher/src/entrypoint.ts", launcher);
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
    if (nativeEngineMetadata) {
      for (const name of ["Codex-LICENSE.txt", "Codex-NOTICE.txt"]) copyFileSync(join(repoRoot, "release/licenses", name), join(notices, name));
      writeFileSync(join(notices, "Codex-build.txt"), `This is a modified OpenAI Codex build included by ChatGPT Tela.\nVersion: ${nativeEngineMetadata.version}\nUpstream commit: ${nativeEngineMetadata.upstreamCommit}\nTela patch SHA-256: ${nativeEngineMetadata.patchSha256}\nCapabilities: ${nativeEngineMetadata.capabilities.join(", ")}\nUpstream: https://github.com/openai/codex\n`);
    }
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
        electronExecutableRelativePath: electronExecutableRelativePath(),
        entrypointSourcePath: profileRuntime,
        setupEntrypointSourcePath: profileSetup,
      },
      ...(menuBar ? { menuBarSourcePath: menuBar, menuBarFrameworkSourcePath: join(temporary, "Sparkle.framework"), maintenanceUISourcePath: join(temporary, "chatgpt-tela-maintenance") } : {}),
      ...(workspaceFilesSourcePath ? { workspaceFilesSourcePath } : {}),
      ...(nativeEngineMetadata && nativeEnginePath ? { nativeEngine: {
        ...nativeEngineMetadata,
        executableSourcePath: realRegularFile(nativeEnginePath, "Native engine executable"),
      } } : {}),
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
      nativeEngine: built.manifest.nativeEngine,
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
