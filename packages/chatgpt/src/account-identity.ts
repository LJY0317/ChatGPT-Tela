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
