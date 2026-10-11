import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
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

  test("explicit setup permits account reuse and swaps without changing another slot", () => {
    const root = mkdtempSync(join(tmpdir(), "chatgpt-tela-account-binding-"));
    try {
      const one = resolveChatGptTelaBrowserProfile({ slot: 1, profileRoot: root });
      const two = resolveChatGptTelaBrowserProfile({ slot: 2, profileRoot: root });
      const accountA = "a".repeat(64);
      const accountB = "b".repeat(64);

      bindChatGptTelaAccount(one, accountA);
      const initialOne = readFileSync(one.accountBindingPath, "utf8");
      bindChatGptTelaAccount(two, accountA);
      expect(assertChatGptTelaAccountBinding(two, accountA).slot).toBe(2);
      expect(readFileSync(one.accountBindingPath, "utf8")).toBe(initialOne);
      bindChatGptTelaAccount(two, accountB);
      expect(assertChatGptTelaAccountBinding(one, accountA).slot).toBe(1);
      expect(assertChatGptTelaAccountBinding(two, accountB).slot).toBe(2);
      expect(() => assertChatGptTelaAccountBinding(two, accountA)).toThrow("different ChatGPT account");
      const initialTwo = readFileSync(two.accountBindingPath, "utf8");
      bindChatGptTelaAccount(one, accountB);
      expect(readFileSync(two.accountBindingPath, "utf8")).toBe(initialTwo);
      bindChatGptTelaAccount(two, accountA);
      expect(assertChatGptTelaAccountBinding(one, accountB).slot).toBe(1);
      expect(assertChatGptTelaAccountBinding(two, accountA).slot).toBe(2);
      expect(() => assertChatGptTelaAccountBinding(one, accountA)).toThrow("different ChatGPT account");
      expect(one.userDataDir).not.toBe(two.userDataDir);
      // An unrelated corrupt binding must not disable this independently owned slot.
      writeFileSync(two.accountBindingPath, "invalid synthetic binding");
      bindChatGptTelaAccount(one, accountB);
      expect(assertChatGptTelaAccountBinding(one, accountB).slot).toBe(1);
      expect(readFileSync(two.accountBindingPath, "utf8")).toBe("invalid synthetic binding");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
