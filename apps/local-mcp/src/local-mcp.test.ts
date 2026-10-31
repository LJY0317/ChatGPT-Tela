import { test, expect } from "bun:test";
import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createChatToolRuntime, startChatService } from "@chatgpt-tela/chat-service";
import { DynamicChatBackend, createPublicMcpServer } from "@chatgpt-tela/gateway";
import { createOwnershipManifest, resolveProductPaths, writeOwnershipManifest } from "@chatgpt-tela/product-lifecycle";
import { writeServiceRuntimeDescriptor } from "@chatgpt-tela/service-protocol";

test("copied SDK stdio package initializes, lists, calls and exits without checkout", async () => {
  const destination = mkdtempSync(join(tmpdir(), "tela-mcp-portable-"));
  const built = join(destination, "built");
  try {
    const build = spawnSync("bun", ["run", "apps/local-mcp/src/package.ts", built], { encoding: "utf8" });
    expect(build.status).toBe(0);
    const plugin = join(built, "plugins", "tela-local-chat");
    const copy = join(destination, "standalone");
    cpSync(plugin, copy, { recursive: true });
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(copy, "probe.cjs")], cwd: copy });
    const client = new Client({ name: "portable-probe", version: "0.0.1" }, { capabilities: {} });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map(x => x.name)).toEqual(["tela_local_stdio_probe"]);
      const result = await client.callTool({ name: "tela_local_stdio_probe", arguments: {} });
      expect(result.content).toEqual([{ type: "text", text: "tela-local-stdio-probe-ok" }]);
      expect(result.isError).not.toBe(true);
    } finally { await client.close(); }
    expect(transport.pid).toBeNull();
  } finally { rmSync(destination, { recursive: true, force: true }); }
});

test("Chat-only MCP has no Native tools and two independent Chat instances never fall back", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-local-chat-"));
  const instances = [];
  try {
    for (const label of ["one", "two"]) {
      const home = join(root, label);
      const allowed = join(home, "workspace");
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(allowed, { recursive: true });
      writeFileSync(join(allowed, "sample.txt"), label);
      const tools = createChatToolRuntime({ allowedRoots: [allowed], stateRoot: join(home, "state") });
      await tools.initialize();
      const service = await startChatService({ bearerToken: label.repeat(48), tools });
      const paths = resolveProductPaths({ platform: "linux", home, environment: {} });
      const owned = createOwnershipManifest("test", new Date(), label);
      writeOwnershipManifest(paths.installManifest, owned);
      writeServiceRuntimeDescriptor(join(paths.serviceRuntime("chat"), "descriptor.json"), {
        version: 1, service: "chat", instanceId: service.instanceId, installId: owned.installId,
        pid: process.pid, endpoint: service.endpoint.href, bearerToken: service.bearerToken, startedAt: new Date().toISOString()
      });
      instances.push({ label, paths, service, allowed });
    }
    for (const instance of instances) {
      const { createDeviceLocalChatMcpServer } = await import("./main");
      const server = createDeviceLocalChatMcpServer(instance.paths);
      const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "local", version: "0.0.1" }, { capabilities: {} });
      await client.connect(clientTransport);
      try {
        expect((await client.listTools()).tools.map(x => x.name).sort()).toEqual([
          "chatgpt_tela_chat_capability_call", "chatgpt_tela_chat_capability_inventory"
        ]);
        const result = await client.callTool({ name: "chatgpt_tela_chat_capability_call",
          arguments: { capability: "open_workspace", arguments: { path: instance.allowed } } });
        const workspace = JSON.parse(((result as { content: readonly { text: string }[] }).content[0]!).text) as { id: string };
        const read = await client.callTool({ name: "chatgpt_tela_chat_capability_call",
          arguments: { capability: "read", arguments: { workspace_id: workspace.id, path: "sample.txt" } } });
        expect(JSON.stringify((read as { content: unknown }).content)).toContain(instance.label);
      } finally { await client.close(); await server.close(); }
    }
  } finally {
    await Promise.all(instances.map(i => i.service.close()));
    rmSync(root, { recursive: true, force: true });
  }
});
