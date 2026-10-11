import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineNativeTurnAuthority } from "@chatgpt-tela/core";
import {
  AppServerCompactionHistorySource, AppServerNativeHandoffSource,
  NativeHistoryBootstrapRequired, NATIVE_WEB_HANDOFF_PROMPT,
} from "@chatgpt-tela/codex";
import { createHash } from "node:crypto";
import { FileContextCheckpointCache } from "./context-cache";
import { nativeOpaqueCompaction, resolveNativeContextContinuity } from "./native-context-continuity";

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

test("foreign turn or thread cannot select retained, current or cached Native-to-Web context", async () => {
  let touches = 0;
  const forbidden = async () => {
    touches++;
    throw new Error("No cache, historical RPC, or model operation for a foreign owner");
  };
  const options = {
    compactionHistory: forbidden,
    compactionAnchor: forbidden,
    nativeWebHandoff: forbidden,
    automaticNativeHandoff: forbidden,
  };
  const cases = [
    input({ currentTurnId: "foreign-turn",
      opaque: nativeOpaqueCompaction({ input: [] }), options }),
    input({ threadId: "foreign-thread", retainedHistory: "private retained history", options }),
    input({ currentTurnId: "foreign-turn", options }),
    input({ authority: { ...authority, source: "untrusted-request" as "native-current-turn" },
      retainedHistory: "private retained history", options }),
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
    retainedHistory: "Existing source-bound Web history",
    options: {
      compactionHistory: async () => { calls++; throw Error("Unexpected historical download"); },
      compactionAnchor: async () => { calls++; throw Error("Unexpected anchor read"); },
      nativeWebHandoff: async () => { calls++; throw Error("Unexpected Native model handoff"); },
    },
  }));
  expect(out.mode).toBe("retained");
  expect(out.checkpointReused).toBe(true);
  expect(out.visibleHistory).toBe("Existing source-bound Web history");
  expect(calls).toBe(0);
});

test("first cold recovery accepts the exact user-owned handoff before any heavy Legacy page", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-continuity-handoff-"));
  try {
    let anchors = 0, sources = 0, summaries = 0;
    const out = await resolveNativeContextContinuity(input({
      options: {
        historyCheckpointCache: new FileContextCheckpointCache({ directory: root }),
        compactionHistory: async () => { sources++; throw Error("73MB read forbidden"); },
        compactionAnchor: async () => { anchors++; throw new NativeHistoryBootstrapRequired(); },
        nativeWebHandoff: async () => { summaries++; return {
          threadId: "task-1", currentTurnId: "web-current",
          handoffTurnId: "owned-native-summary-turn", handoffItemId: "final",
          answerDigest: "a".repeat(64),
          summary: "Small read-only Native task summary",
          limitations: "Older command outputs remain unverified",
        }; },
        verifyNativeWebHandoff: async () => ({
          threadId: "task-1", currentTurnId: "web-current",
          handoffTurnId: "owned-native-summary-turn", handoffItemId: "final",
          answerDigest: "a".repeat(64),
          summary: "Small read-only Native task summary",
          limitations: "Older command outputs remain unverified",
        }),
      },
    }));
    expect(out.mode).toBe("explicit-handoff");
    expect(out.visibleHistory).toContain("Older command outputs remain unverified");
    expect(summaries).toBe(1);
    expect(anchors).toBe(0);
    expect(sources).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a fresh Native final-answer handoff must be reverified before Web use or cache write", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-handoff-current-source-proof-"));
  try {
    const cache = new FileContextCheckpointCache({ directory: root });
    const handoff = {
      threadId: "task-1", currentTurnId: "web-current",
      handoffTurnId: "native-summary", handoffItemId: "final-item",
      answerDigest: "b".repeat(64), summary: "Native summary requires revalidation",
      limitations: "Original tool evidence has not been re-read",
    };
    let reads = 0;
    // Null denotes a missing verifier; undefined denotes a verifier that
    // could not find the source. Both must reject rather than accepting a
    // provider-supplied summary without an exact public Native source.
    const scenarios = [
      null,
      undefined,
      { ...handoff, threadId: "different-thread" },
      { ...handoff, currentTurnId: "different-turn" },
      { ...handoff, handoffItemId: "different-item" },
      { ...handoff, answerDigest: "c".repeat(64) },
      { ...handoff, summary: "Different unverified summary" },
      { ...handoff, limitations: "Changed evidence limits" },
    ];
    for (const verified of scenarios) {
      await expect(resolveNativeContextContinuity(input({
        options: {
          historyCheckpointCache: cache,
          nativeWebHandoff: async () => { reads++; return handoff; },
          ...(verified === null ? {} : {
            verifyNativeWebHandoff: async () => verified,
          }),
          compactionHistory: async () => { throw Error("No unbounded history read"); },
        },
      }))).rejects.toBeInstanceOf(NativeHistoryBootstrapRequired);
      expect(await cache.list("task-1")).toHaveLength(0);
    }
    expect(reads).toBe(scenarios.length);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Paginated public Native handoff is re-proven before a cold Web checkpoint is admitted", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-public-manual-proof-"));
  try {
    const methods: Array<{ method: string; params: Record<string, unknown> }> = [];
    let closed = 0;
    const answer = JSON.stringify({
      type: "tela_native_web_handoff_v1",
      summary: "Bounded verified summary of the preceding Native work",
      limitations: "Historical tool evidence is not reconstructed",
    });
    const rpc = {
      async request(method: string, params: Record<string, unknown>) {
        methods.push({ method, params });
        if (method === "thread/read") {
          if (params.includeTurns !== false) throw Error("Unbounded history read forbidden");
          return { thread: { id: "task-1", historyMode: "paginated",
            status: { type: "active" } } };
        }
        if (method === "thread/turns/list") {
          if (params.itemsView !== "summary" || Number(params.limit) > 8) {
            throw Error("Only bounded public summaries are permitted");
          }
          return { data: [
            { id: "web-current", status: "inProgress", itemsView: "summary", items: [] },
            { id: "native-summary", status: "completed", itemsView: "summary", items: [
              { id: "native-request", type: "userMessage",
                content: [{ type: "text", text: NATIVE_WEB_HANDOFF_PROMPT }] },
              { id: "native-final", type: "agentMessage",
                phase: "finalAnswer", text: answer },
            ] },
          ], nextCursor: null };
        }
        throw Error("No Native fork, tools, or model execution permitted");
      },
      async close() { closed++; },
    };
    const provider = new AppServerNativeHandoffSource(async () => rpc);
    const cache = new FileContextCheckpointCache({ directory: root });
    const result = await resolveNativeContextContinuity(input({
      options: {
        historyCheckpointCache: cache,
        nativeWebHandoff: (thread, turn, signal) => provider.latest(thread, turn, signal),
        verifyNativeWebHandoff: (thread, turn, sourceTurn, digest, signal) =>
          provider.verifyRecent(thread, turn, sourceTurn, digest, signal),
        compactionHistory: async () => { throw Error("Legacy replay forbidden"); },
      },
    }));
    expect(result.mode).toBe("explicit-handoff");
    expect(result.visibleHistory).toContain("Bounded verified summary");
    expect(await cache.list("task-1")).toHaveLength(1);
    expect(methods.map(entry => entry.method)).toEqual([
      "thread/read", "thread/turns/list", "thread/read",
      "thread/read", "thread/turns/list", "thread/read",
    ]);
    expect(closed).toBe(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
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

test("real public-adapter wiring refuses a cold Legacy handoff before any hidden paging or model call", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-legacy-integration-fixture-"));
  try {
    const calls: string[] = [];
    let closed = 0;
    let modelCalls = 0;
    const connect = async () => ({
      async request(method: string, params: unknown) {
        calls.push(method);
        if (method !== "thread/read"
          || (params as { includeTurns?: boolean }).includeTurns !== false) {
          throw Error("No Legacy pagination, fork or secondary model call is permitted");
        }
        return { thread: {
          id: "task-1", status: { type: "active" }, historyMode: "legacy",
        } };
      },
      async close() { closed++; },
    });
    const publicHistory = new AppServerCompactionHistorySource(connect);
    const publicHandoff = new AppServerNativeHandoffSource(connect);
    await expect(resolveNativeContextContinuity(input({
      options: {
        historyCheckpointCache: new FileContextCheckpointCache({ directory: root }),
        compactionAnchor: (thread, current, signal) =>
          publicHistory.latestAnchor(thread, current, signal),
        compactionHistory: (thread, current) => publicHistory.project(thread, current),
        nativeWebHandoff: (thread, current, signal) =>
          publicHandoff.latest(thread, current, signal),
        automaticNativeHandoff: async () => {
          modelCalls++;
          throw Error("No experimental model-backed fork is allowed");
        },
        verifyAutomaticNativeHandoff: async () => false,
      },
    }))).rejects.toMatchObject({
      code: "native_history_bootstrap_required",
      recoveryReason: "unindexed_history",
    });
    expect(calls).toEqual(["thread/read"]);
    expect(closed).toBe(1);
    expect(modelCalls).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("an explicitly requested Native handoff needs no legacy transcript projector",async()=>{
 const answer={
   threadId:"task-1",currentTurnId:"web-current",
   handoffTurnId:"user-approved-native-summary",handoffItemId:"native-final",
   answerDigest:"1".repeat(64),
   summary:"Work reached a safe checkpoint without full-history transport",
   limitations:"Past file and tool evidence requires authorized readback",
 };
 const out=await resolveNativeContextContinuity(input({
   options:{nativeWebHandoff:async()=>answer,verifyNativeWebHandoff:async()=>answer},
 }));
 expect(out.mode).toBe("explicit-handoff");
 expect(out.visibleHistory).toContain(answer.summary);
 expect(out.visibleHistory).toContain(answer.limitations);
});

const autoContent=JSON.stringify({
  type:"tela_native_auto_web_handoff_v1",
  objective:"Resume the prior Native task with current Web user input",
  constraints:["Native is the only tool authority"], completed:["Baseline verified"],
  decisions:["Keep the original branch unchanged"],pending:["Test new Web work"],
  files:["File hints only"],evidence:["Past command receipts need readback"],
  limitations:["This is a lossy checkpoint; original evidence is not proven"],
});
test("synthetic-only fallback reuses a derived checkpoint after restart without another fake model call",async()=>{
 const root=mkdtempSync(join(tmpdir(),"tela-continuity-auto-"));
 try {
   let sourceCalls=0, autoCalls=0, verified=0;
   const cache=new FileContextCheckpointCache({directory:root});
   const options={
     historyCheckpointCache:cache,
     compactionHistory:async()=>{
       sourceCalls++;
       throw new NativeHistoryBootstrapRequired();
     },
     automaticNativeHandoff:async(threadId:string,currentTurnId:string,fingerprint:string)=>{
       autoCalls++;
       expect(fingerprint).toBe(opaque.fingerprint!);
       return {threadId,currentTurnId,sourceTurnId:"prior-native",
         content:autoContent,
         answerDigest:createHash("sha256").update(autoContent).digest("hex")};
     },
     verifyAutomaticNativeHandoff:async(threadId:string,currentTurnId:string,sourceTurnId:string)=>{
       verified++;
       expect(threadId).toBe("task-1");
       expect(currentTurnId).toMatch(/^web-/);
       return sourceTurnId==="prior-native";
     },
   };
   const first=await resolveNativeContextContinuity(input({options}));
   expect(first.mode).toBe("automatic-handoff");
   expect(first.visibleHistory).toContain("tela_native_automatic_web_continuation_v1");
   expect(first.visibleHistory).toContain("original evidence is not proven");
   expect(autoCalls).toBe(1);
   expect(sourceCalls).toBe(1);
   const second=await resolveNativeContextContinuity(input({
     currentTurnId:"web-second",
     authority:defineNativeTurnAuthority({
       threadId:"task-1",turnId:"web-second",cwd:"/readonly/fixture",
       workspaceRoots:["/readonly/fixture"],
       sandbox:{kind:"read-only",network:"restricted"},
     }),
     options:{
       ...options,
       historyCheckpointCache:new FileContextCheckpointCache({directory:root}),
     },
   }));
   expect(second.mode).toBe("cached-automatic-handoff");
   expect(second.visibleHistory).toBe(first.visibleHistory);
   expect(autoCalls).toBe(1);
   expect(sourceCalls).toBe(1);
   expect(verified).toBe(2);
 } finally { rmSync(root,{recursive:true,force:true}); }
});
test("complete original Native source never starts a second Native model",async()=>{
 const root=mkdtempSync(join(tmpdir(),"tela-auto-not-needed-"));
 try {
   let called=0;
   const result=await resolveNativeContextContinuity(input({
     options:{
       historyCheckpointCache:new FileContextCheckpointCache({directory:root}),
       compactionHistory:async()=>boundSource,
       verifyAutomaticNativeHandoff:async()=>true,
       automaticNativeHandoff:async()=>{ called++;throw Error("Never needed"); },
     },
   }));
   expect(result.mode).toBe("bounded-source");
   expect(called).toBe(0);
 } finally { rmSync(root,{recursive:true,force:true}); }
});
test("a failed automatic fork never claims an incomplete Native transcript is readable",async()=>{
 const root=mkdtempSync(join(tmpdir(),"tela-auto-fail-closed-"));
 try{
   let attempts=0;
   await expect(resolveNativeContextContinuity(input({
     options:{
       historyCheckpointCache:new FileContextCheckpointCache({directory:root}),
       compactionHistory:async()=>{throw new NativeHistoryBootstrapRequired();},
       verifyAutomaticNativeHandoff:async()=>true,
       automaticNativeHandoff:async()=>{attempts++;throw Error("Fork cannot inherit opaque state");},
     },
   }))).rejects.toBeInstanceOf(NativeHistoryBootstrapRequired);
   expect(attempts).toBe(1);
 } finally {rmSync(root,{recursive:true,force:true});}
});
