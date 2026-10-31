import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export const LOCAL_PROBE_TOOL = "tela_local_stdio_probe";
export const LOCAL_PROBE_RESULT = "tela-local-stdio-probe-ok";

export function createLocalStdioProbeServer(): McpServer {
  const server = new McpServer({ name: "tela-local-stdio-probe", version: "0.0.1" }, { capabilities: { tools: {} } });
  server.registerTool(LOCAL_PROBE_TOOL, {
    title: "Tela local stdio probe",
    description: "Return a fixed non-secret value from this local process.",
    inputSchema: {},
  }, async () => ({ content: [{ type: "text", text: LOCAL_PROBE_RESULT }] }));
  return server;
}

if (import.meta.main) {
  void createLocalStdioProbeServer().connect(new StdioServerTransport()).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
