import { emitDiagnosticEvent } from "@chatgpt-tela/core";
import { accountDisplayEmail, compareAccountDisplayEmails, type CodexAccountDisplayContract } from "@chatgpt-tela/service-protocol";
import { observeAccountRead } from "./account-check";

export type AccountDisplay = Omit<CodexAccountDisplayContract, "contractVersion" | "slot">;

/** On-demand only. Emails live in this response, never in persistent state or diagnostics. */
export function createAccountDisplay(input: {
  readonly native: (signal: AbortSignal) => Promise<unknown>;
  readonly web: (signal: AbortSignal) => Promise<AccountDisplay["web"]>;
  readonly signal: AbortSignal;
  readonly revision: () => number;
}): () => Promise<AccountDisplay> {
  let pending: Promise<AccountDisplay> | undefined;
  return () => {
    if (pending) return pending;
    const revision = input.revision();
    pending = (async () => {
      const signal = AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]);
      const [nativeResult, webResult] = await Promise.allSettled([
        observeAccountRead(signal, () => input.native(signal)), observeAccountRead(signal, () => input.web(signal)),
      ]);
      let native: AccountDisplay["native"] = { state: "unavailable" };
      let web: AccountDisplay["web"] = { state: "unavailable" };
      if (!signal.aborted && revision === input.revision()) {
        if (nativeResult.status === "fulfilled" && nativeResult.value && typeof nativeResult.value === "object") {
          const account = (nativeResult.value as { account?: { type?: unknown; email?: unknown } | null }).account;
          if (account === null) native = { state: "signed-out" };
          else if (account?.type === "chatgpt") {
            const email = accountDisplayEmail(account.email);
            native = { state: "signed-in", ...(email ? { email } : {}) };
          }
        }
        if (webResult.status === "fulfilled") {
          const email = accountDisplayEmail(webResult.value.email);
          web = { state: webResult.value.state, ...(webResult.value.state === "signed-in" && email ? { email } : {}) };
        }
      }
      const comparison = compareAccountDisplayEmails(native.email, web.email);
      emitDiagnosticEvent("chatgpt_tela_profile_startup", "account_display_observed", {
        native_signin: native.state, web_signin: web.state, comparison,
        reason_class: revision === input.revision() ? "current_observation" : "account_changed_during_read",
      });
      return Object.freeze({ native: Object.freeze(native), web: Object.freeze(web), comparison });
    })().finally(() => { pending = undefined; });
    return pending;
  };
}
