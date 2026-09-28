import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export interface ChatApprovedRootsConfig {
  readonly version: 1;
  readonly roots: readonly string[];
}

export interface OpenAiChatAgentProviderConfig {
  readonly id: "openai-responses";
  readonly enabled: boolean;
  readonly model: string;
  readonly apiKeyEnv?: string;
  readonly credentialId?: string;
}

export interface ChatAgentProvidersConfig {
  readonly version: 1;
  readonly providers: readonly OpenAiChatAgentProviderConfig[];
}

function exactFields(record: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const extras = Object.keys(record).filter(key => !allowed.includes(key));
  if (extras.length > 0) throw new Error(`${field} contains unknown fields: ${extras.join(", ")}`);
}

function singleLine(value: unknown, field: string, maximumBytes = 1024): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000\r\n]/.test(value)) throw new Error(`${field} is invalid`);
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, "utf8") > maximumBytes) throw new Error(`${field} is too large`);
  return normalized;
}

export function parseChatApprovedRootsConfig(value: unknown): ChatApprovedRootsConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tela Chat roots config must be an object");
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || !Array.isArray(item.roots)) throw new Error("Tela Chat roots config version is invalid");
  const roots = item.roots.map((root, index) => {
    if (typeof root !== "string" || !root.trim() || /[\u0000\r\n]/.test(root)) throw new Error(`Tela Chat root[${index}] is invalid`);
    const absolute = resolve(root);
    if (!isAbsolute(absolute)) throw new Error(`Tela Chat root[${index}] must be absolute`);
    return absolute;
  });
  return Object.freeze({ version: 1, roots: Object.freeze([...new Set(roots)]) });
}

export function readChatApprovedRootsConfig(path: string): ChatApprovedRootsConfig {
  if (!existsSync(path)) return Object.freeze({ version: 1, roots: Object.freeze([]) });
  return parseChatApprovedRootsConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export function writeChatApprovedRootsConfig(path: string, config: ChatApprovedRootsConfig): void {
  const normalized = parseChatApprovedRootsConfig(config);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(temporary, 0o600); } catch { /* Windows ACLs own permissions there. */ }
  renameSync(temporary, path);
}

export function parseChatAgentProvidersConfig(value: unknown): ChatAgentProvidersConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tela Chat agent providers config must be an object");
  const root = value as Record<string, unknown>;
  exactFields(root, ["version", "providers"], "Tela Chat agent providers config");
  if (root.version !== 1 || !Array.isArray(root.providers)) throw new Error("Tela Chat agent providers config version is invalid");
  const seen = new Set<string>();
  const providers = root.providers.map((value, index): OpenAiChatAgentProviderConfig => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`agent provider[${index}] is invalid`);
    const item = value as Record<string, unknown>;
    exactFields(item, ["id", "enabled", "model", "apiKeyEnv", "credentialId"], `agent provider[${index}]`);
    if (item.id !== "openai-responses") throw new Error(`agent provider[${index}].id is unsupported`);
    if (seen.has(item.id)) throw new Error(`duplicate Tela Chat agent provider: ${item.id}`);
    seen.add(item.id);
    if (typeof item.enabled !== "boolean") throw new Error(`agent provider[${index}].enabled must be boolean`);
    const apiKeyEnv = item.apiKeyEnv === undefined
      ? undefined
      : singleLine(item.apiKeyEnv, `agent provider[${index}].apiKeyEnv`, 128);
    if (apiKeyEnv && !/^[A-Z_][A-Z0-9_]*$/.test(apiKeyEnv)) throw new Error(`agent provider[${index}].apiKeyEnv is invalid`);
    const credentialId = item.credentialId === undefined
      ? undefined
      : singleLine(item.credentialId, `agent provider[${index}].credentialId`, 128);
    if (credentialId && !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(credentialId)) {
      throw new Error(`agent provider[${index}].credentialId is invalid`);
    }
    if (!apiKeyEnv && !credentialId) throw new Error(`agent provider[${index}] requires apiKeyEnv or credentialId`);
    return Object.freeze({
      id: "openai-responses",
      enabled: item.enabled,
      model: singleLine(item.model, `agent provider[${index}].model`, 256),
      ...(apiKeyEnv ? { apiKeyEnv } : {}),
      ...(credentialId ? { credentialId } : {}),
    });
  });
  return Object.freeze({ version: 1, providers: Object.freeze(providers) });
}

export function readChatAgentProvidersConfig(path: string): ChatAgentProvidersConfig {
  if (!existsSync(path)) return Object.freeze({ version: 1, providers: Object.freeze([]) });
  return parseChatAgentProvidersConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export function writeChatAgentProvidersConfig(path: string, config: ChatAgentProvidersConfig): void {
  const normalized = parseChatAgentProvidersConfig(config);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(temporary, 0o600); } catch { /* Windows ACLs own permissions there. */ }
  renameSync(temporary, path);
}
