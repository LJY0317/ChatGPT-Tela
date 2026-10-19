import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { readOwnershipManifest } from "./ownership";
import { resolveProductPaths, type ProductPathOptions } from "./layout";
import { observeInstalledPackagedPayload } from "./packaged-payload";
import { PACKAGED_PRODUCT_MANIFEST, readPackagedProductManifest, type PackagedNativeEngine } from "./packaged-manifest";

/** Upstream Codex's install-context resolves this helper beside its executable. */
export function nativeEngineHelperName(platform: NodeJS.Platform): string {
  return `codex-code-mode-host${platform === "win32" ? ".exe" : ""}`;
}

/** Bounded memory; called only during staging/startup, never periodically. */
export function nativeEngineFileSha256(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Native engine must be a real regular file");
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let size: number;
    while ((size = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, size));
    return hash.digest("hex");
  } finally { closeSync(fd); }
}

export function verifyNativeEngineArtifact(input: {
  readonly payloadRoot: string;
  readonly engine: PackagedNativeEngine;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly readVersion?: (executable: string) => string;
}): { readonly executable: string; readonly sha256: string; readonly localCompaction: true; readonly catalogRefresh?: true; readonly catalogSeed?: true } {
  if (input.engine.platform !== (input.platform ?? process.platform)
    || input.engine.architecture !== (input.architecture ?? process.arch)) throw new Error("Native engine platform/architecture mismatch");
  const root = realpathSync(input.payloadRoot);
  const path = join(root, ...input.engine.executable.split("/"));
  const canonical = realpathSync(path);
  const rel = relative(root, canonical);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Native engine escapes its payload");
  if (nativeEngineFileSha256(path) !== input.engine.sha256) throw new Error("Native engine hash mismatch");
  const helper = join(dirname(path), nativeEngineHelperName(input.engine.platform));
  if (!existsSync(helper)) throw new Error("Native engine helper is missing");
  const helperStat = lstatSync(helper);
  if (!helperStat.isFile() || helperStat.isSymbolicLink()) throw new Error("Native engine helper must be a real regular file");
  const helperRelative = relative(root, realpathSync(helper));
  if (!helperRelative || helperRelative.startsWith("..") || isAbsolute(helperRelative)) throw new Error("Native engine helper escapes its payload");
  if (input.engine.platform !== "win32" && !(helperStat.mode & 0o111)) throw new Error("Native engine helper must be executable");
  const version = (input.readVersion ?? (executable => execFileSync(executable, ["--version"], {
    encoding: "utf8", timeout: 5000, maxBuffer: 8192, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  })))(canonical).trim();
  if (version !== `codex-cli ${input.engine.version}`) throw new Error("Native engine version mismatch");
  return Object.freeze({ executable: canonical, sha256: input.engine.sha256, localCompaction: true as const,
    ...(input.engine.capabilities[1] === "model-catalog-refresh-v1" ? { catalogRefresh: true as const } : {}),
    ...(input.engine.capabilities[2] === "model-catalog-seed-v1" ? { catalogSeed: true as const } : {}),
  });
}

/** Selection comes from an installed, signed payload receipt, never a capability environment flag. */
export function resolveOwnedNativeEngine(pathOptions?: ProductPathOptions, options: {
  readonly readVersion?: (executable: string) => string;
} = {}): ReturnType<typeof verifyNativeEngineArtifact> | undefined {
  const paths = resolveProductPaths(pathOptions);
  const ownership = readOwnershipManifest(paths.installManifest);
  if (!ownership) return undefined;
  const resources = ownership.resources.filter(resource => resource.kind === "directory"
    && resource.id === "product-binaries" && resource.dataClass === "binary");
  if (resources.length === 0) return undefined;
  if (resources.length !== 1 || resources[0]!.kind !== "directory") throw new Error("Native engine binary ownership is ambiguous");
  const resource = resources[0]!;
  if (!existsSync(join(resource.path, PACKAGED_PRODUCT_MANIFEST))) return undefined;
  const manifest = readPackagedProductManifest(resource.path);
  if (!manifest.nativeEngine) return undefined;
  const observed = observeInstalledPackagedPayload(resource, ownership);
  if (observed.state !== "owned" || observed.receipt.productVersion !== manifest.productVersion
    || ownership.productVersion !== manifest.productVersion) throw new Error("Native engine installed receipt could not be re-proven");
  return verifyNativeEngineArtifact({ payloadRoot: resource.path, engine: manifest.nativeEngine, ...options });
}
