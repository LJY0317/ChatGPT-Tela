import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  editAppOwnedDesktopProviderConfig,
  resolveDefaultDesktopInstallation,
  TELA_APP_OWNED_PROVIDER_ID,
} from "@chatgpt-tela/default-desktop-target";
import { readProductConfig } from "@chatgpt-tela/product-config";
import { readPreparedAppOwnedDesktopCatalog } from "@chatgpt-tela/development-runtime/app-owned-desktop-catalog";
import type { ProductPathOptions } from "@chatgpt-tela/product-lifecycle";
import { verifyInstalledPackage } from "./runtime";

/** Public Codex config.toml only. Inputs in product flow come from the verified install receipt. */
export function editOfficialCodexProviderFile(input: {
  readonly configPath: string;
  readonly action: "register" | "restore";
  readonly mode: "dry-run" | "apply";
  readonly installId: string;
  readonly baseUrl: string;
  readonly catalogPath?: string;
}): boolean {
  const configHome = dirname(input.configPath);
  const homeStat = lstatSync(configHome);
  if (homeStat.isSymbolicLink() || !homeStat.isDirectory()) {
    throw new Error("official Codex config home must be a real directory");
  }
  const stat = lstatSync(input.configPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("official Codex config must be a regular file");
  const current = readFileSync(input.configPath, "utf8");
  const result = editAppOwnedDesktopProviderConfig(current, input.action, {
    installId: input.installId, baseUrl: input.baseUrl,
    ...(input.catalogPath ? { catalogPath: input.catalogPath } : {}),
  });
  if (input.mode === "apply" && result.changed) {
    // The user explicitly requested a change. Preserve concurrent modifications
    // when detected instead of silently replacing the whole external config.
    if (readFileSync(input.configPath, "utf8") !== current || lstatSync(input.configPath).ino !== stat.ino) {
      throw new Error("official Codex config changed while preparing provider registration");
    }
    const temporary = join(configHome, `.chatgpt-tela-config-${randomUUID()}.tmp`);
    try {
      // A replacement file must retain the user's existing config permissions.
      writeFileSync(temporary, result.content, { flag: "wx", mode: stat.mode & 0o777 });
      renameSync(temporary, input.configPath);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  return result.changed;
}

/** Explicit user-facing opt-in; never performed by configure, setup or startup. */
export async function runPackagedDesktopProviderCommand(
  args: readonly string[],
  options: {
    readonly payloadRoot: string;
    readonly launcherExecutablePath?: string;
    readonly pathOptions?: ProductPathOptions;
  },
): Promise<{ readonly action: string; readonly changed: boolean; readonly mode: string; readonly providerId: string;
  readonly selection: string }> {
  const action = args[1], mode = args[2];
  if (args.length !== 3 || (action !== "register" && action !== "restore")
    || (mode !== "--dry-run" && mode !== "--apply")) {
    throw new Error("usage: desktop-provider <register|restore> <--dry-run|--apply>");
  }
  const { paths, ownership } = verifyInstalledPackage(options);
  const config = readProductConfig(join(paths.configRoot, "product-v1.json"));
  const owned = config.appOwnedResponses?.find(entry => entry.slot === 1);
  if (!owned) throw new Error("app-owned default Desktop Responses must be explicitly configured first");
  const installation = resolveDefaultDesktopInstallation({
    ...(options.pathOptions?.home ? { home: options.pathOptions.home } : {}),
    environment: options.pathOptions?.environment ?? process.env,
  });
  // Registration consumes the file produced by the verified account-bound
  // profile. It never seeds one from a static model list or a previous cache.
  const catalogPath = action === "register"
    ? readPreparedAppOwnedDesktopCatalog({ paths, installId: ownership.installId })
    : undefined;
  const changed = editOfficialCodexProviderFile({
    configPath: join(installation.codexHome, "config.toml"),
    action,
    mode: mode === "--apply" ? "apply" : "dry-run",
    installId: ownership.installId,
    baseUrl: `http://127.0.0.1:${owned.port}/${owned.capability}/v1`,
    ...(catalogPath ? { catalogPath } : {}),
  });
  return Object.freeze({
    action,
    changed,
    mode: mode.slice(2),
    providerId: TELA_APP_OWNED_PROVIDER_ID,
    selection: "Registration does not change model_provider or the chosen model. "
      + "Select the provider explicitly in user-level Codex settings and normally restart Desktop to apply it.",
  });
}
