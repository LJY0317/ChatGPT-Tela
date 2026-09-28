import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  throw new Error("ChatGPT Tela menu bar is currently macOS-only");
}

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const outputIndex = process.argv.indexOf("--output");
const output = resolve(outputIndex >= 0 && process.argv[outputIndex + 1]
  ? process.argv[outputIndex + 1]!
  : resolve(repoRoot, "build/chatgpt-tela-menu-bar"));
mkdirSync(dirname(output), { recursive: true });
execFileSync("/usr/bin/xcrun", [
  "swiftc",
  "-parse-as-library",
  resolve(repoRoot, "apps/menu-bar-macos/main.swift"),
  "-framework", "AppKit",
  "-o", output,
], { cwd: repoRoot, stdio: "inherit" });
console.log(output);
