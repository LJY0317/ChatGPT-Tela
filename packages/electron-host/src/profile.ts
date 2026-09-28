import { createHash } from "node:crypto";

export interface ElectronProfileIdentity {
  readonly profileId: string;
  readonly partition: string;
}

/**
 * Derive an Electron persistent partition from a stable ChatGPT Tela-local profile id, never from a mutable
 * display name. Hashing also keeps path/platform-sensitive characters out of Chromium storage ids.
 */
export function electronProfileIdentity(profileId: string): ElectronProfileIdentity {
  const normalized = profileId.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error("ChatGPT Tela Electron profile id is invalid");
  }
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 24);
  return Object.freeze({
    profileId: normalized,
    partition: `persist:chatgpt-tela-${digest}`,
  });
}
