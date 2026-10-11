import {
  BROWSER_PAGE_AUTOMATION,
  type BrowserSurfaceLease,
} from "@chatgpt-tela/browser-host";

export interface ChatGptAccountIdentity {
  /** Stable pseudonymous identity; raw user/account ids never leave the ChatGPT page. */
  readonly accountFingerprint: string;
  /** Pseudonymous fingerprint of the active ChatGPT account/workspace container id only. */
  readonly containerFingerprint: string;
  /** Coarse ChatGPT account container only; never includes a workspace name or raw id. */
  readonly accountStructure: "personal" | "workspace" | "unknown";
}

const ACCOUNT_IDENTITY_PROBE = `async () => {
  if (location.origin !== "https://chatgpt.com") {
    throw new Error("ChatGPT account identity requires the chatgpt.com origin");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch("/api/auth/session", {
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    });
    const url = new URL(response.url);
    if (!response.ok || url.origin !== "https://chatgpt.com" || url.pathname !== "/api/auth/session") {
      throw new Error("ChatGPT account identity could not verify the current session");
    }
    const session = await response.json();
    const userId = session && session.user && session.user.id;
    const accountId = session && session.account && session.account.id;
    if (typeof userId !== "string" || !userId || userId.length > 256
      || typeof accountId !== "string" || !accountId || accountId.length > 256) {
      throw new Error("ChatGPT account identity is unavailable; sign in and retry");
    }
    const structure = session && session.account && session.account.structure;
    const bytes = new TextEncoder().encode(userId + "\\0" + accountId);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const containerDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accountId));
    return {
      accountFingerprint: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""),
      containerFingerprint: Array.from(new Uint8Array(containerDigest), byte => byte.toString(16).padStart(2, "0")).join(""),
      accountStructure: structure === "personal" ? "personal" : structure === "workspace" ? "workspace" : "unknown",
    };
  } finally {
    clearTimeout(timeout);
  }
}`;

// Separate from the routing identity probe: only an explicit local UI request returns email.
const ACCOUNT_DISPLAY_PROBE = `async () => {
  if (location.origin !== "https://chatgpt.com") throw new Error("ChatGPT account display requires the ChatGPT origin");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store", signal: controller.signal });
    const url = new URL(response.url);
    if (url.origin !== "https://chatgpt.com" || url.pathname !== "/api/auth/session") throw new Error("Unexpected account display response");
    if (response.status === 401) return { state: "signed-out" };
    if (!response.ok) throw new Error("Account display unavailable");
    const value = await response.json();
    if (value && value.user === null) return { state: "signed-out" };
    if (!value || !value.user || typeof value.user.id !== "string" || !value.user.id) throw new Error("Account display unavailable");
    const email = value.user.email;
    return { state: "signed-in", ...(typeof email === "string" ? { email } : {}) };
  } finally { clearTimeout(timeout); }
}`;

export async function observeChatGptAccountDisplay(surface: BrowserSurfaceLease, signal?: AbortSignal): Promise<{
  readonly state: "signed-in" | "signed-out";
  readonly email?: string;
}> {
  const page = surface.capability(BROWSER_PAGE_AUTOMATION);
  if (!page) throw new Error("browser surface does not expose account display observation");
  const row = await page.evaluate<null, { state: string; email?: unknown }>(ACCOUNT_DISPLAY_PROBE, null, signal);
  if (!["signed-in", "signed-out"].includes(row.state)
    || (row.email !== undefined && (row.state !== "signed-in" || typeof row.email !== "string" || row.email.length > 254
      || !/^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+$/.test(row.email)))) throw new Error("Invalid account display observation");
  return Object.freeze({ state: row.state as "signed-in" | "signed-out", ...(row.email !== undefined ? { email: row.email as string } : {}) });
}

export async function observeChatGptAccountIdentity(
  surface: BrowserSurfaceLease,
  signal?: AbortSignal,
): Promise<ChatGptAccountIdentity> {
  const page = surface.capability(BROWSER_PAGE_AUTOMATION);
  if (!page) throw new Error("browser surface does not expose page automation for ChatGPT account identity");
  const identity = await page.evaluate<null, { accountFingerprint: string; containerFingerprint: string; accountStructure: string }>(ACCOUNT_IDENTITY_PROBE, null, signal);
  if (!/^[a-f0-9]{64}$/.test(identity.accountFingerprint)) {
    throw new Error("ChatGPT account identity probe returned an invalid fingerprint");
  }
  if (!/^[a-f0-9]{64}$/.test(identity.containerFingerprint)) {
    throw new Error("ChatGPT account identity probe returned an invalid container fingerprint");
  }
  if (!["personal", "workspace", "unknown"].includes(identity.accountStructure)) {
    throw new Error("ChatGPT account identity probe returned an invalid account structure");
  }
  return Object.freeze({
    accountFingerprint: identity.accountFingerprint,
    containerFingerprint: identity.containerFingerprint,
    accountStructure: identity.accountStructure as ChatGptAccountIdentity["accountStructure"],
  });
}
