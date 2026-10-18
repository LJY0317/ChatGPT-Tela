import { createHmac, randomBytes } from "node:crypto";
import { connectCodexAppServerWebSocket, type CodexAppServerRpc } from "@chatgpt-tela/codex";
import { accountDisplayEmail } from "@chatgpt-tela/service-protocol";
import type { LocalProfileBinding } from "./cross-profile-thread-relay";

/**
 * Read-only native account owner proof for a future exact-thread delegation.
 * Not exposed by the installed service or available to an arbitrary caller.
 *
 * The trusted controller MUST supply only a session it has already checked
 * against its own profile runtime process, target and responses route.
 * account/read.workspaceRouting proves selected owner account routing, not
 * permission to grant another account access to a stored thread.
 */
export interface TrustedNativeProfileSession {
  readonly slot: number;
  readonly runtimeProcessId: number;
  readonly responsesRouteFingerprint: string;
  readonly terminalEndpoint: string;
}

export interface LocalNativeAccountProofAdapters {
  resolveOwnedSession(slot: number): Promise<TrustedNativeProfileSession>;
  connect?(endpoint: string, signal: AbortSignal): Promise<Pick<CodexAppServerRpc, "request" | "close">>;
  /** Memory-local key, never part of a service response, log or document. */
  fingerprintKey?: Uint8Array;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function chatgptSelectedLoginBinding(result: unknown): string {
  const response = object(result);
  const account = object(response?.account);
  const routing = object(response?.workspaceRouting);
  // The routing account ID is NOT uniquely user-scoped. In real profiles,
  // different verified Native login emails can share the same routing ID.
  // Bind BOTH observations, fail closed if either is missing, and never
  // mistake this for upstream per-thread delegation authorization.
  const id = routing?.chatgptAccountId;
  const email = accountDisplayEmail(account?.email);
  if (account?.type !== "chatgpt" || typeof id !== "string"
    || id.length < 2 || id.length > 256 || /[\u0000-\u001f\u007f\s]/.test(id)
    || !email) {
    throw new Error("Authenticated selected ChatGPT login and routing are unavailable");
  }
  const at = email.lastIndexOf("@");
  return JSON.stringify([id, email.slice(0, at) + email.slice(at).toLowerCase()]);
}

/**
 * Returns only salted, process-local fingerprints. No account ID, email,
 * refresh token, endpoint address or raw app-server response escapes.
 */
export function createLocalNativeAccountProof(adapters: LocalNativeAccountProofAdapters) {
  const key = adapters.fingerprintKey ?? randomBytes(32);
  if (key.length < 32) throw new Error("Local account fingerprints require a private 256-bit key");
  const hmac = (kind: string, value: string) =>
    createHmac("sha256", key).update(kind).update("\u0000").update(value).digest("hex");
  const connect = adapters.connect
    ?? ((endpoint: string, signal: AbortSignal) => connectCodexAppServerWebSocket(endpoint, { signal }));

  return async (slot: number): Promise<LocalProfileBinding> => {
    if (!Number.isSafeInteger(slot) || slot < 1 || slot > 99) {
      throw new Error("Native selected account proof requires a valid exact profile slot");
    }
    const first = await adapters.resolveOwnedSession(slot);
    const rpc = await connect(first.terminalEndpoint, AbortSignal.timeout(8000));
    try {
      const one = chatgptSelectedLoginBinding(
        await rpc.request("account/read", { refreshToken: false }, AbortSignal.timeout(8000)),
      );
      return Object.freeze({
        slot,
        accountFingerprint: hmac("selected-native-login-and-routing", one),
        sessionFingerprint: hmac("owned-runtime", `${first.runtimeProcessId}:${first.responsesRouteFingerprint}`),
        routeFingerprint: first.responsesRouteFingerprint,
      });
    } finally {
      await rpc.close();
    }
  };
}
