import { createHash } from "node:crypto";
import { isAbsolute, win32 } from "node:path";

export interface AppOwnedProviderRegistration {
  readonly installId: string;
  readonly baseUrl: string;
  /** An already prepared, installation-owned Native + Web startup catalog. */
  readonly catalogPath?: string;
}

export type CatalogRegistrationStatus = "not-requested" | "installed" | "already-owned"
  | "foreign-preserved" | "modified-preserved" | "removed" | "absent";

function catalogBlock(installId: string, catalogPath: string): string {
  if ((!isAbsolute(catalogPath) && !win32.isAbsolute(catalogPath)) || /[\r\n\0]/.test(catalogPath)) {
    throw new Error("Desktop catalog registration requires an absolute catalog path");
  }
  const fingerprint = createHash("sha256").update(`${installId}\0${catalogPath}`).digest("hex");
  return [
    `# ChatGPT Tela catalog begin: ${installId} ${fingerprint}`,
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    `# ChatGPT Tela catalog end: ${installId}`,
    "",
  ].join("\n");
}

function ownedCatalog(content: string, installId: string): { block?: string; path?: string; modified: boolean } {
  const begin = `# ChatGPT Tela catalog begin: ${installId} `;
  const end = `# ChatGPT Tela catalog end: ${installId}`;
  const start = content.indexOf(begin);
  const finish = content.indexOf(end);
  if (start < 0 && finish < 0) return { modified: false };
  if (start < 0 || finish < start || content.indexOf(begin, start + begin.length) >= 0
    || content.indexOf(end, finish + end.length) >= 0) return { modified: true };
  const after = finish + end.length;
  const span = content.slice(start, after) + (content[after] === "\n" ? "\n" : "");
  const match = /^# ChatGPT Tela catalog begin: [^\r\n]+\nmodel_catalog_json = ("(?:[^"\\]|\\.)*")\n# ChatGPT Tela catalog end: [^\r\n]+\n?$/.exec(span);
  if (!match) return { modified: true };
  let path: unknown;
  try { path = JSON.parse(match[1]!); } catch { return { modified: true }; }
  if (typeof path !== "string" || span !== catalogBlock(installId, path)) return { modified: true };
  return { block: span, path, modified: false };
}

function routeBlock(input: AppOwnedProviderRegistration): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.installId)) {
    throw new Error("Desktop routing requires a valid install ID");
  }
  const url = new URL(input.baseUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port
    || !/^\/[A-Za-z0-9_-]{43,128}\/v1\/?$/.test(url.pathname)
    || url.username || url.password || url.search || url.hash) {
    throw new Error("Desktop routing requires the configured fixed app-owned Responses URL");
  }
  return [
    `# ChatGPT Tela route begin: ${input.installId}`,
    `openai_base_url = ${JSON.stringify(url.href.replace(/\/$/, ""))}`,
    `# ChatGPT Tela route end: ${input.installId}`, "",
  ].join("\n");
}

// Removal only: never register the retired provider or rewrite old conversations.
function retireOwnedProvider(content: string, input: AppOwnedProviderRegistration): string {
  const parsed = Bun.TOML.parse(content) as Record<string, any>;
  const provider = parsed.model_providers?.chatgpt_tela_local;
  const marker = `# ChatGPT Tela provider begin: ${input.installId}`;
  if (!content.includes(marker)) {
    if (provider || parsed.model_provider === "chatgpt_tela_local"
      || Object.values(parsed.profiles ?? {}).some((p: any) => p?.model_provider === "chatgpt_tela_local")) {
      throw new Error("Retired Desktop provider ownership or contents changed; refusing to modify user settings");
    }
    return content;
  }
  const expected = { name: "ChatGPT Tela (local)", base_url: new URL(input.baseUrl).href.replace(/\/$/, ""),
    wire_api: "responses", requires_openai_auth: true, supports_websockets: false };
  if (!provider || Object.keys(provider).length !== Object.keys(expected).length
    || !Object.entries(expected).every(([key, value]) => provider[key] === value)) {
    throw new Error("Retired Desktop provider ownership or contents changed; refusing to modify user settings");
  }
  const block = ["", marker, "[model_providers.chatgpt_tela_local]",
    ...Object.entries(expected).map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
    `# ChatGPT Tela provider end: ${input.installId}`, ""].join("\n");
  if (!content.includes(block) || content.indexOf(marker) !== content.lastIndexOf(marker)) {
    throw new Error("Retired Desktop provider ownership or contents changed; refusing to modify user settings");
  }
  // Only root/named-profile selections are supported by this config editor.
  let section = "";
  const next = content.replace(block, "").split(/(?<=\n)/).map(line => {
    const heading = /^\s*\[([^\]\r\n]+)\]/.exec(line);
    if (heading) section = heading[1]!;
    if (section !== "" && !/^profiles\.(?:[\w-]+|"[^"\n]+")$/.test(section)) return line;
    return line.replace(/^(\s*model_provider\s*=\s*)(["'])chatgpt_tela_local\2/, '$1"openai"');
  }).join("");
  const remaining = Bun.TOML.parse(next) as Record<string, any>;
  if (remaining.model_provider === "chatgpt_tela_local"
    || Object.values(remaining.profiles ?? {}).some((p: any) => p?.model_provider === "chatgpt_tela_local")) {
    throw new Error("Retired provider selection has an unsupported layout; preserving user settings");
  }
  return next;
}

function clearWebModelSelections(content: string, baseUrl: string): string {
  const parsed = Bun.TOML.parse(content) as Record<string, any>;
  let section = "";
  return content.split(/(?<=\n)/).map(line => {
    const heading = /^\s*\[([^\]\r\n]+)\]/.exec(line);
    if (heading) section = heading[1]!;
    const profile = /^profiles\.(.+)$/.exec(section);
    let settings = section === "" ? parsed : undefined;
    if (profile) {
      let name = profile[1]!;
      if (name.startsWith('"')) { try { name = JSON.parse(name); } catch { return line; } }
      settings = parsed.profiles?.[name];
    }
    if (!settings || (settings.model_provider ?? parsed.model_provider ?? "openai") !== "openai"
      || settings !== parsed && settings.openai_base_url !== undefined && settings.openai_base_url !== baseUrl) return line;
    const web = /^([ \t]*)model[ \t]*=[ \t]*(["'])chatgpt-tela-web\/family\/[^'"\s]+\2([ \t]*(?:#.*)?)(\r?\n)?$/.exec(line);
    return web ? `${web[3]?.trim() ? `${web[1]}${web[3].trim()}` : ""}${web[4] ?? ""}` : line;
  }).join("");
}

/** One owned built-in route, shared by registration, restoration and uninstall. */
export function editAppOwnedDesktopProviderConfig(
  content: string,
  action: "register" | "restore",
  registration: AppOwnedProviderRegistration,
): { readonly content: string; readonly changed: boolean; readonly catalogStatus: CatalogRegistrationStatus } {
  const block = routeBlock(registration);
  let next = retireOwnedProvider(content, registration);
  const retired = next !== content;
  const parsed = Bun.TOML.parse(next) as Record<string, any>;
  const baseUrl = new URL(registration.baseUrl).href.replace(/\/$/, "");
  if (action === "restore" && Object.values(parsed.profiles ?? {}).some((profile: any) =>
    profile?.openai_base_url === baseUrl && (profile.model_provider ?? parsed.model_provider ?? "openai") === "openai")) {
    throw new Error("Desktop route remains referenced by a user-owned named profile; preserving user settings");
  }
  const hasRoute = next.includes(block) && parsed.openai_base_url === baseUrl;
  const anyRouteMarker = next.includes("# ChatGPT Tela route begin:") || next.includes("# ChatGPT Tela route end:");
  if (anyRouteMarker && (!hasRoute || next.split("# ChatGPT Tela route begin:").length !== 2
    || next.split("# ChatGPT Tela route end:").length !== 2)) {
    throw new Error("Desktop route ownership or contents changed; refusing to modify user settings");
  }
  if (action === "register") {
    if ((parsed.model_provider ?? "openai") !== "openai") {
      throw new Error("Select the built-in openai provider before connecting Desktop routing");
    }
    if (!hasRoute && parsed.openai_base_url !== undefined) {
      throw new Error("openai_base_url belongs to another router; refusing to overwrite user settings");
    }
    if (!hasRoute) next = block + next;
  } else if (hasRoute) {
    next = next.replace(block, "");
  }

  const owned = ownedCatalog(next, registration.installId);
  const anyCatalogMarker = next.includes("# ChatGPT Tela catalog begin:") || next.includes("# ChatGPT Tela catalog end:");
  const catalogValue = (Bun.TOML.parse(next) as Record<string, any>).model_catalog_json;
  let catalogStatus: CatalogRegistrationStatus = "not-requested";
  if (action === "register" && registration.catalogPath !== undefined) {
    const proposed = catalogBlock(registration.installId, registration.catalogPath);
    if (owned.block) {
      catalogStatus = owned.block === proposed && catalogValue === registration.catalogPath ? "already-owned" : "modified-preserved";
    } else if (owned.modified || anyCatalogMarker || catalogValue !== undefined) {
      catalogStatus = "foreign-preserved";
    } else {
      next = proposed + next;
      catalogStatus = "installed";
    }
  } else if (action === "restore") {
    if (owned.block && catalogValue === owned.path) {
      next = next.replace(owned.block, "");
      catalogStatus = "removed";
    } else {
      catalogStatus = owned.modified || anyCatalogMarker ? "modified-preserved"
        : catalogValue !== undefined ? "foreign-preserved" : "absent";
    }
    if (hasRoute || retired || catalogStatus === "removed") next = clearWebModelSelections(next, baseUrl);
  }
  Bun.TOML.parse(next);
  return { content: next, changed: next !== content, catalogStatus };
}
