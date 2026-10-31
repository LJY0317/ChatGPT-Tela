// One embedded Bun runtime; each invocation loads only its selected process entrypoint.
if (process.argv[2] === "--tela-operation-owner-v1") {
  await import("../../chat-daemon/src/main");
} else if (process.argv[2] === "--tela-daemon") {
  const service = process.argv[3];
  process.argv.splice(2, 2);
  switch (service) {
    case "gateway": await import("../../gateway-daemon/src/main"); break;
    case "chat": await import("../../chat-daemon/src/main"); break;
    case "codex": await import("../../codex-daemon/src/main"); break;
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
  } else throw new Error("usage: chatgpt-tela local-mcp [package <destination>]");
} else {
  await import("./main");
}

export {};
