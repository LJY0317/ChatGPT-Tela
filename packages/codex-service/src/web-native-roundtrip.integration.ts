/**
 * Opt-in installed-profile acceptance. Uses ONE new Web Native turn and a
 * disposable repository; never resumes or reads an existing personal thread.
 *
 * Before any model request, prove official Delete + exact absence on a new,
 * empty paginated thread. On failure, do not start a model or retry a delete.
 *
 *   bun run packages/codex-service/src/web-native-roundtrip.integration.ts --preflight [--slot 1|2]
 *   TELA_EXPLICIT_REAL_WEB_NATIVE_ACCEPTANCE=1 bun run \
 *     packages/codex-service/src/web-native-roundtrip.integration.ts --acceptance [--slot 1|2]
 *
 * This is a test-only source script, not installed product functionality.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProductPaths, readOwnershipManifest } from "@chatgpt-tela/product-lifecycle";
import { LocalServiceSupervisor } from "@chatgpt-tela/service-supervisor";
import { CodexServiceClient, descriptorForService } from "@chatgpt-tela/service-protocol/client";
import { connectCodexAppServerWebSocket, type CodexAppServerRpc } from "@chatgpt-tela/codex";
import { createLocalNativeAccountProof, type TrustedNativeProfileSession } from "./cross-profile-account-proof";
import { isExactDeletedNativeThreadAbsent } from "./one-chat-native-destination";
import { runWebDelegation, WebDelegationStore } from "./web-delegation";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const mode = process.argv[2];
const selectedSlot = process.argv.length === 5 && process.argv[3] === "--slot"
  ? Number(process.argv[4]) : process.argv.length === 3 ? 1 : NaN;
if (!(mode === "--preflight" || mode === "--acceptance") || ![1, 2].includes(selectedSlot)) {
  throw new Error("Choose --preflight or --acceptance and optionally --slot 1|2");
}
if (mode === "--acceptance" && process.env.TELA_EXPLICIT_REAL_WEB_NATIVE_ACCEPTANCE !== "1") {
  throw new Error("Real Web model acceptance requires explicit opt-in");
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

const temp = realpathSync(mkdtempSync(join(tmpdir(), "tela-web-native-e2e-")));
const cwd = join(temp, "synthetic-repository");
mkdirSync(cwd, { mode: 0o700 });
const marker = randomBytes(12).toString("hex");
writeFileSync(join(cwd, "test-marker.txt"), marker + "\n", { mode: 0o600 });
execFileSync("git", ["init", "-q"], { cwd });
execFileSync("git", ["add", "test-marker.txt"], { cwd });
execFileSync("git", ["-c", "user.name=Tela Test", "-c", "user.email=test@example.invalid",
  "commit", "-q", "-m", "disposable marker"], { cwd });
const store = new WebDelegationStore(join(temp, "private-journal"));
const jobId = randomUUID();
const pendingThreads = new Map<string, boolean>();
let canRemoveTemp = true;
let modelRequests = 0;
let webFinalProven = false;
let nativeToolResultProven = false;
const liveToolEvidence: Array<{
  readonly threadId: string;
  readonly turnId: string;
  readonly kind: string;
  readonly markerInResult: boolean;
  readonly resultCarrierCount: number;
}> = [];
const TOOL_KINDS = new Set(["commandExecution", "mcpToolCall", "dynamicToolCall", "functionCallOutput"]);

function toolResultWitness(raw: unknown): { readonly markerInResult: boolean; readonly resultCarrierCount: number } {
  const item = object(raw);
  if (!item) return { markerInResult: false, resultCarrierCount: 0 };
  const fields = ["aggregatedOutput", "output", "response", "result", "contentItems"];
  let markerInResult = false;
  let resultCarrierCount = 0;
  for (const field of fields) {
    if (!Object.hasOwn(item, field)) continue;
    const serialized = JSON.stringify(item[field]);
    if (typeof serialized !== "string" || Buffer.byteLength(serialized) > 128 * 1024) continue;
    resultCarrierCount++;
    if (serialized.includes(marker)) markerInResult = true;
  }
  return { markerInResult, resultCarrierCount };
}

async function cleanupExactOwnedThread(rpc: CodexAppServerRpc, threadId: string) {
  // One exact authorized Delete only; never retry an uncertain outcome.
  if (pendingThreads.get(threadId) !== false) return;
  pendingThreads.set(threadId, true);
  await rpc.request("thread/delete", { threadId }, AbortSignal.timeout(15_000));
  let absent = false;
  try {
    const result = object(await rpc.request("thread/read", {
      threadId, includeTurns: false,
    }, AbortSignal.timeout(10_000)));
    absent = object(result?.thread)?.id !== threadId;
  } catch (error) {
    absent = isExactDeletedNativeThreadAbsent(error, threadId);
  }
  if (!absent) throw new Error("Official Delete did not prove absence of the exact synthetic thread");
  pendingThreads.delete(threadId);
}

async function main() {
  const paths = resolveProductPaths();
  const install = readOwnershipManifest(paths.installManifest);
  if (!install) throw new Error("Installed product identity is unavailable");
  const supervisor = new LocalServiceSupervisor({ installId: install.installId });
  const owner = await supervisor.current({
    service: "codex", descriptorPath: join(paths.serviceRuntime("codex"), "descriptor.json"),
  });
  if (!owner) throw new Error("Exact installed Codex service is unavailable");
  const client = new CodexServiceClient(descriptorForService(owner.descriptor, "codex"));
  const slot = selectedSlot;
  const currentSession = async (): Promise<TrustedNativeProfileSession> => {
    const profile = (await client.profiles()).find(row => row.slot === slot);
    if (!profile || profile.controlState !== "running" || profile.targetSessionState !== "ready"
      || profile.webState !== "ready" || !profile.childProcessId
      || !profile.responsesRouteFingerprint || profile.accountManagementActive) {
      throw new Error("Exact Web/Native profile owner is not currently ready");
    }
    const terminal = await client.terminalSession(slot);
    if (terminal.slot !== slot) throw new Error("Native terminal session changed slot");
    return { slot, runtimeProcessId: profile.childProcessId,
      responsesRouteFingerprint: profile.responsesRouteFingerprint,
      terminalEndpoint: terminal.endpoint };
  };
  const before = await currentSession();
  const account = await client.accountCheck(slot);
  if (account.nativeSignIn !== "signed-in" || account.webBinding !== "matching"
    || account.nativeWebContainer !== "matching") {
    throw new Error("Exact Native/Web account binding is not verified");
  }
  const preview = await client.bridgePreview(slot);
  if (preview.slot !== slot || preview.activeSurfaceCount !== 0) {
    throw new Error("Web work is already active or cannot be proven idle");
  }
  const rpc = await connectCodexAppServerWebSocket(before.terminalEndpoint, {
    signal: AbortSignal.timeout(10_000),
  });
  try {
    // Empty paginated thread: exercise the exact official Delete route without
    // spending a model call or accessing any old user conversation.
    const started = object(await rpc.request("thread/start", {
      cwd, ephemeral: false, historyMode: "paginated",
      sandbox: "read-only", approvalPolicy: "never",
    }, AbortSignal.timeout(20_000)));
    const empty = object(started?.thread);
    if (!empty || typeof empty.id !== "string" || !UUID.test(empty.id)) {
      throw new Error("Empty test thread creation acknowledgement is uncertain");
    }
    pendingThreads.set(empty.id, false);
    if (empty.cwd !== cwd || empty.ephemeral === true
      || (empty.historyMode !== undefined && empty.historyMode !== "paginated")) {
      throw new Error("Empty test thread lacks exact ownership");
    }
    await cleanupExactOwnedThread(rpc, empty.id);
    if (JSON.stringify(before) !== JSON.stringify(await currentSession())) {
      throw new Error("Profile owner changed after official deletion preflight");
    }
    if (mode === "--preflight") {
      console.log(JSON.stringify({ phase: "preflight", officialDeleteAndAbsence: true,
        modelRequests, personalThreadsRead: 0, newSyntheticThreadsRemaining: 0 }));
      return;
    }
    // Only one model request: a new Native-owned paginated Web turn in the
    // isolated repository. The model does not receive the random marker.
    const proof = createLocalNativeAccountProof({
      resolveOwnedSession: async () => currentSession(),
      fingerprintKey: store.fingerprintKey,
    });
    const binding = await proof(slot);
    const resultAdapters = {
      store,
      owner: async (requested: number) => {
        if (requested !== slot) throw new Error("Foreign test profile");
        return { binding: await proof(slot), session: await currentSession() };
      },
      connect: async (endpoint: string) => {
        const inner = await connectCodexAppServerWebSocket(endpoint, {
          signal: AbortSignal.timeout(10_000),
        });
        return {
          request: (method: string, params?: unknown, signal?: AbortSignal) => {
            if (method === "turn/start") {
              if (modelRequests !== 0) throw new Error("Real acceptance permits one Native turn/start only");
              modelRequests++;
            }
            return inner.request(method, params, signal);
          },
          close: () => inner.close(),
          subscribe: (callback: (method: string, params: unknown) => void, disconnected: () => void) =>
            inner.subscribe!((method, params) => {
              if (method === "item/completed" && liveToolEvidence.length < 32) {
                const event = object(params), item = object(event?.item);
                const current = store.get(jobId);
                if (event && current?.threadId && event.threadId === current.threadId
                  && typeof event.turnId === "string" && item && TOOL_KINDS.has(String(item.type))) {
                  const witness = toolResultWitness(item);
                  liveToolEvidence.push({ threadId: current.threadId, turnId: event.turnId,
                    kind: String(item.type), ...witness });
                }
              }
              callback(method, params);
            }, disconnected),
        };
      },
    };
    // Ensure identity is resolved before model admission; no shared account.
    if (binding.slot !== slot || binding.routeFingerprint !== before.responsesRouteFingerprint) {
      throw new Error("Web test account route differs from exact Native owner");
    }
    const prompt = "Test-only Native tool round-trip in an isolated disposable repository. "
      + "Use your Native Codex read-only command tool to read test-marker.txt in the current "
      + "working directory. Do not infer, invent or guess its contents, and do not edit files "
      + "or access other paths or network resources. After the actual tool RESULT is returned, "
      + "provide a final answer containing the exact 24-character hex marker you observed. "
      + "If a tool is unavailable, say so instead of fabricating a marker.";
    const job = runWebDelegation(resultAdapters, {
      id: jobId, slot, cwd, prompt, signal: AbortSignal.timeout(180_000),
    });
    const result = await job;
    webFinalProven = result.state === "completed" && result.finalEvidence === "explicit-final-phase"
      && typeof result.answer === "string" && result.answer.includes(marker);
    if (!result.threadId || !result.turnId || !UUID.test(result.threadId) || !UUID.test(result.turnId)) {
      throw new Error("Web turn identity is not a proven exact Native thread");
    }
    const status = object(await rpc.request("thread/turns/list", {
      threadId: result.threadId, sortDirection: "desc", itemsView: "summary", limit: 1,
    }, AbortSignal.timeout(20_000)));
    const rows = status?.data;
    const latest = Array.isArray(rows) && rows.length === 1 ? object(rows[0]) : undefined;
    if (!latest || latest.id !== result.turnId || latest.status !== "completed"
      || !Array.isArray(latest.items) || latest.items.length > 120) {
      throw new Error("Native current test turn summary was not proven");
    }
    const summaryProof = latest.items.some(value => {
      const item = object(value);
      return Boolean(item && TOOL_KINDS.has(String(item.type))
        && toolResultWitness(item).markerInResult);
    });
    const liveProof = liveToolEvidence.some(item => item.threadId === result.threadId
      && item.turnId === result.turnId && item.markerInResult);
    nativeToolResultProven = liveProof || summaryProof;
    console.log(JSON.stringify({ phase: "acceptance", modelRequests, webFinalProven,
      toolItemCountObserved: result.toolItems ?? 0, nativeToolResultProven,
      proofChannel: liveProof ? "native_live_completed_item" : summaryProof ? "native_public_summary" : "unverified",
      completedToolKinds: liveToolEvidence.filter(item => item.threadId === result.threadId
        && item.turnId === result.turnId).map(item => item.kind),
      observedResultCarriers: liveToolEvidence.filter(item => item.threadId === result.threadId
        && item.turnId === result.turnId).reduce((count, item) => count + item.resultCarrierCount, 0),
      sameNativeTurn: true, personalThreadsRead: 0 }));
    if (!webFinalProven || !nativeToolResultProven) {
      throw new Error("Actual Web answer and same-turn Native tool result were not both proved");
    }
  } finally {
    const record = store.get(jobId);
    if (record && !record.threadId && !["reserved"].includes(record.state)) {
      canRemoveTemp = false; // Unknown creation ACK; preserve the exact local journal.
    }
    if (record?.threadId && UUID.test(record.threadId)) {
      pendingThreads.set(record.threadId, false);
    }
    let cleanupFailure = false;
    for (const threadId of [...pendingThreads.keys()]) {
      try {
        if (JSON.stringify(before) !== JSON.stringify(await currentSession())) {
          throw new Error("Original Native profile binding changed before exact Delete");
        }
        await cleanupExactOwnedThread(rpc, threadId);
      } catch {
        cleanupFailure = true;
        // Only synthetic IDs created during this process; local private
        // inspection can use them if official Delete outcome is uncertain.
        console.error(JSON.stringify({ cleanup: "unverified", exactSyntheticThreadId: threadId,
          deleteRetried: false }));
      }
    }
    await rpc.close();
    if (cleanupFailure) {
      canRemoveTemp = false;
      throw new Error("At least one synthetic conversation requires exact owner cleanup inspection");
    }
    console.log(JSON.stringify({ cleanup: "all_exact_synthetic_threads_deleted",
      modelRequests, deletedAndAbsent: true }));
  }
}

try {
  await main();
} catch (error) {
  process.exitCode = 1;
  console.error(JSON.stringify({ phase: "failed", reason: error instanceof Error ? error.message : "unknown",
    modelRequests, webFinalProven, nativeToolResultProven }));
} finally {
  // Do not discard a private recovery journal while a synthetic thread is
  // still unproven. Remove only test-owned temporary data on exact cleanup.
  if (canRemoveTemp && pendingThreads.size === 0) {
    rmSync(temp, { recursive: true, force: true });
  } else {
    console.error(JSON.stringify({ cleanup: "manual_owner_inspection_needed",
      localRecoveryDirectory: temp, remainingExactSyntheticThreads: pendingThreads.size }));
    process.exitCode = 1;
  }
}
