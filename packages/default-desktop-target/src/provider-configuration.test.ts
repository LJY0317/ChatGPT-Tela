import { describe, expect, test } from "bun:test";
import { editAppOwnedDesktopProviderConfig } from "./provider-configuration";

const owned = { installId: "b974fd98-8ead-4aa0-954d-62cce4d23985",
  baseUrl: `http://127.0.0.1:18744/${"a".repeat(48)}/v1/` };
const original = '# keep user comment\nmodel_provider = "openai"\nmodel = "user-model"\n[sandbox_workspace_write]\nwritable_roots = ["/user/extra"]\n';

// Historic on-disk shape, used only to verify one-time removal, never registration.
function retiredConfig() {
  return [original, `# ChatGPT Tela provider begin: ${owned.installId}`,
    '[model_providers.chatgpt_tela_local]', 'name = "ChatGPT Tela (local)"',
    `base_url = ${JSON.stringify(owned.baseUrl.slice(0, -1))}`, 'wire_api = "responses"',
    'requires_openai_auth = true', 'supports_websockets = false',
    `# ChatGPT Tela provider end: ${owned.installId}`, ''].join('\n');
}

describe("owned built-in OpenAI routing", () => {
  test("register/repeat/restore preserves provider identity and unrelated settings exactly", () => {
    const added = editAppOwnedDesktopProviderConfig(original, "register", owned);
    const parsed = Bun.TOML.parse(added.content) as any;
    expect(parsed.model_provider).toBe("openai");
    expect(parsed.openai_base_url).toBe(owned.baseUrl.slice(0, -1));
    expect(parsed.model).toBe("user-model");
    expect(parsed.model_providers).toBeUndefined();
    expect(parsed.sandbox_workspace_write.writable_roots).toEqual(["/user/extra"]);
    expect(editAppOwnedDesktopProviderConfig(added.content, "register", owned).changed).toBe(false);
    expect(editAppOwnedDesktopProviderConfig(added.content, "restore", owned).content).toBe(original);
    expect(editAppOwnedDesktopProviderConfig(original, "restore", owned).changed).toBe(false);
    const userReference = added.content + `\n[profiles.manual]\nopenai_base_url = ${JSON.stringify(owned.baseUrl.slice(0, -1))}\n`;
    expect(() => editAppOwnedDesktopProviderConfig(userReference, "restore", owned)).toThrow("user-owned named profile");
  });

  test("foreign router/provider and changed ownership cannot be overwritten", () => {
    const foreign = 'openai_base_url = "https://user.example/v1"\n' + original;
    expect(() => editAppOwnedDesktopProviderConfig(foreign, "register", owned)).toThrow("another router");
    expect(editAppOwnedDesktopProviderConfig(foreign, "restore", owned).content).toBe(foreign);
    expect(() => editAppOwnedDesktopProviderConfig('model_provider = "other"\n', "register", owned)).toThrow("built-in openai");
    const added = editAppOwnedDesktopProviderConfig(original, "register", owned).content;
    expect(() => editAppOwnedDesktopProviderConfig(added, "restore", { ...owned,
      installId: "1f01709c-0fa2-4f88-b4b3-2d18afac1039" })).toThrow("ownership or contents changed");
    const changed = added.replace(owned.baseUrl.slice(0, -1), 'https://user.example/v1');
    expect(() => editAppOwnedDesktopProviderConfig(changed, "restore", owned)).toThrow("ownership or contents changed");
  });

  test("retire exact owned private provider, keep Web model on registration, clear it on removal", () => {
    const old = retiredConfig().replace('model_provider = "openai"', 'model_provider = "chatgpt_tela_local"')
      .replace('model = "user-model"', 'model = "chatgpt-tela-web/family/synthetic" # keep comment')
      + '\n[profiles.work]\nmodel_provider = "chatgpt_tela_local"\nmodel = "native-choice"\n';
    const migrated = editAppOwnedDesktopProviderConfig(old, "register", owned).content;
    const parsed = Bun.TOML.parse(migrated) as any;
    expect(parsed.model_provider).toBe("openai");
    expect(parsed.profiles.work.model_provider).toBe("openai");
    expect(parsed.model).toBe('chatgpt-tela-web/family/synthetic');
    expect(migrated).not.toContain('chatgpt_tela_local');
    expect(() => editAppOwnedDesktopProviderConfig(old.replace('[profiles.work]', "[profiles.'work']"), "register", owned)).toThrow("unsupported layout");
    const restored = editAppOwnedDesktopProviderConfig(migrated, "restore", owned).content;
    expect(restored).not.toContain('chatgpt-tela-web/family/');
    expect(restored).toContain('# keep comment');
    expect(restored).toContain('model = "native-choice"');
    expect(restored).not.toContain('openai_base_url');
    expect(() => editAppOwnedDesktopProviderConfig(old.replace('supports_websockets = false', 'supports_websockets = true'), "register", owned)).toThrow("Retired Desktop provider");
  });

  test("restoring clears only Web selections on built-in root and profiles", () => {
    const base = 'model = "chatgpt-tela-web/family/root"\n[profiles.work]\nmodel = "chatgpt-tela-web/family/work"\n[profiles.other]\nmodel_provider = "other"\nmodel = "chatgpt-tela-web/family/foreign"\n';
    const added = editAppOwnedDesktopProviderConfig(base, "register", owned).content;
    const restored = editAppOwnedDesktopProviderConfig(added, "restore", owned).content;
    expect(restored).not.toContain('family/root');
    expect(restored).not.toContain('family/work');
    expect(restored).toContain('family/foreign');
  });

  test("validates local route, install id and TOML", () => {
    expect(() => editAppOwnedDesktopProviderConfig(original, "register", { ...owned, baseUrl: "https://example.net/v1" })).toThrow("fixed app-owned");
    expect(() => editAppOwnedDesktopProviderConfig(original, "register", { ...owned, installId: "owner\n[evil]" })).toThrow("install ID");
    expect(() => editAppOwnedDesktopProviderConfig('model_provider = [', "register", owned)).toThrow();
  });
});

describe("owned model catalog with built-in routing", () => {
  const registration = { ...owned, catalogPath: "/isolated/owned/models.json" };
  test("catalog and route register and restore as one exact transaction", () => {
    const added = editAppOwnedDesktopProviderConfig(original, "register", registration);
    expect(added.catalogStatus).toBe("installed");
    expect((Bun.TOML.parse(added.content) as any).model_catalog_json).toBe(registration.catalogPath);
    expect(editAppOwnedDesktopProviderConfig(added.content, "register", registration).catalogStatus).toBe("already-owned");
    expect(editAppOwnedDesktopProviderConfig(added.content, "restore", registration))
      .toEqual({ content: original, changed: true, catalogStatus: "removed" });
  });
  test("foreign or edited catalogs are preserved independently of the owned route", () => {
    const foreign = 'model_catalog_json = "/user/catalog.json"\n' + original;
    const added = editAppOwnedDesktopProviderConfig(foreign, "register", registration);
    expect(added.catalogStatus).toBe("foreign-preserved");
    expect(editAppOwnedDesktopProviderConfig(added.content, "restore", registration).content).toBe(foreign);
    const edited = editAppOwnedDesktopProviderConfig(original, "register", registration).content
      .replace(registration.catalogPath, '/user/new.json');
    const restored = editAppOwnedDesktopProviderConfig(edited, "restore", registration);
    expect(restored.catalogStatus).toBe("modified-preserved");
    expect(restored.content).toContain('model_catalog_json = "/user/new.json"');
    expect(restored.content).not.toContain('openai_base_url');
  });
  test("Windows catalog paths are valid; relative paths are not", () => {
    const windows = { ...registration, catalogPath: "C:\\Tela\\models.json" };
    const added = editAppOwnedDesktopProviderConfig(original, "register", windows);
    expect(editAppOwnedDesktopProviderConfig(added.content, "restore", windows).content).toBe(original);
    expect(() => editAppOwnedDesktopProviderConfig(original, "register", { ...owned, catalogPath: "relative.json" })).toThrow("absolute catalog");
  });
});
