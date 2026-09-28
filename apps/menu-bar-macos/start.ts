import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  throw new Error("ChatGPT Tela menu bar development start is currently macOS-only");
}

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const executable = resolve(repoRoot, "build/chatgpt-tela-menu-bar");

execFileSync("bun", ["run", "apps/menu-bar-macos/build.ts"], {
  cwd: repoRoot,
  stdio: "inherit",
});

const commands = execFileSync("/bin/ps", ["-axo", "command="], { encoding: "utf8" })
  .split("\n")
  .map(line => line.trim())
  .filter(Boolean);
if (commands.includes(executable)) {
  console.log(JSON.stringify({ started: false, reason: "already-running", executable }));
  process.exit(0);
}

const child = spawn(executable, [], {
  cwd: repoRoot,
  detached: true,
  stdio: "ignore",
});
child.unref();
console.log(JSON.stringify({ started: true, pid: child.pid, executable }));
