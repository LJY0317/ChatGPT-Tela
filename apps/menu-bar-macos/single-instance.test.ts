import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, chmodSync, linkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

(process.platform === "darwin" ? test : test.skip)("native menu bar lock excludes concurrent instances, releases on exit, and preserves unsafe files", async () => {
  const base = mkdtempSync(join(tmpdir(), "tela-menu-lock-"));
  const executable = join(base, "probe");
  const harness = join(base, "probe.swift");
  const path = join(base, "instance.lock");
  let holder: ReturnType<typeof Bun.spawn> | undefined;
  try {
    writeFileSync(harness, `import Foundation\nimport Darwin\n@main struct Probe { static func main() {\nlet lock = TelaMenuBarInstanceLock()\ndo { guard try lock.acquire(at: URL(fileURLWithPath: CommandLine.arguments[1])) else { exit(2) }\nprint("acquired"); fflush(stdout)\nwithExtendedLifetime(lock) { if CommandLine.arguments.count > 2 { _ = readLine() } }\n} catch { exit(3) }\n} }`);
    const compile = spawnSync("/usr/bin/xcrun", ["swiftc", "-parse-as-library", resolve("apps/menu-bar-macos/single-instance.swift"), harness, "-o", executable], { encoding: "utf8" });
    expect(compile.status).toBe(0);
    holder = Bun.spawn([executable, path, "hold"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const first = await (holder.stdout as ReadableStream<Uint8Array>).getReader().read();
    expect(new TextDecoder().decode(first.value)).toContain("acquired");
    expect(spawnSync(executable, [path]).status).toBe(2);
    holder.kill("SIGTERM"); await holder.exited; holder = undefined;
    expect(spawnSync(executable, [path]).status).toBe(0);
    expect(spawnSync(executable, [path]).status).toBe(0);
    writeFileSync(join(base, "private"), "preserved", { mode: 0o600 });
    symlinkSync(join(base, "private"), join(base, "symlink"));
    expect(spawnSync(executable, [join(base, "symlink")]).status).toBe(3);
    expect(readFileSync(join(base, "private"), "utf8")).toBe("preserved");
    chmodSync(path, 0o666);
    expect(spawnSync(executable, [path]).status).toBe(3);
    chmodSync(path, 0o600); linkSync(path, join(base, "hardlink"));
    expect(spawnSync(executable, [path]).status).toBe(3);
  } finally { if (holder) { holder.kill(); await holder.exited; } rmSync(base, { recursive: true, force: true }); }
}, 15000);
