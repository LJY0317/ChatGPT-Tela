import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  PACKAGED_PRODUCT_MANIFEST,
  parsePackagedProductManifest,
  parsePackagedNativeEngine,
  type PackagedProductManifest,
  type PackagedProductManifestService,
  type PackagedNativeEngine,
} from "./packaged-manifest";
import { nativeEngineFileSha256, nativeEngineHelperName, verifyNativeEngineArtifact } from "./native-engine";
import { packagedPayloadFingerprint } from "./packaged-payload";
import type { TelaServiceId } from "./layout";

export interface PackagedPayloadBuildServiceInput {
  readonly executableSourcePath: string;
  readonly arguments?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
}

export interface PackagedPayloadBuildProfileRuntimeInput {
  readonly electronBundleSourcePath: string;
  readonly electronExecutableRelativePath: string;
  readonly entrypointSourcePath: string;
  readonly setupEntrypointSourcePath?: string;
}

export interface PackagedPayloadBuildInput {
  readonly outputPath: string;
  readonly productVersion: string;
  readonly launcherSourcePath: string;
  readonly services: Readonly<Record<TelaServiceId, PackagedPayloadBuildServiceInput>>;
  readonly profileRuntime: PackagedPayloadBuildProfileRuntimeInput;
  readonly menuBarSourcePath?: string;
  readonly menuBarFrameworkSourcePath?: string;
  readonly menuBarLicenseSourcePath?: string;
  readonly maintenanceUISourcePath?: string;
  readonly workspaceFilesSourcePath?: string;
  readonly chatProcessStore?: PackagedProductManifest["chatProcessStore"];
  readonly lifecycle?: PackagedProductManifest["lifecycle"];
  readonly nativeEngine?: Omit<PackagedNativeEngine, "executable"> & { readonly executableSourcePath: string };
  readonly finalizeStagedPayload?: (input: {
    readonly outputPath: string;
    readonly manifest: PackagedProductManifest;
  }) => void;
}

export interface BuiltPackagedPayload {
  readonly outputPath: string;
  readonly manifest: PackagedProductManifest;
  readonly payloadFingerprint: string;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function portable(path: string): string {
  return path.split(sep).join("/");
}

function realRegularFile(path: string, field: string): string {
  if (!existsSync(path)) throw new Error(`${field} is missing: ${path}`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${field} must be a real regular file`);
  return realpathSync(path);
}

function oneLine(value: string, field: string): string {
  if (!value.trim() || /[\u0000\r\n]/.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function assertEmptyOutput(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return;
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("packaged payload output must be a real directory");
  if (readdirSync(path).length > 0) throw new Error("packaged payload output directory must be empty");
}

function copyFile(source: string, destination: string): void {
  const stat = lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`packaged artifact must be a regular file: ${source}`);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination);
  try { chmodSync(destination, stat.mode & 0o777); } catch { /* Windows ACLs own permissions there. */ }
}

function copyBundlePreservingInternalLinks(sourceRoot: string, destinationRoot: string): void {
  const canonicalRoot = realpathSync(sourceRoot);
  const rootStat = lstatSync(sourceRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("profile runtime bundle source must be a real directory");

  const copyEntry = (source: string, destination: string): void => {
    const stat = lstatSync(source);
    if (stat.isSymbolicLink()) {
      const rawTarget = readlinkSync(source);
      if (isAbsolute(rawTarget)) throw new Error(`profile runtime bundle symlink is absolute: ${portable(relative(sourceRoot, source))}`);
      const lexicalTarget = resolve(dirname(source), rawTarget);
      let canonicalTarget: string;
      try { canonicalTarget = realpathSync(source); }
      catch (error) { throw new Error(`profile runtime bundle symlink is broken or cyclic: ${portable(relative(sourceRoot, source))}`, { cause: error }); }
      if (!inside(canonicalRoot, canonicalTarget)) {
        throw new Error(`profile runtime bundle symlink escapes its source root: ${portable(relative(sourceRoot, source))}`);
      }
      if (!inside(resolve(sourceRoot), lexicalTarget)) {
        throw new Error(`profile runtime bundle symlink lexically escapes its source root: ${portable(relative(sourceRoot, source))}`);
      }
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      symlinkSync(rawTarget, destination);
      return;
    }
    copyResolved(source, destination);
  };

  const copyResolved = (source: string, destination: string): void => {
    const stat = lstatSync(source);
    if (stat.isDirectory()) {
      mkdirSync(destination, { recursive: false, mode: stat.mode & 0o777 || 0o700 });
      for (const entry of readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        copyEntry(join(source, entry.name), join(destination, entry.name));
      }
      try { chmodSync(destination, stat.mode & 0o777); } catch { /* Windows ACLs own permissions there. */ }
      return;
    }
    if (!stat.isFile()) throw new Error(`profile runtime bundle contains a non-regular entry: ${source}`);
    copyFile(source, destination);
  };

  mkdirSync(destinationRoot, { recursive: false, mode: rootStat.mode & 0o777 || 0o700 });
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    copyEntry(join(sourceRoot, entry.name), join(destinationRoot, entry.name));
  }
}

function serviceOutputName(service: TelaServiceId, source: string): string {
  return `${service}${extname(source).toLowerCase() === ".exe" ? ".exe" : ""}`;
}

function launcherOutputName(source: string): string {
  const ext = extname(source).toLowerCase() === ".exe" ? ".exe" : "";
  return `chatgpt-tela${ext}`;
}

export function buildPackagedPayload(input: PackagedPayloadBuildInput): BuiltPackagedPayload {
  const outputPath = resolve(input.outputPath);
  assertEmptyOutput(outputPath);

  const launcherSource = realRegularFile(input.launcherSourcePath, "packaged launcher source");
  const launcherName = launcherOutputName(launcherSource);
  copyFile(launcherSource, join(outputPath, launcherName));

  const serviceManifest: Record<TelaServiceId, PackagedProductManifestService> = {} as Record<TelaServiceId, PackagedProductManifestService>;
  for (const service of ["gateway", "chat", "codex"] as const) {
    const spec = input.services[service];
    const source = realRegularFile(spec.executableSourcePath, `packaged ${service} source`);
    const relativePath = `services/${serviceOutputName(service, source)}`;
    copyFile(source, join(outputPath, ...relativePath.split("/")));
    serviceManifest[service] = Object.freeze({
      executable: relativePath,
      arguments: Object.freeze([...(spec.arguments ?? [])].map(value => oneLine(value, `${service} argument`))),
      ...(spec.environment ? { environment: Object.freeze({ ...spec.environment }) } : {}),
    });
  }

  const runtimeSource = resolve(input.profileRuntime.electronBundleSourcePath);
  const runtimeDestination = join(outputPath, "electron");
  copyBundlePreservingInternalLinks(runtimeSource, runtimeDestination);
  const electronRelative = portable(input.profileRuntime.electronExecutableRelativePath);
  if (electronRelative.startsWith("/") || electronRelative.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("profile runtime Electron executable relative path is unsafe");
  }
  const installedElectron = join(runtimeDestination, ...electronRelative.split("/"));
  if (!existsSync(installedElectron) || !lstatSync(installedElectron).isFile() || lstatSync(installedElectron).isSymbolicLink()) {
    throw new Error("profile runtime Electron executable is missing after bundle staging");
  }
  const runtimeEntrypointSource = realRegularFile(input.profileRuntime.entrypointSourcePath, "profile runtime entrypoint source");
  const runtimeEntrypoint = "runtime/profile-runtime.cjs";
  copyFile(runtimeEntrypointSource, join(outputPath, ...runtimeEntrypoint.split("/")));
  const setupEntrypoint = input.profileRuntime.setupEntrypointSourcePath ? "runtime/profile-setup.cjs" : undefined;
  if (setupEntrypoint) {
    copyFile(realRegularFile(input.profileRuntime.setupEntrypointSourcePath!, "profile setup entrypoint source"),
      join(outputPath, ...setupEntrypoint.split("/")));
  }

  const menuBarRelative = input.menuBarSourcePath ? "ui/ChatGPT Tela.app/Contents/MacOS/chatgpt-tela-menu-bar" : undefined;
  if (input.menuBarSourcePath && menuBarRelative) {
    copyFile(realRegularFile(input.menuBarSourcePath, "packaged menu bar source"), join(outputPath, ...menuBarRelative.split("/")));
    if (input.menuBarFrameworkSourcePath) {
      const frameworks = join(outputPath, "ui/ChatGPT Tela.app/Contents/Frameworks");
      mkdirSync(frameworks, { recursive: true });
      copyBundlePreservingInternalLinks(input.menuBarFrameworkSourcePath, join(frameworks, "Sparkle.framework"));
    }
    if (input.menuBarLicenseSourcePath) copyFile(realRegularFile(input.menuBarLicenseSourcePath, "Sparkle license"),
      join(outputPath, "ui/ChatGPT Tela.app/Contents/Resources/ThirdPartyNotices/Sparkle.txt"));
    writeFileSync(join(outputPath, "ui/ChatGPT Tela.app/Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>chatgpt-tela-menu-bar</string>
<key>CFBundleIdentifier</key><string>com.openai.chatgpt-tela.menu-bar</string>
<key>CFBundleName</key><string>ChatGPT Tela</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>LSUIElement</key><true/>
</dict></plist>
`);
  }

  const maintenanceExecutable = input.maintenanceUISourcePath ? "ui/Tela Maintenance.app/Contents/MacOS/chatgpt-tela-maintenance" : undefined;
  if (maintenanceExecutable) {
    copyFile(realRegularFile(input.maintenanceUISourcePath!, "maintenance UI source"), join(outputPath, maintenanceExecutable));
    writeFileSync(join(outputPath, "ui/Tela Maintenance.app/Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>chatgpt-tela-maintenance</string>
<key>CFBundleIdentifier</key><string>com.openai.chatgpt-tela.maintenance</string>
<key>CFBundleName</key><string>Tela Maintenance</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string></dict></plist>\n`);
  }

  let nativeEngine: PackagedNativeEngine | undefined;
  if (input.nativeEngine) {
    const { executableSourcePath, ...metadata } = input.nativeEngine;
    const source = realRegularFile(executableSourcePath, "Native engine source");
    const executable = `native-engine/codex${metadata.platform === "win32" ? ".exe" : ""}`;
    const helperName = nativeEngineHelperName(metadata.platform);
    const helperSource = realRegularFile(join(dirname(source), helperName), "Native engine helper source");
    copyFile(source, join(outputPath, ...executable.split("/")));
    copyFile(helperSource, join(outputPath, "native-engine", helperName));
    nativeEngine = parsePackagedNativeEngine({ ...metadata, executable });
    verifyNativeEngineArtifact({ payloadRoot: outputPath, engine: nativeEngine });
  }

  let workspaceFiles: PackagedProductManifest["workspaceFiles"];
  if (input.workspaceFilesSourcePath) {
    const executable = `helpers/tela-workspace-files${process.platform === "win32" ? ".exe" : ""}`;
    copyFile(realRegularFile(input.workspaceFilesSourcePath, "file publisher source"), join(outputPath, ...executable.split("/")));
    workspaceFiles = { executable, protocolVersion: 2 };
  }

  let manifest = parsePackagedProductManifest({
    version: 1,
    product: "chatgpt-tela",
    productVersion: oneLine(input.productVersion, "product version"),
    launcher: { executable: launcherName },
    profileRuntime: {
      executable: `electron/${electronRelative}`,
      entrypoint: runtimeEntrypoint,
      ...(setupEntrypoint ? { setupEntrypoint } : {}),
    },
    ...(menuBarRelative ? { menuBar: { executable: menuBarRelative, ...(maintenanceExecutable ? { maintenanceExecutable } : {}) } } : {}),
    ...(nativeEngine ? { nativeEngine } : {}),
    ...(workspaceFiles ? { workspaceFiles } : {}),
    ...(input.chatProcessStore ? { chatProcessStore: input.chatProcessStore } : {}),
    ...(input.lifecycle ? { lifecycle: input.lifecycle } : {}),
    services: serviceManifest,
  });
  writeFileSync(join(outputPath, PACKAGED_PRODUCT_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  input.finalizeStagedPayload?.({ outputPath, manifest });
  // OS code signing may change executable bytes; compute the receipt fingerprint from the final artifact.
  if (manifest.nativeEngine) {
    manifest = parsePackagedProductManifest({ ...manifest, nativeEngine: {
      ...manifest.nativeEngine,
      sha256: nativeEngineFileSha256(join(outputPath, ...manifest.nativeEngine.executable.split("/"))),
    } });
    writeFileSync(join(outputPath, PACKAGED_PRODUCT_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    verifyNativeEngineArtifact({ payloadRoot: outputPath, engine: manifest.nativeEngine! });
  }
  return Object.freeze({
    outputPath,
    manifest,
    payloadFingerprint: packagedPayloadFingerprint(outputPath),
  });
}
