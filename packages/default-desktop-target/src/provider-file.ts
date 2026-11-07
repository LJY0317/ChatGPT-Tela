import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { editAppOwnedDesktopProviderConfig, type AppOwnedProviderRegistration } from "./provider-configuration";

/** The official Desktop uses the same user-level Codex home as its launcher. */
export function officialCodexConfigPath(home?: string): string {
  return join(resolve(home ?? homedir()), ".codex", "config.toml");
}

/** Shared file operation for explicit registration and the owned uninstall lifecycle. */
export function editOfficialCodexProviderFile(input: AppOwnedProviderRegistration & {
  readonly configPath: string;
  readonly action: "register" | "restore";
  readonly mode: "dry-run" | "apply";
  readonly restoreSelected?: boolean;
}): boolean {
  const configHome = dirname(input.configPath);
  const homeStat = lstatSync(configHome);
  if (homeStat.isSymbolicLink() || !homeStat.isDirectory()) {
    throw new Error("official Codex config home must be a real directory");
  }
  const stat = lstatSync(input.configPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("official Codex config must be a regular file");
  const current = readFileSync(input.configPath, "utf8");
  const result = editAppOwnedDesktopProviderConfig(current, input.action, input, {
    restoreSelected: input.restoreSelected === true,
  });
  if (input.mode === "apply" && result.changed) {
    if (readFileSync(input.configPath, "utf8") !== current || lstatSync(input.configPath).ino !== stat.ino) {
      throw new Error("official Codex config changed while preparing provider registration");
    }
    const temporary = join(configHome, `.chatgpt-tela-config-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, result.content, { flag: "wx", mode: stat.mode & 0o777 });
      renameSync(temporary, input.configPath);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  return result.changed;
}
