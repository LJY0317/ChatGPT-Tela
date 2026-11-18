// One embedded Bun runtime; each invocation loads only its selected process entrypoint.
if (process.argv[2] === "--tela-operation-owner-v1") {
  await import("../../chat-daemon/src/main");
} else if (process.argv[2] === "--tela-daemon") {
  const service = process.argv[3];
  process.argv.splice(2, 2);
  const { launchDaemon } = await import("./daemon-entry");
  switch (service) {
    case "gateway": await launchDaemon("gateway", () => import("../../gateway-daemon/src/main")); break;
    case "chat": await launchDaemon("chat", () => import("../../chat-daemon/src/main")); break;
    case "codex": await launchDaemon("codex", () => import("../../codex-daemon/src/main")); break;
    default: throw new Error("packaged daemon must be gateway, chat, or codex");
  }
} else if (process.argv[2] === "delegation-hook") {
  const { runDelegationHook } = await import("../../cli/src/delegation-hook");
  await runDelegationHook(await Bun.stdin.text());
} else if (process.argv[2] === "local-mcp") {
  const args = process.argv.slice(3);
  if (args.length === 0) {
    const { serveDeviceLocalChatStdio } = await import("../../local-mcp/src/main");
    await serveDeviceLocalChatStdio();
  } else if (args[0] === "package" && args.length === 2) {
    const { mkdirSync } = await import("node:fs");
    const { prepareLocalChatPlugin } = await import("../../local-mcp/src/plugin-package");
    // The explicit output directory must be new; do not overwrite a user's existing catalog or README.
    mkdirSync(args[1]!);
    process.stdout.write(JSON.stringify(prepareLocalChatPlugin(args[1]!, process.execPath)) + "\n");
  } else if (args[0] === "status" && args.length === 1) {
    const { readLocalPluginStatus } = await import("./local-plugin");
    process.stdout.write(JSON.stringify(await readLocalPluginStatus({ launcherExecutablePath: process.execPath })) + "\n");
  } else if (args[0] === "register" && args.length === 1) {
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const { resolveProductPaths } = await import("@chatgpt-tela/product-lifecycle");
    const { registerDeviceLocalChatPlugin } = await import("../../local-mcp/src/main");
    const result = await registerDeviceLocalChatPlugin({ paths: resolveProductPaths(), launcherExecutablePath: process.execPath,
      marketplacePath: join(homedir(), ".agents", "plugins", "marketplace.json") });
    const { refreshInstalledLocalPlugin } = await import("./local-plugin");
    const refresh = await refreshInstalledLocalPlugin({ launcherExecutablePath: process.execPath });
    process.stdout.write(JSON.stringify({ result, refresh }) + "\n");
  } else throw new Error("usage: chatgpt-tela local-mcp [package <destination>|register|status]");
} else {
  await import("./main");
}

export {};
