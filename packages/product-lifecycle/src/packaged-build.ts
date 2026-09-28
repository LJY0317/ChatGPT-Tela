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
  type PackagedProductManifest,
  type PackagedProductManifestService,
} from "./packaged-manifest";
import { packagedPayloadFingerprint } from "./packaged-payload";
import {
  writePackagedPayloadSignature,
  type PackagedPayloadSignatureEnvelope,
  type PackagedPayloadSigner,
} from "./packaged-signature";
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
}

export interface PackagedPayloadBuildInput {
  readonly outputPath: string;
  readonly productVersion: string;
  readonly launcherSourcePath: string;
  readonly services: Readonly<Record<TelaServiceId, PackagedPayloadBuildServiceInput>>;
  readonly profileRuntime: PackagedPayloadBuildProfileRuntimeInput;
  readonly signer: PackagedPayloadSigner;
  readonly finalizeStagedPayload?: (input: {
    readonly outputPath: string;
    readonly manifest: PackagedProductManifest;
  }) => void;
}

export interface BuiltPackagedPayload {
  readonly outputPath: string;
  readonly manifest: PackagedProductManifest;
  readonly signature: PackagedPayloadSignatureEnvelope;
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

  const manifest = parsePackagedProductManifest({
    version: 1,
    product: "chatgpt-tela",
    productVersion: oneLine(input.productVersion, "product version"),
    launcher: { executable: launcherName },
    profileRuntime: {
      executable: `electron/${electronRelative}`,
      entrypoint: runtimeEntrypoint,
    },
    integrity: {
      signature: "ed25519-sha256-tree-v1",
      keyId: input.signer.keyId,
    },
    services: serviceManifest,
  });
  writeFileSync(join(outputPath, PACKAGED_PRODUCT_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  input.finalizeStagedPayload?.({ outputPath, manifest });
  const signature = writePackagedPayloadSignature({ payloadRoot: outputPath, signer: input.signer });
  return Object.freeze({
    outputPath,
    manifest,
    signature,
    payloadFingerprint: packagedPayloadFingerprint(outputPath),
  });
}
