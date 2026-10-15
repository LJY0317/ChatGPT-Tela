import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { connectCodexAppServerWebSocket } from "@chatgpt-tela/codex";
import { readOwnershipManifest, type resolveProductPaths } from "@chatgpt-tela/product-lifecycle";
import { CodexServiceClient, descriptorForService } from "@chatgpt-tela/service-protocol/client";
import { LocalServiceSupervisor } from "@chatgpt-tela/service-supervisor";
import { createLocalNativeAccountProof, type TrustedNativeProfileSession } from "../../../packages/codex-service/src/cross-profile-account-proof";
import { WebDelegationStore, runReadOnlyWebDelegation, reconcileWebDelegation } from "../../../packages/codex-service/src/web-delegation";
import { selectDelegationWebModel } from "../../../packages/codex-service/src/web-delegation-model";
import { profileSlotFromArguments } from "./profile-selection";

/** On-demand source CLI first. No new daemon, poller, paid API provider or product lifecycle mutation. */
export async function runWebDelegationCommand(args: readonly string[], paths: ReturnType<typeof resolveProductPaths>): Promise<void> {
  const subcommand = args[0];
  const option = (name: string) => {
    const indexes = args.flatMap((value, index) => value === name ? [index] : []);
    if (indexes.length !== 1 || !args[indexes[0]! + 1] || args[indexes[0]! + 1]!.startsWith("--")) throw Error(`${name} requires one value`);
    return args[indexes[0]! + 1]!;
  };
  const store = new WebDelegationStore(join(paths.serviceState("codex"), "web-delegations"));
  if (subcommand === "status" || subcommand === "result") {
    const record = store.get(option("--job"));
    if (!record) throw Error("Web job was not found");
    if (subcommand === "result") {
      if (record.state !== "completed" || record.finalEvidence !== "explicit-final-phase" || !record.answer) throw Error("No verified final result; inspect job status");
      console.log(record.answer);
    } else console.log(JSON.stringify({ jobId: record.id, state: record.state, taskOutcome: record.taskOutcome ?? "unassessed", finalEvidence: record.finalEvidence ?? "unproven", observation: "journal", selection: record.selection, toolItems: record.toolItems ?? 0, toolItemCoverage: record.toolItemCoverage ?? "unverified", toolCountProvesNoExecution: false, failure: record.failure }, null, 2));
    return;
  }
  if (subcommand !== "start" && subcommand !== "catalog" && subcommand !== "reconcile") throw Error("Usage: web-delegate <catalog|start|status|result|reconcile>");
  const selectedJob = subcommand === "reconcile" ? store.get(option("--job")) : undefined;
  if (subcommand === "reconcile" && !selectedJob) throw Error("Web job was not found");
  const slot = selectedJob?.slot ?? profileSlotFromArguments(args);
  const install = readOwnershipManifest(paths.installManifest);
  if (!install) throw Error("Tela is not installed");
  const service = await new LocalServiceSupervisor({ installId: install.installId }).current({
    service: "codex", descriptorPath: join(paths.serviceRuntime("codex"), "descriptor.json"),
  });
  if (!service) throw Error("Tela Work is not running");
  const client = new CodexServiceClient(descriptorForService(service.descriptor, "codex"));
  const session = async (selected: number): Promise<TrustedNativeProfileSession> => {
    const profile = (await client.profiles()).find(row => row.slot === selected);
    if (!profile || profile.controlState !== "running" || profile.targetSessionState !== "ready"
      || !profile.childProcessId || !profile.responsesRouteFingerprint) {
      throw Error("Selected profile is not ready for a new Web job");
    }
    const terminal = await client.terminalSession(selected);
    return { slot: selected, runtimeProcessId: profile.childProcessId, responsesRouteFingerprint: profile.responsesRouteFingerprint, terminalEndpoint: terminal.endpoint };
  };
  const binding = createLocalNativeAccountProof({ resolveOwnedSession: session, fingerprintKey: store.fingerprintKey });
  const owner = async (selected: number) => {
    return { binding: await binding(selected), session: await session(selected) };
  };
  if (subcommand === "reconcile") {
    const record = await reconcileWebDelegation({ store, owner,
      connect: endpoint => connectCodexAppServerWebSocket(endpoint, { signal: AbortSignal.timeout(10_000) }),
    }, selectedJob!.id, AbortSignal.timeout(30_000));
    console.log(JSON.stringify({ jobId: record.id, state: record.state, toolItems: record.toolItems ?? 0, resultAvailable: Boolean(record.answer && record.finalEvidence === "explicit-final-phase") }));
    return;
  }
  const profile = (await client.profiles()).find(row => row.slot === slot);
  if (profile?.webState !== "ready" || profile.accountManagementActive) throw Error("Selected Web profile is not ready");
  const account = await client.accountCheck(slot);
  if (account.nativeSignIn !== "signed-in" || account.webBinding !== "matching" || account.nativeWebContainer !== "matching") throw Error("Native/Web account binding is not proven");
  if (subcommand === "catalog") {
    const current = await owner(slot);
    const rpc = await connectCodexAppServerWebSocket(current.session.terminalEndpoint);
    try { console.log(JSON.stringify(selectDelegationWebModel(await rpc.request("model/list", { includeHidden: false }, AbortSignal.timeout(10_000))), null, 2)); }
    finally { await rpc.close(); }
    return;
  }
  const cwd = realpathSync(option("--cwd"));
  if (!lstatSync(cwd).isDirectory()) throw Error("Web job requires an existing workspace");
  const promptPath = option("--prompt-file"), stat = lstatSync(promptPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 24 * 1024) throw Error("Web job prompt must be a bounded regular file");
  const prompt = readFileSync(promptPath, "utf8");
  const id = args.includes("--job") ? option("--job") : randomUUID();
  console.log(JSON.stringify({ jobId: id, state: "preparing", readOnly: true }));
  await runReadOnlyWebDelegation({
    store, owner,
    connect: endpoint => connectCodexAppServerWebSocket(endpoint, { signal: AbortSignal.timeout(10_000) }),
    changed: record => console.log(JSON.stringify({ jobId: record.id, state: record.state, selection: record.selection, toolItems: record.toolItems ?? 0 })),
  }, { id, slot, cwd, prompt, signal: AbortSignal.timeout(20 * 60 * 1000) });
}
