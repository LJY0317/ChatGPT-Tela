import { join } from "node:path";
import { readOwnershipManifest, resolveProductPaths, type ProductPaths } from "@chatgpt-tela/product-lifecycle";
import { CodexServiceClient, descriptorForService } from "@chatgpt-tela/service-protocol/client";
import { LocalServiceSupervisor } from "@chatgpt-tela/service-supervisor";
import { profileSlotFromArguments } from "./profile-selection";

export const DELEGATION_COMMANDS = ["start-web-delegation", "follow-up-web-delegation", "retain-delegation", "list-delegations", "read-delegation-result", "acknowledge-result", "reconcile-delegations"];

/** Source and installed launchers use the same command and existing owned service. */
export async function runDelegationCommand(args: readonly string[], input: {
  paths?: ProductPaths; environment?: NodeJS.ProcessEnv;
  client?: Pick<CodexServiceClient, "manageDelegation"> & Partial<Pick<CodexServiceClient, "startWebDelegation" | "submitWebFollowUp">>;
  readPrompt?: () => Promise<string>;
} = {}): Promise<unknown> {
  const environment = input.environment ?? process.env;
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
  const serviceClient = async () => {
    if (input.client) return input.client;
    const paths = input.paths ?? resolveProductPaths(), manifest = readOwnershipManifest(paths.installManifest);
    if (!manifest) throw Error("Install and start Tela before managing delegated chats");
    const running = await new LocalServiceSupervisor({ installId: manifest.installId }).current({
      service: "codex", descriptorPath: join(paths.serviceRuntime("codex"), "descriptor.json"),
    });
    if (!running) throw Error("Start Tela before managing delegated chats");
    return new CodexServiceClient(descriptorForService(running.descriptor, "codex"));
  };
  if (command === "follow-up-web-delegation") {
    if (!args.includes("--slot")) throw Error("Choose the destination with --slot");
    const coordinatorThreadId = environment.CODEX_THREAD_ID;
    if (!coordinatorThreadId) throw Error("Run the follow-up from the coordinating Native chat");
    const threadId = required("--thread");
    const prompt = (await (input.readPrompt?.() ?? Bun.stdin.text())).trim();
    if (!prompt) throw Error("Pass the follow-up assignment on standard input");
    const client = await serviceClient();
    if (!client.submitWebFollowUp) throw Error("Web follow-up submission is unavailable");
    const result = await client.submitWebFollowUp({
      slot: slot!, coordinatorThreadId, threadId, prompt,
      ...(args.includes("--wait") ? { wait: true } : {}),
    });
    if (!result || typeof result !== "object" || Array.isArray(result)) throw Error("Invalid Web follow-up service receipt");
    return { sourceThreadId: coordinatorThreadId, slot, ...result };
  }
  if (command === "start-web-delegation") {
    if (!args.includes("--slot")) throw Error("Choose the destination with --slot");
    const model = option("--model");
    const title = required("--title").trim();
    if (!title || title.length > 187) throw Error("Choose a title from 1 to 187 characters");
    const prompt = (await Bun.stdin.text()).trim();
    if (!prompt) throw Error("Pass the assignment on standard input");
    const sourceThreadId = environment.CODEX_THREAD_ID;
    const client = await serviceClient();
    if (!client.startWebDelegation) throw Error("The connected Codex service does not support Web submission");
    const result = await client.startWebDelegation({
      slot: slot!, title, prompt, cwd: process.cwd(), ...(model ? { model } : {}),
      ...(sourceThreadId ? { coordinatorThreadId: sourceThreadId } : {}),
      ...(args.includes("--wait") ? { wait: true } : {}),
    });
    if (!result || typeof result !== "object" || Array.isArray(result)) throw Error("Invalid Web delegation service receipt");
    return { ...(sourceThreadId ? { sourceThreadId } : {}), slot, ...result };
  }
  const standalone = args.includes("--standalone");
  if (standalone && (command === "reconcile-delegations" || command === "list-delegations" || !args.includes("--slot"))) throw Error("--standalone requires an explicit --slot and a chat");
  const parentThreadId = standalone ? undefined : environment.CODEX_THREAD_ID;
  if (command !== "reconcile-delegations" && !standalone && !parentThreadId) throw Error(`Run ${command} from the coordinating Native chat`);
  const owner = standalone ? { standalone: true as const } : { parentThreadId: parentThreadId! };
  let request: Parameters<CodexServiceClient["manageDelegation"]>[0];
  if (command === "reconcile-delegations") request = { action: "reconcile", ...(slot === undefined ? {} : { slot }) };
  else if (command === "retain-delegation") request = { action: "enroll", slot: slot!, ...owner, threadId: required("--thread") };
  else if (command === "list-delegations") request = { action: "list-tracked", slot: slot!, parentThreadId: parentThreadId! };
  else if (command === "read-delegation-result") {
    const previousBefore = option("--previous-before");
    const expectedTurnId = option("--turn");
    if (previousBefore && expectedTurnId) throw Error("Choose --turn or --previous-before");
    request = { action: "read-result", slot: slot!, ...owner, threadId: required("--thread"),
      ...(previousBefore ? { previousBefore } : {}), ...(expectedTurnId ? { expectedTurnId } : {}) };
  }
  else {
    const outcome = option("--outcome") ?? "answer";
    if (!["answer", "failed", "interrupted"].includes(outcome)
      || outcome !== "answer" && option("--item")) throw Error("Use --item for an answer, or --outcome failed|interrupted");
    request = { action: "acknowledge", slot: slot!, ...owner, threadId: required("--thread"), turnId: required("--turn"),
      ...(outcome === "answer" ? { outcome, itemId: required("--item") } : { outcome: outcome as "failed" | "interrupted" }) };
  }
  return (await serviceClient()).manageDelegation(request);
}
