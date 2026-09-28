import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { TelaServiceId } from "./layout";

export const OWNERSHIP_MARKER = ".chatgpt-tela-owner.json";

export type DirectoryDataClass =
  | "binary"
  | "config"
  | "state"
  | "cache"
  | "logs"
  | "runtime"
  | "browser-profile";

export type ServiceRegistrationPlatform = "darwin" | "win32" | "linux";
export type CredentialStoreKind = "macos-keychain" | "windows-dpapi" | "linux-secret-service";

export interface ServiceRegistrationIdentity {
  readonly platform: ServiceRegistrationPlatform;
  readonly markerPath: string;
  readonly definitionFingerprint: string;
  readonly definitionPath?: string;
}

export type OwnedResource =
  | {
      readonly kind: "directory";
      readonly id: string;
      readonly owner: "product" | TelaServiceId;
      readonly path: string;
      readonly dataClass: DirectoryDataClass;
    }
  | {
      readonly kind: "service-registration";
      readonly id: string;
      readonly owner: TelaServiceId;
      readonly registrationId: string;
      readonly identity?: ServiceRegistrationIdentity;
    }
  | {
      readonly kind: "tailscale-route";
      readonly id: string;
      readonly owner: "gateway";
      readonly host: string;
      readonly httpsPort: number;
      readonly publicPath: string;
      readonly localTarget: string;
      readonly leaseFingerprint: string;
    }
  | {
      readonly kind: "managed-worktree";
      readonly id: string;
      readonly owner: "chat";
      readonly path: string;
      readonly repositoryIdentity: string;
    }
  | {
      readonly kind: "credential";
      readonly id: string;
      readonly owner: "chat";
      readonly credentialId: string;
      readonly storeKind: CredentialStoreKind;
      readonly storeKey: string;
    };

export interface OwnershipManifest {
  readonly version: 1;
  readonly installId: string;
  readonly productVersion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resources: readonly OwnedResource[];
}

interface OwnershipMarker {
  readonly version: 1;
  readonly installId: string;
  readonly resourceId: string;
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000\r\n]/.test(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function absolutePath(value: unknown, field: string): string {
  const path = nonEmpty(value, field);
  if (!isAbsolute(path)) throw new Error(`${field} must be absolute`);
  return path;
}

export function parseOwnedResource(value: unknown): OwnedResource {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ownership resource must be an object");
  const item = value as Record<string, unknown>;
  const id = nonEmpty(item.id, "ownership resource id");
  const kind = item.kind;
  const owner = item.owner;
  if (kind === "directory") {
    if (!(["product", "gateway", "chat", "codex"] as const).includes(owner as never)) {
      throw new Error("directory ownership owner is invalid");
    }
    const dataClass = item.dataClass;
    if (!(["binary", "config", "state", "cache", "logs", "runtime", "browser-profile"] as const)
      .includes(dataClass as never)) throw new Error("directory data class is invalid");
    return Object.freeze({ kind, id, owner: owner as "product" | TelaServiceId,
      path: absolutePath(item.path, "owned directory path"), dataClass: dataClass as DirectoryDataClass });
  }
  if (kind === "service-registration") {
    if (!(["gateway", "chat", "codex"] as const).includes(owner as never)) throw new Error("service owner is invalid");
    let identity: ServiceRegistrationIdentity | undefined;
    if (item.identity !== undefined) {
      if (!item.identity || typeof item.identity !== "object" || Array.isArray(item.identity)) {
        throw new Error("service registration identity must be an object");
      }
      const value = item.identity as Record<string, unknown>;
      const platform = value.platform;
      if (!(platform === "darwin" || platform === "win32" || platform === "linux")) {
        throw new Error("service registration platform is invalid");
      }
      const fingerprint = nonEmpty(value.definitionFingerprint, "service registration definition fingerprint");
      if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("service registration definition fingerprint is invalid");
      const definitionPath = value.definitionPath === undefined
        ? undefined
        : absolutePath(value.definitionPath, "service registration definition path");
      if (platform === "win32" && definitionPath !== undefined) {
        throw new Error("Windows scheduled-task registration identity must not contain a definition path");
      }
      if (platform !== "win32" && definitionPath === undefined) {
        throw new Error(`${platform} service registration identity requires a definition path`);
      }
      identity = Object.freeze({
        platform,
        markerPath: absolutePath(value.markerPath, "service registration marker path"),
        definitionFingerprint: fingerprint,
        ...(definitionPath ? { definitionPath } : {}),
      });
    }
    return Object.freeze({ kind, id, owner: owner as TelaServiceId,
      registrationId: nonEmpty(item.registrationId, "service registration id"),
      ...(identity ? { identity } : {}) });
  }
  if (kind === "tailscale-route") {
    if (owner !== "gateway") throw new Error("Tailscale route must be gateway-owned");
    const host = nonEmpty(item.host, "Tailscale host");
    if (!/^[A-Za-z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".")) {
      throw new Error("Tailscale host is invalid");
    }
    if (!Number.isSafeInteger(item.httpsPort) || ![443, 8443, 10000].includes(item.httpsPort as number)) {
      throw new Error("Tailscale HTTPS port is invalid");
    }
    const publicPath = nonEmpty(item.publicPath, "Tailscale public path");
    if (!publicPath.startsWith("/")) throw new Error("Tailscale public path must be absolute");
    const localTarget = new URL(nonEmpty(item.localTarget, "Tailscale local target"));
    if (localTarget.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(localTarget.hostname)) {
      throw new Error("Tailscale local target must be loopback http://");
    }
    const leaseFingerprint = nonEmpty(item.leaseFingerprint, "Tailscale lease fingerprint");
    if (!/^[a-f0-9]{64}$/.test(leaseFingerprint)) throw new Error("Tailscale lease fingerprint is invalid");
    return Object.freeze({ kind, id, owner: "gateway", host, httpsPort: item.httpsPort as number,
      publicPath, localTarget: localTarget.href, leaseFingerprint });
  }
  if (kind === "managed-worktree") {
    if (owner !== "chat") throw new Error("managed worktree must be Chat-owned");
    return Object.freeze({ kind, id, owner: "chat", path: absolutePath(item.path, "managed worktree path"),
      repositoryIdentity: nonEmpty(item.repositoryIdentity, "managed worktree repository identity") });
  }
  if (kind === "credential") {
    if (owner !== "chat") throw new Error("credential resource must be Chat-owned");
    const credentialId = nonEmpty(item.credentialId, "credential id");
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(credentialId)) throw new Error("credential id is invalid");
    const storeKind = item.storeKind;
    if (!(storeKind === "macos-keychain" || storeKind === "windows-dpapi" || storeKind === "linux-secret-service")) {
      throw new Error("credential store kind is invalid");
    }
    const storeKey = nonEmpty(item.storeKey, "credential store key");
    if (!/^tela\.[a-f0-9]{48}$/.test(storeKey)) throw new Error("credential store key is invalid");
    return Object.freeze({ kind, id, owner: "chat", credentialId, storeKind, storeKey });
  }
  throw new Error("unknown ownership resource kind");
}

export function parseOwnershipManifest(value: unknown): OwnershipManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ownership manifest must be an object");
  const item = value as Record<string, unknown>;
  if (item.version !== 1) throw new Error("unsupported ownership manifest version");
  const resources = item.resources;
  if (!Array.isArray(resources)) throw new Error("ownership manifest resources must be an array");
  const parsed = resources.map(parseOwnedResource);
  const ids = new Set<string>();
  for (const resource of parsed) {
    if (ids.has(resource.id)) throw new Error(`duplicate ownership resource id: ${resource.id}`);
    ids.add(resource.id);
  }
  return Object.freeze({
    version: 1,
    installId: nonEmpty(item.installId, "install id"),
    productVersion: nonEmpty(item.productVersion, "product version"),
    createdAt: nonEmpty(item.createdAt, "manifest createdAt"),
    updatedAt: nonEmpty(item.updatedAt, "manifest updatedAt"),
    resources: Object.freeze(parsed),
  });
}

export function createOwnershipManifest(
  productVersion: string,
  now = new Date(),
  installId: string = randomUUID(),
): OwnershipManifest {
  const timestamp = now.toISOString();
  return Object.freeze({ version: 1, installId: nonEmpty(installId, "install id"), productVersion: nonEmpty(productVersion, "product version"),
    createdAt: timestamp, updatedAt: timestamp, resources: Object.freeze([]) });
}

export function withOwnedResource(
  manifest: OwnershipManifest,
  resource: OwnedResource,
  now = new Date(),
): OwnershipManifest {
  const normalized = parseOwnedResource(resource);
  if (manifest.resources.some(existing => existing.id === normalized.id)) {
    throw new Error(`ownership resource already exists: ${normalized.id}`);
  }
  return Object.freeze({ ...manifest, updatedAt: now.toISOString(),
    resources: Object.freeze([...manifest.resources, normalized]) });
}

export function withoutOwnedResource(
  manifest: OwnershipManifest,
  resourceId: string,
  now = new Date(),
): OwnershipManifest {
  const id = nonEmpty(resourceId, "ownership resource id");
  if (!manifest.resources.some(resource => resource.id === id)) return manifest;
  return Object.freeze({
    ...manifest,
    updatedAt: now.toISOString(),
    resources: Object.freeze(manifest.resources.filter(resource => resource.id !== id)),
  });
}

export function readOwnershipManifest(path: string): OwnershipManifest | undefined {
  if (!existsSync(path)) return undefined;
  return parseOwnershipManifest(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export function writeOwnershipManifest(path: string, manifest: OwnershipManifest): void {
  const normalized = parseOwnershipManifest(manifest);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600, encoding: "utf8" });
  try { chmodSync(temporary, 0o600); } catch { /* Windows ACLs own permissions there. */ }
  renameSync(temporary, path);
}

export function writeOwnershipMarker(path: string, manifest: OwnershipManifest, resourceId: string): void {
  if (!manifest.resources.some(resource => resource.kind === "directory" && resource.id === resourceId && resource.path === path)) {
    throw new Error("directory is not recorded in this ownership manifest");
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("owned directory path is unsafe or replaced");
  const marker: OwnershipMarker = { version: 1, installId: manifest.installId, resourceId };
  writeFileSync(join(path, OWNERSHIP_MARKER), `${JSON.stringify(marker)}\n`, { mode: 0o600, encoding: "utf8" });
}

export function readOwnershipMarker(path: string): OwnershipMarker | undefined {
  const markerPath = join(path, OWNERSHIP_MARKER);
  if (!existsSync(markerPath)) return undefined;
  const value = JSON.parse(readFileSync(markerPath, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ownership marker is invalid");
  const item = value as Record<string, unknown>;
  if (item.version !== 1) throw new Error("unsupported ownership marker version");
  return Object.freeze({ version: 1, installId: nonEmpty(item.installId, "marker install id"),
    resourceId: nonEmpty(item.resourceId, "marker resource id") });
}
