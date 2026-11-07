import { join } from "node:path";
import {
  editOfficialCodexProviderFile,
  officialCodexConfigPath,
  TELA_APP_OWNED_PROVIDER_ID,
} from "@chatgpt-tela/default-desktop-target";
import { readProductConfig } from "@chatgpt-tela/product-config";
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
  if (args.length !== 3 || (action !== "register" && action !== "restore")
    || (mode !== "--dry-run" && mode !== "--apply")) {
    throw new Error("usage: desktop-provider <register|restore> <--dry-run|--apply>");
  }
  const { paths, ownership } = verifyInstalledPackage(options);
  const config = readProductConfig(join(paths.configRoot, "product-v1.json"));
  const owned = config.appOwnedResponses?.find(entry => entry.slot === 1);
  if (!owned) throw new Error("app-owned default Desktop Responses must be explicitly configured first");
  // Register consumes current account-bound production output; restore can
  // identify the owned path even after the producer has stopped.
  const catalogPath = action === "register"
    ? readPreparedAppOwnedDesktopCatalog({ paths, installId: ownership.installId })
    : appOwnedDesktopCatalogPath(paths);
  const result = editOfficialCodexProviderFile({
    configPath: officialCodexConfigPath(options.pathOptions?.home),
    action,
    mode: mode === "--apply" ? "apply" : "dry-run",
    installId: ownership.installId,
    baseUrl: `http://127.0.0.1:${owned.port}/${owned.capability}/v1`,
    catalogPath,
    result: "detailed",
  });
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
