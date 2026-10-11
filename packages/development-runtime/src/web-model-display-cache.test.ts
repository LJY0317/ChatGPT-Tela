import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatGptWebFamilyKey } from "@chatgpt-tela/chatgpt";
import { resolveChatGptTelaBrowserProfile, bindChatGptTelaAccount } from "./browser-profile";
import { readWebModelDisplayCache, writeWebModelDisplayCache } from "./web-model-display-cache";

const family = { key: chatGptWebFamilyKey("Fixture Web"), label: "Fixture Web", availableEfforts: ["medium"] as const };
test("display cache expires and never crosses account binding", () => {
  const root = mkdtempSync(join(tmpdir(), "tela-display-cache-"));
  const profile = resolveChatGptTelaBrowserProfile({ slot: 1, profileRoot: root });
  try {
    expect(readWebModelDisplayCache(profile)).toEqual([]);
    bindChatGptTelaAccount(profile, "a".repeat(64));
    expect(writeWebModelDisplayCache(profile, [family], 1000)).toBe(true);
    expect(readWebModelDisplayCache(profile, 2000)).toEqual([family]);
    expect(writeWebModelDisplayCache(profile, [], 2000)).toBe(true);
    expect(readWebModelDisplayCache(profile, 2000)).toEqual([]);
    expect(writeWebModelDisplayCache(profile, [family], 2000)).toBe(true);
    bindChatGptTelaAccount(profile, "b".repeat(64));
    expect(readWebModelDisplayCache(profile, 2000)).toEqual([]);
    expect(writeWebModelDisplayCache(profile, [family], 1000)).toBe(true);
    expect(readWebModelDisplayCache(profile, 1000 + 25 * 60 * 60 * 1000)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("malformed or oversized cache cannot block Native startup", () => {
  const root = mkdtempSync(join(tmpdir(), "tela-display-cache-"));
  const profile = resolveChatGptTelaBrowserProfile({ slot: 1, profileRoot: root });
  try {
    bindChatGptTelaAccount(profile, "a".repeat(64));
    expect(writeWebModelDisplayCache(profile, [family])).toBe(true);
    writeFileSync(join(profile.userDataDir, "web-model-display-v1.json"), "x".repeat(65537));
    expect(readWebModelDisplayCache(profile)).toEqual([]);
    expect(writeWebModelDisplayCache(profile, [{ ...family, key: "wrong" }])).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
