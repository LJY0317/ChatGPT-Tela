import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createChatToolRuntime } from "./tools";

const executable = resolve(import.meta.dir, "../../../build/workspace-files-target/release/tela-workspace-files" + (process.platform === "win32" ? ".exe" : ""));
const nativeTest = existsSync(executable) ? test : test.skip;
nativeTest("export has exact immutable binary receipt, root identity and containment, no workspace writes", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "tela-export-")));
  const root = join(base, "project"); mkdirSync(root); mkdirSync(join(root, "results"));
  const runtime = createChatToolRuntime({ allowedRoots: [root], stateRoot: join(base, "state"), filePublisherExecutable: executable });
  try {
    expect(runtime.capabilities).not.toContain("export_file");
    await runtime.initialize();
    expect(runtime.capabilities).toContain("export_file");
    const workspace = runtime.workspaces.open(root);
    const bytes = Buffer.from([0, 255, 128, 10]);
    writeFileSync(join(root, "results", "output.bin"), bytes);
    const args = { workspace_id: workspace.id, path: "results/output.bin" };
    const result = await runtime.call("export_file", args) as { dataBase64: string; bytes: number; name: string };
    expect(result).toMatchObject({ name: "output.bin", bytes: bytes.length });
    expect(Buffer.from(result.dataBase64, "base64")).toEqual(bytes);
    expect(readFileSync(join(root, "results", "output.bin"))).toEqual(bytes);
    writeFileSync(join(root, "results", "output.bin"), "later edit");
    expect(Buffer.from(result.dataBase64, "base64")).toEqual(bytes);
    await expect(runtime.call("export_file", { ...args, path: "../outside" })).rejects.toThrow("export failed");
    await expect(runtime.call("export_file", { ...args, workspace_id: "unknown" })).rejects.toThrow();
    writeFileSync(join(root, "big"), Buffer.alloc(2 * 1024 * 1024 + 1));
    await expect(runtime.call("export_file", { ...args, path: "big" })).rejects.toThrow("export failed");
    if (process.platform !== "win32") {
      writeFileSync(join(base, "outside"), "private"); symlinkSync(base, join(root, "escape"));
      await expect(runtime.call("export_file", { ...args, path: "escape/outside" })).rejects.toThrow("export failed");
    }
    renameSync(root, join(base, "original")); mkdirSync(root); mkdirSync(join(root, "results"));
    writeFileSync(join(root, "results", "output.bin"), "replacement");
    await expect(runtime.call("export_file", args)).rejects.toThrow();
  } finally { await runtime.close(); rmSync(base, { recursive: true, force: true }); }
});

test("no native helper means no export capability or delegated download authority", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "tela-no-export-")));
  const runtime = createChatToolRuntime({ allowedRoots: [base], stateRoot: join(base, "state") });
  try {
    await runtime.initialize();
    expect(runtime.capabilities).not.toContain("export_file");
    await expect(runtime.call("export_file", { workspace_id: "unknown", path: "file" })).rejects.toThrow("unavailable");
  } finally { await runtime.close(); rmSync(base, { recursive: true, force: true }); }
});
