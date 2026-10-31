import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({ args: process.argv.slice(2),
  options: { launcher: { type: "string" } }, allowPositionals: true });
// Keep stable launcher aliases intact across upgrades instead of pinning their current symlink target.
const launcher = values.launcher ? resolve(values.launcher) : undefined;
const destination = resolve(positionals[0] ?? "build/local-mcp");
const plugin = join(destination, "plugins", "tela-local-chat");
mkdirSync(plugin, { recursive: true });
for (const [file, entry] of [["server.cjs", "apps/local-mcp/src/main.ts"], ["probe.cjs", "apps/local-mcp/src/probe.ts"]] as const) {
  if (launcher) { rmSync(join(plugin, file), { force: true }); continue; }
  const result = spawnSync("bun", ["build", entry, "--target=node", "--format=cjs", "--outfile=" + join(plugin, file)], { stdio: "inherit" });
  if (result.status !== 0) throw Error("MCP bundle failed: " + entry);
}
writeFileSync(join(plugin, "plugin.json"), JSON.stringify({
  $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  name: "tela-local-chat", version: "0.0.1", description: "Device-local Tela Chat MCP"
}, null, 2) + "\n");
writeFileSync(join(plugin, "mcp.json"), JSON.stringify({
  $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  mcpServers: { "tela-local-chat": { type: "stdio", command: launcher ? basename(launcher) : "node",
    ...(launcher ? { env: { PATH: dirname(launcher) } } : {}),
    args: launcher ? ["local-mcp"] : ["${PLUGIN_ROOT}/server.cjs"], cwd: "${PLUGIN_ROOT}" } }
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
  "Run: bun run local-mcp:package [destination] [--launcher installed-executable]; test: bun run local-mcp:test.",
  launcher ? "Uses the installed Tela launcher and its embedded runtime; no separate Node or runtime copy."
    : "Developer bundle launch: node plugins/tela-local-chat/server.cjs (Node must be on PATH).",
  "The Chat service must already be installed and running on this computer; its ownership and loopback descriptor are resolved at call time.",
  "The plugin provides Chat tools only; no Native tools, discovery of other computers, or fallback.",
  "The inactive local marketplace is .agents/plugins/marketplace.json; installing it is an explicit separate host step.",
  "The source tests also exercise a copied Node probe; that is separate from installed plugin acceptance.",
  "Native/Codex host acceptance is recorded separately from general Work and Electron Web support.",
].join("\n") + "\n");
console.log("local MCP package prepared");
