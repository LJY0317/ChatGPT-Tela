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
