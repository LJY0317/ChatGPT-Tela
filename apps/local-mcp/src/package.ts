import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const destination = resolve(process.argv[2] ?? "build/local-mcp");
const plugin = join(destination, "plugins", "tela-local-chat");
mkdirSync(plugin, { recursive: true });
for (const [file, entry] of [["server.cjs", "apps/local-mcp/src/main.ts"], ["probe.cjs", "apps/local-mcp/src/probe.ts"]] as const) {
  const result = spawnSync("bun", ["build", entry, "--target=node", "--format=cjs", "--outfile=" + join(plugin, file)], { stdio: "inherit" });
  if (result.status !== 0) throw Error("MCP bundle failed: " + entry);
}
writeFileSync(join(plugin, "plugin.json"), JSON.stringify({
  $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  name: "tela-local-chat", version: "0.0.1", description: "Device-local Tela Chat MCP"
}, null, 2) + "\n");
writeFileSync(join(plugin, "mcp.json"), JSON.stringify({
  $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  mcpServers: { "tela-local-chat": { type: "stdio", command: "node",
    args: ["${PLUGIN_ROOT}/server.cjs"], cwd: "${PLUGIN_ROOT}" } }
}, null, 2) + "\n");
const catalog = join(destination, ".agents", "plugins");
mkdirSync(catalog, { recursive: true });
writeFileSync(join(catalog, "marketplace.json"), JSON.stringify({
  name: "tela-local-development", plugins: [{ name: "tela-local-chat",
    source: { source: "local", path: "./plugins/tela-local-chat" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Productivity", interface: { displayName: "Tela Local Chat" } }]
}, null, 2) + "\n");
writeFileSync(join(destination, "README.md"), [
  "Private local developer candidate. No installation or ChatGPT account changes occur during packaging.",
  "Run: bun run local-mcp:package [destination]; test: bun run local-mcp:test.",
  "Local Chat stdio launch: node plugins/tela-local-chat/server.cjs (from destination).",
  "The Chat service must already be installed and running on this computer; its ownership and loopback descriptor are resolved at call time.",
  "The plugin provides Chat tools only; no Native tools, discovery of other computers, or fallback.",
  "The inactive local marketplace is .agents/plugins/marketplace.json; installing it is an explicit separate host step.",
  "Copied bundle test uses probe.cjs with a fixed public string, not the actual Chat service.",
  "Desktop host installation and Electron temporary Web-worker access have not been tested.",
].join("\n") + "\n");
console.log("local MCP package prepared");
