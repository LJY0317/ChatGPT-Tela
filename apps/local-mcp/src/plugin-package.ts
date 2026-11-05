import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  write(join(manifest, "plugin.json"), {
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "tela-local-chat", version: "0.0.1", description: "Device-local Tela Chat MCP"
  });
  write(join(plugin, ".mcp.json"), {
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: { "tela-local-chat": { type: "stdio", command: executable ? basename(executable) : "node",
      ...(executable ? { env: { PATH: dirname(executable) } } : {}),
      args: executable ? ["local-mcp"] : ["${PLUGIN_ROOT}/server.cjs"], cwd: "${PLUGIN_ROOT}" } }
  });
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
