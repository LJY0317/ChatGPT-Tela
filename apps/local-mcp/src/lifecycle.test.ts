import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  applyPackagedInstallFromPayload, applyPackagedUpgradeFromPayload, planPackagedInstallFromPayload,
  planPackagedUpgradeFromPayload, prepareOwnedDirectory, readOwnershipManifest,
  registerLocalMarketplace, resolveProductPaths, PACKAGED_PRODUCT_MANIFEST, type ServiceRegistrationCommandRunner,
} from "@chatgpt-tela/product-lifecycle";
import { runProductUninstall } from "../../../packages/product-uninstall/src/index";
import { createDeviceLocalChatMcpServer } from "./main";
import { prepareLocalChatPlugin, validateOwnedLocalChatPlugin } from "./plugin-package";

// The runner models only the standard OS registration contract. Nothing is
// installed in the real user account, and no service is started or restarted.
class LocalSystemd implements ServiceRegistrationCommandRunner {
  readonly enabled = new Set<string>();
  async run(command: string, args: readonly string[]) {
    if (command !== "systemctl") throw Error("unexpected host executable");
    const unit = args.at(-1)!;
    if (args.includes("show")) return { exitCode: this.enabled.has(unit) ? 0 : 1,
      stdout: this.enabled.has(unit) ? "loaded\n" : "not-found\n", stderr: "" };
    if (args.includes("is-enabled")) return { exitCode: this.enabled.has(unit) ? 0 : 1,
      stdout: this.enabled.has(unit) ? "enabled\n" : "disabled\n", stderr: "" };
    if (args.includes("is-active")) return { exitCode: 3, stdout: "inactive\n", stderr: "" };
    if (args.includes("enable")) this.enabled.add(unit);
    else if (args.includes("disable")) this.enabled.delete(unit);
    else if (!args.includes("daemon-reload")) throw Error("unexpected service operation");
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

function payload(root: string, version: string) {
  const path = join(root, "payload-" + version);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "tela"), "#!/bin/sh\nexit 0\n# " + version, { mode: 0o755 });
  writeFileSync(join(path, PACKAGED_PRODUCT_MANIFEST), JSON.stringify({
    version: 1, product: "chatgpt-tela", productVersion: version,
    launcher: { executable: "tela" }, profileRuntime: { executable: "tela", entrypoint: "tela" },
    services: Object.fromEntries(["gateway", "chat", "codex"].map(service =>
      [service, { executable: "tela", arguments: ["service", service] }])),
  }));
  return path;
}

test("owned local MCP source, alias and marketplace settle across packaged install, upgrade, uninstall and reinstall", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-local-lifecycle-"));
  const home = join(root, "home");
  mkdirSync(home);
  const runner = new LocalSystemd(), options = { platform: "linux" as const, home, environment: {}, runner };
  const paths = resolveProductPaths(options);
  const first = payload(root, "1.0.0"), second = payload(root, "2.0.0");
  let client: Client | undefined;
  let server: ReturnType<typeof createDeviceLocalChatMcpServer> | undefined;
  try {
    // Supported OS paths remain on the selected computer, not an account URL.
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const selected = resolveProductPaths({ platform, home, environment: {} });
      expect(selected.installManifest.startsWith(home)).toBe(true);
      expect(selected.binaryRoot.startsWith(home)).toBe(true);
    }
    const planned = await planPackagedInstallFromPayload({ payloadSourcePath: first, ...options });
    expect((await applyPackagedInstallFromPayload({ planned, payloadSourcePath: first, ...options })).verify.ready).toBe(true);
    const installed = readOwnershipManifest(paths.installManifest)!;
    const sourceRoot = join(paths.stateRoot, "install", "local-chat-plugin");
    const ownedSource = { kind: "directory" as const, id: "local-chat-plugin-source",
      owner: "product" as const, dataClass: "binary" as const, path: sourceRoot };
    expect((await prepareOwnedDirectory({ manifestPath: paths.installManifest,
      installId: installed.installId, productVersion: installed.productVersion,
      resource: ownedSource })).state).toBe("created-owned");
    const plugin = prepareLocalChatPlugin(sourceRoot, join(paths.binaryRoot, "tela")).plugin;
    const personal = join(home, ".agents", "plugins", "marketplace.json");
    mkdirSync(dirname(personal), { recursive: true });
    const foreign = { name: "user-legacy-0.0.1", source: { source: "local", path: "./external-legacy" } };
    writeFileSync(personal, JSON.stringify({ name: "personal", plugins: [foreign] }));
    const register = (path: string) => registerLocalMarketplace({
      manifestPath: paths.installManifest, marketplacePath: personal, pluginPath: path });
    expect(await register(plugin)).toBe("registered");
    const registered = JSON.parse(readFileSync(personal, "utf8"));
    expect(registered.plugins).toHaveLength(2);
    expect(registered.plugins[0]).toEqual(foreign);
    expect(join(home, registered.plugins[1].source.path)).toBe(plugin);
    // No silent re-adoption of an intact entry that refers to a different source.
    expect(await register(join(home, "abandoned", "tela-local-chat"))).toBe("preserved-user-change");
    expect(await register(plugin)).toBe("already-registered");

    const configPath = join(plugin, ".mcp.json");
    const before = JSON.parse(readFileSync(configPath, "utf8")).mcpServers["tela-local-chat"];
    expect(before).toEqual({ type: "stdio", command: "tela", env: { PATH: paths.binaryRoot },
      args: ["local-mcp"], cwd: "${PLUGIN_ROOT}" });
    expect(before.command).toBe(basename(join(paths.binaryRoot, "tela")));
    // The SDK observes only this computer's MCP tools. No backend descriptor
    // exists, so inventory fails locally rather than using an account endpoint.
    server = createDeviceLocalChatMcpServer(paths);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "lifecycle", version: "1" }, { capabilities: {} });
    await client.connect(clientTransport);
    expect((await client.listTools()).tools.map(x => x.name).sort()).toEqual([
      "chatgpt_tela_chat_capability_call", "chatgpt_tela_chat_capability_inventory",
    ]);
    expect((await client.callTool({ name: "chatgpt_tela_chat_capability_inventory", arguments: {} })).isError).toBe(true);

    const originalPluginConfig = readFileSync(configPath, "utf8");
    const upgrade = await planPackagedUpgradeFromPayload({ payloadSourcePath: second, ...options });
    const stoppedServices = { async inspect() { return "stopped" as const; },
      async quiesce() {}, async resume() {} };
    expect((await applyPackagedUpgradeFromPayload({ plan: upgrade, payloadSourcePath: second,
      services: stoppedServices, ...options })).toVersion).toBe("2.0.0");
    expect(readOwnershipManifest(paths.installManifest)?.installId).toBe(installed.installId);
    expect(readOwnershipManifest(paths.installManifest)?.productVersion).toBe("2.0.0");
    validateOwnedLocalChatPlugin(sourceRoot);
    expect(readFileSync(configPath, "utf8")).toBe(originalPluginConfig);
    expect(readFileSync(join(paths.binaryRoot, "tela"), "utf8")).toContain("# 2.0.0");
    expect(await register(plugin)).toBe("already-registered");
    expect(existsSync(join(paths.binaryRoot, "tela"))).toBe(true);

    // Preserve the user's folder and config through default uninstall.
    const userFolder = join(home, "Documents", "private-work");
    mkdirSync(userFolder, { recursive: true });
    writeFileSync(join(userFolder, "keep.txt"), "personal");
    const keepSettings = { kind: "directory" as const, id: "chat-owned-settings",
      owner: "chat" as const, dataClass: "config" as const, path: join(paths.configRoot, "chat") };
    expect((await prepareOwnedDirectory({ manifestPath: paths.installManifest, installId: installed.installId,
      productVersion: "2.0.0", resource: keepSettings })).state).toBe("created-owned");
    writeFileSync(join(keepSettings.path, "settings.json"), "{\"user\":true}");
    const dry = await runProductUninstall({ mode: "dry-run", ...options,
      serviceRegistrationRunner: runner }) as { steps: { resourceId: string; action: string }[] };
    expect(dry.steps.find(x => x.resourceId === "local-chat-plugin-source")?.action).toBe("remove");
    expect(dry.steps.find(x => x.resourceId === "chat-owned-settings")?.action).toBe("preserve");
    const result = await runProductUninstall({ mode: "apply", ...options,
      serviceRegistrationRunner: runner });
    expect(result.failedCount).toBe(0);
    expect(existsSync(plugin)).toBe(false);
    expect(existsSync(paths.binaryRoot)).toBe(false);
    expect(JSON.parse(readFileSync(personal, "utf8")).plugins).toEqual([foreign]);
    expect(readFileSync(join(userFolder, "keep.txt"), "utf8")).toBe("personal");
    expect(readFileSync(join(keepSettings.path, "settings.json"), "utf8")).toBe("{\"user\":true}");
    expect((await client.callTool({ name: "chatgpt_tela_chat_capability_inventory", arguments: {} })).isError).toBe(true);
    // The local alias is missing: never execute a similarly named program from
    // a different PATH, nor try Node or a remote server.
    const stale = spawnSync(before.command, before.args, {
      env: { PATH: before.env.PATH }, encoding: "utf8" });
    expect(stale.error && (stale.error as NodeJS.ErrnoException).code).toBe("ENOENT");

    const removed = await runProductUninstall({ mode: "apply", removeData: true, ...options,
      serviceRegistrationRunner: runner });
    expect(removed.failedCount).toBe(0);
    expect(existsSync(paths.installManifest)).toBe(false);
    expect(existsSync(keepSettings.path)).toBe(false);
    expect(existsSync(join(userFolder, "keep.txt"))).toBe(true);

    const replan = await planPackagedInstallFromPayload({ payloadSourcePath: second, ...options });
    expect((await applyPackagedInstallFromPayload({ planned: replan, payloadSourcePath: second, ...options })).verify.ready).toBe(true);
    const next = readOwnershipManifest(paths.installManifest)!;
    expect(next.installId).not.toBe(installed.installId);
    expect((await prepareOwnedDirectory({ manifestPath: paths.installManifest, installId: next.installId,
      productVersion: next.productVersion, resource: ownedSource })).state).toBe("created-owned");
    prepareLocalChatPlugin(sourceRoot, join(paths.binaryRoot, "tela"));
    expect(await register(plugin)).toBe("registered");
    expect(JSON.parse(readFileSync(personal, "utf8")).plugins[0]).toEqual(foreign);
    // Old connections never follow a new installation merely because its
    // launcher and owned source occupy the same filesystem path.
    expect((await client.callTool({ name: "chatgpt_tela_chat_capability_inventory", arguments: {} })).isError).toBe(true);
  } finally {
    await client?.close();
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
