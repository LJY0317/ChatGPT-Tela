/**
 * Explicitly opted-in test-only acceptance, NOT included in ordinary tests or
 * the installed product. Two NEW disposable Native Codex threads, one in the
 * owner's profile 1, the other in independently managed profile 2.
 *
 * Never reads an existing private conversation. No browser/saved Web chat
 * send. Official Native thread/delete is attempted exactly once on each
 * synthetic thread and absence is checked by the exact thread/read RPC.
 *
 * Run only AFTER real, owner-bound empty-thread Delete and absence were
 * separately verified in both target accounts. The latest authorizing
 * user expressly requested this two-profile continuation experiment.
 *
 *   TELA_EXPLICIT_REAL_HANDOFF_ACCEPTANCE=1 bun run \
 *     packages/codex-service/src/one-chat-real-profile-acceptance.integration.ts
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProductPaths, readOwnershipManifest } from "@chatgpt-tela/product-lifecycle";
import { LocalServiceSupervisor } from "@chatgpt-tela/service-supervisor";
import { CodexServiceClient, descriptorForService } from "@chatgpt-tela/service-protocol/client";
import { connectCodexAppServerWebSocket, type CodexAppServerRpc } from "@chatgpt-tela/codex";
import { createLocalNativeAccountProof, type TrustedNativeProfileSession } from "./cross-profile-account-proof";
import { createReadOnlyOriginalNativeThreadOwner } from "./cross-profile-native-reader";
import {
  createOwnedNewNativeThreadTarget, isExactDeletedNativeThreadAbsent,
} from "./one-chat-native-destination";
import { handoffOneSelectedNativeConversation } from "./one-chat-checkpoint-handoff";
import { SqliteOneChatHandoffJournal } from "./one-chat-handoff-journal";

if (process.env.TELA_EXPLICIT_REAL_HANDOFF_ACCEPTANCE !== "1") {
  throw new Error("This real two-account model-backed acceptance requires explicit opt-in");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Slot = 1 | 2;
const signal = () => AbortSignal.timeout(10_000);
const root = realpathSync(mkdtempSync(join(tmpdir(), "tela-native-one-chat-e2e-")));
const workspace = join(root, "only-synthetic-worktree");
const names = new Map<Slot, string>();
const cleaned = new Set<Slot>();
let sourceRpc: CodexAppServerRpc | undefined;
let destinationRpc: CodexAppServerRpc | undefined;
let journal: SqliteOneChatHandoffJournal | undefined;
let uncertain = false;
let result = "failed";
let sourceModelCompleted = false;
let targetModelCompleted = false;

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: workspace, encoding: "utf8", timeout: 8000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
}

async function waitForTurn(rpc: CodexAppServerRpc, threadId: string, turnId: string): Promise<boolean> {
  const deadline = Date.now() + 95_000;
  while (Date.now() < deadline) {
    const response = object(await rpc.request("thread/turns/list", {
      threadId, sortDirection: "desc", itemsView: "notLoaded", limit: 1,
    }, signal()));
    const entries = response?.data;
    const current = Array.isArray(entries) ? object(entries[0]) : undefined;
    if (current && current.id === turnId) {
      if (current.status === "completed") return true;
      if (current.status === "failed" || current.status === "interrupted") return false;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return false;
}

async function officialCleanup(slot: Slot, rpc: CodexAppServerRpc | undefined): Promise<void> {
  const id = names.get(slot);
  if (!id || !rpc) return;
  // The exact IDs below were returned by this process's NEW thread/start.
  // An uncertain (possibly accepted) delete is never automatically retried.
  await rpc.request("thread/delete", { threadId: id }, AbortSignal.timeout(15_000));
  let absent = false;
  try {
    const after = object(await rpc.request("thread/read", {
      threadId: id, includeTurns: false,
    }, signal()));
    absent = object(after?.thread)?.id !== id;
  } catch (error) { absent = isExactDeletedNativeThreadAbsent(error, id); }
  if (!absent) throw new Error("Official Delete did not prove exact synthetic thread absence");
  cleaned.add(slot);
}

async function main() {
  const paths = resolveProductPaths();
  const install = readOwnershipManifest(paths.installManifest);
  if (!install) throw new Error("Installed Tela owner is unavailable");
  const supervisor = new LocalServiceSupervisor({ installId: install.installId });
  const service = await supervisor.current({
    service: "codex", descriptorPath: join(paths.serviceRuntime("codex"), "descriptor.json"),
  });
  if (!service) throw new Error("No exact installed Codex owner");
  const client = new CodexServiceClient(descriptorForService(service.descriptor, "codex"));
  const getSession = async (slot: number): Promise<TrustedNativeProfileSession> => {
    const profile = (await client.profiles()).find(item => item.slot === slot);
    if (!profile || profile.controlState !== "running" || profile.targetSessionState !== "ready"
      || !profile.childProcessId || !profile.responsesRouteFingerprint) {
      throw new Error("Profile Native owner is not ready for exact account test");
    }
    const terminal = await client.terminalSession(slot);
    return {
      slot, runtimeProcessId: profile.childProcessId,
      responsesRouteFingerprint: profile.responsesRouteFingerprint,
      terminalEndpoint: terminal.endpoint,
    };
  };

  for (const slot of [1, 2] as const) {
    const web = await client.bridgePreview(slot);
    if (web.activeSurfaceCount !== 0) {
      throw new Error("Existing account has active Web work; do not create test thread");
    }
  }

  const binding = createLocalNativeAccountProof({ resolveOwnedSession: getSession });
  const [b1, b2] = await Promise.all([binding(1), binding(2)]);
  if (b1.accountFingerprint === b2.accountFingerprint
    || b1.sessionFingerprint === b2.sessionFingerprint) {
    throw new Error("Test must use two different authenticated Native logins and runtimes");
  }

  const session1 = await getSession(1);
  sourceRpc = await connectCodexAppServerWebSocket(session1.terminalEndpoint, { signal: signal() });
  const first = object(await sourceRpc.request("thread/start", {
    cwd: workspace, ephemeral: false, historyMode: "paginated",
    sandbox: "read-only", approvalPolicy: "never",
  }, AbortSignal.timeout(20_000)));
  const sourceThread = object(first?.thread);
  if (!sourceThread || typeof sourceThread.id !== "string" || !UUID.test(sourceThread.id)) {
    throw new Error("New disposable SOURCE thread identity was not acknowledged; do not begin a turn");
  }
  names.set(1, sourceThread.id);
  // The just-started official rollout can be empty before its FIRST model
  // turn. thread/read on an empty rollout is not a valid pre-turn probe.
  // Verify the indexed history via the source owner AFTER completion.
  if (sourceThread.cwd !== workspace
    || (sourceThread.historyMode !== undefined && sourceThread.historyMode !== "paginated")) {
    throw new Error("Source start acknowledgement did not confirm the selected test worktree/indexing");
  }

  // Real but harmless model-backed source, isolated to a disposable Git repo.
  const sourceTurn = object(object(await sourceRpc.request("turn/start", {
    threadId: sourceThread.id,
    input: [{ type: "text",
      text: "T E L A test-only handoff: We are editing ONLY a disposable sample repository. "
        + "The goal is to continue task ALPHA-OMEGA: inspect branch handoff-synthetic and "
        + "state the next step, which is to verify the sample README. Do not use tools. "
        + "Reply in one sentence mentioning ALPHA-OMEGA.",
    }], approvalPolicy: "never",
  }, AbortSignal.timeout(30_000)))?.turn);
  if (!sourceTurn || typeof sourceTurn.id !== "string" || !UUID.test(sourceTurn.id)) {
    throw new Error("Synthetic source turn ACK is uncertain; do not resend");
  }
  sourceModelCompleted = await waitForTurn(sourceRpc, sourceThread.id, sourceTurn.id);
  if (!sourceModelCompleted) throw new Error("Synthetic source turn did not prove terminal completion");

  const source = createReadOnlyOriginalNativeThreadOwner({
    sourceSlot: 1, profile: binding, resolveOwnedSession: getSession,
  });
  // Important: the user owns this fresh test-only worktree; exactly this
  // integration process made the Git commit. No other checkout was touched.
  const checkpoint = async (slot: number, threadId: string) => {
    if (slot !== 1 || threadId !== sourceThread.id) {
      throw new Error("Synthetic source selection is not exact");
    }
    const evidence = await source.prove(threadId);
    if (git("status", "--porcelain=v1", "--untracked-files=all") !== "") {
      throw new Error("Synthetic Git checkpoint is no longer clean");
    }
    return {
      threadId, workspaceFingerprint: evidence.workspaceFingerprint,
      cwd: workspace,
      git: {
        branch: git("branch", "--show-current"),
        commit: git("rev-parse", "HEAD"),
        trackedChanges: 0, untrackedChanges: 0, conflicts: 0,
      },
      admission: "source-idle-no-other-writer" as const,
    };
  };
  const session2 = await getSession(2);
  destinationRpc = await connectCodexAppServerWebSocket(session2.terminalEndpoint, { signal: signal() });
  const target = createOwnedNewNativeThreadTarget({
    profile: binding, session: getSession,
  });
  journal = new SqliteOneChatHandoffJournal(join(root, "handoff", "journal.sqlite"));
  const handoff = await handoffOneSelectedNativeConversation({
    operationId: randomUUID(),
    sourceSlot: 1, destinationSlot: 2,
    sourceThreadId: sourceThread.id, explicitlySelectedAndApproved: true,
  }, {
    profile: binding,
    source: async slot => {
      if (slot !== 1) throw new Error("Not the selected original test account");
      return source;
    },
    workspace: checkpoint,
    destination: {
      start: async x => {
        const receipt = await target.start(x);
        names.set(2, receipt.threadId);
        return receipt;
      },
      seed: x => target.seed(x),
    },
    journal,
  });
  targetModelCompleted = await waitForTurn(destinationRpc, handoff.destinationThreadId, handoff.destinationTurnId);
  if (!targetModelCompleted) throw new Error("Synthetic target first turn did not prove terminal completion");
  result = "complete_one_exact_source_to_new_destination";
  console.log(JSON.stringify({
    result,
    sourceSlot: 1, targetSlot: 2,
    sameOriginalThreadId: false,
    sourceModelCompleted, targetModelCompleted,
    originalSourceUntouchedExceptSyntheticTestTurns: true,
    personalThreadsRead: 0, sourceCrossAccountHistoryCopied: false,
    destinationFirstTurnAccepted: true,
    otherAccountCredentialsCopied: false,
  }));
}

try {
  execFileSync("mkdir", ["-p", workspace]);
  writeFileSync(join(workspace, "README.md"), "Test-only synthetic repository for the one-chat handoff.\n");
  git("init", "-q", "-b", "handoff-synthetic");
  git("add", "README.md");
  git("-c", "user.name=Tela Test", "-c", "user.email=test@example.invalid",
    "commit", "-q", "-m", "test-only fixture");
  await main();
} catch (error) {
  uncertain = true;
  console.log(JSON.stringify({
    result: "inconclusive_or_failed",
    reason: error instanceof Error ? error.message : "unknown",
    sourceModelCompleted, targetModelCompleted,
  }));
} finally {
  let cleanupFailed = false;
  for (const [slot, rpc] of [[2, destinationRpc], [1, sourceRpc]] as const) {
    try { await officialCleanup(slot, rpc); }
    catch (error) {
      cleanupFailed = true;
      console.log(JSON.stringify({
        cleanup: "unproven", slot,
        exactSyntheticThreadIdForOwnerCleanup: names.get(slot) ?? null,
        reason: error instanceof Error ? error.message : "unknown",
      }));
    }
  }
  try { journal?.close(); } catch { cleanupFailed = true; }
  try { await destinationRpc?.close(); } catch {}
  try { await sourceRpc?.close(); } catch {}
  if (!cleanupFailed && cleaned.size === names.size) {
    rmSync(root, { recursive: true, force: true });
    console.log(JSON.stringify({
      cleanup: "official_thread_delete_verified",
      deletedAndAbsentProfiles: [...cleaned].sort(),
      syntheticWorkspaceRemoved: true,
      savedWebChatsCreated: 0,
    }));
  } else {
    console.log(JSON.stringify({
      cleanup: "manual_owner_inspection_needed",
      syntheticWorkspaceRetained: true,
      cleanupReceiptDirectory: root,
      threadCountRequiringCheck: names.size - cleaned.size,
    }));
  }
  if (uncertain || cleanupFailed || cleaned.size !== names.size) process.exitCode = 1;
}
