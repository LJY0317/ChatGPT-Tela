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
} else {
  await import("./main");
}

export {};
