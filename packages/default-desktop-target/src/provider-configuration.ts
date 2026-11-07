/**
 * Official Codex user-level config.toml provider registration.
 *
 * A dedicated provider is deliberately registered without changing the user's
 * model_provider, model, model_catalog_json or built-in openai_base_url.
 * The owning install ID is already recorded in the product installation receipt.
 * Only the exact, unmodified stanza written by that install can be removed.
 */
export const TELA_APP_OWNED_PROVIDER_ID = "chatgpt_tela_local";

export interface AppOwnedProviderRegistration {
  readonly installId: string;
  readonly baseUrl: string;
}

function registrationBlock(input: AppOwnedProviderRegistration): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.installId)) {
    throw new Error("Desktop provider registration requires a valid install ID");
  }
  const url = new URL(input.baseUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port
    || !/^\/[A-Za-z0-9_-]{43,128}\/v1\/?$/.test(url.pathname)
    || url.username || url.password || url.search || url.hash) {
    throw new Error("Desktop provider registration requires the configured fixed app-owned Responses URL");
  }
  const baseUrl = url.href.replace(/\/$/, "");
  return [
    "",
    `# ChatGPT Tela provider begin: ${input.installId}`,
    `[model_providers.${TELA_APP_OWNED_PROVIDER_ID}]`,
    'name = "ChatGPT Tela (local)"',
    `base_url = ${JSON.stringify(baseUrl)}`,
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "supports_websockets = false",
    `# ChatGPT Tela provider end: ${input.installId}`,
    "",
  ].join("\n");
}

function parsedProviders(content: string): Record<string, unknown> {
  const parsed = Bun.TOML.parse(content) as Record<string, unknown>;
  const providers = parsed.model_providers;
  if (providers === undefined) return {};
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    throw new Error("Codex model_providers is not a table");
  }
  return providers as Record<string, unknown>;
}

function exactOwnedProvider(content: string, registration: AppOwnedProviderRegistration): boolean {
  const provider = parsedProviders(content)[TELA_APP_OWNED_PROVIDER_ID];
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) return false;
  const expected = {
    name: "ChatGPT Tela (local)",
    base_url: new URL(registration.baseUrl).href.replace(/\/$/, ""),
    wire_api: "responses",
    requires_openai_auth: true,
    supports_websockets: false,
  };
  const record = provider as Record<string, unknown>;
  return Object.keys(record).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, value]) => record[key] === value);
}

/** On uninstall, an explicitly selected Tela provider falls back to Codex's built-in openai provider. */
function restoreSelection(content: string, selected: boolean, selectedProfiles: readonly string[]): string {
  if (!selected && selectedProfiles.length === 0) return content;
  let section = "";
  let replaced = 0;
  const next = content.split(/(?<=\n)/).map(line => {
    const heading = /^\s*\[([^\]\r\n]+)\]/.exec(line);
    if (heading) section = heading[1]!;
    const target = section === "" && selected || selectedProfiles.some(profile =>
      section === `profiles.${profile}` || section === `profiles.${JSON.stringify(profile)}`);
    if (!target) return line;
    // Synthetic Web model IDs belong to the disappearing Tela provider.
    // Removing only this model assignment lets official Codex select its
    // default Native model after falling back to the built-in provider.
    const webModel = /^([ \t]*)model[ \t]*=[ \t]*(["'])chatgpt-tela-web\/family\/[^'"\s]+\2([ \t]*(?:#.*)?)(\r?\n)?$/.exec(line);
    if (webModel) {
      const comment = webModel[3]?.trim();
      return `${comment ? `${webModel[1]}${comment}` : ""}${webModel[4] ?? ""}`;
    }
    return line.replace(/^([ \t]*model_provider[ \t]*=[ \t]*)(["'])chatgpt_tela_local\2([ \t]*(?:#.*)?)(\r?\n)?$/, (_all, prefix: string, _quote: string, suffix: string, newline = "") => {
      replaced++;
      return `${prefix}"openai"${suffix}${newline}`;
    });
  }).join("");
  if (replaced !== Number(selected) + selectedProfiles.length) {
    throw new Error("Selected Tela provider has an unsupported config layout; preserving user settings");
  }
  return next;
}

/**
 * Pure transformation: the caller must separately establish explicit user
 * approval, current installation ownership, and safe file-write conditions.
 */
export function editAppOwnedDesktopProviderConfig(
  content: string,
  action: "register" | "restore",
  registration: AppOwnedProviderRegistration,
  options: { readonly restoreSelected?: boolean } = {},
): { readonly content: string; readonly changed: boolean } {
  const block = registrationBlock(registration);
  const hasExactBlock = content.includes(block);
  const provider = parsedProviders(content)[TELA_APP_OWNED_PROVIDER_ID];
  if (hasExactBlock && !exactOwnedProvider(content, registration)) {
    throw new Error("Desktop provider has user modifications; refusing to replace or restore it");
  }
  if (action === "register") {
    if (hasExactBlock) return { content, changed: false };
    if (provider !== undefined || content.includes("# ChatGPT Tela provider begin:")) {
      throw new Error("Desktop provider exists or has changed; refusing to overwrite another owner's configuration");
    }
    const next = content + block;
    parsedProviders(next); // Verify that the generated stanza is valid in context.
    return { content: next, changed: true };
  }
  if (!hasExactBlock) {
    if (provider !== undefined || content.includes("# ChatGPT Tela provider begin:")) {
      throw new Error("Desktop provider ownership or contents changed; refusing to restore");
    }
    const settings = Bun.TOML.parse(content) as Record<string, unknown>;
    const profiles = settings.profiles;
    if (settings.model_provider === TELA_APP_OWNED_PROVIDER_ID || profiles && typeof profiles === "object"
      && Object.values(profiles).some(profile => profile && typeof profile === "object"
        && (profile as Record<string, unknown>).model_provider === TELA_APP_OWNED_PROVIDER_ID)) {
      throw new Error("Tela provider remains selected without an owned registration; preserving user settings");
    }
    return { content, changed: false };
  }
  const settings = Bun.TOML.parse(content) as Record<string, unknown>;
  const profiles = settings.profiles;
  const selectedProfiles = profiles && typeof profiles === "object" && !Array.isArray(profiles)
    ? Object.entries(profiles).filter(([, profile]) => profile && typeof profile === "object"
      && !Array.isArray(profile) && (profile as Record<string, unknown>).model_provider === TELA_APP_OWNED_PROVIDER_ID)
      .map(([name]) => name) : [];
  const selected = settings.model_provider === TELA_APP_OWNED_PROVIDER_ID;
  if ((selected || selectedProfiles.length) && !options.restoreSelected) {
    throw new Error("Select another user-level or profile model_provider before restoring the Tela provider");
  }
  // A byte-for-byte match of the owned block is required. Other user sections,
  // before or after it, are left untouched.
  const next = restoreSelection(content.replace(block, ""), selected, selectedProfiles);
  parsedProviders(next);
  return { content: next, changed: true };
}
