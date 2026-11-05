import { test, expect } from "bun:test";
import { mkdtempSync, cpSync, rmSync, readFileSync, readdirSync, writeFileSync, renameSync, rmdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createChatToolRuntime, startChatService } from "@chatgpt-tela/chat-service";
import { createOwnershipManifest, resolveProductPaths, writeOwnershipManifest, prepareOwnedDirectory, registerLocalMarketplace } from "@chatgpt-tela/product-lifecycle";
import { normalizeOwnedLocalChatPlugin, prepareLocalChatPlugin } from "./plugin-package";
import { writeServiceRuntimeDescriptor } from "@chatgpt-tela/service-protocol";

test("owned legacy plugin source is converted once before existing marketplace re-registration; custom source is preserved", async () => {
  const home = mkdtempSync(join(tmpdir(), "tela-local-plugin-update-"));
  try {
    const paths = resolveProductPaths({ home, environment: {} });
    const owner = createOwnershipManifest("test", new Date(), "legacy-plugin");
    writeOwnershipManifest(paths.installManifest, owner);
    const root = join(paths.stateRoot, "install", "local-chat-plugin");
    const resource = { kind: "directory" as const, id: "local-chat-plugin-source",
      owner: "product" as const, path: root, dataClass: "binary" as const };
    expect((await prepareOwnedDirectory({ manifestPath: paths.installManifest,
      installId: owner.installId, productVersion: owner.productVersion, resource })).state).toBe("created-owned");
    const launcher = join(home, "tela");
    const { plugin } = prepareLocalChatPlugin(root, launcher);
    const marketplacePath = join(home, ".agents", "plugins", "marketplace.json");
    const register = () => registerLocalMarketplace({ manifestPath: paths.installManifest, marketplacePath, pluginPath: plugin });
    expect(await register()).toBe("registered");
    expect(await register()).toBe("already-registered");

    // Recreate the exact old generated layout, as a previously registered consumer would retain.
    const legacyLayout = () => {
      renameSync(join(plugin, ".codex-plugin", "plugin.json"), join(plugin, "plugin.json"));
      rmdirSync(join(plugin, ".codex-plugin"));
      renameSync(join(plugin, ".mcp.json"), join(plugin, "mcp.json"));
    };
    legacyLayout();
    expect(existsSync(join(plugin, ".codex-plugin", "plugin.json"))).toBe(false);
    normalizeOwnedLocalChatPlugin(root, launcher);
    expect(existsSync(join(plugin, ".codex-plugin", "plugin.json"))).toBe(true);
    expect(existsSync(join(plugin, ".mcp.json"))).toBe(true);
    expect(existsSync(join(plugin, "mcp.json"))).toBe(false);
    expect(await register()).toBe("already-registered");

    // A changed legacy package is user data: do not silently rewrite it.
    legacyLayout();
    writeFileSync(join(plugin, "mcp.json"), "user-modified");
    expect(() => normalizeOwnedLocalChatPlugin(root, launcher)).toThrow("modified; preserved");
    expect(readFileSync(join(plugin, "mcp.json"), "utf8")).toBe("user-modified");
    expect(existsSync(join(plugin, ".codex-plugin"))).toBe(false);
    expect(await register()).toBe("already-registered");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("regenerating a launcher plugin removes old bundles and preserves unrelated files", () => {
  const destination = mkdtempSync(join(tmpdir(), "tela-mcp-launcher-"));
  try {
    const initial = spawnSync("bun", ["run", "apps/local-mcp/src/package.ts", destination], { encoding: "utf8" });
    expect(initial.status).toBe(0);
    const plugin = join(destination, "plugins", "tela-local-chat");
    expect(readdirSync(plugin)).toContain("server.cjs");
    writeFileSync(join(plugin, "keep.txt"), "unrelated");
    const build = spawnSync("bun", ["run", "apps/local-mcp/src/package.ts", destination,
      "--launcher", process.execPath], { encoding: "utf8" });
    expect(build.status).toBe(0);
    const config = JSON.parse(readFileSync(join(plugin, ".mcp.json"), "utf8"));
    expect(config.mcpServers["tela-local-chat"]).toEqual({ type: "stdio", command: basename(process.execPath),
      env: { PATH: dirname(process.execPath) },
      args: ["local-mcp"], cwd: "${PLUGIN_ROOT}" });
    expect(readdirSync(plugin).sort()).toEqual([".codex-plugin", ".mcp.json", "keep.txt"]);
  } finally { rmSync(destination, { recursive: true, force: true }); }
});

test("copied SDK stdio package initializes, lists, calls and exits without checkout", async () => {
  const destination = mkdtempSync(join(tmpdir(), "tela-mcp-portable-"));
  const built = join(destination, "built");
  try {
    const build = spawnSync("bun", ["run", "apps/local-mcp/src/package.ts", built], { encoding: "utf8" });
    expect(build.status).toBe(0);
    const plugin = join(built, "plugins", "tela-local-chat");
    const copy = join(destination, "standalone");
    cpSync(plugin, copy, { recursive: true });
    const transport = new StdioClientTransport({ command: "node", args: [join(copy, "probe.cjs")], cwd: copy });
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
  const clients: Client[] = [];
  const servers = [];
  const workspaces: { id: string }[] = [];
  const stopped = new Set<string>();
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
      clients.push(client); servers.push(server);
      expect((await client.listTools()).tools.map(x => x.name).sort()).toEqual([
        "chatgpt_tela_chat_capability_call", "chatgpt_tela_chat_capability_inventory"
      ]);
      const result = await client.callTool({ name: "chatgpt_tela_chat_capability_call",
        arguments: { capability: "open_workspace", arguments: { path: instance.allowed } } });
      const workspace = JSON.parse(((result as { content: readonly { text: string }[] }).content[0]!).text) as { id: string };
      workspaces.push(workspace);
      const read = await client.callTool({ name: "chatgpt_tela_chat_capability_call",
        arguments: { capability: "read", arguments: { workspace_id: workspace.id, path: "sample.txt" } } });
      expect(JSON.stringify((read as { content: unknown }).content)).toContain(instance.label);
    }
    for (const index of [0, 1]) {
      const cross = await clients[index]!.callTool({ name: "chatgpt_tela_chat_capability_call",
        arguments: { capability: "read", arguments: { workspace_id: workspaces[1 - index]!.id, path: "sample.txt" } } });
      expect(cross.isError).toBe(true);
      const crossWrite = await clients[index]!.callTool({ name: "chatgpt_tela_chat_capability_call",
        arguments: { capability: "apply_patch", arguments: { workspace_id: workspaces[1 - index]!.id,
          patch: `*** Begin Patch\n*** Update File: sample.txt\n@@\n-${instances[1 - index]!.label}\n+cross-write\n*** End Patch` } } });
      expect(crossWrite.isError).toBe(true);
      expect(readFileSync(join(instances[1 - index]!.allowed, "sample.txt"), "utf8")).toBe(instances[1 - index]!.label);
    }
    await instances[0]!.service.close(); stopped.add(instances[0]!.label);
    const unavailable = await clients[0]!.callTool({ name: "chatgpt_tela_chat_capability_inventory", arguments: {} });
    expect(unavailable.isError).toBe(true);
    const available = await clients[1]!.callTool({ name: "chatgpt_tela_chat_capability_call",
      arguments: { capability: "read", arguments: { workspace_id: workspaces[1]!.id, path: "sample.txt" } } });
    expect(available.isError).not.toBe(true);
    expect(JSON.stringify(available.content)).toContain("two");
  } finally {
    await Promise.all(clients.map(client => client.close()));
    await Promise.all(servers.map(server => server.close()));
    await Promise.all(instances.filter(i => !stopped.has(i.label)).map(i => i.service.close()));
    rmSync(root, { recursive: true, force: true });
  }
});
