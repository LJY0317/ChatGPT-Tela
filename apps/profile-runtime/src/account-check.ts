import { createHash } from "node:crypto";
import type { ChatGptAccountIdentity } from "@chatgpt-tela/chatgpt";
import type { CodexAccountCheckContract } from "@chatgpt-tela/service-protocol";

/** Shared workspace identity never establishes the same human user or Desktop UI session. */
export type AccountCheck = Omit<CodexAccountCheckContract, "contractVersion" | "slot">;

/** One coalesced on-demand observation. Never returns identities or changes authentication. */
export function createAccountCheck(input: {
  readonly native: (signal: AbortSignal) => Promise<unknown>;
  readonly web: (signal: AbortSignal) => Promise<ChatGptAccountIdentity>;
  readonly binding: () => string | undefined;
  readonly signal?: AbortSignal;
}): () => Promise<AccountCheck> {
  let pending: Promise<AccountCheck> | undefined;
  return () => {
    if (pending) return pending;
    pending = (async () => {
      const timeout = AbortSignal.timeout(15_000);
      const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
      const [native, web] = await Promise.allSettled([
        observeAccountRead(signal, () => input.native(signal)), observeAccountRead(signal, () => input.web(signal)),
      ]);
      let nativeSignIn: AccountCheck["nativeSignIn"] = "unavailable";
      let nativeContainer: string | undefined;
      if (native.status === "fulfilled" && native.value && typeof native.value === "object") {
        const row = native.value as {account?: {type?: string} | null; workspaceRouting?: {chatgptAccountId?: unknown}};
        if (row.account === null) nativeSignIn = "signed-out";
        else if (row.account?.type === "chatgpt") {
          nativeSignIn = "signed-in";
          const id = row.workspaceRouting?.chatgptAccountId;
          if (typeof id === "string" && id.length > 0 && id.length <= 256) {
            nativeContainer = createHash("sha256").update(id).digest("hex");
          }
        }
      }
      let webBinding: AccountCheck["webBinding"] = "unavailable";
      let nativeWebContainer: AccountCheck["nativeWebContainer"] = "unavailable";
      if (web.status === "fulfilled" && /^[a-f0-9]{64}$/.test(web.value.accountFingerprint)
        && /^[a-f0-9]{64}$/.test(web.value.containerFingerprint)) {
        try {
          const binding = input.binding();
          webBinding = binding === undefined ? "unbound" : binding === web.value.accountFingerprint ? "matching" : "different";
        } catch { /* Invalid binding is unavailable, never matching. */ }
        if (nativeContainer) nativeWebContainer = nativeContainer === web.value.containerFingerprint ? "matching" : "different";
      }
      return Object.freeze({ nativeSignIn, webBinding, nativeWebContainer, userIdentity: "unverified" as const });
    })().finally(() => { pending = undefined; });
    return pending;
  };
}

/** Abort must settle the endpoint even if an observer fails to honor cancellation. */
export async function observeAccountRead<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return read();
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
