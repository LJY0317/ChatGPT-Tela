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
    "requires_openai_auth = false",
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
    requires_openai_auth: false,
    supports_websockets: false,
  };
  const record = provider as Record<string, unknown>;
  return Object.keys(record).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, value]) => record[key] === value);
}

/**
 * Pure transformation: the caller must separately establish explicit user
 * approval, current installation ownership, and safe file-write conditions.
 */
export function editAppOwnedDesktopProviderConfig(
  content: string,
  action: "register" | "restore",
  registration: AppOwnedProviderRegistration,
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
    return { content, changed: false };
  }
  if ((Bun.TOML.parse(content) as Record<string, unknown>).model_provider === TELA_APP_OWNED_PROVIDER_ID) {
    throw new Error("Select another user-level model_provider before restoring the Tela provider");
  }
  // A byte-for-byte match of the owned block is required. Other user sections,
  // before or after it, are left untouched.
  const next = content.replace(block, "");
  parsedProviders(next);
  return { content: next, changed: true };
}
