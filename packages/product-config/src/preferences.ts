import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveProductPaths, type ProductPathOptions } from "@chatgpt-tela/product-lifecycle";

export type ProductApprovalAutomationMode = "off" | "recognized_once";
export type ProductApprovalDelayPreset = "instant" | "250ms" | "500ms" | "1s" | "2s" | "5s" | "10s" | "15s";

const APPROVAL_DELAY_MS: Readonly<Record<ProductApprovalDelayPreset, number>> = Object.freeze({
  instant: 0,
  "250ms": 250,
  "500ms": 500,
  "1s": 1_000,
  "2s": 2_000,
  "5s": 5_000,
  "10s": 10_000,
  "15s": 15_000,
});

export interface ProductPreferences {
  readonly version: 1;
  readonly approvalAutomation: ProductApprovalAutomationMode;
  readonly approvalDelay?: ProductApprovalDelayPreset;
  /** Target identities chosen by the user; never evidence of live route ownership. */
  readonly workProfileConnections?: readonly string[];
  /** Explicit owner-only acceptance window; never enables saved Web chats by default. */
  readonly savedChatAcceptance?: { readonly slot: number; readonly expiresAt: number };
}

export const DEFAULT_PRODUCT_PREFERENCES: ProductPreferences = Object.freeze({
  version: 1,
  approvalAutomation: "off",
  approvalDelay: "instant",
});

export function approvalDelayMilliseconds(preset: ProductApprovalDelayPreset | undefined): number {
  return APPROVAL_DELAY_MS[preset ?? "instant"];
}

export function parseProductPreferences(value: unknown): ProductPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ChatGPT Tela preferences must be a JSON object");
  }
  const item = value as Record<string, unknown>;
  const extra = Object.keys(item).filter(key => !["version", "approvalAutomation", "approvalDelay", "workProfileConnections", "savedChatAcceptance"].includes(key));
  if (extra.length > 0) throw new Error(`ChatGPT Tela preferences contain unknown fields: ${extra.join(", ")}`);
  if (item.version !== 1) throw new Error("unsupported ChatGPT Tela preferences version");
  const approvalAutomation = item.approvalAutomation ?? "off";
  if (approvalAutomation !== "off" && approvalAutomation !== "recognized_once") {
    throw new Error("ChatGPT Tela approval automation mode is invalid");
  }
  const approvalDelay = item.approvalDelay ?? "instant";
  if (typeof approvalDelay !== "string" || !Object.hasOwn(APPROVAL_DELAY_MS, approvalDelay)) {
    throw new Error("ChatGPT Tela approval delay preset is invalid");
  }
  const connections = item.workProfileConnections;
  if (connections !== undefined && (!Array.isArray(connections) || connections.length > 32
    || connections.some(id => typeof id !== "string" || !/^[a-zA-Z0-9._-]{1,160}$/.test(id))
    || new Set(connections).size !== connections.length)) {
    throw new Error("ChatGPT Tela Work connection identities are invalid");
  }
  const acceptance = item.savedChatAcceptance;
  if (acceptance !== undefined && (!acceptance || typeof acceptance !== "object" || Array.isArray(acceptance)
    || Object.keys(acceptance).some(key => key !== "slot" && key !== "expiresAt")
    || !Number.isSafeInteger((acceptance as { slot?: unknown }).slot)
    || Number((acceptance as { slot: number }).slot) < 1
    || Number((acceptance as { slot: number }).slot) > 99
    || !Number.isSafeInteger((acceptance as { expiresAt?: unknown }).expiresAt)
    || Number((acceptance as { expiresAt: number }).expiresAt) <= 0)) {
    throw new Error("ChatGPT Tela saved-chat acceptance lease is invalid");
  }
  return Object.freeze({
    version: 1,
    approvalAutomation,
    approvalDelay: approvalDelay as ProductApprovalDelayPreset,
    ...(connections === undefined ? {} : { workProfileConnections: Object.freeze([...connections as string[]]) }),
    ...(acceptance === undefined ? {} : { savedChatAcceptance: Object.freeze({
      slot: (acceptance as { slot: number }).slot,
      expiresAt: (acceptance as { expiresAt: number }).expiresAt,
    }) }),
  });
}

export function resolveProductPreferencesPath(options: ProductPathOptions = {}): string {
  return join(resolveProductPaths(options).configRoot, "preferences-v1.json");
}

export function readProductPreferences(path = resolveProductPreferencesPath()): ProductPreferences {
  if (!existsSync(path)) return DEFAULT_PRODUCT_PREFERENCES;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("ChatGPT Tela preferences path is unsafe or replaced");
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")) as unknown; }
  catch (error) { throw new Error("ChatGPT Tela preferences are unreadable", { cause: error }); }
  return parseProductPreferences(value);
}

export function writeProductPreferences(
  preferences: ProductPreferences,
  path = resolveProductPreferencesPath(),
): void {
  const normalized = parseProductPreferences(preferences);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try { chmodSync(temporary, 0o600); } catch { /* Windows ACLs own permissions there. */ }
  renameSync(temporary, path);
}

export function setWorkProfileConnection(targetId: string, enabled: boolean, path = resolveProductPreferencesPath()): void {
  const preferences = readProductPreferences(path);
  const identities = new Set(preferences.workProfileConnections ?? []);
  if (enabled) identities.add(targetId); else identities.delete(targetId);
  writeProductPreferences({ ...preferences, workProfileConnections: [...identities].sort() }, path);
}

/** Owner-operated, bounded, local-only experiment; no permanent saved-chat preference. */
export function armSavedChatAcceptance(
  slot: number, path = resolveProductPreferencesPath(), now = Date.now(),
): void {
  if (!Number.isSafeInteger(slot) || slot < 1 || slot > 99 || !Number.isSafeInteger(now) || now < 1) {
    throw new Error("saved-chat acceptance needs a valid slot and current time");
  }
  const preferences = readProductPreferences(path);
  if (preferences.savedChatAcceptance && preferences.savedChatAcceptance.expiresAt > now) {
    throw new Error("another saved-chat acceptance lease has not expired");
  }
  writeProductPreferences({ ...preferences, savedChatAcceptance: {
    slot, expiresAt: now + 15 * 60_000,
  } }, path);
}

export function clearSavedChatAcceptance(path = resolveProductPreferencesPath()): void {
  const { savedChatAcceptance, ...preferences } = readProductPreferences(path);
  if (savedChatAcceptance) writeProductPreferences(preferences, path);
}

export function savedChatAcceptanceSlot(preferences: ProductPreferences, now = Date.now()): number | undefined {
  const lease = preferences.savedChatAcceptance;
  if (!lease || !Number.isSafeInteger(now) || now < 1
    || lease.expiresAt <= now || lease.expiresAt > now + 15 * 60_000) return undefined;
  return lease.slot;
}

/** Consume before spawning the exact owned profile; failed starts cannot replay the grant. */
export function consumeSavedChatAcceptance(
  slot: number, path = resolveProductPreferencesPath(), now = Date.now(),
): boolean {
  const preferences = readProductPreferences(path);
  if (savedChatAcceptanceSlot(preferences, now) !== slot) return false;
  const { savedChatAcceptance, ...ordinary } = preferences;
  if (!savedChatAcceptance) return false;
  writeProductPreferences(ordinary, path);
  return true;
}
