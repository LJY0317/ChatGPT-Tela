import { payloadRootForLauncherExecutable, resolvePackagedServiceLaunch, runPackagedServiceLauncher } from "./runtime";

function serviceFromArguments(arguments_: readonly string[]): "gateway" | "chat" | "codex" {
  if (arguments_.length !== 2 || arguments_[0] !== "service") {
    throw new Error("usage: chatgpt-tela service <gateway|chat|codex>");
  }
  const service = arguments_[1];
  if (!(service === "gateway" || service === "chat" || service === "codex")) {
    throw new Error("packaged launcher service must be gateway, chat, or codex");
  }
  return service;
}

async function main(): Promise<void> {
  const service = serviceFromArguments(process.argv.slice(2));
  const launch = resolvePackagedServiceLaunch({
    service,
    payloadRoot: payloadRootForLauncherExecutable(),
    launcherExecutablePath: process.execPath,
  });
  process.exitCode = await runPackagedServiceLauncher({ launch });
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
