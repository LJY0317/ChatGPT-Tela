import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PackagedProductInstallSpec, PackagedServiceLaunchSpec } from "./packaged-install";
import type { TelaServiceId } from "./layout";

export const PACKAGED_PRODUCT_MANIFEST = "chatgpt-tela-package-v1.json";

export interface PackagedProductManifestService {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
}

export interface PackagedProductManifestLauncher {
  readonly executable: string;
}

export interface PackagedProductManifestProfileRuntime {
  readonly executable: string;
  readonly entrypoint: string;
}

export interface PackagedProductManifestMenuBar {
  readonly executable: string;
}

export interface PackagedProductManifestIntegrity {
  readonly signature: "ed25519-sha256-tree-v1";
  readonly keyId: string;
}

export interface PackagedProductManifest {
  readonly version: 1;
  readonly product: "chatgpt-tela";
  readonly productVersion: string;
  readonly launcher?: PackagedProductManifestLauncher;
  readonly profileRuntime?: PackagedProductManifestProfileRuntime;
  readonly menuBar?: PackagedProductManifestMenuBar;
  readonly integrity?: PackagedProductManifestIntegrity;
  readonly services: Readonly<Record<TelaServiceId, PackagedProductManifestService>>;
}

function oneLine(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000\r\n]/.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function relativePayloadPath(value: unknown, field: string): string {
  const path = oneLine(value, field);
  if (path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)) {
    throw new Error(`${field} must be a portable relative payload path`);
  }
  const segments = path.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === "..")) {
    throw new Error(`${field} contains unsafe path segments`);
  }
  return path;
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return Object.freeze(value.map((item, index) => oneLine(item, `${field}[${index}]`)));
}

function environment(value: unknown, field: string): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`${field} key is invalid: ${key}`);
    result[key] = oneLine(raw, `${field}.${key}`);
  }
  return Object.freeze(result);
}

function service(value: unknown, field: string): PackagedProductManifestService {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const item = value as Record<string, unknown>;
  const extra = Object.keys(item).filter(key => !["executable", "arguments", "environment"].includes(key));
  if (extra.length > 0) throw new Error(`${field} contains unknown fields: ${extra.join(", ")}`);
  const env = environment(item.environment, `${field}.environment`);
  return Object.freeze({
    executable: relativePayloadPath(item.executable, `${field}.executable`),
    arguments: stringArray(item.arguments ?? [], `${field}.arguments`),
    ...(env ? { environment: env } : {}),
  });
}

function launcher(value: unknown): PackagedProductManifestLauncher | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("packaged launcher must be an object");
  const item = value as Record<string, unknown>;
  const extra = Object.keys(item).filter(key => key !== "executable");
  if (extra.length > 0) throw new Error(`packaged launcher contains unknown fields: ${extra.join(", ")}`);
  const executable = relativePayloadPath(item.executable, "packaged launcher executable");
  if (executable.includes("/")) throw new Error("packaged launcher executable must live at the payload root");
  return Object.freeze({ executable });
}

function profileRuntime(value: unknown): PackagedProductManifestProfileRuntime | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("packaged profile runtime must be an object");
  const item = value as Record<string, unknown>;
  const extra = Object.keys(item).filter(key => !["executable", "entrypoint"].includes(key));
  if (extra.length > 0) throw new Error(`packaged profile runtime contains unknown fields: ${extra.join(", ")}`);
  return Object.freeze({
    executable: relativePayloadPath(item.executable, "packaged profile runtime executable"),
    entrypoint: relativePayloadPath(item.entrypoint, "packaged profile runtime entrypoint"),
  });
}

function menuBar(value: unknown): PackagedProductManifestMenuBar | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("packaged menu bar must be an object");
  const item = value as Record<string, unknown>;
  const extra = Object.keys(item).filter(key => key !== "executable");
  if (extra.length > 0) throw new Error(`packaged menu bar contains unknown fields: ${extra.join(", ")}`);
  return Object.freeze({ executable: relativePayloadPath(item.executable, "packaged menu bar executable") });
}

function integrity(value: unknown): PackagedProductManifestIntegrity | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("packaged integrity must be an object");
  const item = value as Record<string, unknown>;
  const extra = Object.keys(item).filter(key => !["signature", "keyId"].includes(key));
  if (extra.length > 0) throw new Error(`packaged integrity contains unknown fields: ${extra.join(", ")}`);
  if (item.signature !== "ed25519-sha256-tree-v1") throw new Error("packaged integrity signature algorithm is unsupported");
  return Object.freeze({ signature: "ed25519-sha256-tree-v1", keyId: oneLine(item.keyId, "packaged integrity key id") });
}

export function parsePackagedProductManifest(value: unknown): PackagedProductManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("packaged product manifest must be an object");
  const item = value as Record<string, unknown>;
  const extra = Object.keys(item).filter(key => !["version", "product", "productVersion", "launcher", "profileRuntime", "menuBar", "integrity", "services"].includes(key));
  if (extra.length > 0) throw new Error(`packaged product manifest contains unknown fields: ${extra.join(", ")}`);
  if (item.version !== 1 || item.product !== "chatgpt-tela") throw new Error("packaged product manifest identity is unsupported");
  if (!item.services || typeof item.services !== "object" || Array.isArray(item.services)) {
    throw new Error("packaged product manifest services must be an object");
  }
  const services = item.services as Record<string, unknown>;
  const serviceKeys = Object.keys(services).sort();
  if (JSON.stringify(serviceKeys) !== JSON.stringify(["chat", "codex", "gateway"])) {
    throw new Error("packaged product manifest must define exactly gateway, chat, and codex services");
  }
  const parsedLauncher = launcher(item.launcher);
  const parsedRuntime = profileRuntime(item.profileRuntime);
  const parsedMenuBar = menuBar(item.menuBar);
  const parsedIntegrity = integrity(item.integrity);
  if ((parsedLauncher || parsedRuntime || parsedIntegrity) && !(parsedLauncher && parsedRuntime && parsedIntegrity)) {
    throw new Error("packaged launcher, profile runtime, and integrity must be declared together");
  }
  return Object.freeze({
    version: 1,
    product: "chatgpt-tela",
    productVersion: oneLine(item.productVersion, "packaged product version"),
    ...(parsedLauncher ? { launcher: parsedLauncher } : {}),
    ...(parsedRuntime ? { profileRuntime: parsedRuntime } : {}),
    ...(parsedMenuBar ? { menuBar: parsedMenuBar } : {}),
    ...(parsedIntegrity ? { integrity: parsedIntegrity } : {}),
    services: Object.freeze({
      gateway: service(services.gateway, "packaged gateway service"),
      chat: service(services.chat, "packaged chat service"),
      codex: service(services.codex, "packaged codex service"),
    }),
  });
}

export function readPackagedProductManifest(payloadSourcePath: string): PackagedProductManifest {
  const path = join(payloadSourcePath, PACKAGED_PRODUCT_MANIFEST);
  if (!existsSync(path)) throw new Error(`packaged product manifest is missing: ${path}`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("packaged product manifest path is unsafe or replaced");
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")) as unknown; }
  catch (error) { throw new Error("packaged product manifest is invalid JSON", { cause: error }); }
  return parsePackagedProductManifest(value);
}

export function packagedInstallSpecFromPayload(payloadSourcePath: string): PackagedProductInstallSpec {
  const manifest = readPackagedProductManifest(payloadSourcePath);
  const services: PackagedServiceLaunchSpec[] = (["gateway", "chat", "codex"] as const).map(serviceId => {
    const entry = manifest.services[serviceId];
    if (manifest.launcher) {
      return Object.freeze({
        service: serviceId,
        executableRelativePath: manifest.launcher.executable,
        arguments: Object.freeze(["service", serviceId]),
      });
    }
    return Object.freeze({
      service: serviceId,
      executableRelativePath: entry.executable,
      arguments: entry.arguments,
      ...(entry.environment ? { environment: entry.environment } : {}),
    });
  });
  return Object.freeze({
    productVersion: manifest.productVersion,
    payloadSourcePath,
    ...(manifest.menuBar ? {
      menuBar: manifest.launcher
        ? { executableRelativePath: manifest.launcher.executable, arguments: Object.freeze(["menu-bar"]) }
        : { executableRelativePath: manifest.menuBar.executable },
    } : {}),
    services: Object.freeze(services),
  });
}
