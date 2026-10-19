import {
  BROWSER_PAGE_AUTOMATION,
  type BrowserSurfaceLease,
} from "@chatgpt-tela/browser-host";
import { diagnosticDurationMs, emitDiagnosticEvent } from "@chatgpt-tela/core";

export interface ChatGptAccountIdentity {
  /** Stable pseudonymous identity; raw user/account ids never leave the ChatGPT page. */
  readonly accountFingerprint: string;
  /** Pseudonymous fingerprint of the active ChatGPT account/workspace container id only. */
  readonly containerFingerprint: string;
  /** Coarse ChatGPT account container only; never includes a workspace name or raw id. */
  readonly accountStructure: "personal" | "workspace" | "unknown";
}

/** Explicit unauthenticated session shapes; transport/unknown responses stay unavailable. */
const SIGNED_OUT_SESSION = `(value) => value === null || (typeof value === "object" && !Array.isArray(value)
  && (value.user === null || Object.keys(value).length === 0))`;

export class ChatGptWebLoginRequiredError extends Error {
  readonly code = "tela_web_login_required";
  constructor() {
    super("Sign in to ChatGPT in this profile's Web browser, then close the window to reconnect Web models.");
    this.name = "ChatGptWebLoginRequiredError";
  }
}

const ACCOUNT_IDENTITY_PROBE = `async () => {
  const result = (state, reasonClass, fields = {}) => ({ state, reasonClass, ...fields });
  if (location.origin !== "https://chatgpt.com") return result("unavailable", "wrong_origin");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    let response;
    try {
      response = await fetch("/api/auth/session", {
        credentials: "same-origin", cache: "no-store", signal: controller.signal,
      });
    } catch {
      return result("unavailable", controller.signal.aborted ? "probe_timeout" : "network_error");
    }
    const url = new URL(response.url);
    if (url.origin !== "https://chatgpt.com" || url.pathname !== "/api/auth/session") {
      return result("unavailable", "redirected", { httpStatus: response.status });
    }
    if (response.status === 401) return result("signed-out", "unauthorized", { httpStatus: response.status });
    if (!response.ok) return result("unavailable", response.status === 403 ? "forbidden"
      : response.status === 429 ? "rate_limited" : response.status >= 500 ? "server_error" : "http_error",
      { httpStatus: response.status });
    let session;
    try { session = await response.json(); }
    catch { return result("unavailable", "invalid_response", { httpStatus: response.status }); }
    if ((${SIGNED_OUT_SESSION})(session)) return result("signed-out", "empty_session", { httpStatus: response.status });
    const userId = session && session.user && session.user.id;
    const accountId = session && session.account && session.account.id;
    if (typeof userId !== "string" || !userId || userId.length > 256
      || typeof accountId !== "string" || !accountId || accountId.length > 256) {
      return result("unavailable", "invalid_session_shape", { httpStatus: response.status,
        userPresent: !!(session && session.user), userIdValid: typeof userId === "string" && !!userId && userId.length <= 256,
        accountPresent: !!(session && session.account), accountIdValid: typeof accountId === "string" && !!accountId && accountId.length <= 256 });
    }
    const structure = session && session.account && session.account.structure;
    const bytes = new TextEncoder().encode(userId + "\\0" + accountId);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const containerDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accountId));
    return result("signed-in", "verified", {
      accountFingerprint: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""),
      containerFingerprint: Array.from(new Uint8Array(containerDigest), byte => byte.toString(16).padStart(2, "0")).join(""),
      accountStructure: structure === "personal" ? "personal" : structure === "workspace" ? "workspace" : "unknown",
      httpStatus: response.status,
    });
  } finally {
    clearTimeout(timeout);
  }
}`;

// Separate from the routing identity probe: only an explicit local UI request returns email.
const ACCOUNT_DISPLAY_PROBE = `async () => {
  const result = (state, reasonClass, fields = {}) => ({ state, reasonClass, ...fields });
  if (location.origin !== "https://chatgpt.com") return result("unavailable", "wrong_origin");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    let response;
    try { response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store", signal: controller.signal }); }
    catch { return result("unavailable", controller.signal.aborted ? "probe_timeout" : "network_error"); }
    const url = new URL(response.url);
    if (url.origin !== "https://chatgpt.com" || url.pathname !== "/api/auth/session") return result("unavailable", "redirected", { httpStatus: response.status });
    if (response.status === 401) return result("signed-out", "unauthorized", { httpStatus: response.status });
    if (!response.ok) return result("unavailable", response.status === 403 ? "forbidden"
      : response.status === 429 ? "rate_limited" : response.status >= 500 ? "server_error" : "http_error",
      { httpStatus: response.status });
    let value;
    try { value = await response.json(); }
    catch { return result("unavailable", "invalid_response", { httpStatus: response.status }); }
    if ((${SIGNED_OUT_SESSION})(value)) return result("signed-out", "empty_session", { httpStatus: response.status });
    if (!value || !value.user || typeof value.user.id !== "string" || !value.user.id) return result("unavailable", "invalid_session_shape", { httpStatus: response.status,
      userPresent: !!(value && value.user), userIdValid: !!(value && value.user && typeof value.user.id === "string" && value.user.id),
      accountPresent: !!(value && value.account), accountIdValid: !!(value && value.account && typeof value.account.id === "string" && value.account.id) });
    const email = value.user.email;
    return result("signed-in", "verified", { httpStatus: response.status, ...(typeof email === "string" ? { email } : {}) });
  } finally { clearTimeout(timeout); }
}`;

const AUTH_REASON_CLASSES = new Set([
  "verified", "wrong_origin", "redirected", "unauthorized", "empty_session", "forbidden",
  "rate_limited", "server_error", "http_error", "network_error", "probe_timeout",
  "invalid_response", "invalid_session_shape", "observation_aborted", "page_evaluation_failed",
]);

interface AuthShapeObservation {
  readonly userPresent?: boolean;
  readonly userIdValid?: boolean;
  readonly accountPresent?: boolean;
  readonly accountIdValid?: boolean;
}

function recordAccountProbe(input: {
  readonly kind: "identity" | "display";
  readonly state: "signed-in" | "signed-out" | "unavailable";
  readonly reasonClass: string;
  readonly httpStatus?: number;
  readonly shape?: AuthShapeObservation;
  readonly startedAt: number;
}): void {
  const reasonClass = AUTH_REASON_CLASSES.has(input.reasonClass) ? input.reasonClass : "page_evaluation_failed";
  const fields = {
    probe_kind: input.kind,
    auth_state: input.state,
    reason_class: reasonClass,
    duration_ms: diagnosticDurationMs(input.startedAt),
    ...(typeof input.shape?.userPresent === "boolean" ? { user_present: input.shape.userPresent } : {}),
    ...(typeof input.shape?.userIdValid === "boolean" ? { user_key_valid: input.shape.userIdValid } : {}),
    ...(typeof input.shape?.accountPresent === "boolean" ? { account_present: input.shape.accountPresent } : {}),
    ...(typeof input.shape?.accountIdValid === "boolean" ? { account_key_valid: input.shape.accountIdValid } : {}),
    ...(Number.isInteger(input.httpStatus) && input.httpStatus! >= 100 && input.httpStatus! <= 599
      ? { http_status: input.httpStatus! } : {}),
  };
  emitDiagnosticEvent("chatgpt_tela_web_auth", "session_probe_observed", fields);
  if (input.state === "signed-out") {
    emitDiagnosticEvent("chatgpt_tela_web_auth", "auth_session_signed_out", fields);
  } else if (input.state === "unavailable") {
    emitDiagnosticEvent("chatgpt_tela_web_auth", "auth_probe_failed", fields);
  }
}

function probeFailureReason(error: unknown, signal?: AbortSignal): string {
  if (signal?.aborted) return "observation_aborted";
  if (error instanceof Error && error.name === "AbortError") return "observation_aborted";
  return "page_evaluation_failed";
}

export async function observeChatGptAccountDisplay(surface: BrowserSurfaceLease, signal?: AbortSignal): Promise<{
  readonly state: "signed-in" | "signed-out";
  readonly email?: string;
}> {
  const page = surface.capability(BROWSER_PAGE_AUTOMATION);
  const startedAt = Date.now();
  if (!page) {
    recordAccountProbe({ kind: "display", state: "unavailable", reasonClass: "page_evaluation_failed", startedAt });
    throw new Error("browser surface does not expose account display observation");
  }
  let row: AuthShapeObservation & { state: string; reasonClass?: string; httpStatus?: number; email?: unknown };
  try { row = await page.evaluate<null, typeof row>(ACCOUNT_DISPLAY_PROBE, null, signal); }
  catch (error) {
    recordAccountProbe({ kind: "display", state: "unavailable", reasonClass: probeFailureReason(error, signal), startedAt });
    throw new Error("ChatGPT account display observation failed");
  }
  const state = ["signed-in", "signed-out"].includes(row.state) ? row.state as "signed-in" | "signed-out" : "unavailable";
  const reasonClass = typeof row.reasonClass === "string" && AUTH_REASON_CLASSES.has(row.reasonClass) ? row.reasonClass : "page_evaluation_failed";
  recordAccountProbe({ kind: "display", state, reasonClass, shape: row,
    ...(typeof row.httpStatus === "number" ? { httpStatus: row.httpStatus } : {}), startedAt });
  if (state === "unavailable" || (row.email !== undefined && (row.state !== "signed-in" || typeof row.email !== "string" || row.email.length > 254
      || !/^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+$/.test(row.email)))) throw new Error("Invalid account display observation");
  return Object.freeze({ state: row.state as "signed-in" | "signed-out", ...(row.email !== undefined ? { email: row.email as string } : {}) });
}

export async function observeChatGptAccountIdentity(
  surface: BrowserSurfaceLease,
  signal?: AbortSignal,
): Promise<ChatGptAccountIdentity> {
  const page = surface.capability(BROWSER_PAGE_AUTOMATION);
  const startedAt = Date.now();
  if (!page) {
    recordAccountProbe({ kind: "identity", state: "unavailable", reasonClass: "page_evaluation_failed", startedAt });
    throw new Error("browser surface does not expose page automation for ChatGPT account identity");
  }
  let identity: AuthShapeObservation & { state?: string; reasonClass?: string; httpStatus?: number; accountFingerprint?: string; containerFingerprint?: string; accountStructure?: string };
  try { identity = await page.evaluate<null, typeof identity>(ACCOUNT_IDENTITY_PROBE, null, signal); }
  catch (error) {
    recordAccountProbe({ kind: "identity", state: "unavailable", reasonClass: probeFailureReason(error, signal), startedAt });
    throw new Error("ChatGPT account identity observation failed");
  }
  const state = identity?.state === "signed-in" || identity?.state === "signed-out" ? identity.state : "unavailable";
  const reasonClass = typeof identity?.reasonClass === "string" && AUTH_REASON_CLASSES.has(identity.reasonClass) ? identity.reasonClass : "page_evaluation_failed";
  recordAccountProbe({ kind: "identity", state, reasonClass, shape: identity,
    ...(typeof identity?.httpStatus === "number" ? { httpStatus: identity.httpStatus } : {}), startedAt });
  if (state === "unavailable") throw new Error("ChatGPT account identity is unavailable; sign in and retry");
  if (identity?.state === "signed-out") throw new ChatGptWebLoginRequiredError();
  if (!/^[a-f0-9]{64}$/.test(identity.accountFingerprint ?? "")) {
    throw new Error("ChatGPT account identity probe returned an invalid fingerprint");
  }
  if (!/^[a-f0-9]{64}$/.test(identity.containerFingerprint ?? "")) {
    throw new Error("ChatGPT account identity probe returned an invalid container fingerprint");
  }
  if (!["personal", "workspace", "unknown"].includes(identity.accountStructure ?? "")) {
    throw new Error("ChatGPT account identity probe returned an invalid account structure");
  }
  return Object.freeze({
    accountFingerprint: identity.accountFingerprint!,
    containerFingerprint: identity.containerFingerprint!,
    accountStructure: identity.accountStructure as ChatGptAccountIdentity["accountStructure"],
  });
}
