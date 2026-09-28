import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  assertChatGptTelaAccountBinding,
  bindChatGptTelaAccount,
  resolveChatGptTelaBrowserProfile,
} from "./browser-profile";

describe("ChatGPT Tela browser profiles", () => {
  test("profile slots derive isolated persistent identities and user-data directories", () => {
    const root = "/tmp/chatgpt-tela-profiles";
    const one = resolveChatGptTelaBrowserProfile({ slot: 1, profileRoot: root });
    const two = resolveChatGptTelaBrowserProfile({ slot: 2, profileRoot: root });
    const resolvedRoot = resolve(root);

    expect(one.profileId).toBe("Profile1-ChatGPT-Tela");
    expect(one.userDataDir).toBe(join(resolvedRoot, "Canary-Profile1"));
    expect(two.profileId).toBe("Profile2-ChatGPT-Tela");
    expect(two.userDataDir).toBe(join(resolvedRoot, "Canary-Profile2"));
    expect(two.userDataDir).not.toBe(one.userDataDir);
    expect(two.accountBindingPath).not.toBe(one.accountBindingPath);
  });

  test("platform defaults keep the same profile-slot isolation contract", () => {
    expect(resolveChatGptTelaBrowserProfile({
      slot: 2,
      platform: "darwin",
      homeDirectory: "/Users/test",
      environment: {},
    }).userDataDir).toBe(join(resolve("/Users/test"), "Library", "Application Support", "ChatGPT Tela", "Canary-Profile2"));
    expect(resolveChatGptTelaBrowserProfile({
      slot: 2,
      platform: "linux",
      homeDirectory: "/home/test",
      environment: {},
    }).userDataDir).toBe(join(resolve("/home/test"), ".config", "ChatGPT Tela", "Canary-Profile2"));
    expect(resolveChatGptTelaBrowserProfile({
      slot: 2,
      platform: "linux",
      profileRoot: "~/custom-tela",
      homeDirectory: "/home/test",
      environment: {},
    }).userDataDir).toBe(join(resolve("/home/test"), "custom-tela", "Canary-Profile2"));
  });

  test("one ChatGPT account fingerprint cannot be bound to two profile slots", () => {
    const root = mkdtempSync(join(tmpdir(), "chatgpt-tela-account-binding-"));
    try {
      const one = resolveChatGptTelaBrowserProfile({ slot: 1, profileRoot: root });
      const two = resolveChatGptTelaBrowserProfile({ slot: 2, profileRoot: root });
      const accountA = "a".repeat(64);
      const accountB = "b".repeat(64);

      bindChatGptTelaAccount(one, accountA);
      expect(() => bindChatGptTelaAccount(two, accountA)).toThrow("must use a different account");
      bindChatGptTelaAccount(two, accountB);
      expect(assertChatGptTelaAccountBinding(one, accountA).slot).toBe(1);
      expect(assertChatGptTelaAccountBinding(two, accountB).slot).toBe(2);
      expect(() => assertChatGptTelaAccountBinding(two, accountA)).toThrow("different ChatGPT account");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
