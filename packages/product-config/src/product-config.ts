import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { resolveProductPaths, type ProductPathOptions } from "@chatgpt-tela/product-lifecycle";

export interface ExistingHttpsProductExposureConfig {
  readonly kind: "existing-https";
  readonly publicUrl: string;
  readonly localPort: number;
  readonly authentication: "none";
  readonly allowUnauthenticatedPublicEndpoint: true;
}

export interface TailscaleFunnelProductExposureConfig {
  readonly kind: "tailscale-funnel";
  readonly publicUrl: string;
  readonly localPort: number;
  readonly authentication: "none";
  readonly allowUnauthenticatedPublicEndpoint: true;
  readonly tailscaleCli: string;
}

export type ProductExposureConfig = ExistingHttpsProductExposureConfig | TailscaleFunnelProductExposureConfig;
export type ProductPublicMcpAbi = "stable" | "unified-development";

export interface ProductMultiProfileConfig {
  readonly launcherCli: string;
}

export interface ProductConfig {
  readonly version: 1;
  readonly multiProfile?: ProductMultiProfileConfig;
  readonly publicMcpAbi: ProductPublicMcpAbi;
  readonly exposure: ProductExposureConfig;
}

function exactFields(record: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const extras = Object.keys(record).filter(key => !allowed.includes(key));
  if (extras.length > 0) throw new Error(`${field} contains unknown fields: ${extras.join(", ")}`);
}

function port(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 65_535) {
    throw new Error(`${field} must be an integer TCP port from 1 to 65535`);
  }
  return value as number;
}

function regularFilePath(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000\r\n]/.test(value)) throw new Error(`${field} is invalid`);
  const path = resolve(value);
  if (!isAbsolute(path) || !existsSync(path)) throw new Error(`${field} does not exist: ${path}`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${field} must be a regular non-symlink file`);
  return path;
}

function optionalAdapterPath(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000\r\n]/.test(value)) throw new Error(`${field} is invalid`);
  const path = resolve(value);
  if (!isAbsolute(path)) throw new Error(`${field} must be absolute`);
  if (!existsSync(path)) return path;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${field} must be a regular non-symlink file when present`);
  return path;
}

function httpsUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("product MCP public URL is invalid");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("product MCP public URL must be credential-free HTTPS without query/hash state");
  }
  return url.href;
}

function command(value: unknown, field: string, fallback: string): string {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== "string" || !candidate.trim() || /[\u0000\r\n]/.test(candidate)) throw new Error(`${field} is invalid`);
  const trimmed = candidate.trim();
  if (trimmed.includes("/") || trimmed.includes("\\")) return regularFilePath(trimmed, field);
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) throw new Error(`${field} command name is invalid`);
  return trimmed;
}

function parseMultiProfile(value: unknown): ProductMultiProfileConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("product multi-profile config must be an object");
  const record = value as Record<string, unknown>;
  exactFields(record, ["launcherCli"], "product multi-profile config");
  return Object.freeze({ launcherCli: optionalAdapterPath(record.launcherCli, "product multi-profile launcher CLI") });
}

function parseExposure(value: unknown): ProductExposureConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("product config is missing exposure");
  const record = value as Record<string, unknown>;
  if (record.kind === "existing-https") {
    exactFields(record, ["kind", "publicUrl", "localPort", "authentication", "allowUnauthenticatedPublicEndpoint"], "existing HTTPS exposure");
    if (record.authentication !== "none" || record.allowUnauthenticatedPublicEndpoint !== true) {
      throw new Error("pre-alpha existing HTTPS exposure requires explicit unauthenticated development opt-in");
    }
    return Object.freeze({
      kind: "existing-https",
      publicUrl: httpsUrl(record.publicUrl),
      localPort: port(record.localPort, "product MCP local port"),
      authentication: "none",
      allowUnauthenticatedPublicEndpoint: true,
    });
  }
  if (record.kind === "tailscale-funnel") {
    exactFields(record, ["kind", "publicUrl", "localPort", "authentication", "allowUnauthenticatedPublicEndpoint", "tailscaleCli"], "Tailscale Funnel exposure");
    if (record.authentication !== "none" || record.allowUnauthenticatedPublicEndpoint !== true) {
      throw new Error("pre-alpha Tailscale Funnel exposure requires explicit unauthenticated development opt-in");
    }
    return Object.freeze({
      kind: "tailscale-funnel",
      publicUrl: httpsUrl(record.publicUrl),
      localPort: port(record.localPort, "product MCP local port"),
      authentication: "none",
      allowUnauthenticatedPublicEndpoint: true,
      tailscaleCli: command(record.tailscaleCli, "Tailscale CLI", "tailscale"),
    });
  }
  throw new Error("product exposure kind is unsupported");
}

export function parseProductConfig(value: unknown): ProductConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("product config must be a JSON object");
  const record = value as Record<string, unknown>;
  exactFields(record, ["version", "multiProfile", "publicMcpAbi", "exposure"], "product config");
  if (record.version !== 1) throw new Error("unsupported product config version");
  const publicMcpAbi = record.publicMcpAbi ?? "stable";
  if (publicMcpAbi !== "stable" && publicMcpAbi !== "unified-development") {
    throw new Error("product public MCP ABI is invalid");
  }
  const multiProfile = parseMultiProfile(record.multiProfile);
  return Object.freeze({
    version: 1,
    ...(multiProfile ? { multiProfile } : {}),
    publicMcpAbi,
    exposure: parseExposure(record.exposure),
  });
}

export function resolveProductConfigPath(options: ProductPathOptions = {}): string {
  return join(resolveProductPaths(options).configRoot, "product-v1.json");
}

export function readProductConfig(path = resolveProductConfigPath()): ProductConfig {
  if (!existsSync(path)) throw new Error(`ChatGPT Tela product config is missing: ${path}`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("ChatGPT Tela product config path is unsafe or replaced");
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")) as unknown; }
  catch (error) { throw new Error("ChatGPT Tela product config is unreadable", { cause: error }); }
  return parseProductConfig(value);
}

export function readProductConfigIfPresent(path = resolveProductConfigPath()): ProductConfig | undefined {
  return existsSync(path) ? readProductConfig(path) : undefined;
}

export function writeProductConfig(config: ProductConfig, path = resolveProductConfigPath()): void {
  const normalized = parseProductConfig(config);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try { chmodSync(temporary, 0o600); } catch { /* Windows ACLs own permissions there. */ }
  renameSync(temporary, path);
}
