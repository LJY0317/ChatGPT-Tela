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
      requires_openai_auth: true,
      supports_websockets: false,
    });
    expect(editAppOwnedDesktopProviderConfig(added.content, "register", owned))
      .toEqual({ content: added.content, changed: false, catalogStatus: "not-requested" });
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
    const profileSelected = added + `\n[profiles.work]\nmodel_provider = "${TELA_APP_OWNED_PROVIDER_ID}"\n`;
    expect(() => editAppOwnedDesktopProviderConfig(profileSelected, "restore", owned)).toThrow("Select another");
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
  test("uninstall restores selected root and named profile providers to official openai without touching other settings", () => {
    const added = editAppOwnedDesktopProviderConfig(original, "register", owned).content;
    const selected = added.replace('model_provider = "openai"', `model_provider = "${TELA_APP_OWNED_PROVIDER_ID}"`)
      .replace('model = "user-model"', 'model = "chatgpt-tela-web/family/synthetic" # keep model comment')
      + `\n[profiles.work]\nmodel_provider = "${TELA_APP_OWNED_PROVIDER_ID}" # custom comment\nmodel = "keep"\n`
      + '\n[profiles.other]\nmodel_provider = "custom"\n';
    const planned = editAppOwnedDesktopProviderConfig(selected, "restore", owned, { restoreSelected: true });
    expect(planned.changed).toBe(true);
    expect(planned.content).toContain('model_provider = "openai"');
    expect(planned.content).not.toContain('chatgpt-tela-web/family/synthetic');
    expect(planned.content).toContain('# keep model comment');
    expect(planned.content).toContain('model_provider = "openai" # custom comment');
    expect(planned.content).toContain('model = "keep"');
    expect(planned.content).toContain('model_provider = "custom"');
    expect(planned.content).not.toContain(`[model_providers.${TELA_APP_OWNED_PROVIDER_ID}]`);
    expect(editAppOwnedDesktopProviderConfig(planned.content, "restore", owned, { restoreSelected: true }).changed).toBe(false);
    expect(() => editAppOwnedDesktopProviderConfig('model_provider = "chatgpt_tela_local"\n', "restore", owned,
      { restoreSelected: true })).toThrow("remains selected");
  });
});

describe("owned top-level startup model catalog", () => {
  const catalogPath = "/isolated/owned/native-web-models.json";
  const registration = { ...owned, catalogPath };
  const plain = 'model_provider = "openai"\nmodel = "native-choice"\n# user comment\n\n[profiles.work]\nmodel_provider = "openai"\n';

  test("register, repeat, restore exact owned top-level catalog while preserving choices and comments", () => {
    const installed = editAppOwnedDesktopProviderConfig(plain, "register", registration);
    expect(installed.catalogStatus).toBe("installed");
    expect(installed.content.indexOf("model_catalog_json")).toBeLessThan(installed.content.indexOf("[profiles.work]"));
    const parsed = Bun.TOML.parse(installed.content) as Record<string, any>;
    expect(parsed.model_catalog_json).toBe(catalogPath);
    expect(parsed.model_provider).toBe("openai");
    expect(parsed.model).toBe("native-choice");
    expect(parsed.profiles.work.model_provider).toBe("openai");
    expect(editAppOwnedDesktopProviderConfig(installed.content, "register", registration))
      .toMatchObject({ content: installed.content, changed: false, catalogStatus: "already-owned" });
    const restored = editAppOwnedDesktopProviderConfig(installed.content, "restore", owned);
    expect(restored).toEqual({ content: plain, changed: true, catalogStatus: "removed" });
    expect(editAppOwnedDesktopProviderConfig(restored.content, "restore", owned).changed).toBe(false);
  });

  test("foreign catalog remains untouched and registration reports no automatic catalog connection", () => {
    const foreign = 'model_catalog_json = "/user/catalog.json"\n' + plain;
    const installed = editAppOwnedDesktopProviderConfig(foreign, "register", registration);
    expect(installed.catalogStatus).toBe("foreign-preserved");
    expect((Bun.TOML.parse(installed.content) as any).model_catalog_json).toBe("/user/catalog.json");
    expect(editAppOwnedDesktopProviderConfig(installed.content, "restore", registration))
      .toMatchObject({ content: foreign, catalogStatus: "foreign-preserved" });
  });

  test("user-modified owned catalog is preserved when restoring exact provider", () => {
    const installed = editAppOwnedDesktopProviderConfig(plain, "register", registration).content;
    const changed = installed.replace(catalogPath, "/user/new-catalog.json");
    const restored = editAppOwnedDesktopProviderConfig(changed, "restore", registration);
    expect(restored.catalogStatus).toBe("modified-preserved");
    expect(restored.content).toContain('model_catalog_json = "/user/new-catalog.json"');
    expect(restored.content).not.toContain("[model_providers.chatgpt_tela_local]");
  });

  test("provider registration without catalog stays supported", () => {
    const installed = editAppOwnedDesktopProviderConfig(plain, "register", owned);
    expect(installed.catalogStatus).toBe("not-requested");
    expect((Bun.TOML.parse(installed.content) as any).model_catalog_json).toBeUndefined();
    expect(editAppOwnedDesktopProviderConfig(installed.content, "restore", owned).content).toBe(plain);
  });

  test("an unchanged owned catalog remains removable after the provider stanza was removed separately", () => {
    const installed = editAppOwnedDesktopProviderConfig(plain, "register", registration).content;
    const providerOnly = editAppOwnedDesktopProviderConfig(plain, "register", owned).content.slice(plain.length);
    const withoutProvider = installed.replace(providerOnly, "");
    expect(editAppOwnedDesktopProviderConfig(withoutProvider, "restore", owned))
      .toEqual({ content: plain, changed: true, catalogStatus: "removed" });
  });

  test("Windows absolute owned paths work and relative paths are rejected", () => {
    const windows = { ...registration, catalogPath: "C:\\Tela\\owned-models.json" };
    const installed = editAppOwnedDesktopProviderConfig(plain, "register", windows);
    expect((Bun.TOML.parse(installed.content) as any).model_catalog_json).toBe(windows.catalogPath);
    expect(editAppOwnedDesktopProviderConfig(installed.content, "restore", windows).content).toBe(plain);
    expect(() => editAppOwnedDesktopProviderConfig(plain, "register", {
      ...registration, catalogPath: "relative-models.json",
    })).toThrow("absolute catalog path");
  });
});
