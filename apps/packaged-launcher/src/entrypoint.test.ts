import { registerTemporaryFixtureCleanup } from "../../../tests/support/temporary-fixtures";
import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { ChatWorkspaceRegistry } from "../../../packages/chat-service/src/workspaces";
import { ChatProcessManager } from "../../../packages/chat-service/src/processes";
import { createChatToolRuntime, startChatService } from "@chatgpt-tela/chat-service";
import { createOwnershipManifest, resolveProductPaths, writeOwnershipManifest } from "@chatgpt-tela/product-lifecycle";
import { writeServiceRuntimeDescriptor } from "@chatgpt-tela/service-protocol";
import { registerDeviceLocalChatPlugin } from "../../local-mcp/src/main";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const removeFixture = registerTemporaryFixtureCleanup();

test("one compiled runtime dispatches isolated daemons, CLI and a real owned command", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-shared-runtime-"));
  const executable = join(root, process.platform === "win32" ? "tela.exe" : "tela");
  let manager: ChatProcessManager | undefined;
  let service: Awaited<ReturnType<typeof startChatService>> | undefined;
  let client: Client | undefined;
  try {
    const build = Bun.spawn([process.execPath, "build", fileURLToPath(new URL("./entrypoint.ts", import.meta.url)),
      "--compile", `--outfile=${executable}`], { stdout: "pipe", stderr: "pipe" });
    const [built, , buildError] = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()]);
    expect(buildError).not.toContain("error:");
    expect(built).toBe(0);
    // Match package finalization: Bun appends the bundle after its runtime's signed bytes.
    if (process.platform === "darwin") execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", executable]);
    const run = async (args: string[], environment: Record<string, string> = {}) => {
      const child = Bun.spawn([executable, ...args], { env: { PATH: process.env.PATH, ...environment }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, out, err };
    };
    const help = await run(["--help"]);
    expect(help.code).toBe(0); expect(help.out).toContain("ChatGPT Tela packaged runtime"); expect(help.err).toBe("");
    for (const service of ["gateway", "chat", "codex"]) {
      const refused = await run(["--tela-daemon", service, "--help"]);
      expect(refused.code).toBe(1); expect(refused.out).toBe("");
      expect(refused.err).toContain(`Tela ${service[0]!.toUpperCase() + service.slice(1)} daemon accepts no command-line arguments`);
      const selected = await run(["--tela-daemon", service]);
      expect(selected.code).toBe(1); expect(selected.out).toBe("");
      expect(selected.err).toContain(`Tela ${service[0]!.toUpperCase() + service.slice(1)} daemon requires`);
    }
    const registryPath = join(root, "workspaces.json"), approvedRootsPath = join(root, "roots.json");
    const registry = new ChatWorkspaceRegistry({ allowedRoots: [root], storePath: registryPath });
    const workspace = registry.open(root);
    writeFileSync(approvedRootsPath, JSON.stringify({ version: 1, roots: [root] }));
    manager = new ChatProcessManager({ workspaces: registry, storePath: join(root, "operations.json"),
      ownerWorker: { executable, workspaceStorePath: registryPath, approvedRootsPath } });
    const initial = await manager.exec({ workspaceId: workspace.id, command: "echo shared-runtime-worker > result.txt", yieldTimeMs: 0 });
    await manager.waitUntilResolved();
    expect(manager.status(workspace.id, initial.operationId)).toMatchObject({ state: "exited", exitCode: 0 });
    expect(readFileSync(join(root, "result.txt"), "utf8").trim()).toBe("shared-runtime-worker");

    const destination = join(root, "local marketplace");
    const exported = await run(["local-mcp", "package", destination]);
    expect(exported).toMatchObject({ code: 0, err: "" });
    const { plugin, marketplace } = JSON.parse(exported.out);
    const entry = JSON.parse(readFileSync(marketplace, "utf8")).plugins[0];
    expect(join(destination, entry.source.path)).toBe(plugin);
    expect(readdirSync(plugin).sort()).toEqual([".codex-plugin", ".mcp.json"]);
    writeFileSync(join(destination, "README.md"), "user content");
    expect((await run(["local-mcp", "package", destination])).code).toBe(1);
    expect(readFileSync(join(destination, "README.md"), "utf8")).toBe("user content");
    expect((await run(["local-mcp", "package"])).code).toBe(1);

    // Host caches the plugin elsewhere; only the installed Tela executable is needed on PATH.
    const cached = join(root, "plugin cache", "local");
    cpSync(plugin, cached, { recursive: true });
    rmSync(destination, { recursive: true });
    const config = JSON.parse(readFileSync(join(cached, ".mcp.json"), "utf8")).mcpServers["tela-local-chat"];
    const home = join(root, "isolated home");
    const paths = resolveProductPaths({ home, environment: {} });
    const tools = createChatToolRuntime({ allowedRoots: [root], stateRoot: join(root, "local-chat") });
    await tools.initialize();
    service = await startChatService({ bearerToken: "x".repeat(48), tools });
    const owned = createOwnershipManifest("test", new Date(), "compiled-local-plugin");
    writeOwnershipManifest(paths.installManifest, owned);
    const marketplacePath = join(home, ".agents", "plugins", "marketplace.json");
    expect(await registerDeviceLocalChatPlugin({ paths, launcherExecutablePath: executable, marketplacePath })).toBe("registered");
    const personal = JSON.parse(readFileSync(join(home, ".agents", "plugins", "marketplace.json"), "utf8"));
    expect(personal.plugins[0].source.path.startsWith("./")).toBe(true);
    const ownedPlugin = join(home, personal.plugins[0].source.path);
    expect(readdirSync(ownedPlugin).sort()).toEqual([".codex-plugin", ".mcp.json"]);
    expect(await registerDeviceLocalChatPlugin({ paths, launcherExecutablePath: executable, marketplacePath })).toBe("already-registered");
    writeServiceRuntimeDescriptor(join(paths.serviceRuntime("chat"), "descriptor.json"), {
      version: 1, service: "chat", instanceId: service.instanceId, installId: owned.installId,
      pid: process.pid, endpoint: service.endpoint.href, bearerToken: service.bearerToken, startedAt: new Date().toISOString()
    });
    // Keep the installed path while replacing actual executable bytes. The
    // cached host plugin must use the replacement without re-registration.
    const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    const versionA = digest(executable);
    const replacement = join(root, process.platform === "win32" ? "tela-next.exe" : "tela-next");
    const upgrade = Bun.spawn([process.execPath, "build", fileURLToPath(new URL("./entrypoint.ts", import.meta.url)),
      "--compile", "--minify", `--outfile=${replacement}`], { stdout: "pipe", stderr: "pipe" });
    const [upgraded, , upgradeError] = await Promise.all([upgrade.exited,
      new Response(upgrade.stdout).text(), new Response(upgrade.stderr).text()]);
    expect(upgraded).toBe(0);
    expect(upgradeError).not.toContain("error:");
    if (process.platform === "darwin") execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", replacement]);
    const versionB = digest(replacement);
    expect(versionB).not.toBe(versionA);
    renameSync(replacement, executable);
    expect(digest(executable)).toBe(versionB);
    expect((await run(["--help"])).code).toBe(0);
    client = new Client({ name: "compiled-local-plugin", version: "0.0.1" }, { capabilities: {} });
    await client.connect(new StdioClientTransport({ command: config.command, args: config.args,
      cwd: cached, env: { ...config.env, HOME: home, USERPROFILE: home,
        APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
        XDG_DATA_HOME: join(home, ".local", "share"), XDG_CONFIG_HOME: join(home, ".config"),
        XDG_STATE_HOME: join(home, ".local", "state"), XDG_CACHE_HOME: join(home, ".cache"),
        XDG_RUNTIME_DIR: "" } }));
    const opened = await client.callTool({ name: "chatgpt_tela_chat_capability_call",
      arguments: { capability: "open_workspace", arguments: { path: root } } });
    const localWorkspace = JSON.parse((opened.content as { text: string }[])[0]!.text);
    const read = await client.callTool({ name: "chatgpt_tela_chat_capability_call",
      arguments: { capability: "read", arguments: { workspace_id: localWorkspace.id, path: "result.txt" } } });
    expect(read.isError).not.toBe(true);
    expect(JSON.stringify(read.content)).toContain("shared-runtime-worker");
    const write = await client.callTool({ name: "chatgpt_tela_chat_capability_call",
      arguments: { capability: "exec_command", arguments: { workspace_id: localWorkspace.id,
        cmd: "echo upgraded-runtime > upgraded.txt" } } });
    expect(write.isError).not.toBe(true);
    expect(readFileSync(join(root, "upgraded.txt"), "utf8").trim()).toBe("upgraded-runtime");
  } finally {
    await client?.close();
    await service?.close();
    await manager?.close();
    removeFixture(root);
  }
}, 60_000);
