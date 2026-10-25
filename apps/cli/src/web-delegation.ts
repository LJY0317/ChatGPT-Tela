import { randomUUID } from "node:crypto";
import { readProductPreferences, webDelegationLimit } from "@chatgpt-tela/product-config";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { decodeNativeInlineEvidence } from "@chatgpt-tela/core";
import { connectCodexAppServerWebSocket } from "@chatgpt-tela/codex";
import { readOwnershipManifest, type resolveProductPaths } from "@chatgpt-tela/product-lifecycle";
import { CodexServiceClient, descriptorForService } from "@chatgpt-tela/service-protocol/client";
import { LocalServiceSupervisor } from "@chatgpt-tela/service-supervisor";
import { createLocalNativeAccountProof, type TrustedNativeProfileSession } from "../../../packages/codex-service/src/cross-profile-account-proof";
import { WebDelegationStore, inspectWebDelegationResult, collectWebDelegationResult, WebDelegationCapacityError, verifiedWebDelegationAnswer, runWebDelegation, reconcileWebDelegation } from "../../../packages/codex-service/src/web-delegation";
import { selectDelegationWebModel } from "../../../packages/codex-service/src/web-delegation-model";
import { profileSlotFromArguments, delegationProfileSlot } from "./profile-selection";

/** On-demand source CLI first. No new daemon, poller, paid API provider or product lifecycle mutation. */
export async function runWebDelegationCommand(args: readonly string[], paths: ReturnType<typeof resolveProductPaths>): Promise<void> {
  const subcommand = args[0];
  const option = (name: string) => {
    const indexes = args.flatMap((value, index) => value === name ? [index] : []);
    if (indexes.length !== 1 || !args[indexes[0]! + 1] || args[indexes[0]! + 1]!.startsWith("--")) throw Error(`${name} requires one value`);
    return args[indexes[0]! + 1]!;
  };
  const store = new WebDelegationStore(join(paths.serviceState("codex"), "web-delegations"),
    slot => webDelegationLimit(readProductPreferences(), slot));
  let connectedClient: CodexServiceClient | undefined;
  const getClient = async (): Promise<CodexServiceClient> => {
    if (connectedClient) return connectedClient;
    const install = readOwnershipManifest(paths.installManifest);
    if (!install) throw Error("Tela is not installed");
    const service = await new LocalServiceSupervisor({ installId: install.installId }).current({
      service: "codex", descriptorPath: join(paths.serviceRuntime("codex"), "descriptor.json"),
    });
    if (!service) throw Error("Tela Work is not running");
    return connectedClient = new CodexServiceClient(descriptorForService(service.descriptor, "codex"));
  };
  const session = async (selected: number): Promise<TrustedNativeProfileSession> => {
    const client = await getClient();
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
  const adapters = { store, owner, connect: (endpoint: string) => connectCodexAppServerWebSocket(endpoint, { signal: AbortSignal.timeout(10_000) }) };
  if (args.includes("--mode")) throw Error("--mode has been removed; each new task uses workspace-write authority");
  if (subcommand === "capacity") {
    console.log(JSON.stringify(store.capacity(profileSlotFromArguments(args)), null, 2));
    return;
  }
  if (subcommand === "status" || subcommand === "result") {
    if (subcommand === "result") {
      const id = option("--job");
      console.log(await collectWebDelegationResult(adapters, id, args.includes("--confirm-title-retry")));
    } else {
      const record = await inspectWebDelegationResult(adapters, option("--job"), args.includes("--confirm-title-retry"));
      console.log(JSON.stringify({ jobId: record.id, state: record.state, taskOutcome: record.taskOutcome ?? "unassessed", finalEvidence: record.finalEvidence ?? "unproven", observation: "journal", reconciliation: record.reconciliation ?? "not-observed", progress: record.progress, parentJobId: record.parentJobId, threadId: record.threadId, turnId: record.turnId, selection: record.selection, toolItems: record.toolItems ?? 0, toolItemCoverage: record.toolItemCoverage ?? "unverified", toolResultItems: record.toolResultItems ?? 0, toolResultCoverage: record.toolResultCoverage ?? "unverified", toolCountProvesNoExecution: false, failure: record.failure, failureStage: record.failureStage, failureClass: record.failureClass, failureNativeCode: record.failureNativeCode, failureIncidentRef: record.failureIncidentRef, failureNextAction: record.failureNextAction, coordinatorWake: "unsupported_public_contract" }, null, 2));
    }
    return;
  }
  if (subcommand !== "start" && subcommand !== "continue" && subcommand !== "catalog" && subcommand !== "reconcile") throw Error("Usage: web-delegate <catalog|capacity|start|continue|status|result|reconcile>");
  const selectedJob = subcommand === "reconcile" ? store.get(option("--job")) : undefined;
  if (subcommand === "reconcile" && !selectedJob) throw Error("Web job was not found");
  const continuation = subcommand === "continue" ? store.get(option("--job")) : undefined;
  if (subcommand === "continue" && !continuation) throw Error("Web job was not found");
  if ((selectedJob || continuation) && args.includes("--slot")
    && profileSlotFromArguments(args) !== (selectedJob ?? continuation)!.slot) {
    throw Error("Existing Web job belongs to a different profile; its owner cannot be changed");
  }
  let slot = selectedJob?.slot ?? continuation?.slot ?? profileSlotFromArguments(args);
  const client = await getClient();
  if (!selectedJob && !continuation) {
    slot = await delegationProfileSlot(args, { findCallerProfile: async threadId => {
      const profiles = (await client.profiles()).filter(profile => profile.targetSessionState === "ready");
      const matches = await Promise.all(profiles.map(async profile => {
        let rpc: Awaited<ReturnType<typeof connectCodexAppServerWebSocket>> | undefined;
        try {
          const terminal = await client.terminalSession(profile.slot);
          rpc = await connectCodexAppServerWebSocket(terminal.endpoint);
          const result = await rpc.request("thread/read", { threadId, includeTurns: false }) as { thread?: { id?: string } };
          return result.thread?.id === threadId ? profile.slot : undefined;
        } catch { return undefined; }
        finally { await rpc?.close(); }
      }));
      const found = matches.filter(value => value !== undefined);
      return found.length === 1 ? found[0] : undefined;
    } });
  }
  if (subcommand === "reconcile") {
    const record = await reconcileWebDelegation(adapters, selectedJob!.id, AbortSignal.timeout(30_000));
    if (record.state === "completed" || record.state === "failed") await inspectWebDelegationResult(adapters, record.id);
    const answer = verifiedWebDelegationAnswer(record);
    if (answer) await collectWebDelegationResult(adapters, record.id);
    console.log(JSON.stringify({ jobId: record.id, state: record.state, toolItems: record.toolItems ?? 0,
      resultAvailable: Boolean(answer), failure: record.failure, failureStage: record.failureStage,
      failureClass: record.failureClass, failureNativeCode: record.failureNativeCode, failureIncidentRef: record.failureIncidentRef,
      failureNextAction: record.failureNextAction,
      coordinatorWake: "unsupported_public_contract", ...(answer ? { finalEvidence: record.finalEvidence, answer } : {}) }));
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
  const cwd = realpathSync(continuation?.cwd ?? option("--cwd"));
  if (!lstatSync(cwd).isDirectory()) throw Error("Web job requires an existing workspace");
  const promptPath = option("--prompt-file"), stat = lstatSync(promptPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 24 * 1024) throw Error("Web job prompt must be a bounded regular file");
  const prompt = readFileSync(promptPath, "utf8");
  if (args.includes("--file")) throw Error("File attachments are not supported by the current Native turn/start contract");
  const imagePaths = args.flatMap((arg, index) => arg === "--image-file" ? [args[index + 1]] : []);
  if (imagePaths.some(path => !path || path.startsWith("--")) || imagePaths.length > 8) throw Error("--image-file requires a bounded local image path");
  const images = imagePaths.map(path => {
    const stat = lstatSync(path!);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 24 * 1024 * 1024) throw Error("Image attachment must be a bounded regular file");
    const bytes = readFileSync(path!);
    const mime = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png"
      : bytes.subarray(0, 3).equals(Buffer.from([255,216,255])) ? "image/jpeg"
      : bytes.subarray(0, 3).toString() === "GIF" ? "image/gif"
      : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP" ? "image/webp" : undefined;
    if (!mime) throw Error("Unsupported image attachment format");
    const inline = `data:${mime};base64,${bytes.toString("base64")}`;
    decodeNativeInlineEvidence(inline);
    return inline;
  });
  const id = continuation ? randomUUID() : args.includes("--job") ? option("--job") : randomUUID();
  const lifecycle = new AbortController();
  const interrupt = () => lifecycle.abort(new Error("CLI interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const result = await runWebDelegation({
      ...adapters,
      changed: record => console.log(JSON.stringify({ jobId: record.id, state: record.state, selection: record.selection, toolItems: record.toolItems ?? 0 })),
    }, { id, slot, cwd, prompt, ...(images.length ? { images } : {}), ...(continuation ? { parentJobId: continuation.id } : {}), signal: lifecycle.signal });
    const answer = verifiedWebDelegationAnswer(result);
    if (answer) {
      await collectWebDelegationResult(adapters, result.id);
      console.log(JSON.stringify({ event: "result", jobId: result.id, state: result.state,
        finalEvidence: result.finalEvidence, taskOutcome: result.taskOutcome, answer }));
    } else await inspectWebDelegationResult(adapters, result.id);
  } catch (error) {
    if (error instanceof WebDelegationCapacityError) {
      console.error(JSON.stringify({ status: "admission_refused", code: error.code, capacity: error.capacity }));
      process.exitCode = 1;
      return;
    }
    if (store.get(id)) await inspectWebDelegationResult(adapters, id);
    throw error;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
