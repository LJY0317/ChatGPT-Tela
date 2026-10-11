import { execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  throw new Error("ChatGPT Tela menu bar development start is currently macOS-only");
}

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const executable = resolve(repoRoot, "build/chatgpt-tela-menu-bar");

const commands = execFileSync("/bin/ps", ["-axo", "command="], { encoding: "utf8" })
  .split("\n")
  .map(line => line.trim())
  .filter(Boolean);
const installedBin = resolve(homedir(), "Library/Application Support/ChatGPT Tela/bin");
// Respect an existing installed instance, including versions predating the native lock.
const existing = [executable, resolve(installedBin, "ui/chatgpt-tela-menu-bar"),
  `${resolve(installedBin, "chatgpt-tela")} menu-bar`].find(command => commands.includes(command));
if (existing) {
  console.log(JSON.stringify({ started: false, reason: "already-running" }));
  process.exit(0);
}

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
