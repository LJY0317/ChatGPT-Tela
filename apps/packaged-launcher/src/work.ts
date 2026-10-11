import { join, resolve } from "node:path";
import { resolveDefaultDesktopInstallation } from "@chatgpt-tela/default-desktop-target";
import { runWorkTerminal, workTerminalArguments } from "@chatgpt-tela/codex";
import { readOwnershipManifest, resolveProductPaths } from "@chatgpt-tela/product-lifecycle";
import { CodexServiceClient, descriptorForService } from "@chatgpt-tela/service-protocol/client";
import { LocalServiceSupervisor } from "@chatgpt-tela/service-supervisor";
import { payloadRootForLauncherExecutable, resolvePackagedServiceLaunch } from "./runtime";

export function parsePackagedWorkArguments(args: readonly string[]) {
  if (args[0] !== "work") throw new Error("expected work command");
  const options = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const name = args[i]!;
    if (!["--slot", "--thread", "--model", "--cwd"].includes(name)) throw new Error(`unknown Work option: ${name}`);
    const value = args[i + 1];
    if (!value || value.startsWith("--") || options.has(name)) throw new Error(`invalid or repeated ${name}`);
    options.set(name, value);
  }
  const slotText = options.get("--slot") ?? "1";
  if (!/^[1-9][0-9]?$/.test(slotText)) throw new Error("Work slot must be an integer from 1 to 99");
  return {
    slot: Number(slotText),
    ...(options.has("--thread") ? { threadId: options.get("--thread")! } : {}),
    ...(options.has("--model") ? { model: options.get("--model")! } : {}),
    ...(options.has("--cwd") ? { cwd: resolve(options.get("--cwd")!) } : {}),
  };
}

export async function runPackagedWorkCommand(args: readonly string[]): Promise<number> {
  const options = parsePackagedWorkArguments(args);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("work requires an interactive terminal");
  // Prove the installed payload and completed ownership transition before attaching.
  // Resolving this launch does not start, replace or stop the service.
  resolvePackagedServiceLaunch({ service: "codex", payloadRoot: payloadRootForLauncherExecutable(),
    launcherExecutablePath: process.execPath });
  const paths = resolveProductPaths();
  const ownership = readOwnershipManifest(paths.installManifest)!;
  const current = await new LocalServiceSupervisor({ installId: ownership.installId }).current({
    service: "codex", descriptorPath: join(paths.serviceRuntime("codex"), "descriptor.json"),
  });
  if (!current) throw new Error("Open Tela and connect your Work profile before opening the terminal");
  const session = await new CodexServiceClient(descriptorForService(current.descriptor, "codex"))
    .terminalSession(options.slot, AbortSignal.timeout(10_000));
  const installation = resolveDefaultDesktopInstallation({ environment: process.env });
  return runWorkTerminal({ executable: installation.codexExecutable,
    arguments: workTerminalArguments({ session, ...options }) });
}
