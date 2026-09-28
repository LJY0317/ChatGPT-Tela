import { expect, test } from "bun:test";
import {
  BROWSER_PAGE_AUTOMATION,
  type BrowserPageAutomation,
  type BrowserSurfaceLease,
} from "@chatgpt-tela/browser-host";
import { observeChatGptAccountIdentity } from "./account-identity";

test("ChatGPT account identity exports only SHA-256 fingerprints plus coarse account structure from the page", async () => {
  const page: BrowserPageAutomation = {
    async evaluate(functionSource) {
      expect(functionSource).toContain("/api/auth/session");
      expect(functionSource).toContain("crypto.subtle.digest");
      expect(functionSource).toContain("userId");
      expect(functionSource).toContain("accountId");
      return {
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
