import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("package build rejects a workspace helper for the right OS and wrong CPU", () => {
  const linuxX64 = Buffer.alloc(64);
  linuxX64.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]); // ELF64 little-endian
  linuxX64.writeUInt16LE(62, 18);

  const windowsArm64 = Buffer.alloc(134);
  windowsArm64.write("MZ");
  windowsArm64.writeUInt32LE(128, 0x3c);
  windowsArm64.write("PE\0\0", 128);
  windowsArm64.writeUInt16LE(0xaa64, 132);

  const root = mkdtempSync(join(tmpdir(), "tela-package-helper-target-"));
  try {
    for (const [platform, arch, bytes] of [
      ["linux", "arm64", linuxX64],
      ["win32", "x64", windowsArm64],
    ] as const) {
      const helper = join(root, platform === "win32" ? "helper.exe" : "helper");
      const output = join(root, platform);
      writeFileSync(helper, bytes);
      const result = Bun.spawnSync([
        process.execPath, fileURLToPath(new URL("./main.ts", import.meta.url)),
        "--output", output, "--version", "0.0.0-test", "--target-platform", platform,
        "--target-arch", arch, "--workspace-files", helper,
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain(`Workspace files helper must be built for ${platform}/${arch}`);
      expect(existsSync(output)).toBe(false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
