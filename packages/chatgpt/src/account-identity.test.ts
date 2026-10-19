import { expect, test } from "bun:test";
import {
  BROWSER_PAGE_AUTOMATION,
  type BrowserPageAutomation,
  type BrowserSurfaceLease,
} from "@chatgpt-tela/browser-host";
import { ChatGptWebLoginRequiredError, observeChatGptAccountDisplay, observeChatGptAccountIdentity } from "./account-identity";

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
    await expect(observeChatGptAccountIdentity(surface)).rejects.not.toBeInstanceOf(ChatGptWebLoginRequiredError);
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
