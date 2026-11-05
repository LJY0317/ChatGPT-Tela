import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Prepare an inactive marketplace; installation remains a separate host operation. */
export function prepareLocalChatPlugin(destination: string, launcher?: string) {
  const root = resolve(destination);
  // Preserve the installed launcher's stable alias across updates.
  const executable = launcher ? resolve(launcher) : undefined;
  const plugin = join(root, "plugins", "tela-local-chat");
  const manifest = join(plugin, ".codex-plugin");
  const catalog = join(root, ".agents", "plugins");
  mkdirSync(manifest, { recursive: true });
  mkdirSync(catalog, { recursive: true });
  if (executable) {
    for (const file of ["server.cjs", "probe.cjs"]) rmSync(join(plugin, file), { force: true });
  }
  const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
  write(join(manifest, "plugin.json"), localPluginManifest());
  write(join(plugin, ".mcp.json"), localMcpManifest(executable));
  const marketplace = join(catalog, "marketplace.json");
  write(marketplace, {
    name: "tela-local-development", interface: { displayName: "Tela Local Chat" },
    plugins: [{ name: "tela-local-chat", source: { source: "local", path: "./plugins/tela-local-chat" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }]
  });
  writeFileSync(join(root, "README.md"), [
    "Private local developer candidate. Preparation does not install a plugin or change ChatGPT configuration.",
    executable ? "Uses this computer's installed Tela launcher and embedded runtime; no Node or runtime copy."
      : "Developer bundle: node plugins/tela-local-chat/server.cjs (Node must be on PATH).",
    "The Chat service must already be installed and running here; ownership and the loopback descriptor are resolved at call time.",
    "Chat tools only: no Native work tools, discovery of other computers, or remote fallback.",
    "The inactive marketplace is .agents/plugins/marketplace.json; source paths resolve from this output root.",
    "Use a supported personal/repository marketplace and install in ChatGPT Desktop's Plugins Directory.",
    "Packaging and Native/Codex acceptance do not prove Desktop installation, Work or Electron Web-worker support.",
  ].join("\n") + "\n");
  return { root, plugin, marketplace };
}

function localPluginManifest(version = "0.0.2") {
  return { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "tela-local-chat", version, description: "Device-local Tela Chat MCP" };
}

function localMcpManifest(executable?: string) {
  return { $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: { "tela-local-chat": { type: "stdio", command: executable ? basename(executable) : "node",
      ...(executable ? { env: { PATH: dirname(executable) } } : {}),
      args: executable ? ["local-mcp"] : ["${PLUGIN_ROOT}/server.cjs"], cwd: "${PLUGIN_ROOT}" } } };
}

/** Called only after the product ownership marker and install manifest match. */
export function normalizeOwnedLocalChatPlugin(destination: string, launcher: string): void {
  const plugin = join(resolve(destination), "plugins", "tela-local-chat");
  const standardManifest = join(plugin, ".codex-plugin", "plugin.json");
  const standardMcp = join(plugin, ".mcp.json");
  const entries = readdirSync(plugin);
  if (entries.includes(".codex-plugin") && entries.includes(".mcp.json")) {
    // A current source may contain user edits. Leave it untouched on re-registration.
    return;
  }
  const oldManifest = join(plugin, "plugin.json");
  const oldMcp = join(plugin, "mcp.json");
  const expected = new Map([
    ["plugin.json", JSON.stringify(localPluginManifest("0.0.1"), null, 2) + "\n"],
    ["mcp.json", JSON.stringify(localMcpManifest(resolve(launcher)), null, 2) + "\n"],
  ]);
  if (entries.sort().join(",") !== "mcp.json,plugin.json"
    || [...expected].some(([name, content]) => {
      const path = join(plugin, name);
      const stat = lstatSync(path);
      return !stat.isFile() || stat.isSymbolicLink() || readFileSync(path, "utf8") !== content;
    })) throw Error("existing local plugin source was modified; preserved");

  const manifestDir = join(plugin, ".codex-plugin");
  mkdirSync(manifestDir);
  try {
    renameSync(oldManifest, standardManifest);
    renameSync(oldMcp, standardMcp);
  } catch (error) {
    // Restore the previous layout if the second rename fails.
    if (readdirSync(manifestDir).includes("plugin.json")) renameSync(standardManifest, oldManifest);
    rmdirSync(manifestDir);
    throw error;
  }
}
