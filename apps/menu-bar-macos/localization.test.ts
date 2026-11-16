import { test, expect } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("macOS Tela translations come from the shipped .lproj bundle and respect the saved language", () => {
  if (process.platform !== "darwin") return;
  const root = mkdtempSync(join(tmpdir(), "tela-ui-language-"));
  try {
    const executable = join(root, "language-proof");
    const harness = join(root, "main.swift");
    cpSync(resolve("apps/menu-bar-macos/TelaLocalizations.bundle"), join(root, "TelaLocalizations.bundle"), { recursive: true });
    writeFileSync(harness, [
      "import Foundation",
      "@main struct Proof {",
      "  static func main() throws {",
      "    let prefs = URL(fileURLWithPath: CommandLine.arguments[1])",
      "    precondition(telaStoredUILanguage(at: prefs) == .english)",
      "    precondition(telaText(\"Home\") == \"Home\")",
      "    try telaSetUILanguage(.korean, at: prefs)",
      "    precondition(telaStoredUILanguage(at: prefs) == .korean)",
      "    precondition(telaText(\"Home\") == \"홈\")",
      "    precondition(telaText(\"Language\") == \"언어\")",
      "    precondition(telaText(\"Untranslated app text\") == \"Untranslated app text\")",
      "    try telaWritePreference(\"approvalDelay\", value: \"2s\", at: prefs)",
      "    precondition(telaStoredUILanguage(at: prefs) == .korean)",
      "    try telaSetUILanguage(.english, at: prefs)",
      "    precondition(telaText(\"Home\") == \"Home\")",
      "    try telaSetUILanguage(.system, at: prefs)",
      "    precondition(telaStoredUILanguage(at: prefs) == .system)",
      "  }",
      "}",
    ].join("\n"));
    const compile = spawnSync("/usr/bin/xcrun", ["swiftc", "-parse-as-library",
      resolve("apps/menu-bar-macos/localization.swift"), harness, "-o", executable], { encoding: "utf8" });
    expect(compile.status, compile.stderr).toBe(0);
    const run = spawnSync(executable, [join(root, "preferences.json")], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
