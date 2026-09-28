import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPackagedPayload,
  createEd25519PackagedPayloadSigner,
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

function macCodesign(outputPath: string, identity: string): void {
  const sign = (path: string, deep = false) => {
    execFileSync("/usr/bin/codesign", ["--force", ...(deep ? ["--deep"] : []), "--sign", identity, path], {
      stdio: "inherit",
    });
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", ...(deep ? ["--deep"] : []), "--verbose=2", path], {
      stdio: "inherit",
    });
  };
  sign(join(outputPath, "chatgpt-tela"));
  for (const service of ["gateway", "chat", "codex"] as const) sign(join(outputPath, "services", service));
  const menuBar = join(outputPath, "ui", "chatgpt-tela-menu-bar");
  if (existsSync(menuBar)) sign(menuBar);
  sign(join(outputPath, "electron", "Electron.app"), true);
}

async function main(): Promise<void> {
  const outputPath = resolve(requiredOption("--output"));
  const productVersion = requiredOption("--version");
  const signingKeyPath = realRegularFile(requiredOption("--signing-key"), "signing key");
  const keyId = requiredOption("--key-id");
  const privateKey = readFileSync(signingKeyPath);
  const macCodesignIdentity = process.platform === "darwin" ? requiredOption("--mac-codesign-identity") : undefined;

  const electronBundle = resolve(repoRoot, "node_modules", "electron", "dist");
  if (!existsSync(electronBundle) || !lstatSync(electronBundle).isDirectory() || lstatSync(electronBundle).isSymbolicLink()) {
    throw new Error("Electron distribution is missing; run the official electron/install.js postinstall before package build");
  }

  const temporary = mkdtempSync(join(tmpdir(), "chatgpt-tela-package-build-"));
  try {
    const executableExtension = process.platform === "win32" ? ".exe" : "";
    const launcher = join(temporary, `chatgpt-tela${executableExtension}`);
    const gateway = join(temporary, `gateway${executableExtension}`);
    const chat = join(temporary, `chat${executableExtension}`);
    const codex = join(temporary, `codex${executableExtension}`);
    const profileRuntime = join(temporary, "profile-runtime.cjs");
    const menuBar = process.platform === "darwin" ? join(temporary, "chatgpt-tela-menu-bar") : undefined;

    compileExecutable("apps/packaged-launcher/src/main.ts", launcher);
    compileExecutable("apps/gateway-daemon/src/main.ts", gateway);
    compileExecutable("apps/chat-daemon/src/main.ts", chat);
    compileExecutable("apps/codex-daemon/src/main.ts", codex);
    runBun(["build", "apps/profile-runtime/src/main.ts", "--target=node", "--format=cjs", "--external", "electron",
      `--outfile=${profileRuntime}`]);
    if (menuBar) {
      execFileSync("/usr/bin/xcrun", [
        "swiftc",
        "-parse-as-library",
        resolve(repoRoot, "apps/menu-bar-macos/main.swift"),
        resolve(repoRoot, "apps/menu-bar-macos/control-center.swift"),
        "-framework", "AppKit",
        "-o", menuBar,
      ], { cwd: repoRoot, stdio: "inherit" });
    }

    const built = buildPackagedPayload({
      outputPath,
      productVersion,
      launcherSourcePath: launcher,
      services: {
        gateway: { executableSourcePath: gateway },
        chat: { executableSourcePath: chat },
        codex: { executableSourcePath: codex },
      },
      profileRuntime: {
        electronBundleSourcePath: electronBundle,
        electronExecutableRelativePath: electronExecutableRelativePath(),
        entrypointSourcePath: profileRuntime,
      },
      ...(menuBar ? { menuBarSourcePath: menuBar } : {}),
      signer: createEd25519PackagedPayloadSigner({ keyId, privateKey }),
      ...(macCodesignIdentity
        ? { finalizeStagedPayload: ({ outputPath: staged }) => macCodesign(staged, macCodesignIdentity) }
        : {}),
    });

    console.log(JSON.stringify({
      outputPath: built.outputPath,
      productVersion: built.manifest.productVersion,
      payloadFingerprint: built.payloadFingerprint,
      signingKeyId: built.signature.keyId,
      services: built.manifest.services,
      launcher: built.manifest.launcher,
      profileRuntime: built.manifest.profileRuntime,
      menuBar: built.manifest.menuBar,
    }, null, 2));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
