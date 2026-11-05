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
  } else if (args[0] === "register" && args.length === 1) {
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const { readdirSync } = await import("node:fs");
    const { resolveProductPaths, readOwnershipManifest, prepareOwnedDirectory, registerLocalMarketplace, withPackagedTransitionOwner } =
      await import("@chatgpt-tela/product-lifecycle");
    const paths = resolveProductPaths(), manifest = readOwnershipManifest(paths.installManifest);
    if (!manifest) throw Error("local marketplace requires an installed Tela product");
    const root = join(paths.stateRoot, "install", "local-chat-plugin");
    const resource = { kind: "directory" as const, id: "local-chat-plugin-source", owner: "product" as const,
      path: root, dataClass: "binary" as const };
    const result = await withPackagedTransitionOwner({ paths, installId: manifest.installId }, async () => {
      const prepared = await prepareOwnedDirectory({ manifestPath: paths.installManifest,
        installId: manifest.installId, productVersion: manifest.productVersion, resource });
      if (prepared.state === "external-existing") throw Error("local plugin source belongs to another owner");
      const { prepareLocalChatPlugin, normalizeOwnedLocalChatPlugin } = await import("../../local-mcp/src/plugin-package");
      const contents = readdirSync(root).filter(name => name !== ".chatgpt-tela-owner.json");
      if (contents.length === 0) prepareLocalChatPlugin(root, process.execPath);
      else normalizeOwnedLocalChatPlugin(root, process.execPath);
      return registerLocalMarketplace({ manifestPath: paths.installManifest,
        marketplacePath: join(homedir(), ".agents", "plugins", "marketplace.json"),
        pluginPath: join(root, "plugins", "tela-local-chat") });
    });
    process.stdout.write(JSON.stringify({ result }) + "\n");
  } else throw new Error("usage: chatgpt-tela local-mcp [package <destination>|register]");
} else {
  await import("./main");
}

export {};
