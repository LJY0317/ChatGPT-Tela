import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chatGptWebFamilyKey,
  chatGptWebModelId,
} from "@chatgpt-tela/chatgpt";
import {
  NativeToolInventory,
  decodeNativeInlineEvidence,
  nativeEvidenceRef,
  defineNativeTurnAuthority,
  NativeIngressMediaRegistry,
  prepareNativeIngressTurnMedia,
} from "@chatgpt-tela/core";
import type { NativeTurnBinding } from "@chatgpt-tela/codex";
import { ActiveTurnRegistry } from "@chatgpt-tela/runtime";
import { FileContextCheckpointCache } from "./context-cache";
import { maybeProduceNativeHistoryCheckpoint } from "./native-history-checkpoint";
import { NativeHistoryBootstrapRequired } from "@chatgpt-tela/codex";
import {
  createNativeRequestDevelopmentWebTurnPlanner,
  projectNativeRequestContext,
} from "./native-request-planner";
import { prepareWebTurnMedia } from "@chatgpt-tela/chatgpt";
import { projectFreshWebPhysicalContext } from "./provider-projection";

function binding(): NativeTurnBinding {
  const tools = [{
    wireName: "exec_command",
    name: "exec_command",
    description: "command",
    kind: "function" as const,
    inputSchema: { type: "object" },
  }];
  return {
    claim: {
      threadId: "thread-1",
      turnId: "turn-1",
      requestKind: "turn",
      toolObservations: [{ source: "fixture", tools }],
    },
    authority: defineNativeTurnAuthority({
      threadId: "thread-1",
      turnId: "turn-1",
      cwd: "/private/workspace",
      workspaceRoots: ["/private/workspace"],
      sandbox: { kind: "read-only", network: "restricted" },
    }),
    tools: NativeToolInventory.fromObservations("thread-1", "turn-1", [
      { source: "fixture", tools },
    ]),
    canonicalEvidence: {
      threadId: "thread-1",
      turnId: "turn-1",
      cwd: "/private/workspace",
      workspaceRoots: ["/private/workspace"],
      sandbox: { kind: "read-only", network: "restricted" },
      proof: "turn-context",
      environmentSourceTurnId: "turn-1",
    },
  };
}

function registered() {
  return new ActiveTurnRegistry().register(binding());
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "chatgpt-tela-native-planner-test-"));
}

describe("Native request development Web planner", () => {
  test("request-local stages identify model and continuity failures without modifying exceptions", async () => {
    const unexpected = new Error("private continuity failure");
    const stages: string[] = [];
    const planner = createNativeRequestDevelopmentWebTurnPlanner({
      compactionAnchor: async () => { throw unexpected; },
    });
    await expect(planner(registered(), {
      model: "browser-model",
      input: [{ type: "compaction", encrypted_content: "opaque" }, { role: "user", content: "continue" }],
    }, {
      signal: new AbortController().signal, onProgress() {},
      onPlannerStage(stage) { stages.push(stage); },
    })).rejects.toBeInstanceOf(NativeHistoryBootstrapRequired);
    expect(stages).toEqual([
      "request_parse", "model_route", "retained_context", "native_continuity",
    ]);
    expect(Object.keys(unexpected)).toEqual([]);
    const modelStages: string[] = [];
    await expect(planner(registered(), { model: "browser-model", input: [] }, {
      signal: new AbortController().signal, onProgress() {},
      onPlannerStage(stage) { modelStages.push(stage); },
    })).rejects.toThrow();
    expect(modelStages).toContain("logical_projection");
  });
  test("diagnostic observer failure cannot alter request planning", async () => {
    const plan = await createNativeRequestDevelopmentWebTurnPlanner()(registered(), {
      input: [{ role: "user", content: "safe fixture" }],
    }, {
      signal: new AbortController().signal, onProgress() {},
      onPlannerStage() { throw new Error("observer unavailable"); },
    });
    expect(plan.physicalContext.segments.at(-1)).toMatchObject({kind: "user", content: "safe fixture"});
    plan.settle?.({ status: "failed" });
  });
  test("cold old Native history accepts ONLY explicit bounded Native model handoff without reading 73MB source", async () => {
    const directory=scratch();
    try {
      const cache=new FileContextCheckpointCache({directory});
      const answerDigest="a".repeat(64);
      let markerCalls=0,rawReads=0,manualCalls=0,verificationCalls=0;
      const source={
        threadId:"thread-1",currentTurnId:"turn-1",
        handoffTurnId:"native-previous",handoffItemId:"native-final",
        answerDigest,
        summary:"Latest Native work state and bounded decisions.",
        limitations:"Historical command results are unavailable and must be read back before consequential actions.",
      };
      const request={model:"browser-model",input:[
        {type:"compaction",encrypted_content:"legacy-opaque-prefix-73MB"},
        {type:"message",role:"user",content:"Continue my existing Native work"},
      ]};
      const options={
        historyCheckpointCache:cache,
        compactionAnchor:async()=>{
          markerCalls++;
          throw new NativeHistoryBootstrapRequired();
        },
        compactionHistory:async()=>{
          rawReads++;
          throw new Error("Legacy 73 MB source must not be hydrated");
        },
        nativeWebHandoff:async()=>{
          manualCalls++;
          return source;
        },
        verifyNativeWebHandoff:async()=>{
          verificationCalls++;
          return source;
        },
      };
      const planner=createNativeRequestDevelopmentWebTurnPlanner(options);
      const first=await planner(registered(),request);
      expect(first.diagnostics?.history_manual_handoff).toBe(true);
      expect(first.physicalContext.segments.map(x=>x.content).join("\n"))
        .toContain("tela_native_explicit_web_handoff_v1");
      expect(first.physicalContext.segments.map(x=>x.content).join("\n"))
        .toContain("Historical command results are unavailable");
      expect(first.physicalContext.segments.map(x=>x.content).join("\n"))
        .toContain("Continue my existing Native work");
      expect(rawReads).toBe(0);
      expect(markerCalls).toBe(0);
      expect(manualCalls).toBe(1);
      expect(await cache.list("thread-1")).toHaveLength(1);
      first.settle?.({status:"completed",surfaceLeaseId:"retained-surface",
        documentGeneration:1,answer:"Native limitations understood."});
      const next=await planner(registered(),{...request,input:[
        ...request.input,
        {type:"message",role:"assistant",content:"Native limitations understood."},
        {type:"message",role:"user",content:"Follow-up with same Native compaction anchor"},
      ]});
      expect(next.physicalContext.mode).toBe("retained-delta");
      expect(markerCalls).toBe(0);
      expect(manualCalls).toBe(1);
      next.settle?.({status:"failed"});

      // Process restart has no surviving physical page; the exact old Native
      // public final answer is read back before any cached handoff is reused.
      const reloaded=createNativeRequestDevelopmentWebTurnPlanner({
        ...options,
        nativeWebHandoff:async()=>{throw Error("Already cached; no duplicate Native handoff");},
      });
      const cold=await reloaded(registered(),{...request,input:[
        ...request.input,
        {type:"message",role:"assistant",content:"Native limitations understood."},
        {type:"message",role:"user",content:"After browser restart"},
      ]});
      expect(cold.diagnostics?.history_checkpoint_reused).toBe(true);
      expect(verificationCalls).toBe(2); // Fresh source and cached restart both re-proven.
      expect(rawReads).toBe(0);
      cold.settle?.({status:"failed"});
    }finally{rmSync(directory,{recursive:true,force:true});}
  });

  test("changed opaque Native compaction state cannot inherit an old explicit handoff",async()=>{
    const directory=scratch();
    try{
      const cache=new FileContextCheckpointCache({directory});
      let admitted=false;
      const manual={
        threadId:"thread-1",currentTurnId:"turn-1",
        handoffTurnId:"native-old",handoffItemId:"model-answer",
        answerDigest:"f".repeat(64),summary:"Previous work only",
        limitations:"Not a full original history",
      };
      const planner=createNativeRequestDevelopmentWebTurnPlanner({
        historyCheckpointCache:cache,
        compactionAnchor:async()=>{throw new NativeHistoryBootstrapRequired();},
        compactionHistory:async()=>{throw new Error("Unbounded history is not allowed");},
        nativeWebHandoff:async()=>admitted ? manual : undefined,
        verifyNativeWebHandoff:async()=>manual,
      });
      const body=(opaque:string)=>({input:[
        {type:"compaction",encrypted_content:opaque},
        {type:"message",role:"user",content:"Current request"},
      ]});
      admitted=true;
      const first=await planner(registered(),body("compaction-A"));
      first.settle?.({status:"failed"});
      admitted=false;
      await expect(createNativeRequestDevelopmentWebTurnPlanner({
        historyCheckpointCache:cache,
        compactionAnchor:async()=>{throw new NativeHistoryBootstrapRequired();},
        compactionHistory:async()=>{throw new Error("History source is large");},
        nativeWebHandoff:async()=>undefined,
        verifyNativeWebHandoff:async()=>{throw new Error("Must not verify a different compaction fingerprint");},
      })(registered(),body("compaction-B"))).rejects.toBeInstanceOf(NativeHistoryBootstrapRequired);
    }finally{rmSync(directory,{recursive:true,force:true});}
  });
  test("checkpoint-first restoration avoids the entire old Native prefix after process restart", async () => {
    const directory=scratch();
    try {
      const anchor={threadId:"thread-1",currentTurnId:"turn-1",
        compactionTurnId:"compact-turn",compactionItemId:"compact-item"};
      const source=JSON.stringify({
        type:"tela_native_visible_history_v1",compactionItemId:"compact-item",
        items:[{turnId:"old",item:{type:"agentMessage",id:"old-message",
          text:"Previously verified context "+("a".repeat(115_000))}}],
      });
      const cache=new FileContextCheckpointCache({directory:join(directory,"native-history")});
      let producerCalls=0;
      await maybeProduceNativeHistoryCheckpoint({
        anchor,cache,effort:"medium",
        history:{...anchor,content:source,inlineAssets:[],references:[],localImageCandidates:[]},
        producer:input=>{
          producerCalls++;
          return {nativeTaskId:input.nativeTaskId,sourceRevisionId:input.sourceRevisionId,
            content:"Historical task completed; inspect Native evidence before changing any files."};
        },
        confirmAnchor:async()=>anchor,
      });
      expect(producerCalls).toBe(1);
      let anchorCalls=0,historyCalls=0;
      const options={
        checkpointCache:new FileContextCheckpointCache({directory:join(directory,"web-epochs")}),
        historyCheckpointCache:new FileContextCheckpointCache({directory:join(directory,"native-history")}),
        compactionAnchor:async()=>{
          anchorCalls++;
          return anchor;
        },
        compactionHistory:async()=>{
          historyCalls++;
          throw Error("73 MB of legacy Native rollout must not be retrieved");
        },
      };
      for(let i=0;i<12;i++){
        await options.checkpointCache.put({nativeTaskId:"thread-1",
          revisionId:"unrelated-web-epoch-"+i,content:"Short epoch summary "+i,
          estimatedTokens:8});
      }
      const request={model:"native-model",input:[
        {type:"compaction",encrypted_content:"never-decode-native-opaque-state"},
        {type:"message",role:"user",content:"Continue the original task"},
      ]};
      const planner=createNativeRequestDevelopmentWebTurnPlanner(options);
      const first=await planner(registered(),request);
      expect(first.diagnostics?.history_checkpoint_reused).toBe(true);
      expect(first.physicalContext.segments.some(segment=>segment.type==="revision"
        && segment.content.includes("Historical task completed")
        && segment.content.includes("summary-only-requires-native-readback"))).toBe(true);
      expect(historyCalls).toBe(0);
      expect(anchorCalls).toBe(1);
      first.settle?.({status:"completed",surfaceLeaseId:"page-1",
        documentGeneration:1,answer:"Ready to continue"});
      const growing:Array<{type:string;role?:string;content?:string;encrypted_content?:string}>=[...request.input];
      let previousAnswer="Ready to continue";
      for(let i=1;i<=20;i++){
        growing.push({type:"message",role:"assistant",content:previousAnswer});
        growing.push({type:"message",role:"user",content:"Bounded checkpoint follow-up "+i});
        const next=await planner(registered(),{...request,input:growing});
        expect(next.physicalContext.mode).toBe("retained-delta");
        expect(next.physicalContext.transferTokens).toBeLessThan(1_500);
        expect(anchorCalls).toBe(1);
        previousAnswer="Answer "+i;
        next.settle?.({status:"completed",surfaceLeaseId:"page-1",
          documentGeneration:1,answer:previousAnswer});
      }
      expect(historyCalls).toBe(0);
      expect(anchorCalls).toBe(1);
      const rebooted=createNativeRequestDevelopmentWebTurnPlanner(options);
      const restored=await rebooted(registered(),{...request,input:[
        ...growing,
        {type:"message",role:"assistant",content:previousAnswer},
        {type:"message",role:"user",content:"After a new browser process"},
      ]});
      expect(restored.physicalContext.mode).not.toBe("retained-delta");
      expect(restored.diagnostics?.history_checkpoint_reused).toBe(true);
      expect(historyCalls).toBe(0);
      expect(anchorCalls).toBe(2);
      restored.settle?.({status:"failed"});
      await expect(createNativeRequestDevelopmentWebTurnPlanner({
        ...options,
        compactionAnchor:async()=>({...anchor,compactionItemId:"different-branch"}),
        compactionHistory:async()=>{
          throw Error("Cold source must be read when Native compaction ancestry changed");
        },
      })(registered(),request)).rejects.toThrow("Cold source must be read");
    } finally {rmSync(directory,{recursive:true,force:true});}
  });

  test("cold opaque history is never silently rebuilt from a corrupt or missing source-bound cache",async()=>{
    const directory=scratch();
    try{
      const anchor={threadId:"thread-1",currentTurnId:"turn-1",
        compactionTurnId:"compact-turn",compactionItemId:"compact-item"};
      let rawReads=0;
      const planner=createNativeRequestDevelopmentWebTurnPlanner({
        historyCheckpointCache:new FileContextCheckpointCache({directory}),
        compactionAnchor:async()=>anchor,
        compactionHistory:async()=>{
          rawReads++;
          return {threadId:anchor.threadId,currentTurnId:anchor.currentTurnId,
            compactionItemId:anchor.compactionItemId,compactionTurnId:anchor.compactionTurnId,
            content:JSON.stringify({type:"tela_native_visible_history_v1",
              compactionItemId:anchor.compactionItemId,
              items:[{turnId:"old",item:{type:"userMessage",content:["Exact old task"]}}]}),
          };
        },
      });
      const plan=await planner(registered(),{input:[
        {type:"compaction",encrypted_content:"opaque"},
        {type:"message",role:"user",content:"Current question"},
      ]});
      expect(rawReads).toBe(1);
      expect(plan.diagnostics?.history_checkpoint_reused).toBe(false);
      expect(plan.physicalContext.segments.some(segment=>segment.type==="revision"
        && segment.content.includes("Exact old task"))).toBe(true);
      plan.settle?.({status:"failed"});
    }finally{rmSync(directory,{recursive:true,force:true});}
  });

  test("ordinary Web epoch checkpoints cannot stand in for a Native history cache",async()=>{
    const directory=scratch();
    try{
      const webCache=new FileContextCheckpointCache({directory});
      await webCache.put({
        nativeTaskId:"thread-1",
        revisionId:"native_visible_history_v1_old_transitional_alias",
        content:"This ordinary Web epoch entry is not a Native-owned source",
        estimatedTokens:15,
      });
      let anchorProbes=0;
      let boundedSources=0;
      const plan=await createNativeRequestDevelopmentWebTurnPlanner({
        checkpointCache:webCache,
        compactionAnchor:async()=>{
          anchorProbes++;
          throw Error("General Web epoch cache cannot authorize Native anchor discovery");
        },
        compactionHistory:async(threadId,currentTurnId)=>{
          boundedSources++;
          return {threadId,currentTurnId,compactionItemId:"native-compaction",
            content:"The current authenticated bounded historical source"};
        },
      })(registered(),{input:[
        {type:"compaction",encrypted_content:"opaque-native-compaction"},
        {type:"message",role:"user",content:"Exact active Web request"},
      ]});
      expect(anchorProbes).toBe(0);
      expect(boundedSources).toBe(1);
      expect(plan.diagnostics?.history_checkpoint_reused).toBe(false);
      expect(plan.physicalContext.segments.map(item=>item.content).join("\n"))
        .toContain("The current authenticated bounded historical source");
      plan.settle?.({status:"failed"});
    }finally{rmSync(directory,{recursive:true,force:true});}
  });

  test("a Native history continuation is never silently truncated as settled assistant text",async()=>{
    const fullHistory=JSON.stringify({
      type:"tela_native_visible_history_v1",
      compactionItemId:"checkpoint-one",
      semantics:"Original source with evidence limitations",
      items:[{turnId:"old",item:{type:"agentMessage",
        text:"Historical source provenance: "+"P".repeat(29_000)}}],
    });
    const plan=await createNativeRequestDevelopmentWebTurnPlanner({
      compactionHistory:async(threadId,currentTurnId)=>({
        threadId,currentTurnId,compactionItemId:"checkpoint-one",content:fullHistory,
      }),
    })(registered(),{
      model:chatGptWebModelId(chatGptWebFamilyKey("Fixture")),
      reasoning:{effort:"medium"},
      input:[
        {type:"compaction",encrypted_content:"native-opaque"},
        {type:"message",role:"user",content:"Explain the Native evidence limitations"},
      ],
    });
    expect(plan.physicalContext.segments.some(segment=>segment.type==="revision"
      && segment.content===fullHistory)).toBe(true);
    expect(plan.diagnostics?.projection_truncated_assistant).toBe(0);
    expect(plan.diagnostics?.continuity_source).toBe("bounded-source");
    plan.settle?.({status:"failed"});

    await expect(createNativeRequestDevelopmentWebTurnPlanner({
      compactionHistory:async(threadId,currentTurnId)=>({
        threadId,currentTurnId,compactionItemId:"checkpoint-one",
        content:"Original Native evidence, never silently clipped: "+"E".repeat(455_000),
      }),
    })(registered(),{
      model:chatGptWebModelId(chatGptWebFamilyKey("Fixture")),
      reasoning:{effort:"medium"},
      input:[
        {type:"compaction",encrypted_content:"native-opaque"},
        {type:"message",role:"user",content:"Current request"},
      ],
    })).rejects.toBeInstanceOf(NativeHistoryBootstrapRequired);
  });

  test("Native current Goal has explicit protected provenance even when historical tool budget is exhausted",()=>{
    const goal={
      threadId:"thread-1",objective:"Native goal must remain exact across Web model switches",
      status:"active",tokenBudget:18_000,tokensUsed:2_100,timeUsedSeconds:130,updatedAt:44,
    };
    const projection=projectNativeRequestContext("thread-1",{
      input:[
        {type:"message",role:"user",content:"Continue the exact Native goal"},
      ],
    },undefined,[],undefined,undefined,goal);
    const goalRevision=projection.revisions.find(item=>item.content.includes("native-thread-goal-observation"));
    expect(goalRevision).toBeDefined();
    expect(projection.protectedRevisionIds).toContain(goalRevision!.revision.id);
    // The provider-only projection sees old settled tool output payloads as
    // structurally typed JSON; arrange sufficient old output after the
    // current Goal to exhaust its historical tool presentation budget.
    const oldToolEvidence=Array.from({length:16},(_,index)=>({
      type:"revision" as const,
      revisionId:"old-settled-tool-"+index,
      kind:"tool-result" as const,
      content:JSON.stringify({type:"function_call_output",
        call_id:"tool-"+index,output:"T".repeat(4_200)}),
    }));
    const logicalSegments=projection.revisions.map(item=>({
      type:"revision" as const,revisionId:item.revision.id,
      kind:item.revision.kind,content:item.content,
    }));
    const physical={
      headRevisionId:projection.headId,
      activeRequestRevisionId:projection.headId,
      mode:"full" as const,
      logicalTokens:30_000,transferTokens:30_000,
      segments:[
        ...logicalSegments.slice(0,-1),
        ...oldToolEvidence,
        ...logicalSegments.slice(-1),
      ],
    };
    const without=projectFreshWebPhysicalContext(physical);
    const withProtection=projectFreshWebPhysicalContext(physical,undefined,{
      protectedRevisionIds:projection.protectedRevisionIds,
    });
    const oldGoal=without.context.segments.find(item=>item.type==="revision"
      && item.revisionId===goalRevision!.revision.id);
    const intactGoal=withProtection.context.segments.find(item=>item.type==="revision"
      && item.revisionId===goalRevision!.revision.id);
    // The current provider also preserves structured Goal observations because
    // they have no output payload to trim. Keep that behavior while asserting
    // an explicit source-protection contract for future provider policies.
    expect(oldGoal?.content).toBe(goalRevision!.content);
    expect(intactGoal?.content).toBe(goalRevision!.content);
    expect(intactGoal?.content).toContain(goal.objective);
  });
  test("read-only Native Goal snapshot is an exact-thread tool-result revision, never a new user instruction or scheduler", async () => {
    const goal = {
      threadId: "thread-1", objective: "Complete a disposable task once",
      status: "paused", tokenBudget: 9000, tokensUsed: 188,
      timeUsedSeconds: 60, updatedAt: 99,
    };
    const source = binding();
    const registered = new ActiveTurnRegistry().register({
      ...source, canonicalEvidence: { ...source.canonicalEvidence, nativeGoal: goal },
    });
    const planner = createNativeRequestDevelopmentWebTurnPlanner();
    const planned = await planner(registered, { input: [{
      type: "message", role: "user", content: "Explain the current task goal status",
    }] });
    expect(planned.physicalContext.segments.some(segment => segment.type === "revision"
      && segment.kind === "tool-result"
      && segment.content.includes("native-thread-goal-observation")
      && segment.content.includes('"status":"paused"'))).toBe(true);
    const owner = planned.physicalContext.segments.filter(segment =>
      segment.type === "revision" && segment.kind === "user");
    expect(owner).toHaveLength(1);
    expect(planned.media ?? []).toHaveLength(0);
    planned.settle?.({ status: "failed" });
    expect(() => projectNativeRequestContext("different-thread", { input: "safe" },
      undefined, [], undefined, undefined, goal)).toThrow("different thread");
  });

  test("Native Goal absent and unavailable are distinct non-authoritative Web observations", async () => {
    for (const state of ["absent", "unavailable"] as const) {
      const existing = binding();
      const current = new ActiveTurnRegistry().register({
        ...existing, canonicalEvidence: { ...existing.canonicalEvidence,
          nativeGoalState: state },
      });
      const planned = await createNativeRequestDevelopmentWebTurnPlanner()(current, {
        input: [{ type: "message", role: "user", content: "What is the Native goal?" }],
      });
      const observations = planned.physicalContext.segments.filter(s => s.type === "revision"
        && s.kind === "tool-result" && s.content.includes("native-thread-goal-observation"));
      expect(observations).toHaveLength(1);
      expect(observations[0]?.content).toContain('"status":"' + state + '"');
      expect(planned.media ?? []).toHaveLength(0);
      planned.settle?.({ status: "failed" });
    }
    const goal = { threadId: "thread-1", objective: "Owned task", status: "active",
      tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, updatedAt: 3 };
    expect(() => projectNativeRequestContext("thread-1", { input: "text" },
      undefined, [], undefined, undefined, goal, "absent")).toThrow("contradictory");
  });
  test("canonical Native turn-start image is attached on the real context-planner route, not mistaken for past user text", async () => {
    const bytes = Buffer.from("89504e470d0a1a0a00000000", "hex");
    const registry = new NativeIngressMediaRegistry();
    registry.accept(prepareNativeIngressTurnMedia({ threadId: "thread-1", input: [
      { type: "text", text: "What is in my photo?" },
      { type: "image", url: "data:image/png;base64," + bytes.toString("base64") },
    ] }), "turn-1");
    const base = binding();
    const exact = new ActiveTurnRegistry().register({
      ...base,
      canonicalEvidence: { ...base.canonicalEvidence,
        ingressMedia: registry.current("thread-1", "turn-1")! },
    });
    const planner = createNativeRequestDevelopmentWebTurnPlanner();
    const plan = await planner(exact, { input: [
      { type: "message", role: "assistant", content: "Previous response, not this image." },
      { type: "message", role: "user", content: "What is in my photo?" },
    ] });
    expect(plan.media).toHaveLength(1);
    expect(plan.media![0]!.file.bytes).toEqual(bytes);
    expect(plan.media![0]!.revisionId).toBe(plan.physicalContext.activeRequestRevisionId!);
    expect(prepareWebTurnMedia(plan.physicalContext, plan.media!).statistics)
      .toMatchObject({ logicalReferences: 1, uniqueFiles: 1, uniqueBytes: bytes.length });
    plan.settle?.({ status: "failed" });
    registry.clear();
  });
  test("image-bearing public checkpoint reaches Web as an attached historical asset once; later retained turn does not resend",async()=>{
    const png="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9RwvWgAAAABJRU5ErkJggg==";
    const inline=decodeNativeInlineEvidence(png);
    const evidence=nativeEvidenceRef({
      threadId:"thread-1",itemKey:"old:old-user",partKey:"1",kind:"image",origin:"historical-user",
      source:"native_thread_read",sha256:inline.sha256,bytes:inline.bytes.byteLength,
    });
    const visible=JSON.stringify({type:"tela_native_visible_history_v1",items:[{
      turnId:"old",item:{type:"userMessage",content:[{type:"text",text:"Old picture"},evidence]},
    }]});
    const planner=createNativeRequestDevelopmentWebTurnPlanner({
      compactionHistory:async(threadId,currentTurnId)=>({
        threadId,currentTurnId,compactionItemId:"checkpoint",content:visible,
        inlineAssets:[{evidence,mimeType:inline.mimeType,bytes:inline.bytes}],
      }),
    });
    const turn=registered();
    const original={input:[{type:"compaction",encrypted_content:"opaque"},{
      type:"message",role:"user",content:"Follow up on photo",
    }]};
    const first=await planner(turn,original);
    expect(first.media).toHaveLength(1);
    expect(first.media![0]!.evidence.origin).toBe("historical-user");
    expect(prepareWebTurnMedia(first.physicalContext,first.media!).files).toHaveLength(1);
    first.settle?.({status:"completed",surfaceLeaseId:"physical-1",documentGeneration:1,answer:"Old picture reviewed"});
    const resumed=await planner(turn,{input:[
      ...original.input,
      {type:"message",role:"assistant",content:"Old picture reviewed"},
      {type:"message",role:"user",content:"Next question without media"},
    ]});
    expect(resumed.physicalContext.mode).toBe("retained-delta");
    expect(resumed.media).toBeUndefined();
    expect(resumed.physicalContext.segments.map(x=>x.content)).toEqual(["Next question without media"]);
    resumed.settle?.({status:"failed"});
    const rebuilt=await planner(turn,{input:[
      ...original.input,
      {type:"message",role:"assistant",content:"Old picture reviewed"},
      {type:"message",role:"user",content:"Next question without media"},
    ]});
    expect(rebuilt.physicalContext.mode).toBe("full");
    expect(rebuilt.media).toHaveLength(1);
    rebuilt.settle?.({status:"failed"});
  });
  test("opaque Native context uses only an exact current-turn visible history source", async () => {
    const original = {instructions:"Current instructions",input:[{type:"compaction",encrypted_content:"opaque"},
      {type:"message",role:"user",content:"Exact latest request"}]};
    const planner = createNativeRequestDevelopmentWebTurnPlanner({
      compactionHistory:async(threadId,currentTurnId)=>({threadId,currentTurnId,compactionItemId:"native-checkpoint",content:"Visible Native tool history"}),
    });
    const plan = await planner(registered(),original);
    expect(plan.physicalContext.segments.map(x=>x.content)).toEqual(["Current instructions","Visible Native tool history","Exact latest request"]);
    expect(plan.diagnostics?.visible_compaction_history).toBe(true);
    expect(original.input[0]).toEqual({type:"compaction",encrypted_content:"opaque"});
    plan.settle?.({status:"failed"});
    await expect(createNativeRequestDevelopmentWebTurnPlanner({compactionHistory:async()=>({threadId:"foreign",currentTurnId:"turn-1",compactionItemId:"checkpoint",content:"wrong"})})(registered(),original)).rejects.toThrow("different turn");
  });

  test("mid-turn checkpoint preserves the latest user request and its tool suffix", async () => {
    const root=scratch();
    try {
      let prefix:string[]=[];
      const planner=createNativeRequestDevelopmentWebTurnPlanner({checkpointCache:new FileContextCheckpointCache({directory:root}),budgetTokens:35,
        checkpointProducer(input){prefix=input.physicalContext.segments.map(x=>x.content);return {nativeTaskId:input.nativeTaskId,sourceRevisionId:input.sourceRevisionId,content:"summary"};}});
      const plan=await planner(registered(),{input:[{type:"message",role:"user",content:"x".repeat(400)},
        {type:"message",role:"user",content:"Exact active request"},
        {type:"message",role:"assistant",content:"Exact tool-round result"}]});
      expect(prefix).toEqual(["x".repeat(400)]);
      expect(plan.physicalContext.segments.map(x=>x.content)).toEqual(["summary","Exact active request","Exact tool-round result"]);
      plan.settle?.({status:"failed"});
    }finally{rmSync(root,{recursive:true,force:true});}
  });

  test("cached checkpoints cannot replace the active request during a tool round", async () => {
    const root = scratch();
    try {
      const request = { input: [
        { type: "message", role: "user", content: "Old context" },
        { type: "message", role: "user", content: "Exact active request" },
        { type: "message", role: "assistant", content: "Exact tool result" },
      ] };
      const projection = projectNativeRequestContext("thread-1", request);
      const cache = new FileContextCheckpointCache({ directory: root });
      await cache.put({ nativeTaskId: "thread-1", revisionId: projection.revisions[1]!.revision.id,
        content: "Unsafe cached summary", estimatedTokens: 1 });
      const plan = await createNativeRequestDevelopmentWebTurnPlanner({ checkpointCache: cache })(registered(), request);
      expect(plan.physicalContext.segments.map(x => x.content)).toEqual([
        "Old context", "Exact active request", "Exact tool result",
      ]);
      plan.settle?.({ status: "failed" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("continues from a Native local-compaction summary without projecting the marker", () => {
    const projected = projectNativeRequestContext("thread-1", {
      input: [
        { type: "context_compaction" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Native compacted summary" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Continue the task" }] },
      ],
    });
    expect(projected.revisions.map(item => item.content)).toEqual([
      "Native compacted summary", "Continue the task",
    ]);
    expect(projected.revisions.map(item => item.revision.kind)).toEqual(["user", "user"]);
    expect(() => projectNativeRequestContext("thread-1", {
      input: [{ type: "compaction", encrypted_content: "opaque-native-blob" }],
    })).toThrow("readable Native summary is required");
    expect(() => projectNativeRequestContext("thread-1", {
      input: [{ type: "context_compaction" }, { type: "message", role: "user", content: "" }],
    })).toThrow("following readable user summary");
  });

  test("the latest readable Native compaction boundary supersedes the older model-visible transcript", () => {
    const old = "Long private Native-only work before compaction ".repeat(2_500);
    const projected = projectNativeRequestContext("thread-1", {
      instructions: "Preserve current Codex instructions and authorized task.",
      input: [
        { type: "message", role: "user", content: old },
        { type: "message", role: "assistant", content: "Earlier Native answer before compaction." },
        { type: "context_compaction" },
        { type: "message", role: "user", content: "Readable compacted Native state: task B remains." },
        { type: "message", role: "user", content: "Continue task B with the Web model." },
      ],
    });
    expect(projected.revisions.map(item => item.content)).toEqual([
      "Preserve current Codex instructions and authorized task.",
      "Readable compacted Native state: task B remains.",
      "Continue task B with the Web model.",
    ]);
    expect(projected.revisions.map(item => item.revision.kind)).toEqual(["system", "user", "user"]);
  });

  test("first Web use after a long readable Native compaction fits without replaying superseded tool history", async () => {
    const planner = createNativeRequestDevelopmentWebTurnPlanner({ budgetTokens: 700 });
    const oldToolOutput = "Historical tool output from discarded Native context ".repeat(3_000);
    const turn = await planner(registered(), {
      model: chatGptWebModelId(chatGptWebFamilyKey("Fixture")),
      reasoning: { effort: "medium" },
      instructions: "Use the existing Native workspace and original task.",
      input: [
        { type: "message", role: "user", content: "Old work that Native already summarized." },
        { type: "function_call_output", call_id: "old-native-read", output: oldToolOutput },
        { type: "context_compaction" },
        { type: "message", role: "user", content: "Readable Native summary: finish the work already started." },
        { type: "message", role: "user", content: "Make the next change using Native tools only when authorized." },
      ],
    });
    expect(turn.physicalContext.mode).toBe("full");
    const full = turn.physicalContext.segments.map(segment => segment.content).join("\n");
    expect(full).toContain("Readable Native summary: finish the work already started.");
    expect(full).toContain("Make the next change using Native tools only when authorized.");
    expect(full).not.toContain("Historical tool output from discarded Native context");
    expect(turn.physicalContext.transferTokens).toBeLessThan(700);
    turn.settle?.({ status: "failed" });
  });

  test("a later readable Native compaction replaces even an earlier valid compaction summary", () => {
    const projection = projectNativeRequestContext("thread-1", {
      input: [
        { type: "message", role: "user", content: "Source before first compact." },
        { type: "context_compaction" },
        { type: "message", role: "user", content: "First compacted summary." },
        { type: "message", role: "assistant", content: "Work after first compact." },
        { type: "context_compaction" },
        { type: "message", role: "user", content: "Latest readable summary." },
        { type: "message", role: "user", content: "First Web request after second compaction." },
      ],
    });
    expect(projection.revisions.map(item => item.content)).toEqual([
      "Latest readable summary.",
      "First Web request after second compaction.",
    ]);
  });

  test("a malformed earlier compaction marker cannot be bypassed by a later valid marker", () => {
    expect(() => projectNativeRequestContext("thread-1", {
      input: [
        { type: "context_compaction" },
        { type: "message", role: "assistant", content: "Not an authorized Native summary." },
        { type: "context_compaction" },
        { type: "message", role: "user", content: "A later readable summary." },
        { type: "message", role: "user", content: "Continue." },
      ],
    })).toThrow("following readable user summary");
  });

  test("Native compaction retires the prior Web epoch and rebuilds from the new canonical summary", async () => {
    const planner = createNativeRequestDevelopmentWebTurnPlanner();
    const turn = registered();
    const first = await planner(turn, {
      input: [{ type: "message", role: "user", content: "Original task" }],
    });
    first.settle?.({ status: "completed", documentGeneration: 1, surfaceLeaseId: "physical-1", answer: "First answer" });
    const afterCompaction = await planner(turn, {
      input: [
        { type: "context_compaction" },
        { type: "message", role: "user", content: "Native summary of the original task" },
        { type: "message", role: "user", content: "Continue after compaction" },
      ],
    });
    expect(afterCompaction.webEpochId).not.toBe(first.webEpochId);
    expect(afterCompaction.physicalContext.mode).toBe("full");
    expect(afterCompaction.physicalContext.segments.map(segment => segment.content)).toEqual([
      "Native summary of the original task", "Continue after compaction",
    ]);
    afterCompaction.settle?.({ status: "failed" });
  });
  test("projects request instructions/input through the logical -> physical context boundary", async () => {
    const planner = createNativeRequestDevelopmentWebTurnPlanner();
    const turn = registered();
    const request = {
      instructions: "Follow the current Codex task.",
      client_metadata: {
        "x-codex-turn-metadata": {
          thread_id: "thread-1",
          turn_id: "turn-1",
          cwd: "/must-not-enter-web-context",
        },
      },
      tools: [{
        type: "function",
        name: "secret_tool_schema",
        description: "must not enter web context",
      }],
      input: [
        { type: "reasoning", encrypted_content: "opaque-native-state" },
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Preserve developer priority." }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Inspect the repository." }],
        },
        {
          type: "function_call",
          call_id: "old-call",
          name: "exec_command",
          arguments: "{\"cmd\":[\"pwd\"]}",
        },
        {
          type: "function_call_output",
          call_id: "old-call",
          output: "/workspace",
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Repository inspected." }],
        },
      ],
    };

    const plan = await planner(turn, request);
    expect(plan.nativeTaskId).toBe("thread-1");
    expect(plan.webEpochId).toMatch(/^dev_epoch_/);
    expect(plan.physicalContext.mode).toBe("full");
    const activeRequest = plan.physicalContext.segments.find(segment =>
      segment.type === "revision" && segment.revisionId === plan.physicalContext.activeRequestRevisionId);
    expect(activeRequest).toMatchObject({
      type: "revision",
      kind: "user",
      content: "Inspect the repository.",
    });
    expect(plan.physicalContext.logicalTokens).toBe(plan.physicalContext.transferTokens);
    expect(plan.physicalContext.segments.map(segment => (
      segment.type === "revision" ? segment.kind : "checkpoint"
    ))).toEqual(["system", "developer", "user", "tool-call", "tool-result", "assistant"]);

    const serialized = JSON.stringify(plan.physicalContext);
    expect(serialized).toContain("Follow the current Codex task.");
    expect(serialized).toContain("Preserve developer priority.");
    expect(serialized).toContain("Inspect the repository.");
    expect(serialized).toContain("old-call");
    expect(serialized).not.toContain("must-not-enter-web-context");
    expect(serialized).not.toContain("secret_tool_schema");
    expect(serialized).not.toContain("opaque-native-state");

    plan.settle?.({ status: "failed" });
    const replay = await planner(turn, structuredClone(request));
    expect(replay.webEpochId).toBe(plan.webEpochId);
    expect(replay.physicalContext).toEqual(plan.physicalContext);
    replay.settle?.({ status: "failed" });
  });

  test("fails closed on attachment content instead of silently flattening it into text", async () => {
    const planner = createNativeRequestDevelopmentWebTurnPlanner();
    await expect(planner(registered(), {
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: "data:image/png;base64,..." }],
      }],
    })).rejects.toThrow("not proven inline bytes");
  });

  test("fails closed when the Native request has no supported logical context", async () => {
    const planner = createNativeRequestDevelopmentWebTurnPlanner();
    await expect(planner(registered(), {
      input: [{ type: "reasoning", encrypted_content: "opaque" }],
    })).rejects.toThrow("no supported logical context");
  });

  test("synthetic Web model ids carry exact browser family/effort selection while Native ids do not", async () => {
    const planner = createNativeRequestDevelopmentWebTurnPlanner();
    const familyKey = chatGptWebFamilyKey("Observed Family");
    const web = await planner(registered(), {
      model: chatGptWebModelId(familyKey),
      reasoning: { effort: "xhigh" },
      input: [{ type: "message", role: "user", content: "Use the Web route." }],
    });
    expect(web.browserModel).toEqual({ familyKey, effort: "xhigh" });
    web.settle?.({ status: "failed" });

    const native = await planner(registered(), {
      model: "gpt-native",
      reasoning: { effort: "high" },
      input: [{ type: "message", role: "user", content: "Native route fixture." }],
    });
    expect(native.browserModel).toBeUndefined();
    native.settle?.({ status: "failed" });
  });

  test("synthetic Web model ids fail before browser work when reasoning effort is absent or unsupported", async () => {
    const planner = createNativeRequestDevelopmentWebTurnPlanner();
    const model = chatGptWebModelId(chatGptWebFamilyKey("Observed Family"));
    await expect(planner(registered(), {
      model,
      input: [{ type: "message", role: "user", content: "missing effort" }],
    })).rejects.toThrow("supported reasoning effort");
    await expect(planner(registered(), {
      model,
      reasoning: { effort: "future-effort" },
      input: [{ type: "message", role: "user", content: "bad effort" }],
    })).rejects.toThrow("supported reasoning effort");
  });

  test("large fresh Web context automatically uses a memory-backed preload while small fresh context stays inline", async () => {
    const familyKey = chatGptWebFamilyKey("Observed Family");
    const model = chatGptWebModelId(familyKey);
    const planner = createNativeRequestDevelopmentWebTurnPlanner();
    const large = await planner(registered(), {
      model,
      reasoning: { effort: "high" },
      instructions: "D".repeat(190_000),
      input: [{ type: "message", role: "user", content: "U".repeat(20_000) }],
    });
    expect(large.contextAttachment).toBeDefined();
    expect(large.contextAttachment?.name).toMatch(/^tela-context-v1--/);
    expect(large.diagnostics).toMatchObject({ context_attachment: true });
    expect(Number(large.diagnostics?.context_attachment_chars)).toBeGreaterThanOrEqual(200_000);
    large.settle?.({ status: "failed" });

    const small = await planner(registered(), {
      model,
      reasoning: { effort: "high" },
      input: [{ type: "message", role: "user", content: "small request" }],
    });
    expect(small.contextAttachment).toBeUndefined();
    expect(small.diagnostics).toMatchObject({ context_attachment: false });
    small.settle?.({ status: "failed" });
  });

  test("canonical prefixes keep stable revision ids across later turns and append-only steering-like input", () => {
    const earlier = projectNativeRequestContext("thread-1", {
      instructions: "Keep repository context.",
      input: [
        { type: "message", role: "user", content: "Inspect A." },
        { type: "message", role: "assistant", content: "A inspected." },
      ],
    });
    const later = projectNativeRequestContext("thread-1", {
      instructions: "Keep repository context.",
      input: [
        { type: "message", role: "user", content: "Inspect A." },
        { type: "message", role: "assistant", content: "A inspected." },
        { type: "message", role: "user", content: "Now inspect B instead." },
      ],
    });

    expect(later.revisions.slice(0, earlier.revisions.length).map(item => item.revision.id))
      .toEqual(earlier.revisions.map(item => item.revision.id));
    expect(later.headId).not.toBe(earlier.headId);
  });

  test("committed Web answers retain one epoch and send only the exact later Native suffix", async () => {
    const planner = createNativeRequestDevelopmentWebTurnPlanner();
    const first = await planner(registered(), {
      model: "native-model-a",
      reasoning: { effort: "high" },
      instructions: "Keep working in the same repository.",
      input: [{ type: "message", role: "user", content: "Inspect A." }],
    });
    expect(first.physicalContext.mode).toBe("full");
    first.settle?.({ status: "completed", documentGeneration: 1, surfaceLeaseId: "physical-1", answer: "A inspected." });

    const second = await planner(registered(), {
      model: "native-model-a",
      reasoning: { effort: "high" },
      instructions: "Keep working in the same repository.",
      input: [
        { type: "message", role: "user", content: "Inspect A." },
        { type: "message", role: "assistant", content: "A inspected." },
        { type: "message", role: "user", content: "Now inspect B." },
      ],
    });

    expect(second.webEpochId).toBe(first.webEpochId);
    expect(second.physicalContext).toMatchObject({
      mode: "retained-delta",
      activeRequestRevisionId: second.physicalContext.headRevisionId,
    });
    expect(second.physicalContext.baseRevisionId).toBeDefined();
    expect(second.physicalContext.logicalTokens).toBeGreaterThan(second.physicalContext.transferTokens);
    expect(second.physicalContext.segments).toEqual([
      expect.objectContaining({ type: "revision", kind: "user", content: "Now inspect B." }),
    ]);
    second.settle?.({ status: "completed", documentGeneration: 1, surfaceLeaseId: "physical-1", answer: "B inspected." });

    const third = await planner(registered(), {
      model: "native-model-a",
      reasoning: { effort: "high" },
      instructions: "Keep working in the same repository.",
      input: [
        { type: "message", role: "user", content: "Inspect A." },
        { type: "message", role: "assistant", content: "A inspected." },
        { type: "message", role: "user", content: "Now inspect B." },
        { type: "message", role: "assistant", content: "B inspected." },
        { type: "message", role: "user", content: "Finally inspect C." },
      ],
    });
    expect(third.webEpochId).toBe(first.webEpochId);
    expect(third.physicalContext.mode).toBe("retained-delta");
    expect(third.physicalContext.segments.map(segment => (
      segment.type === "revision" ? segment.content : "checkpoint"
    ))).toEqual(["Finally inspect C."]);
    third.settle?.({ status: "failed" });
  });

  test("repeated identical Native assistant answers never hide intervening completed turns from retained Web context", async () => {
    const planner = createNativeRequestDevelopmentWebTurnPlanner();
    const first = await planner(registered(), {
      model: "native-model-a",
      input: [{ type: "message", role: "user", content: "Inspect file A." }],
    });
    first.settle?.({
      status: "completed", documentGeneration: 1,
      surfaceLeaseId: "physical-page-a", answer: "Completed.",
    });
    const next = await planner(registered(), {
      model: "native-model-a",
      input: [
        { type: "message", role: "user", content: "Inspect file A." },
        { type: "message", role: "assistant", content: "Completed." },
        { type: "message", role: "user", content: "Inspect file B." },
        { type: "message", role: "assistant", content: "Completed." },
        { type: "message", role: "user", content: "Now inspect file C." },
      ],
    });
    expect(next.physicalContext.mode).toBe("retained-delta");
    expect(next.physicalContext.segments.filter(segment => segment.type === "revision")
      .map(segment => segment.content)).toEqual([
        "Inspect file B.", "Completed.", "Now inspect file C.",
      ]);
    next.settle?.({ status: "failed" });
  });

  test("an intervening Native request before the previous Web answer revokes retained-page ancestry", async () => {
    const planner = createNativeRequestDevelopmentWebTurnPlanner();
    const first = await planner(registered(), {
      input: [{ type: "message", role: "user", content: "Initial request." }],
    });
    first.settle?.({
      status: "completed", documentGeneration: 1,
      surfaceLeaseId: "physical-page-a", answer: "Repeated final answer.",
    });
    const next = await planner(registered(), {
      input: [
        { type: "message", role: "user", content: "Initial request." },
        { type: "message", role: "user", content: "A later, independently routed request." },
        { type: "message", role: "assistant", content: "Repeated final answer." },
        { type: "message", role: "user", content: "Current request." },
      ],
    });
    expect(next.physicalContext.mode).toBe("full");
    expect(next.retainedSurfaceLeaseId).toBeUndefined();
    expect(JSON.stringify(next.physicalContext.segments)).toContain("A later, independently routed request.");
    next.settle?.({ status: "failed" });
  });

  test("multiple assistant messages before the next Native request cannot impersonate one committed Web final", async () => {
    const planner = createNativeRequestDevelopmentWebTurnPlanner();
    const first = await planner(registered(), {
      input: [{ type: "message", role: "user", content: "Original request." }],
    });
    first.settle?.({
      status: "completed", documentGeneration: 1,
      surfaceLeaseId: "physical-page-a", answer: "Final answer.",
    });
    const next = await planner(registered(), {
      input: [
        { type: "message", role: "user", content: "Original request." },
        { type: "message", role: "assistant", content: "Unverified intervening answer." },
        { type: "message", role: "assistant", content: "Final answer." },
        { type: "message", role: "user", content: "Follow-up." },
      ],
    });
    expect(next.physicalContext.mode).toBe("full");
    expect(next.retainedSurfaceLeaseId).toBeUndefined();
    expect(JSON.stringify(next.physicalContext.segments))
      .toContain("Unverified intervening answer.");
    next.settle?.({ status: "failed" });
  });

  test("a Native tool result after the committed Web final invalidates the retained-page boundary", async () => {
    const planner = createNativeRequestDevelopmentWebTurnPlanner();
    const first = await planner(registered(), {
      input: [{ type: "message", role: "user", content: "First request." }],
    });
    first.settle?.({
      status: "completed", documentGeneration: 1,
      surfaceLeaseId: "physical-page-a", answer: "First final.",
    });
    const later = await planner(registered(), {
      input: [
        { type: "message", role: "user", content: "First request." },
        { type: "message", role: "assistant", content: "First final." },
        { type: "function_call_output", call_id: "late-native-tool", output: "Late tool output." },
        { type: "message", role: "user", content: "Follow-up request." },
      ],
    });
    expect(later.physicalContext.mode).toBe("full");
    expect(later.retainedSurfaceLeaseId).toBeUndefined();
    expect(JSON.stringify(later.physicalContext.segments)).toContain("Late tool output.");
    later.settle?.({ status: "failed" });
  });

  test("large retained assistant growth rolls over only the physical Web epoch while Native history stays complete", async () => {
    const planner = createNativeRequestDevelopmentWebTurnPlanner();
    const familyKey = chatGptWebFamilyKey("Observed Family");
    const model = chatGptWebModelId(familyKey);
    const first = await planner(registered(), {
      model,
      reasoning: { effort: "high" },
      instructions: "Preserve the Native task exactly.",
      input: [{ type: "message", role: "user", content: "Produce the large fixture." }],
    });
    const largeAnswer = "A".repeat(390_000);
    first.settle?.({ status: "completed", documentGeneration: 1, surfaceLeaseId: "physical-1", answer: largeAnswer });

    const second = await planner(registered(), {
      model,
      reasoning: { effort: "high" },
      instructions: "Preserve the Native task exactly.",
      input: [
        { type: "message", role: "user", content: "Produce the large fixture." },
        { type: "message", role: "assistant", content: largeAnswer },
        { type: "message", role: "user", content: "Continue with the next small step." },
      ],
    });

    expect(second.webEpochId).not.toBe(first.webEpochId);
    expect(second.physicalContext.mode).not.toBe("retained-delta");
    expect(second.physicalContext.logicalTokens).toBeGreaterThan(95_000);
    expect(second.physicalContext.transferTokens).toBeLessThan(second.physicalContext.logicalTokens);
    expect(second.diagnostics).toMatchObject({
      physical_rollover: true,
      provider_projection: true,
    });
    expect(Number(second.diagnostics?.previous_epoch_input_estimate)).toBeGreaterThanOrEqual(95_000);
    second.settle?.({ status: "failed" });
  });

  test('retained Web context continues for twenty bounded followups without repacking old revisions',async()=>{
    const model=chatGptWebModelId(chatGptWebFamilyKey('Observed Family'));
    const planner=createNativeRequestDevelopmentWebTurnPlanner();
    const input:Array<{type:string;role:string;content:string}>=[
      {type:'message',role:'user',content:'Initial verified context'},
    ];
    let receipt=await planner(registered(),{model,reasoning:{effort:'high'},input});
    const epoch=receipt.webEpochId;
    receipt.settle?.({status:'completed',documentGeneration:1,
      surfaceLeaseId:'one-retained-physical-page',answer:'Completed step 0'});
    for(let i=1;i<=20;i++){
      input.push({type:'message',role:'assistant',content:`Completed step ${i-1}`});
      input.push({type:'message',role:'user',content:`Complete step ${i} of twenty; keep earlier context`});
      receipt=await planner(registered(),{model,reasoning:{effort:'high'},input});
      expect(receipt.webEpochId).toBe(epoch);
      expect(receipt.physicalContext.mode).toBe('retained-delta');
      expect(receipt.physicalContext.transferTokens).toBeLessThan(1_500);
      expect(receipt.physicalContext.segments.map(s=>s.type==='revision'?s.content:'checkpoint'))
        .toEqual([`Complete step ${i} of twenty; keep earlier context`]);
      receipt.settle?.({status:'completed',documentGeneration:1,
        surfaceLeaseId:'one-retained-physical-page',answer:`Completed step ${i}`});
    }
  });

  test('a cold oversized prefix cannot be sent to checkpoint producer as an unbounded Web prompt',async()=>{
    const root=scratch();
    try{
      let modelCalls=0;
      const planner=createNativeRequestDevelopmentWebTurnPlanner({
        checkpointCache:new FileContextCheckpointCache({directory:root}),
        budgetTokens:1_000,
        checkpointProducer:async input=>{
          modelCalls++;
          return {nativeTaskId:input.nativeTaskId,sourceRevisionId:input.sourceRevisionId,
            content:'A compact summary'};
        },
      });
      const request={instructions:'P'.repeat(410_000),input:[
        {type:'message',role:'user',content:'Small current request'},
      ]};
      await expect(planner(registered(),request))
        .rejects.toThrow('requires a verified checkpoint or explicit handoff');
      expect(modelCalls).toBe(0);
    }finally{rmSync(root,{recursive:true,force:true});}
  });

  test("retained continuation fails closed to a fresh epoch when ancestry, answer, or route identity changes", async () => {
    const planner = createNativeRequestDevelopmentWebTurnPlanner();
    const firstRequest = {
      model: "native-model-a",
      reasoning: { effort: "medium" },
      instructions: "Stable authority.",
      input: [{ type: "message", role: "user", content: "Do A." }],
    };
    const first = await planner(registered(), firstRequest);
    first.settle?.({ status: "completed", documentGeneration: 1, surfaceLeaseId: "physical-1", answer: "A done." });

    const changedModel = await planner(registered(), {
      ...firstRequest,
      model: "native-model-b",
      input: [
        { type: "message", role: "user", content: "Do A." },
        { type: "message", role: "assistant", content: "A done." },
        { type: "message", role: "user", content: "Do B." },
      ],
    });
    expect(changedModel.physicalContext.mode).toBe("full");
    expect(changedModel.webEpochId).not.toBe(first.webEpochId);
    changedModel.settle?.({ status: "failed" });

    const changedBranch = await planner(registered(), {
      model: "native-model-a",
      reasoning: { effort: "medium" },
      instructions: "Different authority.",
      input: [
        { type: "message", role: "user", content: "Different A." },
        { type: "message", role: "assistant", content: "A done." },
        { type: "message", role: "user", content: "Do B." },
      ],
    });
    expect(changedBranch.physicalContext.mode).toBe("full");
    changedBranch.settle?.({ status: "failed" });

    const wrongAnswer = await planner(registered(), {
      ...firstRequest,
      input: [
        { type: "message", role: "user", content: "Do A." },
        { type: "message", role: "assistant", content: "Different answer." },
        { type: "message", role: "user", content: "Do B." },
      ],
    });
    expect(wrongAnswer.physicalContext.mode).toBe("full");
    wrongAnswer.settle?.({ status: "failed" });
  });

  test("failed retained continuation invalidates the retired surface and rebuilds canonical history", async () => {
    const planner = createNativeRequestDevelopmentWebTurnPlanner();
    const request = { input: [{ type: "message", role: "user", content: "Do A." }] };
    const first = await planner(registered(), request);
    first.settle?.({ status: "completed", documentGeneration: 1, surfaceLeaseId: "old-physical-page", answer: "A done." });
    const nextRequest = { input: [
      ...request.input,
      { type: "message", role: "assistant", content: "A done." },
      { type: "message", role: "user", content: "Do B." },
    ] };
    const continuation = await planner(registered(), nextRequest);
    expect(continuation.physicalContext.mode).toBe("retained-delta");
    expect(continuation.retainedSurfaceLeaseId).toBe("old-physical-page");
    continuation.settle?.({ status: "failed" });
    // A later explicit request reconstructs context; this does not replay uncertain submission.
    const retry = await planner(registered(), nextRequest);
    expect(retry.physicalContext.mode).toBe("full");
    expect(retry.retainedSurfaceLeaseId).toBeUndefined();
    expect(JSON.stringify(retry.physicalContext.segments)).toContain("A done.");
    expect(JSON.stringify(retry.physicalContext.segments)).toContain("Do A.");
    retry.settle?.({ status: "completed", documentGeneration: 1, surfaceLeaseId: "new-physical-page", answer: "B done." });
    const third = await planner(registered(), { input: [
      ...nextRequest.input,
      { type: "message", role: "assistant", content: "B done." },
      { type: "message", role: "user", content: "Do C." },
    ] });
    expect(third.physicalContext.mode).toBe("retained-delta");
    expect(third.retainedSurfaceLeaseId).toBe("new-physical-page");
    third.settle?.({ status: "failed" });
  });

  test("retiring a physical owner invalidates only its matching Native context anchor", async () => {
    const planner = createNativeRequestDevelopmentWebTurnPlanner();
    const input = [{type:"message",role:"user",content:"Do A."}];
    const first = await planner(registered(), {input});
    first.settle?.({status:"completed",surfaceLeaseId:"owned-page",documentGeneration:1,answer:"A done."});
    planner.retireSurface("thread-1", "unrelated-page");
    const nextInput = [...input,{type:"message",role:"assistant",content:"A done."},{type:"message",role:"user",content:"Do B."}];
    const retained = await planner(registered(),{input:nextInput});
    expect(retained.physicalContext.mode).toBe("retained-delta");
    retained.settle?.({status:"completed",surfaceLeaseId:"owned-page",documentGeneration:1,answer:"B done."});
    planner.retireSurface("thread-1", "owned-page");
    const next = await planner(registered(),{input:[...nextInput,{type:"message",role:"assistant",content:"B done."},{type:"message",role:"user",content:"Do C."}]});
    expect(next.physicalContext.mode).toBe("full");
    expect(JSON.stringify(next.physicalContext.segments)).toContain("A done.");
    next.settle?.({status:"failed"});
  });

  test("failed plans clear transactional pending state without advancing retained context", async () => {
    const planner = createNativeRequestDevelopmentWebTurnPlanner();
    const request = { input: [{ type: "message", role: "user", content: "Do A." }] };
    const first = await planner(registered(), request);
    await expect(planner(registered(), request)).rejects.toThrow("unsettled Web context plan");
    first.settle?.({ status: "failed" });
    const retry = await planner(registered(), request);
    expect(retry.webEpochId).toBe(first.webEpochId);
    expect(retry.physicalContext).toEqual(first.physicalContext);
    retry.settle?.({ status: "failed" });
  });

  test("persistent checkpoints reduce physical transfer while canonical Native history remains rebuildable", async () => {
    const root = scratch();
    try {
      const request = {
        instructions: "I".repeat(160),
        input: [
          { type: "message", role: "user", content: "U".repeat(160) },
          { type: "message", role: "assistant", content: "A".repeat(20) },
          { type: "message", role: "user", content: "N".repeat(20) },
        ],
      };
      const projection = projectNativeRequestContext("thread-1", request);
      const anchor = projection.revisions[1]?.revision;
      if (!anchor) throw new Error("fixture anchor missing");
      const cache = new FileContextCheckpointCache({ directory: root });
      const checkpoint = await cache.put({
        nativeTaskId: "thread-1",
        revisionId: anchor.id,
        content: "accepted compact projection of the first two revisions",
        estimatedTokens: 8,
      });

      const plannerAfterRestart = createNativeRequestDevelopmentWebTurnPlanner({
        checkpointCache: new FileContextCheckpointCache({ directory: root }),
        budgetTokens: 30,
      });
      const compact = await plannerAfterRestart(registered(), request);
      expect(compact.physicalContext.mode).toBe("checkpoint-delta");
      expect(compact.physicalContext.logicalTokens).toBeGreaterThan(compact.physicalContext.transferTokens);
      expect(compact.physicalContext.segments[0]).toEqual({
        type: "checkpoint",
        checkpointId: checkpoint.checkpoint.id,
        sourceRevisionId: anchor.id,
        content: "accepted compact projection of the first two revisions",
      });
      expect(compact.physicalContext.segments.slice(1).map(segment => (
        segment.type === "revision" ? segment.content : "checkpoint"
      ))).toEqual(["A".repeat(20), "N".repeat(20)]);

      await cache.clear("thread-1");
      const withoutCache = await createNativeRequestDevelopmentWebTurnPlanner()(registered(), request);
      expect(withoutCache.physicalContext.mode).toBe("full");
      expect(withoutCache.physicalContext.headRevisionId).toBe(compact.physicalContext.headRevisionId);
      expect(withoutCache.physicalContext.segments.map(segment => (
        segment.type === "revision" ? segment.content : "checkpoint"
      ))).toEqual([
        "I".repeat(160),
        "U".repeat(160),
        "A".repeat(20),
        "N".repeat(20),
      ]);
      await expect(createNativeRequestDevelopmentWebTurnPlanner({
        checkpointCache: cache,
        budgetTokens: 30,
      })(registered(), request)).rejects.toThrow("requires a checkpoint");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("checkpoint creation owns one task plan and releases it after failure", async () => {
    const root = scratch();
    let rejectProduction!: (error: Error) => void;
    let started!: () => void;
    const reached = new Promise<void>(resolve => { started = resolve; });
    let fail = true;
    try {
      const planner = createNativeRequestDevelopmentWebTurnPlanner({
        checkpointCache: new FileContextCheckpointCache({ directory: root }), budgetTokens: 30,
        async checkpointProducer(input) {
          if (fail) {
            started();
            await new Promise((_, reject) => { rejectProduction = reject; });
          }
          return { nativeTaskId: input.nativeTaskId, sourceRevisionId: input.sourceRevisionId, content: "summary" };
        },
      });
      const request = { input: [{type:"message",role:"user",content:"x".repeat(160)},
        {type:"message",role:"user",content:"exact latest request"}] };
      const first = Promise.resolve(planner(registered(), request));
      const failed = first.catch(error => error);
      await reached;
      await expect(planner(registered(), request)).rejects.toThrow("unsettled Web context plan");
      rejectProduction(new Error("controlled failure"));
      expect((await failed).message).toBe("controlled failure");
      fail = false;
      const recovered = await planner(registered(), request);
      expect(recovered.physicalContext.mode).toBe("checkpoint-delta");
      recovered.settle?.({status:"failed"});
    } finally { rmSync(root, {recursive:true,force:true}); }
  });

  test("product checkpoint producer uses the calibrated Web budget without an explicit test budget", async () => {
    const root = scratch();
    try {
      let produced = 0;
      const newest = "Keep this exact newest request";
      const planner = createNativeRequestDevelopmentWebTurnPlanner({
        checkpointCache: new FileContextCheckpointCache({ directory: root }),
        checkpointProducer(input) {
          produced++;
          expect(input.physicalContext.segments.some(segment => segment.content === newest)).toBe(false);
          return { nativeTaskId: input.nativeTaskId, sourceRevisionId: input.sourceRevisionId, content: "bounded derived summary" };
        },
      });
      const plan = await planner(registered(), {
        model: chatGptWebModelId(chatGptWebFamilyKey("fixture-family")), reasoning: { effort: "medium" },
        input: [{ type: "message", role: "user", content: "x".repeat(390000) },
          { type: "message", role: "user", content: newest }],
      });
      expect(produced).toBe(1);
      expect(plan.physicalContext.mode).toBe("checkpoint-delta");
      expect(plan.physicalContext.segments.at(-1)?.content).toBe(newest);
      plan.settle?.({ status: "failed" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("one dedicated producer checkpoint compacts only the canonical prefix and preserves the newest revision exact", async () => {
    const root = scratch();
    try {
      const request = {
        instructions: "I".repeat(160),
        input: [
          { type: "message", role: "user", content: "U".repeat(160) },
          { type: "message", role: "assistant", content: "A".repeat(80) },
          { type: "message", role: "user", content: "N".repeat(20) },
        ],
      };
      const produced: Array<{
        sourceRevisionId: string;
        contents: string[];
      }> = [];
      const cache = new FileContextCheckpointCache({ directory: root });
      const planner = createNativeRequestDevelopmentWebTurnPlanner({
        checkpointCache: cache,
        budgetTokens: 30,
        checkpointProducer(input) {
          produced.push({
            sourceRevisionId: input.sourceRevisionId,
            contents: input.physicalContext.segments.map(segment => (
              segment.type === "revision" ? segment.content : "unexpected-checkpoint"
            )),
          });
          return {
            nativeTaskId: input.nativeTaskId,
            sourceRevisionId: input.sourceRevisionId,
            content: "compact prefix",
          };
        },
      });

      const plan = await planner(registered(), request);
      expect(produced).toHaveLength(1);
      expect(produced[0]?.contents).toEqual([
        "I".repeat(160),
        "U".repeat(160),
        "A".repeat(80),
      ]);
      expect(plan.physicalContext.mode).toBe("checkpoint-delta");
      expect(plan.physicalContext.segments[0]).toMatchObject({
        type: "checkpoint",
        sourceRevisionId: produced[0]?.sourceRevisionId,
        content: "compact prefix",
      });
      expect(plan.physicalContext.segments.at(-1)).toMatchObject({
        type: "revision",
        kind: "user",
        content: "N".repeat(20),
      });
      expect(await cache.list("thread-1")).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("producer source mismatch fails before cache mutation", async () => {
    const root = scratch();
    try {
      const cache = new FileContextCheckpointCache({ directory: root });
      const planner = createNativeRequestDevelopmentWebTurnPlanner({
        checkpointCache: cache,
        budgetTokens: 10,
        checkpointProducer(input) {
          return {
            nativeTaskId: input.nativeTaskId,
            sourceRevisionId: "wrong-source",
            content: "must not persist",
          };
        },
      });
      await expect(planner(registered(), {
        input: [
          { type: "message", role: "user", content: "A".repeat(80) },
          { type: "message", role: "user", content: "B".repeat(20) },
        ],
      })).rejects.toThrow("different Native source");
      expect(await cache.list("thread-1")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an ineffective checkpoint is not regenerated automatically on the same canonical anchor", async () => {
    const root = scratch();
    try {
      const cache = new FileContextCheckpointCache({ directory: root });
      let producerCalls = 0;
      const planner = createNativeRequestDevelopmentWebTurnPlanner({
        checkpointCache: cache,
        budgetTokens: 10,
        checkpointProducer(input) {
          producerCalls += 1;
          return {
            nativeTaskId: input.nativeTaskId,
            sourceRevisionId: input.sourceRevisionId,
            content: "S".repeat(80),
          };
        },
      });
      const request = {
        input: [
          { type: "message", role: "user", content: "A".repeat(80) },
          { type: "message", role: "user", content: "B".repeat(20) },
        ],
      };
      await expect(planner(registered(), request)).rejects.toThrow("requires a checkpoint");
      expect(producerCalls).toBe(1);
      expect(await cache.list("thread-1")).toHaveLength(1);

      await expect(planner(registered(), request)).rejects.toThrow("requires a checkpoint");
      expect(producerCalls).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a checkpoint from a superseded canonical branch is ignored rather than promoted to authority", async () => {
    const root = scratch();
    try {
      const oldRequest = {
        input: [
          { type: "message", role: "user", content: "Old direction" },
          { type: "message", role: "assistant", content: "Old work" },
        ],
      };
      const oldProjection = projectNativeRequestContext("thread-1", oldRequest);
      const oldHead = oldProjection.revisions.at(-1)!.revision;
      const cache = new FileContextCheckpointCache({ directory: root });
      await cache.put({
        nativeTaskId: "thread-1",
        revisionId: oldHead.id,
        content: "stale branch checkpoint",
        estimatedTokens: 1,
      });

      const changedRequest = {
        input: [
          { type: "message", role: "user", content: "New direction" },
          { type: "message", role: "assistant", content: "New work" },
        ],
      };
      const planned = await createNativeRequestDevelopmentWebTurnPlanner({
        checkpointCache: cache,
      })(registered(), changedRequest);

      expect(planned.physicalContext.mode).toBe("full");
      expect(JSON.stringify(planned.physicalContext)).not.toContain("stale branch checkpoint");
      expect(JSON.stringify(planned.physicalContext)).toContain("New direction");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
