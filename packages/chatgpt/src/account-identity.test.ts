import { expect, test } from "bun:test";
import {
  BROWSER_PAGE_AUTOMATION,
  type BrowserPageAutomation,
  type BrowserSurfaceLease,
} from "@chatgpt-tela/browser-host";
import { observeChatGptAccountIdentity } from "./account-identity";

test("ChatGPT account identity exports only a SHA-256 fingerprint from the page", async () => {
  const page: BrowserPageAutomation = {
    async evaluate(functionSource) {
      expect(functionSource).toContain("/api/auth/session");
      expect(functionSource).toContain("crypto.subtle.digest");
      expect(functionSource).toContain("userId");
      expect(functionSource).toContain("accountId");
      return "a".repeat(64) as never;
    },
    async pointerClick() {},
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
  });
});

test("ChatGPT account identity rejects malformed renderer output", async () => {
  const page: BrowserPageAutomation = {
    async evaluate() { return "raw-account-id" as never; },
    async pointerClick() {},
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
