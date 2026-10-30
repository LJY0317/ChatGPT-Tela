import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { NativeRequestPrefixSnapshot } from "./native-visible-prefix-checkpoint";
import { produceNativePrefixCheckpoint, type NativePrefixCheckpointInput } from "./native-visible-prefix-checkpoint";
import { FileNativeVisiblePrefixStageJournal } from "./native-visible-prefix-journal";
import { ControlledBrowserHost } from "@chatgpt-tela/browser-host";
import { runBrowserContextCheckpoint } from "@chatgpt-tela/runtime";

const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
function source(text:string):NativeRequestPrefixSnapshot {
  const content=JSON.stringify({type:"tela_native_request_prefix_v1",items:[{type:"revision",kind:"assistant",revisionId:"prior",content:text}]});
  return {kind:"native-request-prefix",threadId:"thread",currentTurnId:"active",contentDigest: hash(content), digest:hash(content),sourceItemCount:1,
    content,inlineAssets:[],references:[],localImageCandidates:[]};
}

test.each([false, true])("observation failure follows physical release through the durable journal (close fails=%s)", async failClose => {
  const root = await mkdtemp(join(tmpdir(), "tela-checkpoint-release-"));
  const options = {directory: join(root, "journal"), initializationPath: join(root, "receipt")};
  const snapshot = source("bounded source for one owned summary");
  let sends = 0, releases = 0;
  const host = new ControlledBrowserHost(async () => ({
    async navigate() {}, async reveal() {}, async hide() {},
    async close() { releases++; if (failClose) throw Error("physical close failed"); },
  }));
  const run = (currentTurnId: string) => produceNativePrefixCheckpoint({
    source: {...snapshot, currentTurnId}, journal: new FileNativeVisiblePrefixStageJournal(options),
    accountNamespace: "account", effort: "medium", confirmSource: async () => ({...snapshot, currentTurnId}),
    producer: async r => runBrowserContextCheckpoint({browserHost: host,
      request: {nativeTaskId: r.nativeTaskId, sourceRevisionId: r.sourceRevisionId,
        webEpochId: `isolated-${currentTurnId}`, physicalContext: r.physicalContext},
      ...(r.persistResult ? {persistResult: r.persistResult} : {}),
      provider: {
        async createContextCheckpoint(_surface, request) {
          sends++;
          if (sends === 1) throw Error("accepted operation observation failed");
          return {state: "proven", value: {...request, providerOperationId: "op", content: "verified replacement summary"}, evidence: []};
        },
      },
    }),
  });
  try {
    await expect(run("original-owner")).rejects.toMatchObject({recoveryReason: failClose ? "checkpoint_interrupted" : "checkpoint_closed"});
    expect(sends).toBe(1); expect(releases).toBe(1);
    expect(await new FileNativeVisiblePrefixStageJournal(options).pendingOperations()).toHaveLength(failClose ? 1 : 0);
    await expect(run("original-owner")).rejects.toThrow(); expect(sends).toBe(1);
    if (failClose) {
      await expect(run("new-authorized-owner")).rejects.toThrow(); expect(sends).toBe(1);
    } else {
      expect(await run("new-authorized-owner")).toContain("verified replacement summary");
      expect(sends).toBe(2);
      await run("later-authorized-owner"); expect(sends).toBe(2);
    }
  } finally { await host.close().catch(() => {}); await rm(root, {recursive: true, force: true}); }
});

test("new stage keys cannot bypass a legacy uncertain send or require a cache to preserve it",async()=>{
  const root=await mkdtemp(join(tmpdir(),"tela-legacy-efficiency-"));
  const options={directory:join(root,"journal"),initializationPath:join(root,"receipt")};
  const snapshot=source("legacy source");const journal=new FileNativeVisiblePrefixStageJournal(options);
  try {
    await journal.claim({key:`native-visible-stage-${hash("old stage")}`,sourceDigest:snapshot.digest,inputDigest:hash("old exact input")});
    let sends=0;
    await expect(produceNativePrefixCheckpoint({source:snapshot,journal:new FileNativeVisiblePrefixStageJournal(options),accountNamespace:"account",effort:"medium",
      confirmSource:async()=>snapshot,producer:async r=>{sends++;return {...r,content:"unreachable"};}})).rejects.toThrow("uncertain");
    expect(sends).toBe(0);expect(await journal.pendingOperations()).toHaveLength(1);
  } finally {await rm(root,{recursive:true,force:true});}
});

test("pending reusable stage remains unknown when the source root grows",async()=>{
  const root=await mkdtemp(join(tmpdir(),"tela-pending-reuse-"));
  const options={directory:join(root,"journal"),initializationPath:join(root,"receipt")};
  const identity={key:`native-visible-stage-v2-${hash("same exact stage")}`,sourceDigest:hash("fragment"),inputDigest:hash("exact input")};
  try {
    const claim=await new FileNativeVisiblePrefixStageJournal(options).claim(identity,hash("old owner"),hash("old source root"));
    expect(claim.status).toBe("claimed");
    expect((await new FileNativeVisiblePrefixStageJournal(options).claim(identity,hash("new owner"),hash("grown source root"))).status).toBe("unknown");
    expect(await new FileNativeVisiblePrefixStageJournal(options).pendingOperations()).toHaveLength(1);
  } finally {await rm(root,{recursive:true,force:true});}
});


test("canonical provenance digest is distinct from the exact payload hash",async()=>{
 const snapshot=source("verified bytes");const bound={...snapshot,digest:hash("canonical owner and source")};let calls=0;
 const root=await mkdtemp(join(tmpdir(),"tela-owner-digest-"));
 try{
  const result=JSON.parse(await produceNativePrefixCheckpoint({source:bound,accountNamespace:"account",effort:"medium",
   journal:new FileNativeVisiblePrefixStageJournal({directory:join(root,"journal"),initializationPath:join(root,"receipt")}),
   confirmSource:async()=>bound,producer:async r=>{calls++;return {...r,content:"Bounded verified summary"};}}));
  expect(result.sourceDigest).toBe(bound.digest);expect(calls).toBe(1);
  await expect(produceNativePrefixCheckpoint({source:{...bound,content:bound.content+" "},accountNamespace:"account",effort:"medium",
   journal:new FileNativeVisiblePrefixStageJournal({directory:join(root,"journal"),initializationPath:join(root,"receipt")}),
   confirmSource:async()=>bound,producer:async r=>{calls++;return {...r,content:"unreachable"};}})).rejects.toThrow("digest mismatch");
  expect(calls).toBe(1);
 }finally{await rm(root,{recursive:true,force:true});}
});

test("semantic namespace changes never bypass a pending v2 operation",async()=>{
 const root=await mkdtemp(join(tmpdir(),"tela-pending-scope-"));
 const options={directory:join(root,"journal"),initializationPath:join(root,"receipt")};const snapshot=source("unchanged source");let sends=0;
 const producer=async()=>{sends++;throw Error("accepted response unavailable");};
 const run=(extra:Partial<NativePrefixCheckpointInput>={})=>produceNativePrefixCheckpoint({source:snapshot,accountNamespace:"account",effort:"medium",
  journal:new FileNativeVisiblePrefixStageJournal(options),confirmSource:async()=>extra.source??snapshot,producer,...extra});
 try{
  await expect(run()).rejects.toThrow("uncertain");expect(sends).toBe(1);
  for(const extra of [{summaryPolicyFingerprint:hash("new policy")},{effort:"high"},{browserModel:{familyKey:"new family",effort:"medium"}},
   {source:{...snapshot,currentTurnId:"new Native authority"}}, {source:source("edited source")} ] satisfies Partial<NativePrefixCheckpointInput>[]){
   await expect(run(extra)).rejects.toThrow("uncertain");expect(sends).toBe(1);
  }
  // A separately proven Native conversation in the same account has its own scope.
  await expect(run({source:{...snapshot,threadId:"foreign thread"}})).rejects.toThrow("uncertain");expect(sends).toBe(2);
 }finally{await rm(root,{recursive:true,force:true});}
});

test("validated stage survives producer cleanup failure and process recreation without another send",async()=>{
 const root=await mkdtemp(join(tmpdir(),"tela-durable-result-"));
 const options={directory:join(root,"journal"),initializationPath:join(root,"receipt")};
 const snapshot=source("a complete canonical source");let sends=0;
 try{
  await expect(produceNativePrefixCheckpoint({source:snapshot,accountNamespace:"account",effort:"medium",
   journal:new FileNativeVisiblePrefixStageJournal(options),confirmSource:async()=>snapshot,
   producer:async request=>{sends++;const result={...request,content:"durable verified summary"};
    await request.persistResult!(result);await request.persistResult!(result);
    await expect(request.persistResult!({...result,content:"changed summary"})).rejects.toThrow();
    throw Error("physical release failed");
   }})).rejects.toThrow();
  const result=await produceNativePrefixCheckpoint({source:{...snapshot,currentTurnId:"new-owner"},accountNamespace:"account",effort:"medium",
   journal:new FileNativeVisiblePrefixStageJournal(options),confirmSource:async()=>({...snapshot,currentTurnId:"new-owner"}),
   producer:async()=>{sends++;throw Error("must reuse");}});
  expect(JSON.parse(result).content??result).toContain("durable verified summary");expect(sends).toBe(1);
 }finally{await rm(root,{recursive:true,force:true});}
});

test("unscoped modern pending blocks changed keys but completed exact receipts remain reusable",async()=>{
 const root=await mkdtemp(join(tmpdir(),"tela-unscoped-pending-"));
 const options={directory:join(root,"journal"),initializationPath:join(root,"receipt")};
 const identity=(name:string)=>({key:`native-visible-stage-v2-${hash(name)}`,sourceDigest:hash(name),inputDigest:hash("input:"+name)});
 const journal=new FileNativeVisiblePrefixStageJournal(options);const done=identity("completed");
 try{
  const claim=await journal.claim(done,hash("owner"),hash("root"));
  if(claim.status!=="claimed")throw Error("fixture");
  await journal.complete({...done,status:"completed",claimId:claim.claimId,summary:"verified"});
  await journal.claim(identity("old unscoped"),hash("owner"),hash("old root"));
  expect((await journal.claim(identity("new format"),hash("new owner"),hash("new root"),hash("scope"))).status).toBe("unknown");
  expect((await journal.claim(done,hash("new owner"),hash("root"),hash("scope"))).status).toBe("completed");
 }finally{await rm(root,{recursive:true,force:true});}
});

test("public AppServer snapshot enters ordered projection without a bootstrap summary",async()=>{
 const {AppServerCompactionHistorySource}=await import("@chatgpt-tela/codex");
 const rpc={async request(method:string){
  if(method==="thread/read")return {thread:{id:"thread",status:{type:"active"},historyMode:"paginated",cwd:"/fixture",source:"appServer",environments:[]}};
  if(method==="thread/turns/list")return {data:[{id:"active",status:"inProgress",itemsView:"notLoaded",items:[]}]};
  if(method==="thread/items/list")return {data:[{turnId:"prior",item:{id:"message",type:"agentMessage",text:"verified public history"}}],nextCursor:null};
  throw Error("unexpected RPC");
 },async close(){}};
 const snapshot=await new AppServerCompactionHistorySource(async()=>rpc).visibleHistory("thread","active");
 expect(snapshot.contentDigest).toBe(hash(snapshot.content));expect(snapshot.digest).not.toBe(snapshot.contentDigest);
 const root=await mkdtemp(join(tmpdir(),"tela-public-source-"));let sends=0;
 try{
  const {resolveNativeContextContinuity,nativeOpaqueCompaction}=await import("./native-context-continuity");
  const {projectNativeRequestContext}=await import("./native-request-planner");
  const {defineNativeTurnAuthority}=await import("@chatgpt-tela/core");
  const body={input:[{type:"compaction",encrypted_content:"opaque"},{role:"user",content:"current request"}]};
  const continuity=await resolveNativeContextContinuity({threadId:"thread",currentTurnId:"active",
   authority:defineNativeTurnAuthority({threadId:"thread",turnId:"active",cwd:"/fixture",workspaceRoots:["/fixture"],sandbox:{kind:"read-only",network:"restricted"}}),
   opaque:nativeOpaqueCompaction(body),options:{
    visiblePrefix:{accountNamespace:"account",journal:new FileNativeVisiblePrefixStageJournal({directory:join(root,"journal"),initializationPath:join(root,"receipt")}),read:async()=>snapshot},
    checkpointProducer:async()=>{sends++;throw Error("unnecessary bootstrap summary");},
   }});
  const projected=projectNativeRequestContext("thread",body,continuity.visibleHistory,continuity.inlineHistoryAssets,continuity.historyReferences);
  expect(projected.revisions.some(item=>item.content.includes("verified public history"))).toBe(true);
  expect(projected.revisions.at(-1)?.content).toBe("current request");
  expect(sends).toBe(0);
 }finally{await rm(root,{recursive:true,force:true});}
});

test("proven unusable stage is closed without replay and a fresh owner may replace its claim",async()=>{
 const {WebCheckpointOperationClosed}=await import("@chatgpt-tela/chatgpt");
 const root=await mkdtemp(join(tmpdir(),"tela-rejected-stage-"));
 const options={directory:join(root,"journal"),initializationPath:join(root,"receipt")};
 const snapshot=source("bounded stage");let sends=0;
 const run=(currentTurnId:string)=>produceNativePrefixCheckpoint({source:{...snapshot,currentTurnId},accountNamespace:"account",effort:"medium",
  journal:new FileNativeVisiblePrefixStageJournal(options),confirmSource:async()=>({...snapshot,currentTurnId}),
  producer:async r=>{sends++;if(sends===1)throw new WebCheckpointOperationClosed({nativeTaskId:r.nativeTaskId,
   sourceRevisionId:r.sourceRevisionId,webEpochId:"epoch",disposition:"completed_unusable"});
   return {...r,content:"valid replacement summary"};}});
 try{
  await expect(run("active")).rejects.toMatchObject({recoveryReason:"checkpoint_rejected"});expect(sends).toBe(1);
  await expect(run("active")).rejects.toThrow();expect(sends).toBe(1);
  expect(await new FileNativeVisiblePrefixStageJournal(options).pendingOperations()).toHaveLength(0);
  expect(await run("new independently authorized owner")).toContain("valid replacement summary");expect(sends).toBe(2);
 }finally{await rm(root,{recursive:true,force:true});}
});

test("foreign callback result cannot settle an owned pending stage",async()=>{
 const root=await mkdtemp(join(tmpdir(),"tela-foreign-persist-"));
 const options={directory:join(root,"journal"),initializationPath:join(root,"receipt")};const snapshot=source("bounded stage");let sends=0;
 try{
  await expect(produceNativePrefixCheckpoint({source:snapshot,accountNamespace:"account",effort:"medium",
   journal:new FileNativeVisiblePrefixStageJournal(options),confirmSource:async()=>snapshot,
   producer:async r=>{sends++;await r.persistResult!({...r,nativeTaskId:"foreign",content:"wrong"});return {...r,content:"unreachable"};}})).rejects.toThrow();
  expect(sends).toBe(1);expect(await new FileNativeVisiblePrefixStageJournal(options).pendingOperations()).toHaveLength(1);
 }finally{await rm(root,{recursive:true,force:true});}
});

test("foreign closure receipt cannot classify the owned stage as a settled rejection",async()=>{
 const {WebCheckpointOperationClosed}=await import("@chatgpt-tela/chatgpt");
 const root=await mkdtemp(join(tmpdir(),"tela-foreign-closure-"));
 const options={directory:join(root,"journal"),initializationPath:join(root,"receipt")};const snapshot=source("bounded stage");
 try{
  await expect(produceNativePrefixCheckpoint({source:snapshot,accountNamespace:"account",effort:"medium",
   journal:new FileNativeVisiblePrefixStageJournal(options),confirmSource:async()=>snapshot,
   producer:async r=>{throw new WebCheckpointOperationClosed({nativeTaskId:"foreign",sourceRevisionId:r.sourceRevisionId,
    webEpochId:"epoch",disposition:"completed_unusable"});}})).rejects.toMatchObject({recoveryReason:"checkpoint_interrupted"});
  expect(await new FileNativeVisiblePrefixStageJournal(options).pendingOperations()).toHaveLength(1);
 }finally{await rm(root,{recursive:true,force:true});}
});

test("deadline crossing during claim closes a proven uninvoked stage, preserving safe new-owner continuation",async()=>{
 const {CheckpointPreparationBudget}=await import("./checkpoint-preparation-budget");
 const root=await mkdtemp(join(tmpdir(),"tela-preparation-admission-"));
 const options={directory:join(root,"journal"),initializationPath:join(root,"receipt")};
 const journal=new FileNativeVisiblePrefixStageJournal(options),snapshot=source("bounded exact source");
 let now=0,sends=0;
 const budget=new CheckpointPreparationBudget(100000,{maxModelCalls:1,maxInputTokens:100000,maxElapsedMs:10},()=>now);
 const delayedClaim={completedReceipts:()=>journal.completedReceipts(),complete:journal.complete.bind(journal),
  settleClosed:journal.settleClosed.bind(journal),claim:async(...args:Parameters<typeof journal.claim>)=>{
   const result=await journal.claim(...args);now=11;return result;
  }};
 try{
  await expect(produceNativePrefixCheckpoint({source:snapshot,accountNamespace:"account",effort:"medium",
   journal:delayedClaim,preparationBudget:budget,confirmSource:async()=>snapshot,
   producer:async r=>{sends++;return {...r,content:"not reached"};}})).rejects.toMatchObject({
    recoveryReason:"source_budget",budgetReason:"elapsed_time",
   });
  expect(sends).toBe(0);expect(await journal.pendingOperations()).toHaveLength(0);
  const next={...snapshot,currentTurnId:"new-proven-owner"};
  await expect(produceNativePrefixCheckpoint({source:next,accountNamespace:"account",effort:"medium",
   journal:new FileNativeVisiblePrefixStageJournal(options),confirmSource:async()=>next,
   producer:async r=>{sends++;return {...r,content:"verified continuation"};}})).resolves.toContain("verified continuation");
  expect(sends).toBe(1);expect(await journal.pendingOperations()).toHaveLength(0);
 }finally{await rm(root,{recursive:true,force:true});}
});


test("cold Web planning reads a bounded original source and can retrieve its giant deferred item through the same Native binding", async () => {
 const {AppServerCompactionHistorySource,AppServerCurrentTurnSource,bindNativeTurnRequest}=await import('@chatgpt-tela/codex');
 const {ActiveTurnRegistry}=await import('@chatgpt-tela/runtime');
 const {createNativeRequestDevelopmentWebTurnPlanner}=await import('./native-request-planner');
 const {chatGptWebModelId,chatGptWebFamilyKey,formatWebPhysicalContext}=await import('@chatgpt-tela/chatgpt');
 const root=await mkdtemp(join(tmpdir(),'tela-bounded-cold-source-'));
 let current='active',sourceReads=0,bodyReads=0,summaries=0;
 const original={id:'giant-original',type:'agentMessage',text:'original-'.repeat(400_000)};
 const rpc={async request(method:string,params:any):Promise<any>{
  if(method==='thread/read')return {thread:{id:'thread',status:{type:'active'},historyMode:'paginated',cwd:resolve('/fixture'),source:'appServer'}};
  if(method==='thread/turns/list')return {data:(params.limit===4?[current,'prior']:[current])
   .map(id=>({id,status:id===current?'inProgress':'completed',itemsView:'notLoaded',items:[]})),nextCursor:null};
  if(method==='thread/items/list'){
   if(params.turnId){bodyReads++;expect(params.turnId).toBe('prior');}
   return {data:[{turnId:'prior',item:original}],nextCursor:null};
  }
  throw Error('unexpected source API');
 },async close(){}};
 const originalSource = new AppServerCurrentTurnSource(async()=>rpc);
 const canonical:import('@chatgpt-tela/codex').CanonicalCurrentTurnSource={async currentTurn(threadId:string){return {threadId,turnId:current,cwd:resolve('/fixture'),workspaceRoots:[resolve('/fixture')],
  sandbox:{kind:'native-enforced' as const},proof:'turn-context' as const,environmentSourceTurnId:current};},
  readHistoryPage:(...args)=>originalSource.readHistoryPage(...args),
  readHistoryIndex:(...args)=>originalSource.readHistoryIndex(...args)};
 const input=[{type:'compaction',encrypted_content:'opaque-native'},{role:'user',content:'Continue the agreed task'}];
 const request=(items:unknown[]=input)=>({model:chatGptWebModelId(chatGptWebFamilyKey('Fixture')),reasoning:{effort:'medium'},instructions:'Exact current instruction',input:items,
  client_metadata:{'x-codex-turn-metadata':{request_kind:'turn',thread_id:'thread',turn_id:current}},tools:[]});
 const turns=new ActiveTurnRegistry();
 const planner=createNativeRequestDevelopmentWebTurnPlanner({
  visiblePrefix:{accountNamespace:'fixture-account',journal:new FileNativeVisiblePrefixStageJournal({directory:join(root,'journal'),initializationPath:join(root,'init')}),
   async read(threadId,turnId,signal,bodyBudgetBytes){sourceReads++;expect(bodyBudgetBytes).toBeGreaterThan(0);
    return new AppServerCompactionHistorySource(async()=>rpc).visibleHistory(threadId,turnId,signal,bodyBudgetBytes);}},
  checkpointProducer:async()=>{summaries++;throw Error('unseen original archive must not be summarized');},
 });
 try{
  const registered=turns.register(await bindNativeTurnRequest(request(),canonical));
  const plan=await planner(registered,request());
  expect(plan.physicalContext.deferredHistory).toEqual({scope:'prior-native-history'});
  expect(plan.physicalContext.transferTokens).toBeLessThan(4096);
  expect(plan.physicalContext.segments.at(-1)?.content).toBe('Continue the agreed task');
  expect(plan.physicalContext.segments.some(item=>item.content.includes('original-'))).toBe(false);
  const control=turns.historyControl(registered.capability,new AbortController().signal)!;
  const index=await turns.readHistoryPage(control,{});
  expect(index).toMatchObject({type:'native_history_index',data:[{turnId:'prior',status:'completed'}]});
  const readback=await turns.readHistoryPage(control,{turnId:'prior'});
  if(readback.type!=='native_history_page')throw Error('expected original body range');
  expect(readback.text).toContain('original-');expect(readback.continuation).not.toBeNull();
  expect(readback.range.end).toBeLessThan(readback.range.total);
  expect(registered.channel.toolRoundCount).toBe(0);expect(bodyReads).toBe(1);expect(summaries).toBe(0);
  plan.settle?.({status:'completed',surfaceLeaseId:'same-original-page',documentGeneration:1,answer:'Done',
   releasedToolResultBytes:registered.channel.releasedToolResultBytes,toolRoundCount:registered.channel.toolRoundCount});
  turns.retire(registered.capability);current='active-next';
  const continued=request([...input,{role:'assistant',content:'Done'},{role:'user',content:'Next step'}]);
  const next=await planner(turns.register(await bindNativeTurnRequest(continued,canonical)),continued);
  expect(next.physicalContext.mode).toBe('retained-delta');
  expect(next.retainedSurfaceLeaseId).toBe('same-original-page');
  expect(next.physicalContext.deferredHistory).toEqual(plan.physicalContext.deferredHistory);
  expect(formatWebPhysicalContext(next.physicalContext,undefined,undefined,[],{nativeHistoryControl:'fresh-control'})).not.toContain('"deferredHistory"');
  expect(sourceReads).toBe(1);expect(bodyReads).toBe(1);expect(summaries).toBe(0);
  next.settle?.({status:'failed'});
 }finally{turns.cancelAll();await rm(root,{recursive:true,force:true});}
});
