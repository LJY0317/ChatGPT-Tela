import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
    "Device-local Tela Chat for supported ChatGPT Desktop local threads. Preparation does not install or enable the plugin in ChatGPT.",
    executable ? "Uses this computer's installed Tela launcher and embedded runtime; no Node or runtime copy."
      : "Developer bundle: node plugins/tela-local-chat/server.cjs (Node must be on PATH).",
    "1. Start this computer's Tela Chat service; no HTTPS address or Tailscale is required.",
    "2. Approve local folders in Tela Settings and apply Chat settings if prompted.",
    "3. Install tela-local-chat from this marketplace in ChatGPT Desktop's Plugins Directory; this preparation is not host installation.",
    "4. In a supported local Desktop thread, invoke a Chat tool to open an approved workspace and read a file.",
    "The service ownership and loopback descriptor are resolved at call time.",
    "Chat tools only: no Native work tools, discovery of other computers, or remote fallback.",
    "The inactive marketplace is .agents/plugins/marketplace.json; source paths resolve from this output root.",
    "Use a supported personal/repository marketplace; install and enable the plugin in ChatGPT Desktop's Plugins Directory.",
    "ChatGPT controls account-level plugin visibility. Other signed-in devices are not guaranteed to hide the plugin's existence.",
    "Packaging and Native/Codex acceptance do not prove Desktop installation, Work or Electron Web-worker support.",
  ].join("\n") + "\n");
  return { root, plugin, marketplace };
}

function localPluginManifest() {
  return { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "tela-local-chat", version: "0.0.2", description: "Device-local Tela Chat MCP" };
}

function localMcpManifest(executable?: string) {
  return { $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: { "tela-local-chat": { type: "stdio", command: executable ? basename(executable) : "node",
      ...(executable ? { env: { PATH: dirname(executable) } } : {}),
      args: executable ? ["local-mcp"] : ["${PLUGIN_ROOT}/server.cjs"], cwd: "${PLUGIN_ROOT}" } } };
}

/** Preserve user edits; existing sources must already use the supported plugin layout. */
export function validateOwnedLocalChatPlugin(destination: string): void {
  const root = resolve(destination);
  const plugin = join(root, "plugins", "tela-local-chat");
  const manifestDirectory = join(plugin, ".codex-plugin");
  const manifest = join(manifestDirectory, "plugin.json");
  const mcp = join(plugin, ".mcp.json");
  // Ownership of the root does not include a linked external plugin.
  if (realpathSync(plugin) !== join(realpathSync(root), "plugins", "tela-local-chat")
    || !existsSync(manifest) || !existsSync(mcp)
    || !lstatSync(manifestDirectory).isDirectory()
    || !lstatSync(manifest).isFile() || !lstatSync(mcp).isFile())
    throw Error("existing local plugin source was modified; preserved");
}
