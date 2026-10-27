import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("ChatGPT Tela menu bar is currently macOS-only");
const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const testMode = process.argv.includes("--test");
const outputIndex = process.argv.indexOf("--output");
const output = resolve(outputIndex >= 0 && process.argv[outputIndex + 1]
  ? process.argv[outputIndex + 1]!
  : resolve(repoRoot, testMode ? "build/work-connection-tests" : "build/chatgpt-tela-menu-bar"));
mkdirSync(dirname(output), { recursive: true });
if (testMode) {
  execFileSync("/usr/bin/xcrun", ["swiftc", "-parse-as-library",
    resolve(repoRoot, "apps/menu-bar-macos/work-connection.swift"),
    resolve(repoRoot, "apps/menu-bar-macos/work-connection-tests.swift"),
    "-framework", "AppKit", "-o", output], { cwd: repoRoot, stdio: "inherit" });
  execFileSync(output, [], { cwd: repoRoot, stdio: "inherit" });
} else {
  // Public dependency: do not consult personal Keychain or netrc credentials.
  execFileSync("/usr/bin/xcrun", ["swift", "build", "--disable-keychain", "--disable-netrc",
    "--package-path", resolve(repoRoot, "apps/menu-bar-macos"), "-c", "release"], { cwd: repoRoot, stdio: "inherit" });
  copyFileSync(resolve(repoRoot, "apps/menu-bar-macos/.build/release/ChatGPTTela"), output);
  copyFileSync(resolve(repoRoot, "apps/menu-bar-macos/.build/release/TelaMaintenance"), resolve(dirname(output), "chatgpt-tela-maintenance"));
  const framework = resolve(dirname(output), "Sparkle.framework");
  rmSync(framework, { recursive: true, force: true });
  cpSync(resolve(repoRoot, "apps/menu-bar-macos/.build/artifacts/sparkle/Sparkle/Sparkle.xcframework/macos-arm64_x86_64/Sparkle.framework"), framework,
    { recursive: true, verbatimSymlinks: true });
  const license = resolve(dirname(output), "Sparkle-LICENSE.txt");
  rmSync(license, { force: true });
  copyFileSync(resolve(repoRoot, "apps/menu-bar-macos/.build/checkouts/Sparkle/LICENSE"), license);
  console.log(output);
}
