import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, lstatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editOfficialCodexProviderFile } from "./provider-file";

test("isolated official config catalog transaction keeps mode, ownership and foreign values", () => {
  const root = mkdtempSync(join(tmpdir(), "tela-catalog-config-"));
  try {
    const configDir = join(root, ".codex");
    mkdirSync(configDir);
    const configPath = join(configDir, "config.toml");
    const original = 'model_provider = "openai"\n# user-owned comment\n';
    writeFileSync(configPath, original, { mode: 0o640 });
    const owner = {
      configPath, installId: "1cfd5019-a499-43dd-a3a9-8462b0184eaa",
      baseUrl: `http://127.0.0.1:18744/${"a".repeat(48)}/v1`,
      catalogPath: join(root, "owned-native-web.json"),
    };
    expect(editOfficialCodexProviderFile({ ...owner, action: "register", mode: "dry-run", result: "detailed" }))
      .toEqual({ changed: true, catalogStatus: "installed" });
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(editOfficialCodexProviderFile({ ...owner, action: "register", mode: "apply", result: "detailed" }))
      .toEqual({ changed: true, catalogStatus: "installed" });
    expect(editOfficialCodexProviderFile({ ...owner, action: "register", mode: "apply", result: "detailed" }))
      .toEqual({ changed: false, catalogStatus: "already-owned" });
    expect(lstatSync(configPath).mode & 0o777).toBe(0o640);
    const current = readFileSync(configPath, "utf8");
    expect((Bun.TOML.parse(current) as any).model_catalog_json).toBe(owner.catalogPath);
    expect((Bun.TOML.parse(current) as any).model_provider).toBe("openai");
    expect(editOfficialCodexProviderFile({ ...owner, action: "restore", mode: "dry-run", result: "detailed" }))
      .toEqual({ changed: true, catalogStatus: "removed" });
    expect(readFileSync(configPath, "utf8")).toBe(current);
    expect(editOfficialCodexProviderFile({ ...owner, action: "restore", mode: "apply", result: "detailed" }))
      .toEqual({ changed: true, catalogStatus: "removed" });
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(editOfficialCodexProviderFile({ ...owner, action: "restore", mode: "apply", result: "detailed" }))
      .toEqual({ changed: false, catalogStatus: "absent" });

    writeFileSync(configPath, `model_catalog_json = "/user/other.json"\n${original}`);
    expect(editOfficialCodexProviderFile({ ...owner, action: "register", mode: "apply", result: "detailed" }))
      .toEqual({ changed: true, catalogStatus: "foreign-preserved" });
    expect((Bun.TOML.parse(readFileSync(configPath, "utf8")) as any).model_catalog_json).toBe("/user/other.json");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two device homes keep independent provider credentials and catalog paths for one signed-in account", () => {
  const root = mkdtempSync(join(tmpdir(), "tela-two-device-providers-"));
  try {
    const devices = ["device-a", "device-b"].map((name, index) => {
      const home = join(root, name), configDir = join(home, ".codex");
      mkdirSync(configDir, { recursive: true });
      const configPath = join(configDir, "config.toml");
      const original = ['model_provider = "openai"', 'model = "same-account-model"', ''].join("\n");
      writeFileSync(configPath, original);
      return { home, configPath, original, installId: `11111111-2222-4333-8444-55555555555${index}`,
        baseUrl: `http://127.0.0.1:${18744 + index}/${String(index + 1).repeat(48)}/v1`,
        catalogPath: join(home, "state", "owned-models.json") };
    });
    for (const device of devices) {
      expect(editOfficialCodexProviderFile({ ...device, action: "register", mode: "apply", result: "detailed" }))
        .toMatchObject({ changed: true, catalogStatus: "installed" });
    }
    const [a, b] = devices.map(device => readFileSync(device.configPath, "utf8"));
    expect(a).toContain(devices[0]!.baseUrl);
    expect(a).toContain(devices[0]!.catalogPath);
    expect(a).not.toContain(devices[1]!.baseUrl);
    expect(a).not.toContain(devices[1]!.catalogPath);
    expect(b).toContain(devices[1]!.baseUrl);
    expect(b).toContain(devices[1]!.catalogPath);
    expect(b).not.toContain(devices[0]!.baseUrl);
    expect(b).not.toContain(devices[0]!.catalogPath);
    expect(devices.map(device => editOfficialCodexProviderFile({ ...device, action: "restore", mode: "apply", result: "detailed" })))
      .toEqual([{ changed: true, catalogStatus: "removed" }, { changed: true, catalogStatus: "removed" }]);
    for (const device of devices) expect(readFileSync(device.configPath, "utf8")).toBe(device.original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
