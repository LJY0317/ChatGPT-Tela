import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineNativeTurnAuthority } from "@chatgpt-tela/core";
import { NativeHistoryBootstrapRequired } from "@chatgpt-tela/codex";
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
      },
    }));
    expect(out.mode).toBe("explicit-handoff");
    expect(out.visibleHistory).toContain("Older command outputs remain unverified");
    expect(summaries).toBe(1);
    expect(anchors).toBe(0);
    expect(sources).toBe(0);
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
test("an explicitly requested Native handoff needs no legacy transcript projector",async()=>{
 const answer={
   threadId:"task-1",currentTurnId:"web-current",
   handoffTurnId:"user-approved-native-summary",handoffItemId:"native-final",
   answerDigest:"1".repeat(64),
   summary:"Work reached a safe checkpoint without full-history transport",
   limitations:"Past file and tool evidence requires authorized readback",
 };
 const out=await resolveNativeContextContinuity(input({
   options:{nativeWebHandoff:async()=>answer},
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
test("73 MiB Legacy cold failure gets one derived Native handoff, then restart verifies and reuses it without a new model call",async()=>{
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
