import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CHATGPT_WEB_EFFORTS, chatGptWebFamilyKey, type ChatGptWebModelFamily } from "@chatgpt-tela/chatgpt";
import { readChatGptTelaAccountBinding, type ChatGptTelaBrowserProfile } from "./browser-profile";

// One bounded, expiring display projection per owned browser profile. Never execution authority.
const MAX_BYTES = 64 * 1024;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const supportedEfforts = new Set<unknown>(CHATGPT_WEB_EFFORTS);
const filename = (profile: ChatGptTelaBrowserProfile) => join(profile.userDataDir, "web-model-display-v1.json");
function families(value: unknown): readonly ChatGptWebModelFamily[] | undefined {
  // An empty, account-bound projection explicitly invalidates stale display hints.
  if (!Array.isArray(value) || value.length > 64) return undefined;
  const keys = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== "object" || typeof row.label !== "string" || !row.label.trim() || row.label.length > 256
      || row.key !== chatGptWebFamilyKey(row.label) || keys.has(row.key)
      || !Array.isArray(row.availableEfforts) || !row.availableEfforts.length
      || new Set(row.availableEfforts).size !== row.availableEfforts.length
      || row.availableEfforts.some((effort: unknown) => !supportedEfforts.has(effort))) return undefined;
    keys.add(row.key);
  }
  return Object.freeze(value.map(row => Object.freeze({ key: row.key, label: row.label,
    availableEfforts: Object.freeze([...row.availableEfforts]) })));
}
export function readWebModelDisplayCache(profile: ChatGptTelaBrowserProfile, now = Date.now()): readonly ChatGptWebModelFamily[] {
  try {
    const binding = readChatGptTelaAccountBinding(profile);
    if (!binding || statSync(filename(profile)).size > MAX_BYTES) return [];
    const record = JSON.parse(readFileSync(filename(profile), "utf8"));
    if (record.version !== 1 || record.profileId !== profile.profileId || record.accountFingerprint !== binding.accountFingerprint
      || !Number.isFinite(record.verifiedAt) || record.verifiedAt > now) return [];
    if (now - record.verifiedAt > MAX_AGE_MS) {
      rmSync(filename(profile)); // Only the validated, regenerative cache; no idle cleanup timer.
      return [];
    }
    return families(record.families) ?? [];
  } catch { return []; } // An optional display cache cannot block Native startup.
}
export function writeWebModelDisplayCache(profile: ChatGptTelaBrowserProfile, value: readonly ChatGptWebModelFamily[], now = Date.now()): boolean {
  let temporary: string | undefined;
  try {
    const binding = readChatGptTelaAccountBinding(profile), rows = families(value);
    if (!binding || !rows) return false;
    const content = JSON.stringify({ version: 1, profileId: profile.profileId,
      accountFingerprint: binding.accountFingerprint, verifiedAt: now, families: rows }) + "\n";
    if (Buffer.byteLength(content) > MAX_BYTES) return false;
    mkdirSync(profile.userDataDir, { recursive: true, mode: 0o700 });
    temporary = `${filename(profile)}.tmp-${randomUUID()}`;
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, filename(profile));
    return true;
  } catch { return false; }
  finally { if (temporary) { try { rmSync(temporary, { force: true }); } catch { /* Optional cache remains nonfatal. */ } } }
}
