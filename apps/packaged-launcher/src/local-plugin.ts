import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { connectHookMetadataRpc } from "@chatgpt-tela/codex";
import { resolveDefaultDesktopInstallation } from "@chatgpt-tela/default-desktop-target";
import { readProductConfigIfPresent } from "@chatgpt-tela/product-config";
import { diagnosticFailureFields, emitDiagnosticEvent } from "@chatgpt-tela/core";
import { FilesystemOwnershipObserver, observeLocalMarketplaceEntry, readOwnershipManifest,
  resolveProductPaths, withPackagedTransitionOwner, type ProductPathOptions, type ProductPaths } from "@chatgpt-tela/product-lifecycle";
import { LOCAL_CHAT_PLUGIN_VERSION, localChatRetentionHookCommand, refreshOwnedLocalChatPlugin, inspectOwnedLocalChatPlugin } from "../../local-mcp/src/plugin-package";

export type LocalPluginState = "prepare" | "install" | "update" | "review" | "disabled" | "ready" | "customized" | "unavailable";
type InstalledPlugin = { pluginId: string; version: string; enabled: boolean };
type Host = { slot: number; codexHome: string; executable: string };
type Input = ProductPathOptions & { launcherExecutablePath: string; signal?: AbortSignal };

function preparedSource(paths: ProductPaths) {
  const manifest = readOwnershipManifest(paths.installManifest);
  const root = join(paths.stateRoot, "install", "local-chat-plugin");
  const resource = manifest?.resources.find(r => r.id === "local-chat-plugin-source");
  if (!resource || !existsSync(root)) return { state: "prepare" as const, root };
  if (resource.kind !== "directory" || resource.path !== root || resource.owner !== "product"
    || new FilesystemOwnershipObserver().observe(resource, manifest!) !== "owned") return { state: "customized" as const, root };
  const entry = manifest!.resources.find(r => r.id === "local-chat-personal-marketplace");
  if (entry && (entry.kind !== "marketplace-entry" || observeLocalMarketplaceEntry(entry) !== "owned")) return { state: "customized" as const, root };
  return { state: "prepared" as const, root };
}

function hosts(paths: ProductPaths, input: ProductPathOptions): Host[] {
  const installation = resolveDefaultDesktopInstallation(input);
  const routes = readProductConfigIfPresent(join(paths.configRoot, "product-v1.json"))?.appOwnedResponses ?? [];
  const profiles = new Map<number, Host>([[1, { slot: 1, codexHome: installation.codexHome, executable: installation.codexExecutable }]]);
  for (const route of routes) profiles.set(route.slot, { slot: route.slot,
    codexHome: route.desktopConfigPath ? dirname(route.desktopConfigPath) : installation.codexHome,
    executable: installation.codexExecutable });
  return [...profiles.values()];
}

function nativeJson(host: Host, args: string[], input: Input): Promise<any> {
  return new Promise((accept, reject) => execFile(host.executable, args, {
    env: { ...process.env, ...(input.environment ?? {}), CODEX_HOME: host.codexHome },
    maxBuffer: 8 * 1024 * 1024, encoding: "utf8", windowsHide: true,
    ...(input.signal ? { signal: input.signal } : {}),
  }, (error, stdout) => {
    if (error) { reject(Error("Official plugin metadata command failed")); return; }
    try { accept(JSON.parse(stdout)); } catch { reject(Error("Official plugin metadata is invalid")); }
  }));
}

/** Resolve the actual installed identity by its local source, never a personal marketplace name. */
export function ownedInstalledPlugin(value: any, sourcePath: string): InstalledPlugin | undefined {
  if (!Array.isArray(value?.installed)) throw Error("Official installed-plugin metadata is unavailable");
  const matches = value.installed.filter((p: any) => p?.name === "tela-local-chat"
    && p.source?.source === "local" && typeof p.source.path === "string"
    && resolve(p.source.path) === resolve(sourcePath));
  if (matches.length > 1) throw Error("Owned plugin identity is ambiguous");
  const plugin = matches[0];
  if (!plugin) return undefined;
  if (typeof plugin.pluginId !== "string" || typeof plugin.version !== "string" || typeof plugin.enabled !== "boolean") throw Error("Official plugin state is invalid");
  return plugin;
}

export function hookActivation(value: any, pluginId: string, command: string): LocalPluginState {
  if (!Array.isArray(value?.data)) return "unavailable";
  const hook = value.data.flatMap((entry: any) => Array.isArray(entry?.hooks) ? entry.hooks : []).find((h: any) =>
    h?.pluginId === pluginId && h.source === "plugin" && h.eventName === "postToolUse"
    && h.handlerType === "command" && h.command === command && h.async === true && h.matcher === "close_agent$");
  if (!hook) return "unavailable";
  if (hook.enabled === false) return "disabled";
  if (hook.enabled !== true) return "unavailable";
  if (hook.trustStatus === "untrusted" || hook.trustStatus === "modified") return "review";
  return ["trusted", "managed"].includes(hook.trustStatus) ? "ready" : "unavailable";
}

/** On-demand disk configuration, not proof an already-running Desktop loaded new settings. */
export async function readLocalPluginStatus(input: Input) {
  const paths = resolveProductPaths(input);
  try {
    const source = preparedSource(paths);
    if (source.state !== "prepared") return { source: source.state, profiles: [] };
    const prepared = inspectOwnedLocalChatPlugin(source.root, input.launcherExecutablePath).state;
    if (prepared !== "current") return { source: prepared === "outdated" ? "prepare" : "customized", profiles: [] };
    const sourcePath = join(source.root, "plugins", "tela-local-chat");
    const command = localChatRetentionHookCommand(resolve(input.launcherExecutablePath));
    const profiles = await Promise.all(hosts(paths, input).map(async host => {
      let state: LocalPluginState = "unavailable";
      try {
        if (!existsSync(host.codexHome)) return { slot: host.slot, state: "install" as const };
        const plugin = ownedInstalledPlugin(await nativeJson(host, ["plugin", "list", "--json"], input), sourcePath);
        if (!plugin) state = "install";
        else if (!plugin.enabled) state = "disabled";
        else if (plugin.version !== LOCAL_CHAT_PLUGIN_VERSION) state = "update";
        else {
          const rpc = await connectHookMetadataRpc({ executable: host.executable, codexHome: host.codexHome,
            cwd: input.home ?? homedir(), ...(input.signal ? { signal: input.signal } : {}) });
          try {
            const cwd = input.home ?? homedir();
            const config: any = await rpc.request("config/read", { cwd, includeLayers: false });
            if (!config?.config || typeof config.config !== "object") throw Error("Official hook configuration is unavailable");
            state = config.config.features?.hooks === false ? "disabled"
              : hookActivation(await rpc.request("hooks/list", { cwds: [cwd] }), plugin.pluginId, command);
          } finally { await rpc.close(); }
        }
      } catch (error) {
        emitDiagnosticEvent("chatgpt_tela_update", "local_plugin_status_failed", { slot: host.slot, ...diagnosticFailureFields(error) });
      }
      return { slot: host.slot, state };
    }));
    return { source: "prepared" as const, profiles };
  } catch (error) {
    emitDiagnosticEvent("chatgpt_tela_update", "local_plugin_status_failed", diagnosticFailureFields(error));
    return { source: "unavailable" as const, profiles: [] };
  }
}

/** Called inside existing install/update ownership. Never enrolls a missing or disabled host plugin. */
export async function refreshInstalledLocalPluginOwned(input: Input) {
  try {
    const paths = resolveProductPaths(input), source = preparedSource(paths);
    if (source.state !== "prepared") return source.state;
    const launcherExecutablePath = input.launcherExecutablePath;
    let refreshed = refreshOwnedLocalChatPlugin(source.root, launcherExecutablePath);
    if (refreshed === "customized") return refreshed;
    const sourcePath = join(source.root, "plugins", "tela-local-chat");
    let unavailable = false;
    for (const host of hosts(paths, input)) {
      try {
        if (!existsSync(host.codexHome)) continue;
        const plugin = ownedInstalledPlugin(await nativeJson(host, ["plugin", "list", "--json"], { ...input, launcherExecutablePath }), sourcePath);
        if (!plugin?.enabled || plugin.version === LOCAL_CHAT_PLUGIN_VERSION) continue;
        await nativeJson(host, ["plugin", "add", plugin.pluginId, "--json"], { ...input, launcherExecutablePath });
        refreshed = "updated";
      } catch (error) {
        unavailable = true;
        emitDiagnosticEvent("chatgpt_tela_update", "local_plugin_refresh_failed", { slot: host.slot, ...diagnosticFailureFields(error) });
      }
    }
    return unavailable ? "unavailable" : refreshed;
  } catch (error) {
    // Optional plugin maintenance cannot turn a completed app upgrade into a failed one.
    emitDiagnosticEvent("chatgpt_tela_update", "local_plugin_refresh_failed", diagnosticFailureFields(error));
    return "unavailable";
  }
}


/** Normal install/repair/upgrade have released their lifecycle owner on return. */
export async function refreshInstalledLocalPlugin(input: Input) {
  const paths = resolveProductPaths(input), manifest = readOwnershipManifest(paths.installManifest);
  if (!manifest) return "prepare";
  try {
    return await withPackagedTransitionOwner({ paths, installId: manifest.installId }, () => refreshInstalledLocalPluginOwned(input));
  } catch (error) {
    emitDiagnosticEvent("chatgpt_tela_update", "local_plugin_refresh_failed", diagnosticFailureFields(error));
    return "unavailable";
  }
}
