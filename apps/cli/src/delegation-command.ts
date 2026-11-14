import { join } from "node:path";
import { readOwnershipManifest, resolveProductPaths, type ProductPaths } from "@chatgpt-tela/product-lifecycle";
import { CodexServiceClient, descriptorForService } from "@chatgpt-tela/service-protocol/client";
import { LocalServiceSupervisor } from "@chatgpt-tela/service-supervisor";
import { profileSlotFromArguments } from "./profile-selection";

export const DELEGATION_COMMANDS = ["retain-delegation", "acknowledge-result", "reconcile-delegations"];

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
  const slot = profileSlotFromArguments(args.slice(1));
  const parentThreadId = (input.environment ?? process.env).CODEX_THREAD_ID;
  if (command !== "reconcile-delegations" && !parentThreadId) throw Error(`Run ${command} from the coordinating Native chat`);
  let request: Parameters<CodexServiceClient["manageDelegation"]>[0];
  if (command === "reconcile-delegations") request = { action: "reconcile", slot };
  else if (command === "retain-delegation") request = { action: "enroll", slot, parentThreadId: parentThreadId!, threadId: required("--thread") };
  else {
    const outcome = option("--outcome") ?? "answer";
    if (!["answer", "failed", "interrupted"].includes(outcome)
      || outcome !== "answer" && option("--item")) throw Error("Use --item for an answer, or --outcome failed|interrupted");
    request = { action: "acknowledge", slot, parentThreadId: parentThreadId!, threadId: required("--thread"), turnId: required("--turn"),
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
