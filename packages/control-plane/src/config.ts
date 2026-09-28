import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveChatGptTelaBrowserProfile } from "@chatgpt-tela/development-runtime";
import {
  parseProductConfig,
  type ExistingHttpsProductExposureConfig,
  type ProductConfig,
  type ProductExposureConfig,
  type ProductMultiProfileConfig,
  type ProductPublicMcpAbi,
  type TailscaleFunnelProductExposureConfig,
} from "@chatgpt-tela/product-config";

export type {
  ExistingHttpsProductExposureConfig,
  ProductExposureConfig,
  ProductMultiProfileConfig,
  ProductPublicMcpAbi,
  TailscaleFunnelProductExposureConfig,
};

export type ProductControlConfig = ProductConfig;

export interface ProductControlPaths {
  readonly root: string;
  readonly config: string;
  readonly daemonState: string;
  readonly logs: string;
}

export interface ProductDaemonState {
  readonly version: 1;
  readonly pid: number;
  readonly controlUrl: string;
  readonly controlToken: string;
}

export function resolveProductControlPaths(input: {
  readonly profileRoot?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
} = {}): ProductControlPaths {
  const profile = resolveChatGptTelaBrowserProfile({
    slot: 1,
    ...(input.profileRoot ? { profileRoot: input.profileRoot } : {}),
    ...(input.environment ? { environment: input.environment } : {}),
  });
  const root = join(profile.profileRoot, "control-plane");
  return Object.freeze({
    root,
    config: join(root, "config.json"),
    daemonState: join(root, "daemon.json"),
    logs: join(root, "logs"),
  });
}

export function parseProductControlConfig(value: unknown): ProductControlConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("product control config must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) throw new Error("unsupported product control config version");
  const allowed = new Set(["version", "multiProfile", "publicMcpAbi", "exposure", "nativeTarget", "launcherCli"]);
  const extras = Object.keys(record).filter(key => !allowed.has(key));
  if (extras.length > 0) throw new Error(`legacy product control config contains unknown fields: ${extras.join(", ")}`);
  if (record.multiProfile !== undefined && (record.nativeTarget !== undefined || record.launcherCli !== undefined)) {
    throw new Error("legacy and canonical multi-profile config cannot be mixed");
  }
  let multiProfile: unknown = record.multiProfile;
  if (record.multiProfile !== undefined) {
    multiProfile = record.multiProfile;
  } else if (record.nativeTarget !== undefined) {
    // Compatibility for the short-lived v1 selector shape used while default Desktop support was landing.
    if (!record.nativeTarget || typeof record.nativeTarget !== "object" || Array.isArray(record.nativeTarget)) {
      throw new Error("legacy product native target config is invalid");
    }
    const target = record.nativeTarget as Record<string, unknown>;
    if (target.kind === "multi-profile") {
      const targetExtras = Object.keys(target).filter(key => key !== "kind" && key !== "launcherCli");
      if (targetExtras.length > 0) throw new Error(`legacy product native target contains unknown fields: ${targetExtras.join(", ")}`);
      multiProfile = { launcherCli: target.launcherCli };
    } else if (target.kind !== "default-desktop") {
      throw new Error("legacy product native target kind is invalid");
    } else if (Object.keys(target).some(key => key !== "kind")) {
      throw new Error("legacy default Desktop target contains unknown fields");
    }
  } else if (record.launcherCli !== undefined) {
    // Original version-1 compatibility: Multi-Profile used to be mandatory and lived at the top level.
    multiProfile = { launcherCli: record.launcherCli };
  }
  return parseProductConfig({
    version: 1,
    ...(multiProfile ? { multiProfile } : {}),
    publicMcpAbi: record.publicMcpAbi,
    exposure: record.exposure,
  });
}

export function readProductControlConfig(paths = resolveProductControlPaths()): ProductControlConfig {
  if (!existsSync(paths.config)) {
    throw new Error(`ChatGPT Tela control plane is not configured: ${paths.config}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(paths.config, "utf8"));
  } catch (error) {
    throw new Error("ChatGPT Tela control-plane config is unreadable", { cause: error });
  }
  return parseProductControlConfig(value);
}

export function writeProductControlConfig(
  config: ProductControlConfig,
  paths = resolveProductControlPaths(),
): void {
  const normalized = parseProductControlConfig(config);
  mkdirSync(dirname(paths.config), { recursive: true, mode: 0o700 });
  const temporary = `${paths.config}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(temporary, 0o600); } catch { /* Windows ACLs own permissions there. */ }
  renameSync(temporary, paths.config);
}

export function removeProductDaemonState(paths = resolveProductControlPaths()): void {
  rmSync(paths.daemonState, { force: true });
}

export function parseProductDaemonState(value: unknown): ProductDaemonState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("product daemon state must be a JSON object");
  }
  const item = value as Record<string, unknown>;
  if (item.version !== 1) throw new Error("unsupported product daemon state version");
  if (!Number.isSafeInteger(item.pid) || (item.pid as number) < 1) throw new Error("product daemon pid is invalid");
  if (typeof item.controlToken !== "string" || item.controlToken.length < 32) {
    throw new Error("product daemon control token is invalid");
  }
  if (typeof item.controlUrl !== "string") throw new Error("product daemon control URL is invalid");
  const url = new URL(item.controlUrl);
  if (url.protocol !== "http:"
    || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash) {
    throw new Error("product daemon control URL must be credential-free loopback http://");
  }
  return Object.freeze({
    version: 1 as const,
    pid: item.pid as number,
    controlUrl: url.href,
    controlToken: item.controlToken,
  });
}

export function readProductDaemonState(paths = resolveProductControlPaths()): ProductDaemonState | undefined {
  if (!existsSync(paths.daemonState)) return undefined;
  let value: unknown;
  try { value = JSON.parse(readFileSync(paths.daemonState, "utf8")); }
  catch (error) { throw new Error("ChatGPT Tela daemon state is unreadable", { cause: error }); }
  return parseProductDaemonState(value);
}

export function writeProductDaemonState(
  state: ProductDaemonState,
  paths = resolveProductControlPaths(),
): void {
  const normalized = parseProductDaemonState(state);
  mkdirSync(dirname(paths.daemonState), { recursive: true, mode: 0o700 });
  const temporary = `${paths.daemonState}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(temporary, 0o600); } catch { /* Windows ACLs own permissions there. */ }
  renameSync(temporary, paths.daemonState);
}
