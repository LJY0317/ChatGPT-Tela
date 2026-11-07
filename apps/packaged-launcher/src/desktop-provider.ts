import { join } from "node:path";
import {
  editOfficialCodexProviderFile,
  officialCodexConfigPath,
  TELA_APP_OWNED_PROVIDER_ID,
} from "@chatgpt-tela/default-desktop-target";
import { readProductConfig } from "@chatgpt-tela/product-config";
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
  const changed = editOfficialCodexProviderFile({
    configPath: officialCodexConfigPath(options.pathOptions?.home),
    action,
    mode: mode === "--apply" ? "apply" : "dry-run",
    installId: ownership.installId,
    baseUrl: `http://127.0.0.1:${owned.port}/${owned.capability}/v1`,
  });
  return Object.freeze({
    action,
    changed,
    mode: mode.slice(2),
    providerId: TELA_APP_OWNED_PROVIDER_ID,
    selection: "Registration does not change model_provider, the chosen model, or model_catalog_json. "
      + "Select the provider explicitly in user-level Codex settings and normally restart Desktop to apply it.",
  });
}
