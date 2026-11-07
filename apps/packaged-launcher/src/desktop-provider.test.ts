import { expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editOfficialCodexProviderFile } from "./desktop-provider";

test("isolated official config: dry-run, register, idempotent register, restore and user content preservation", () => {
  const root = mkdtempSync(join(tmpdir(), "tela-official-provider-edit-"));
  try {
    const codex = join(root, ".codex");
    mkdirSync(codex);
    const path = join(codex, "config.toml");
    const original = 'model_provider = "openai"\nmodel = "user-model"\n# keep this comment\n';
    writeFileSync(path, original);
    const args = {
      configPath: path,
      installId: "d5c45404-59b6-49a4-995b-8de8dd03cdf0",
      baseUrl: `http://127.0.0.1:18744/${"a".repeat(48)}/v1`,
    };
    expect(editOfficialCodexProviderFile({ ...args, action: "register", mode: "dry-run" })).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(editOfficialCodexProviderFile({ ...args, action: "register", mode: "apply" })).toBe(true);
    expect(editOfficialCodexProviderFile({ ...args, action: "register", mode: "apply" })).toBe(false);
    const added = readFileSync(path, "utf8");
    expect((Bun.TOML.parse(added) as any).model_provider).toBe("openai");
    expect(added).toContain('[model_providers.chatgpt_tela_local]');
    expect(lstatSync(path).mode & 0o077).toBe(0);
    expect(editOfficialCodexProviderFile({ ...args, action: "restore", mode: "dry-run" })).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(added);
    expect(editOfficialCodexProviderFile({ ...args, action: "restore", mode: "apply" })).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(editOfficialCodexProviderFile({ ...args, action: "restore", mode: "apply" })).toBe(false);

    const foreign = join(codex, "external.toml");
    writeFileSync(foreign, "model_provider = \"openai\"\n");
    const linked = join(codex, "linked.toml");
    symlinkSync(foreign, linked);
    expect(() => editOfficialCodexProviderFile({ ...args, configPath: linked, action: "register", mode: "apply" }))
      .toThrow("regular file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
