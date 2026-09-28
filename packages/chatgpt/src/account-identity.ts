import {
  BROWSER_PAGE_AUTOMATION,
  type BrowserSurfaceLease,
} from "@chatgpt-tela/browser-host";

export interface ChatGptAccountIdentity {
  /** Stable pseudonymous identity; raw user/account ids never leave the ChatGPT page. */
  readonly accountFingerprint: string;
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
    const bytes = new TextEncoder().encode(userId + "\\0" + accountId);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
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
  const accountFingerprint = await page.evaluate<null, string>(ACCOUNT_IDENTITY_PROBE, null, signal);
  if (!/^[a-f0-9]{64}$/.test(accountFingerprint)) {
    throw new Error("ChatGPT account identity probe returned an invalid fingerprint");
  }
  return Object.freeze({ accountFingerprint });
}
