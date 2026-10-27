import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  throw new Error("ChatGPT Tela menu bar development start is currently macOS-only");
}

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const executable = resolve(repoRoot, "build/chatgpt-tela-menu-bar");

// The native instance lock owns exclusion and reopening of an existing menu.
execFileSync("bun", ["run", "apps/menu-bar-macos/build.ts"], {
  cwd: repoRoot,
  stdio: "inherit",
});

const child = spawn(executable, [], {
  cwd: repoRoot,
  detached: true,
  stdio: "ignore",
});
child.unref();
console.log(JSON.stringify({ started: true, pid: child.pid, executable }));
