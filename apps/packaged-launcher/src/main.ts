import {
  payloadRootForLauncherExecutable,
  resolvePackagedMenuBarLaunch,
  resolvePackagedServiceLaunch,
  runPackagedServiceLauncher,
} from "./runtime";
import { runPackagedLifecycleCommand } from "./lifecycle";
import { runProductUninstall } from "@chatgpt-tela/product-uninstall";

const USAGE = `ChatGPT Tela packaged runtime

Usage:
  chatgpt-tela install (--dry-run | --apply) --trusted-public-key <release-public-key.pem> [--payload <package-directory>]
  chatgpt-tela repair  (--dry-run | --apply) --trusted-public-key <release-public-key.pem> [--payload <package-directory>]
  chatgpt-tela upgrade (--dry-run | --apply) --trusted-public-key <release-public-key.pem> [--payload <package-directory>]
  chatgpt-tela uninstall (--dry-run | --apply) [--remove-data]

The package directory defaults to the directory containing this launcher. Use --dry-run before --apply.

Internal runtime commands:
  chatgpt-tela service <gateway|chat|codex>
  chatgpt-tela menu-bar
`;

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
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && (args[0] === "--help" || args[0] === "-h"))) {
    process.stdout.write(USAGE);
    return;
  }
  if (args[0] === "install" || args[0] === "repair" || args[0] === "upgrade") {
    const result = await runPackagedLifecycleCommand(args, {
      defaultPayloadRoot: payloadRootForLauncherExecutable(),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (args[0] === "uninstall") {
    const allowed = new Set(["uninstall", "--dry-run", "--apply", "--remove-data"]);
    const unknown = args.find(argument => !allowed.has(argument));
    if (unknown) throw new Error(`unknown packaged uninstall argument: ${unknown}`);
    const dryRun = args.includes("--dry-run");
    const apply = args.includes("--apply");
    if (dryRun === apply) throw new Error("uninstall requires exactly one of --dry-run or --apply");
    const result = await runProductUninstall({
      mode: apply ? "apply" : "dry-run",
      removeData: args.includes("--remove-data"),
      ...(apply ? { executingBinaryPath: process.execPath } : {}),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const launch = args.length === 1 && args[0] === "menu-bar"
    ? resolvePackagedMenuBarLaunch({
        payloadRoot: payloadRootForLauncherExecutable(),
        launcherExecutablePath: process.execPath,
      })
    : resolvePackagedServiceLaunch({
        service: serviceFromArguments(args),
        payloadRoot: payloadRootForLauncherExecutable(),
        launcherExecutablePath: process.execPath,
      });
  process.exitCode = await runPackagedServiceLauncher({ launch });
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
