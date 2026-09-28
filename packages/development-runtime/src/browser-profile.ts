import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface ChatGptTelaBrowserProfile {
  readonly slot: number;
  readonly profileId: string;
  readonly profileRoot: string;
  readonly userDataDir: string;
  readonly accountBindingPath: string;
}

interface AccountBindingRecord {
  readonly version: 1;
  readonly slot: number;
  readonly profileId: string;
  readonly accountFingerprint: string;
  readonly verifiedAt: string;
}

function profileSlot(value: string | number, field = "ChatGPT Tela profile slot"): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 99) {
    throw new Error(`${field} must be an integer from 1 to 99`);
  }
  return parsed;
}

function rootForPlatform(input: {
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
} = {}): string {
  const platform = input.platform ?? process.platform;
  const home = resolve(input.homeDirectory ?? homedir());
  const env = input.environment ?? process.env;
  const explicit = env.CHATGPT_TELA_PROFILE_ROOT?.trim();
  if (explicit) return resolve(explicit.startsWith("~/") ? join(home, explicit.slice(2)) : explicit);
  if (platform === "darwin") return join(home, "Library", "Application Support", "ChatGPT Tela");
  if (platform === "win32") {
    const appData = env.APPDATA?.trim();
    return join(appData ? resolve(appData) : join(home, "AppData", "Roaming"), "ChatGPT Tela");
  }
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg ? resolve(xdg) : join(home, ".config"), "ChatGPT Tela");
}

export function resolveChatGptTelaBrowserProfile(input: {
  readonly slot: string | number;
  readonly profileRoot?: string;
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): ChatGptTelaBrowserProfile {
  const slot = profileSlot(input.slot);
  const home = resolve(input.homeDirectory ?? homedir());
  const rawRoot = input.profileRoot ?? rootForPlatform({
    ...(input.platform ? { platform: input.platform } : {}),
    homeDirectory: home,
    ...(input.environment ? { environment: input.environment } : {}),
  });
  const profileRoot = resolve(rawRoot.startsWith("~/") ? join(home, rawRoot.slice(2)) : rawRoot);
  const profileId = `Profile${slot}-ChatGPT-Tela`;
  return Object.freeze({
    slot,
    profileId,
    profileRoot,
    userDataDir: join(profileRoot, `Canary-Profile${slot}`),
    accountBindingPath: join(profileRoot, "account-bindings", `Profile${slot}.json`),
  });
}

function readBinding(path: string): AccountBindingRecord | undefined {
  if (!existsSync(path)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`ChatGPT Tela account binding is unreadable: ${path}`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`ChatGPT Tela account binding is invalid: ${path}`);
  }
  const record = value as Partial<AccountBindingRecord>;
  if (record.version !== 1
    || !Number.isSafeInteger(record.slot) || (record.slot ?? 0) < 1
    || typeof record.profileId !== "string" || !record.profileId
    || typeof record.accountFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(record.accountFingerprint)
    || typeof record.verifiedAt !== "string" || !record.verifiedAt) {
    throw new Error(`ChatGPT Tela account binding is invalid: ${path}`);
  }
  return Object.freeze(record as AccountBindingRecord);
}

export function readChatGptTelaAccountBinding(profile: ChatGptTelaBrowserProfile): AccountBindingRecord | undefined {
  const record = readBinding(profile.accountBindingPath);
  if (!record) return undefined;
  if (record.slot !== profile.slot || record.profileId !== profile.profileId) {
    throw new Error(`ChatGPT Tela account binding does not belong to ${profile.profileId}`);
  }
  return record;
}

export function bindChatGptTelaAccount(
  profile: ChatGptTelaBrowserProfile,
  accountFingerprint: string,
): AccountBindingRecord {
  if (!/^[a-f0-9]{64}$/.test(accountFingerprint)) {
    throw new Error("ChatGPT account fingerprint must be a lowercase SHA-256 hex digest");
  }
  for (let slot = 1; slot <= 99; slot += 1) {
    if (slot === profile.slot) continue;
    const sibling = resolveChatGptTelaBrowserProfile({ slot, profileRoot: profile.profileRoot });
    const binding = readBinding(sibling.accountBindingPath);
    if (binding?.accountFingerprint === accountFingerprint) {
      throw new Error(
        `ChatGPT account is already bound to ${binding.profileId}; ${profile.profileId} must use a different account`,
      );
    }
  }
  const record: AccountBindingRecord = Object.freeze({
    version: 1,
    slot: profile.slot,
    profileId: profile.profileId,
    accountFingerprint,
    verifiedAt: new Date().toISOString(),
  });
  mkdirSync(dirname(profile.accountBindingPath), { recursive: true, mode: 0o700 });
  const temporary = `${profile.accountBindingPath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(temporary, 0o600); } catch { /* Windows ACLs own permissions there. */ }
  renameSync(temporary, profile.accountBindingPath);
  return record;
}

export function assertChatGptTelaAccountBinding(
  profile: ChatGptTelaBrowserProfile,
  accountFingerprint: string,
): AccountBindingRecord {
  const binding = readChatGptTelaAccountBinding(profile);
  if (!binding) throw new Error(`${profile.profileId} has no verified ChatGPT account binding; run profile setup first`);
  if (binding.accountFingerprint !== accountFingerprint) {
    throw new Error(`${profile.profileId} is signed into a different ChatGPT account than its verified binding`);
  }
  return binding;
}
