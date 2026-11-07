import { describe, expect, test } from "bun:test";
import { editAppOwnedDesktopProviderConfig, TELA_APP_OWNED_PROVIDER_ID } from "./provider-configuration";

const owned = {
  installId: "b974fd98-8ead-4aa0-954d-62cce4d23985",
  baseUrl: `http://127.0.0.1:18744/${"a".repeat(48)}/v1/`,
};
const original = [
  '# keep user comment',
  'model_provider = "openai"',
  'model = "user-model"',
  'model_catalog_json = "/user/catalog.json"',
  'openai_base_url = "https://user.example/v1"',
  "[sandbox_workspace_write]",
  'writable_roots = ["/user/extra"]',
  "",
].join("\n");

describe("explicit app-owned official Codex provider registration", () => {
  test("register -> repeat -> restore preserves unrelated user settings byte-for-byte", () => {
    const added = editAppOwnedDesktopProviderConfig(original, "register", owned);
    expect(added.changed).toBe(true);
    expect(added.content).toContain(`[model_providers.${TELA_APP_OWNED_PROVIDER_ID}]`);
    const parsed = Bun.TOML.parse(added.content) as any;
    expect(parsed.model_provider).toBe("openai");
    expect(parsed.model).toBe("user-model");
    expect(parsed.model_catalog_json).toBe("/user/catalog.json");
    expect(parsed.openai_base_url).toBe("https://user.example/v1");
    expect(parsed.sandbox_workspace_write.writable_roots).toEqual(["/user/extra"]);
    expect(parsed.model_providers[TELA_APP_OWNED_PROVIDER_ID]).toEqual({
      name: "ChatGPT Tela (local)",
      base_url: owned.baseUrl.slice(0, -1),
      wire_api: "responses",
      requires_openai_auth: false,
      supports_websockets: false,
    });
    expect(editAppOwnedDesktopProviderConfig(added.content, "register", owned))
      .toEqual({ content: added.content, changed: false });
    const withOther = added.content + '\n[model_providers.another_owner]\nname = "external"\n';
    const restored = editAppOwnedDesktopProviderConfig(withOther, "restore", owned);
    expect(restored.changed).toBe(true);
    expect(restored.content).toBe(original + '\n[model_providers.another_owner]\nname = "external"\n');
    expect(editAppOwnedDesktopProviderConfig(restored.content, "restore", owned).changed).toBe(false);
  });

  test("refuses preexisting provider, other install and changed stanza", () => {
    const foreign = original + `\n[model_providers.${TELA_APP_OWNED_PROVIDER_ID}]\nname = "user owned"\n`;
    expect(() => editAppOwnedDesktopProviderConfig(foreign, "register", owned)).toThrow("refusing");
    expect(() => editAppOwnedDesktopProviderConfig(foreign, "restore", owned)).toThrow("refusing");
    const added = editAppOwnedDesktopProviderConfig(original, "register", owned).content;
    const differentOwner = { ...owned, installId: "1f01709c-0fa2-4f88-b4b3-2d18afac1039" };
    expect(() => editAppOwnedDesktopProviderConfig(added, "restore", differentOwner)).toThrow("refusing");
    const changed = added.replace('supports_websockets = false', 'supports_websockets = true');
    expect(() => editAppOwnedDesktopProviderConfig(changed, "restore", owned)).toThrow("refusing");
    expect(() => editAppOwnedDesktopProviderConfig(changed, "register", owned)).toThrow("refusing");
    const selected = added.replace('model_provider = "openai"', `model_provider = "${TELA_APP_OWNED_PROVIDER_ID}"`);
    expect(() => editAppOwnedDesktopProviderConfig(selected, "restore", owned)).toThrow("Select another");
  });

  test("rejects invalid app-owned URLs, malformed TOML and injected install IDs", () => {
    expect(() => editAppOwnedDesktopProviderConfig(original, "register", {
      ...owned, baseUrl: "https://example.net/v1",
    })).toThrow("fixed app-owned");
    expect(() => editAppOwnedDesktopProviderConfig(original, "register", {
      ...owned, installId: "owner\n[evil]",
    })).toThrow("install ID");
    expect(() => editAppOwnedDesktopProviderConfig("model_provider = [", "register", owned)).toThrow();
  });
});
