import { parseArgs } from "node:util";
import { writeChatGptTelaPluginArchive } from "./index";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "app-id": { type: "string" },
    output: { type: "string", default: "build/chatgpt-tela-plugin.tar.gz" },
  },
  strict: true,
});

if (!values["app-id"]) {
  throw new Error(
    "Usage: bun run plugin:package --app-id <technical ChatGPT app id> [--output build/chatgpt-tela-plugin.tar.gz]",
  );
}

const output = writeChatGptTelaPluginArchive({
  appId: values["app-id"],
  outputPath: values.output!,
});

console.log(`Created ChatGPT Tela plugin archive: ${output}`);
console.log("The archive references the existing registered ChatGPT Tela App and contains no bundled MCP server URL.");
