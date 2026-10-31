import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { prepareLocalChatPlugin } from "./plugin-package";

const { values, positionals } = parseArgs({ args: process.argv.slice(2),
  options: { launcher: { type: "string" } }, allowPositionals: true });
const { plugin } = prepareLocalChatPlugin(positionals[0] ?? "build/local-mcp", values.launcher);
for (const [file, entry] of [["server.cjs", "apps/local-mcp/src/main.ts"], ["probe.cjs", "apps/local-mcp/src/probe.ts"]] as const) {
  if (values.launcher) continue;
  const result = spawnSync("bun", ["build", entry, "--target=node", "--format=cjs", "--outfile=" + join(plugin, file)], { stdio: "inherit" });
  if (result.status !== 0) throw Error("MCP bundle failed: " + entry);
}
console.log("local MCP package prepared");
