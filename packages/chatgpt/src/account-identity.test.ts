import { expect, test } from "bun:test";
import {
  BROWSER_PAGE_AUTOMATION,
  type BrowserPageAutomation,
  type BrowserSurfaceLease,
} from "@chatgpt-tela/browser-host";
import { ChatGptWebLoginRequiredError, observeChatGptAccountDisplay, observeChatGptAccountIdentity } from "./account-identity";
import { observeDiagnosticEvents, type StructuralDiagnosticEvent } from "@chatgpt-tela/core";

test("identity timeout records fetch deadline separately from external evaluation abort", async () => {
  const rows: StructuralDiagnosticEvent[] = [];
  const stop = observeDiagnosticEvents(row => rows.push(row));
  const surface = (evaluate: BrowserPageAutomation["evaluate"]) => ({ capability: () => ({ evaluate }) }) as unknown as BrowserSurfaceLease;
  try {
    const timedOut = surface(async source => {
      const run = new Function("fetch", "location", `return (${source})();`);
      return run((_url: string, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }), { origin: "https://chatgpt.com" });
    });
    await expect(observeChatGptAccountIdentity(timedOut, undefined, { leaseAcquireDurationMs: 12 })).rejects.toThrow();
    expect(rows.at(-1)).toMatchObject({ reason_class: "probe_timeout", cancellation_source: "fetch_deadline", lease_acquire_duration_ms: 12 });
    expect(rows.at(-1)?.fetch_duration_ms).toBeGreaterThanOrEqual(4900);

    const controller = new AbortController();
    const externallyAborted = surface(async (_source, _argument, signal) => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    await expect(observeChatGptAccountIdentity(externallyAborted, controller.signal)).rejects.toThrow();
    expect(rows.at(-1)).toMatchObject({ reason_class: "observation_aborted", cancellation_source: "external_signal" });
    expect(rows.at(-1)).not.toHaveProperty("fetch_duration_ms");
    const unknownAbort = surface(async () => { throw new DOMException("aborted", "AbortError"); });
    await expect(observeChatGptAccountIdentity(unknownAbort)).rejects.toThrow();
    expect(rows.at(-1)).toMatchObject({ reason_class: "observation_aborted", cancellation_source: "unknown" });
  } finally { stop?.(); }
}, 10000);

test("schema failure preserves presence evidence without account values", async () => {
  const rows: StructuralDiagnosticEvent[] = [];
  const stop = observeDiagnosticEvents(row => rows.push(row));
  const page = { async evaluate(source: string) {
    const run = new Function("fetch", "location", "crypto", `return (${source})();`);
    return run(async () => ({ status: 200, ok: true, url: "https://chatgpt.com/api/auth/session",
      async json() { return { user: { id: "private-auth-canary", email: "private@example.invalid" } }; } }),
      { origin: "https://chatgpt.com" }, crypto);
  } } as unknown as BrowserPageAutomation;
  try {
    await expect(observeChatGptAccountIdentity({ capability: () => page } as unknown as BrowserSurfaceLease))
      .rejects.not.toBeInstanceOf(ChatGptWebLoginRequiredError);
    expect(rows.at(-1)).toMatchObject({ reason_class: "invalid_session_shape", http_status: 200,
      user_present: true, user_key_valid: true, account_present: false, account_key_valid: false });
    expect(JSON.stringify(rows)).not.toContain("private-auth-canary");
    expect(JSON.stringify(rows)).not.toContain("private@example.invalid");
  } finally { stop?.(); }
});

test("session authentication is explicit, bounded and never inferred from transport failure", async () => {
  let status = 200, body: unknown = {}, url = "https://chatgpt.com/api/auth/session";
  const page = { async evaluate(source: string) {
    const run = new Function("fetch", "location", "crypto", `return (${source})();`);
    return run(async () => ({ status, ok: status >= 200 && status < 300, url, async json() { return body; } }),
      { origin: "https://chatgpt.com" }, crypto);
  } } as unknown as BrowserPageAutomation;
  const surface = { capability: () => page } as unknown as BrowserSurfaceLease;
  for (const signedOut of [{}, null, { user: null }]) {
    body = signedOut;
    await expect(observeChatGptAccountIdentity(surface)).rejects.toBeInstanceOf(ChatGptWebLoginRequiredError);
    expect(await observeChatGptAccountDisplay(surface)).toEqual({ state: "signed-out" });
  }
  status = 401; body = { ignored: true };
  await expect(observeChatGptAccountIdentity(surface)).rejects.toBeInstanceOf(ChatGptWebLoginRequiredError);
  for (const unavailable of [429, 503]) {
    status = unavailable;
    await expect(observeChatGptAccountIdentity(surface)).rejects.toThrow("ChatGPT account identity is unavailable");
    await expect(observeChatGptAccountDisplay(surface)).rejects.toThrow();
  }
  status = 200; body = { unexpected: true };
  await expect(observeChatGptAccountIdentity(surface)).rejects.not.toBeInstanceOf(ChatGptWebLoginRequiredError);
  url = "https://example.invalid/api/auth/session"; status = 401;
  await expect(observeChatGptAccountIdentity(surface)).rejects.not.toBeInstanceOf(ChatGptWebLoginRequiredError);
  await expect(observeChatGptAccountDisplay(surface)).rejects.toThrow();
});

test("display-only email observation never changes authentication and rejects unsafe renderer values", async () => {
  let value: unknown = { state: "signed-in", email: "user@example.invalid" };
  const page = { async evaluate(source: string) {
    expect(source).toContain("/api/auth/session"); expect(source).toContain('cache: "no-store"');
    expect(source).not.toContain("logout"); expect(source).not.toContain("document.cookie");
    return value;
  } } as unknown as BrowserPageAutomation;
  const surface = { capability: () => page } as unknown as BrowserSurfaceLease;
  expect(await observeChatGptAccountDisplay(surface)).toEqual({ state: "signed-in", email: "user@example.invalid" });
  for (const invalid of [{ state: "signed-in", email: "user\r@example.invalid" }, { state: "signed-out", email: "user@example.invalid" }, { state: "unknown" }]) {
    value = invalid; await expect(observeChatGptAccountDisplay(surface)).rejects.toThrow("Invalid");
  }
  value = { state: "signed-out" };
  expect(await observeChatGptAccountDisplay(surface)).toEqual({ state: "signed-out" });
});

test("ChatGPT account identity exports only SHA-256 fingerprints plus coarse account structure from the page", async () => {
  const page: BrowserPageAutomation = {
    async evaluate(functionSource) {
      expect(functionSource).toContain("/api/auth/session");
      expect(functionSource).toContain("crypto.subtle.digest");
      expect(functionSource).toContain("userId");
      expect(functionSource).toContain("accountId");
      return {
        state: "signed-in", reasonClass: "verified", httpStatus: 200,
        accountFingerprint: "a".repeat(64),
        containerFingerprint: "b".repeat(64),
        accountStructure: "workspace",
      } as never;
    },
      async pointerClick() {},
      async typeFocusedEditable() {},
      async pressKey() {},
      async clearFocusedEditable() {},
    async mutationRevision() { return 0; },
    async waitForDomMutation() { return 1; },
  };
  const surface: BrowserSurfaceLease = {
    leaseId: "lease-1",
    taskId: "task-1",
    epochId: "epoch-1",
    async navigate() {},
    async reveal() {},
    async hide() {},
    capability(capability) {
      return capability === BROWSER_PAGE_AUTOMATION ? page as never : undefined;
    },
  };

  expect(await observeChatGptAccountIdentity(surface)).toEqual({
    accountFingerprint: "a".repeat(64),
    containerFingerprint: "b".repeat(64),
    accountStructure: "workspace",
  });
});

test("ChatGPT account identity rejects malformed renderer output", async () => {
  const page: BrowserPageAutomation = {
    async evaluate() {
      return {
        state: "signed-in", reasonClass: "verified", httpStatus: 200,
        accountFingerprint: "raw-account-id",
        containerFingerprint: "also-raw",
        accountStructure: "personal",
      } as never;
    },
      async pointerClick() {},
      async typeFocusedEditable() {},
      async pressKey() {},
      async clearFocusedEditable() {},
    async mutationRevision() { return 0; },
    async waitForDomMutation() { return 1; },
  };
  const surface: BrowserSurfaceLease = {
    leaseId: "lease-1",
    taskId: "task-1",
    epochId: "epoch-1",
    async navigate() {},
    async reveal() {},
    async hide() {},
    capability(capability) {
      return capability === BROWSER_PAGE_AUTOMATION ? page as never : undefined;
    },
  };

  await expect(observeChatGptAccountIdentity(surface)).rejects.toThrow("invalid fingerprint");
});
