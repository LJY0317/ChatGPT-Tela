import { appendFileSync } from "node:fs";

// Deliberately minimal public stdio MCP server, owned only by the fixture.
const log = process.argv[2]!;
const decoder = new TextDecoder();
const reader = Bun.stdin.stream().getReader();
let buffer = "";
for (;;) {
  const packet = await reader.read();
  if (packet.done) break;
  buffer += decoder.decode(packet.value, { stream: true });
  let end: number;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    appendFileSync(log, JSON.stringify({ method: message.method }) + "\n");
    if (message.id === undefined) continue;
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "tela-mcp-isolation", version: "0.0.1" } }
      : message.method === "tools/list"
        ? { tools: [{ name: "fixture_probe", description: "Isolated MCP probe",
            inputSchema: { type: "object", properties: { text: { type: "string" } },
              required: ["text"] } }] }
        : message.method === "ping" ? {}
          : message.method === "tools/call"
            ? { content: [{ type: "text", text: "fixture only" }] } : undefined;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id,
      ...(result === undefined ? { error: { code: -32601, message: "unsupported" } } : { result }) }) + "\n");
  }
}
