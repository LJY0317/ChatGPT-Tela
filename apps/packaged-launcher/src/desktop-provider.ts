import { join, resolve } from "node:path";
import {
  editOfficialCodexProviderFile,
  officialCodexConfigPath,
  TELA_APP_OWNED_PROVIDER_ID,
} from "@chatgpt-tela/default-desktop-target";
import { readProductConfig, writeProductConfig } from "@chatgpt-tela/product-config";
import { appOwnedDesktopCatalogPath, readPreparedAppOwnedDesktopCatalog } from "@chatgpt-tela/development-runtime/app-owned-desktop-catalog";
import type { ProductPathOptions } from "@chatgpt-tela/product-lifecycle";
import { verifyInstalledPackage } from "./runtime";

export { editOfficialCodexProviderFile } from "@chatgpt-tela/default-desktop-target";

/** Explicit user-facing opt-in; never performed by configure, setup or startup. */
export async function runPackagedDesktopProviderCommand(
  args: readonly string[],
  options: {
    readonly payloadRoot: string;
    readonly launcherExecutablePath?: string;
    readonly pathOptions?: ProductPathOptions;
  },
): Promise<{ readonly action: string; readonly changed: boolean; readonly catalogStatus: string; readonly mode: string; readonly providerId: string;
  readonly selection: string }> {
  const action = args[1], mode = args[2];
  const rest = args.slice(3);
  const optionsByName = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]!, value = rest[i + 1];
    if (!["--slot", "--config-file"].includes(key) || !value || optionsByName.has(key)) throw Error("Invalid Desktop provider option");
    optionsByName.set(key, value);
  }
  const slot = Number(optionsByName.get("--slot") ?? "1");
  if (!Number.isSafeInteger(slot) || slot < 1 || slot > 99) throw Error("Invalid Desktop provider slot");
  if ((action !== "register" && action !== "restore")
    || (mode !== "--dry-run" && mode !== "--apply")) {
    throw new Error("usage: desktop-provider <register|restore> <--dry-run|--apply>");
  }
  const { paths, ownership } = verifyInstalledPackage(options);
  const productPath = join(paths.configRoot, "product-v1.json");
  const config = readProductConfig(productPath);
  const owned = config.appOwnedResponses?.find(entry => entry.slot === slot);
  if (!owned) throw new Error("app-owned Responses must be explicitly configured for the selected slot first");
  // Register consumes current account-bound production output; restore can
  // identify the owned path even after the producer has stopped.
  const explicitConfig = optionsByName.get("--config-file");
  const configPath = explicitConfig ? resolve(explicitConfig) : owned.desktopConfigPath ?? (slot === 1 ? officialCodexConfigPath(options.pathOptions?.home) : undefined);
  if (!configPath) throw Error("Select the additional Desktop profile's config.toml explicitly with --config-file; Plura v2 does not disclose private profile paths");
  if (owned.desktopConfigPath && owned.desktopConfigPath !== configPath) throw Error("Restore the existing owned registration before choosing another config file");
  const catalogPath = action === "register"
    ? readPreparedAppOwnedDesktopCatalog({ paths, installId: ownership.installId, slot })
    : appOwnedDesktopCatalogPath(paths, slot);
  // Retain only an explicit restoration reference, never ownership of the user's file.
  if (mode === "--apply" && action === "register" && explicitConfig && owned.desktopConfigPath !== configPath) {
    writeProductConfig({ ...config, appOwnedResponses: config.appOwnedResponses!.map(route => route.slot === slot ? { ...route, desktopConfigPath: configPath } : route) }, productPath);
  }
  const result = editOfficialCodexProviderFile({
    configPath,
    action,
    mode: mode === "--apply" ? "apply" : "dry-run",
    installId: ownership.installId,
    baseUrl: `http://127.0.0.1:${owned.port}/${owned.capability}/v1`,
    catalogPath,
    result: "detailed",
  });
  if (mode === "--apply" && action === "restore" && owned.desktopConfigPath
    && ["removed", "absent", "not-requested"].includes(result.catalogStatus)) {
    writeProductConfig({ ...config, appOwnedResponses: config.appOwnedResponses!.map(route => {
      if (route.slot !== slot) return route;
      const { desktopConfigPath: _registered, ...remaining } = route;
      return remaining;
    }) }, productPath);
  }
  return Object.freeze({
    action,
    changed: result.changed,
    catalogStatus: result.catalogStatus,
    mode: mode.slice(2),
    providerId: TELA_APP_OWNED_PROVIDER_ID,
    selection: `Registration does not change model_provider or the chosen model. Catalog: ${result.catalogStatus}. `
      + "Select the provider explicitly in user-level Codex settings and normally restart Desktop to apply it.",
  });
}
