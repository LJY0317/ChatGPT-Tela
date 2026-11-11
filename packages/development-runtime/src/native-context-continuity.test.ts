import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineNativeTurnAuthority, observeDiagnosticEvents, type StructuralDiagnosticEvent } from "@chatgpt-tela/core";
import {
  AppServerCompactionHistorySource,
  NativeHistoryBootstrapRequired,
} from "@chatgpt-tela/codex";
import { createHash } from "node:crypto";
import { FileContextCheckpointCache } from "./context-cache";
import { nativeOpaqueCompaction, resolveNativeContextContinuity } from "./native-context-continuity";
import { FileNativeVisiblePrefixStageJournal } from "./native-visible-prefix-journal";
import type { NativeVisibleHistorySnapshot } from "@chatgpt-tela/codex";

const authority = defineNativeTurnAuthority({
  threadId: "task-1", turnId: "web-current",
  cwd: "/readonly/fixture", workspaceRoots: ["/readonly/fixture"],
  sandbox: { kind: "read-only", network: "restricted" },
});
const anchor = {
  threadId: "task-1", currentTurnId: "web-current",
  compactionTurnId: "native-compacted", compactionItemId: "compaction-id",
};
const response = { input: [
  { type: "compaction", encrypted_content: "opaque-native-state" },
  { type: "message", role: "user", content: "Exact current question" },
] };
const opaque = nativeOpaqueCompaction(response);
const boundSource = {
  ...anchor,
  content: JSON.stringify({
    type: "tela_native_visible_history_v1", compactionItemId: anchor.compactionItemId,
    items: [{ turnId: "old", item: {
      type: "agentMessage", id: "old-text", text: "Old, authorized content" + "x".repeat(118_000),
    } }],
  }),
  inlineAssets: [], references: [], localImageCandidates: [],
};
function input(overrides: Partial<Parameters<typeof resolveNativeContextContinuity>[0]> = {}):
  Parameters<typeof resolveNativeContextContinuity>[0] {
  return { threadId: "task-1", currentTurnId: "web-current", authority, opaque,
    options: {},
    ...overrides };
}

test("indexed opaque continuity acquires ordered source without a separate summary operation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "native-prefix-continuity-"));
  try {
    const content = JSON.stringify({ type: "tela_native_visible_prefix_v1", items: [
      { turnId: "prior", item: { type: "agentMessage", id: "prior-answer", text: "Historical evidence" } },
    ] });
    const digest = createHash("sha256").update(content).digest("hex");
    const source: NativeVisibleHistorySnapshot = { kind: "native-visible-prefix", threadId: "task-1", currentTurnId: "web-current",
      contentDigest: digest, digest, sourceItemCount: 1, content,
      inlineAssets: [], references: [], localImageCandidates: [] };
    const journal = new FileNativeVisiblePrefixStageJournal({ directory: join(directory, "ledger"), initializationPath: join(directory, "receipt") });
    let reads = 0, calls = 0;
    const first = await resolveNativeContextContinuity(input({ options: {
      visiblePrefix: { accountNamespace: "fixture-account", journal, read: async () => { reads++; return source; } },
      checkpointProducer: async () => { calls++; throw Error("Source acquisition must not invoke a model"); },
    } }));
    expect(first.mode).toBe("visible-prefix");
    expect(first.visibleHistory).toBe(content);
    expect(first.checkpointProduced).toBe(false);
    expect(calls).toBe(0); expect(reads).toBe(1);
    expect(await journal.pendingOperations()).toHaveLength(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("foreign turn or thread cannot select retained, current or cached Native-to-Web context", async () => {
  let touches = 0;
  const forbidden = async () => {
    touches++;
    throw new Error("No cache, historical RPC, or model operation for a foreign owner");
  };
  const options = {
    compactionHistory: forbidden,
    compactionAnchor: forbidden,
  };
  const cases = [
    input({ currentTurnId: "foreign-turn",
      opaque: nativeOpaqueCompaction({ input: [] }), options }),
    input({ threadId: "foreign-thread", retainedHistory: { visibleHistory: "private retained history", inlineHistoryAssets: [] }, options }),
    input({ currentTurnId: "foreign-turn", options }),
    input({ authority: { ...authority, source: "untrusted-request" as "native-current-turn" },
      retainedHistory: { visibleHistory: "private retained history", inlineHistoryAssets: [] }, options }),
  ];
  for (const candidate of cases) {
    await expect(resolveNativeContextContinuity(candidate))
      .rejects.toThrow("Native continuity source does not match canonical current-turn authority");
  }
  expect(touches).toBe(0);
});

test("readable Native input never scans opaque history or invokes a checkpoint model", async () => {
  let calls = 0;
  const options = { compactionHistory: async () => { calls++; throw Error("Unexpected history read"); } };
  const out = await resolveNativeContextContinuity(input({
    opaque: nativeOpaqueCompaction({ input: [
      { type: "context_compaction" },
      { type: "message", role: "user", content: "Readable Native summary" },
    ] }),
    options,
  }));
  expect(out.mode).toBe("current-input");
  expect(out.visibleHistory).toBeUndefined();
  expect(calls).toBe(0);
});

test("a proven retained Web page skips every cold Native read and carries exactly its existing history", async () => {
  let calls = 0;
  const out = await resolveNativeContextContinuity(input({
    retainedHistory: { visibleHistory: "Existing source-bound Web history", inlineHistoryAssets: [] },
    options: {
      compactionHistory: async () => { calls++; throw Error("Unexpected historical download"); },
      compactionAnchor: async () => { calls++; throw Error("Unexpected anchor read"); },
    },
  }));
  expect(out.mode).toBe("retained");
  expect(out.checkpointReused).toBe(true);
  expect(out.visibleHistory).toBe("Existing source-bound Web history");
  expect(calls).toBe(0);
});

test("a full source gets one verified checkpoint, then a restart retrieves it without replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-continuity-source-"));
  try {
    let sourceReads = 0, markerReads = 0, modelCalls = 0;
    const cache = new FileContextCheckpointCache({ directory: root });
    const options = {
      historyCheckpointCache: cache,
      compactionAnchor: async () => { markerReads++; return anchor; },
      compactionHistory: async () => { sourceReads++; return boundSource; },
      checkpointProducer: async (source: { nativeTaskId: string; sourceRevisionId: string }) => {
        modelCalls++;
        return { nativeTaskId: source.nativeTaskId, sourceRevisionId: source.sourceRevisionId,
          content: "Bounded, source-specific Web-only checkpoint" };
      },
    };
    const first = await resolveNativeContextContinuity(input({ options, effort: "medium" }));
    expect(first.mode).toBe("produced-checkpoint");
    expect(first.visibleHistory).toContain("summary-only-requires-native-readback");
    expect(sourceReads).toBe(1);
    expect(modelCalls).toBe(1);
    expect(markerReads).toBe(2); // Before and after expensive checkpoint production

    const reopened = new FileContextCheckpointCache({ directory: root });
    const second = await resolveNativeContextContinuity(input({ options: {
      ...options, historyCheckpointCache: reopened,
      compactionHistory: async () => { throw Error("Cannot replay original prefix on restart"); },
      checkpointProducer: async () => { throw Error("Do not regenerate the summary"); },
    }, effort: "medium" }));
    expect(second.mode).toBe("readable-checkpoint");
    expect(second.visibleHistory).toBe(first.visibleHistory);
    expect(markerReads).toBe(3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an unavailable opaque first bootstrap fails without an unproved partial source", async () => {
  let reads = 0;
  await expect(resolveNativeContextContinuity(input({
    options: {
      compactionHistory: async () => { reads++; throw new NativeHistoryBootstrapRequired(); },
    },
  }))).rejects.toBeInstanceOf(NativeHistoryBootstrapRequired);
  expect(reads).toBe(1);
});
test("an opaque compaction without an authenticated historical provider is never treated as readable input",async()=>{
 const body=input({options:{}});
 await expect(resolveNativeContextContinuity(body))
   .rejects.toBeInstanceOf(NativeHistoryBootstrapRequired);
 expect(nativeOpaqueCompaction({input:[{type:'compaction',encrypted_content:'opaque'}]}).count)
   .toBe(1);
});

test("source acquisition neither consumes nor resets an earlier preparation budget",async()=>{
 const {CheckpointPreparationBudget}=await import("./checkpoint-preparation-budget");
 const directory=mkdtempSync(join(tmpdir(),"native-shared-preparation-"));
 const content=JSON.stringify({type:"tela_native_visible_prefix_v1",items:[]});
 const digest=createHash("sha256").update(content).digest("hex");
 const source:NativeVisibleHistorySnapshot={kind:"native-visible-prefix",threadId:"task-1",currentTurnId:"web-current",
  contentDigest:digest,digest,sourceItemCount:0,content,inlineAssets:[],references:[],localImageCandidates:[]};
 const journal=new FileNativeVisiblePrefixStageJournal({directory:join(directory,"ledger"),initializationPath:join(directory,"receipt")});
 const budget=new CheckpointPreparationBudget(100000,{maxModelCalls:1,maxInputTokens:100000,maxElapsedMs:60000});
 budget.recordInvocation(1);let sends=0;
 try{
  const result = await resolveNativeContextContinuity(input({effort:"medium",preparationBudget:budget,options:{
   visiblePrefix:{accountNamespace:"account",journal,read:async()=>source},
   checkpointProducer:async r=>{sends++;return {...r,content:"unreachable"};},
  }}));
  expect(result.mode).toBe("visible-prefix");
  expect(budget.modelCalls).toBe(1);
  expect(sends).toBe(0);expect(await journal.pendingOperations()).toHaveLength(0);
 }finally{rmSync(directory,{recursive:true,force:true});}
});


test("unexpected source probe failure retains phase but never private exception content", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-source-probe-failure-"));
  const log = join(root, "events.jsonl"), previous = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = log;
  const failure = new Error("private source path /secret/task-content");
  let calls = 0;
  try {
    await expect(resolveNativeContextContinuity(input({ effort: "medium", options: {
      visiblePrefix: { accountNamespace: "fixture-account", journal: new FileNativeVisiblePrefixStageJournal({ directory: join(root, "journal"), initializationPath: join(root, "journal-init.json") }),
        async read() { throw failure; } },
      async checkpointProducer() { calls++; throw Error("must not call model"); },
    } }))).rejects.toBe(failure);
    const contents = readFileSync(log, "utf8");
    const rows = contents.trim().split("\n").map(line => JSON.parse(line));
    expect(rows.find(row => row.stage === "native_context_source_probe_failed")).toMatchObject({
      phase: "visible_prefix", reason_class: "unclassified",
    });
    expect(rows.some(row => row.stage === "native_context_source_rejected")).toBe(false);
    expect(calls).toBe(0);
    expect(contents).not.toContain("private source");
    expect(contents).not.toContain("/secret/");
  } finally {
    if (previous === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = previous;
    rmSync(root, { recursive: true, force: true });
  }
});


test("oversized indexed source reaches the common planner without an early whole-history budget rejection", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-recovery-evidence-"));
  const rows: StructuralDiagnosticEvent[] = [];
  const stop = observeDiagnosticEvents(row => { if (row.event === "chatgpt_tela_codex") rows.push(row); });
  const content = JSON.stringify({ type: "tela_native_visible_prefix_v1", items: [{ turnId: "old", item: {
    type: "agentMessage", id: "prior", text: "private historical body ".repeat(60_000),
  } }] });
  const digest = createHash("sha256").update(content).digest("hex");
  let sends = 0;
  try {
    const result = await resolveNativeContextContinuity(input({ effort: "medium", options: {
      historyCheckpointCache: new FileContextCheckpointCache({ directory: join(root, "cache") }),
      visiblePrefix: { accountNamespace: "fixture", journal: new FileNativeVisiblePrefixStageJournal({
        directory: join(root, "ledger"), initializationPath: join(root, "init"),
      }), read: async () => ({ kind: "native-visible-prefix", threadId: "task-1", currentTurnId: "web-current",
        content, digest, contentDigest: digest, sourceItemCount: 1, inlineAssets: [], references: [], localImageCandidates: [],
      }) },
      checkpointProducer: async () => { sends++; throw Error("must not send"); },
    } }));
    expect(result.visibleHistory).toBe(content);
    expect(result.checkpointProduced).toBe(false);
    expect(rows.filter(row => row.stage === "native_context_source_probed").map(row => [row.phase, row.outcome]))
      .toEqual([["visible_prefix", "available"]]);
    expect(rows.some(row => row.stage === "native_context_source_rejected")).toBe(false);
    expect(JSON.stringify(rows)).not.toContain("private historical body");
    expect(sends).toBe(0);
  } finally { stop?.(); rmSync(root, { recursive: true, force: true }); }
});
