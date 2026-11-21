import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runOfficialWebDelegation } from "@chatgpt-tela/codex";
import { resolveDefaultDesktopInstallation } from "@chatgpt-tela/default-desktop-target";
import { readProductConfig } from "@chatgpt-tela/product-config";
import { readOwnershipManifest, resolveProductPaths, type ProductPaths } from "@chatgpt-tela/product-lifecycle";
import { CodexServiceClient, descriptorForService } from "@chatgpt-tela/service-protocol/client";
import { LocalServiceSupervisor } from "@chatgpt-tela/service-supervisor";
import { profileSlotFromArguments } from "./profile-selection";

export const DELEGATION_COMMANDS = ["start-web-delegation", "retain-delegation", "list-delegations", "read-delegation-result", "acknowledge-result", "reconcile-delegations"];

/** Source and installed launchers use the same command and existing owned service. */
export async function runDelegationCommand(args: readonly string[], input: {
  paths?: ProductPaths; environment?: NodeJS.ProcessEnv;
  client?: Pick<CodexServiceClient, "manageDelegation">;
} = {}): Promise<unknown> {
  const command = args[0];
  if (!command || !DELEGATION_COMMANDS.includes(command)) throw Error("Unknown delegation command");
  const option = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const value = args[i + 1];
    if (!value || value.startsWith("--")) throw Error(`${name} requires a value`);
    return value;
  };
  const required = (name: string) => { const value = option(name); if (!value) throw Error(`${command} requires ${name}`); return value; };
  const all = args.includes("--all");
  if (all && (command !== "reconcile-delegations" || args.includes("--slot"))) throw Error("--all is only for reconciliation without --slot");
  const slot = all ? undefined : profileSlotFromArguments(args.slice(1));
  if (command === "start-web-delegation") {
    if (!args.includes("--slot")) throw Error("Choose the destination with --slot");
    const model = required("--model");
    const title = required("--title").trim();
    if (!title || title.length > 187) throw Error("Choose a title from 1 to 187 characters");
    const paths = input.paths ?? resolveProductPaths();
    if (!readOwnershipManifest(paths.installManifest)) throw Error("Install Tela before starting a Web delegation");
    const route = readProductConfig(join(paths.configRoot, "product-v1.json")).appOwnedResponses?.find(route => route.slot === slot);
    const installation = resolveDefaultDesktopInstallation({ environment: input.environment ?? process.env });
    const configPath = route?.desktopConfigPath ?? (slot === 1 ? join(installation.codexHome, "config.toml") : undefined);
    if (!route || !configPath) throw Error("The destination has no registered Tela Web route");
    const config = Bun.TOML.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    if ((config.model_provider ?? "openai") !== "openai"
      || config.openai_base_url !== `http://127.0.0.1:${route.port}/${route.capability}/v1`) {
      throw Error("The destination profile is not using its registered OpenAI Web route");
    }
    const prompt = (await Bun.stdin.text()).trim();
    if (!prompt) throw Error("Pass the assignment on standard input");
    const result = await runOfficialWebDelegation({
      executable: installation.codexExecutable, codexHome: dirname(configPath),
      cwd: process.cwd(), model, title: `[Tela Agent] ${title}`, prompt,
    });
    return { slot, ...result };
  }
  const standalone = args.includes("--standalone");
  if (standalone && (command === "reconcile-delegations" || command === "list-delegations" || !args.includes("--slot"))) throw Error("--standalone requires an explicit --slot and a chat");
  const parentThreadId = standalone ? undefined : (input.environment ?? process.env).CODEX_THREAD_ID;
  if (command !== "reconcile-delegations" && !standalone && !parentThreadId) throw Error(`Run ${command} from the coordinating Native chat`);
  const owner = standalone ? { standalone: true as const } : { parentThreadId: parentThreadId! };
  let request: Parameters<CodexServiceClient["manageDelegation"]>[0];
  if (command === "reconcile-delegations") request = { action: "reconcile", ...(slot === undefined ? {} : { slot }) };
  else if (command === "retain-delegation") request = { action: "enroll", slot: slot!, ...owner, threadId: required("--thread") };
  else if (command === "list-delegations") request = { action: "list-tracked", slot: slot!, parentThreadId: parentThreadId! };
  else if (command === "read-delegation-result") {
    const previousBefore = option("--previous-before");
    request = { action: "read-result", slot: slot!, ...owner, threadId: required("--thread"),
      ...(previousBefore ? { previousBefore } : {}) };
  }
  else {
    const outcome = option("--outcome") ?? "answer";
    if (!["answer", "failed", "interrupted"].includes(outcome)
      || outcome !== "answer" && option("--item")) throw Error("Use --item for an answer, or --outcome failed|interrupted");
    request = { action: "acknowledge", slot: slot!, ...owner, threadId: required("--thread"), turnId: required("--turn"),
      ...(outcome === "answer" ? { outcome, itemId: required("--item") } : { outcome: outcome as "failed" | "interrupted" }) };
  }
  if (input.client) return input.client.manageDelegation(request);
  const paths = input.paths ?? resolveProductPaths(), manifest = readOwnershipManifest(paths.installManifest);
  if (!manifest) throw Error("Install and start Tela before managing delegated chats");
  const running = await new LocalServiceSupervisor({ installId: manifest.installId }).current({
    service: "codex", descriptorPath: join(paths.serviceRuntime("codex"), "descriptor.json"),
  });
  if (!running) throw Error("Start Tela before managing delegated chats");
  return new CodexServiceClient(descriptorForService(running.descriptor, "codex")).manageDelegation(request);
}
