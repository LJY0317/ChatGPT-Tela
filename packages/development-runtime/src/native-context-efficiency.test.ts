import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeVisiblePrefixSnapshot } from "@chatgpt-tela/codex";
import { produceNativePrefixCheckpoint, type NativePrefixCheckpointInput } from "./native-visible-prefix-checkpoint";
import { FileNativeVisiblePrefixStageJournal } from "./native-visible-prefix-journal";

const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
function source(text:string):NativeVisiblePrefixSnapshot {
  const content=JSON.stringify({type:"tela_native_visible_prefix_v1",items:[{turnId:"prior",item:{type:"agentMessage",text}}]});
  return {kind:"native-visible-prefix",threadId:"thread",currentTurnId:"active",contentDigest: hash(content), digest:hash(content),sourceItemCount:1,
    content,inlineAssets:[],references:[],localImageCandidates:[]};
}

test("durable unchanged-fragment reuse survives cache loss, appended history and edited tails",async()=>{
  const root=await mkdtemp(join(tmpdir(),"tela-efficient-context-"));
  const journal=()=>new FileNativeVisiblePrefixStageJournal({directory:join(root,"journal"),initializationPath:join(root,"receipt")});
  const calls:any[]=[];
  const original=source("한글😀\\\"\n".repeat(60000));
  const produce=async(snapshot:NativeVisiblePrefixSnapshot,extra:Partial<NativePrefixCheckpointInput>={})=>produceNativePrefixCheckpoint({source:snapshot,journal:journal(),accountNamespace:"account",effort:"medium",
    confirmSource:async()=>extra.source??snapshot,producer:async r=>{const body=JSON.parse(r.physicalContext.segments[0]!.content);calls.push(body);
      return {nativeTaskId:r.nativeTaskId,sourceRevisionId:r.sourceRevisionId,content:`Bounded derived summary ${hash(JSON.stringify(body)).slice(0,16)}`};},...extra});
  try {
    await produce(original);
    const fragments=calls.filter(c=>c.mode==="fragment");expect(fragments.length).toBeGreaterThan(2);
    expect(fragments.map(f=>f.fragment).join("")).toBe(original.content);
    calls.length=0;
    await produce({...original,currentTurnId:"new-native-owner"});
    expect(calls).toHaveLength(0); // New journal object; no disposable cache supplied.
    const appended=source("한글😀\\\"\n".repeat(60000)+"new canonical suffix");
    const envelope=JSON.parse(await produce(appended));
    const changed=calls.filter(c=>c.mode==="fragment");
    expect(changed.length).toBeLessThan(fragments.length);
    expect(changed.every(c=>c.startByte>0)).toBe(true);
    expect(envelope.sourceDigest).toBe(appended.digest);expect(envelope.sourceBytes).toBe(Buffer.byteLength(appended.content));
    expect(calls.filter(c=>c.mode==="merge").at(-1).endByte).toBe(Buffer.byteLength(appended.content));
    calls.length=0;
    await produce(source("한글😀\\\"\n".repeat(60000)+"edited canonical suffix"));
    expect(calls.filter(c=>c.mode==="fragment").every(c=>c.startByte>0)).toBe(true);
    for (const extra of [{accountNamespace:"foreign-account"},{source:{...original,threadId:"foreign-thread"}},
      {effort:"high"},{browserModel:{familyKey:"different-family",effort:"medium"}},
      {summaryPolicyFingerprint:hash("different semantic policy")}] satisfies Partial<NativePrefixCheckpointInput>[]) {
      calls.length=0;await produce(original,extra);expect(calls.filter(c=>c.mode==="fragment")).toHaveLength(fragments.length);
    }
  } finally {await rm(root,{recursive:true,force:true});}
},30000);

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

test("public AppServer snapshot flows through the production checkpoint contract",async()=>{
 const {AppServerCompactionHistorySource}=await import("@chatgpt-tela/codex");
 const rpc={async request(method:string){
  if(method==="thread/read")return {thread:{id:"thread",status:{type:"active"},historyMode:"paginated",cwd:"/fixture",source:"appServer",environments:[]}};
  if(method==="thread/turns/list")return {data:[{id:"active",status:"inProgress",itemsView:"notLoaded",items:[]}]};
  if(method==="thread/items/list")return {data:[{turnId:"prior",item:{id:"message",type:"agentMessage",text:"verified public history"}}],nextCursor:null};
  throw Error("unexpected RPC");
 },async close(){}};
 const snapshot=await new AppServerCompactionHistorySource(async()=>rpc).completeVisiblePrefix("thread","active");
 expect(snapshot.contentDigest).toBe(hash(snapshot.content));expect(snapshot.digest).not.toBe(snapshot.contentDigest);
 const root=await mkdtemp(join(tmpdir(),"tela-public-source-"));let sends=0;
 try{
  const result=await produceNativePrefixCheckpoint({source:snapshot,accountNamespace:"account",effort:"medium",
   journal:new FileNativeVisiblePrefixStageJournal({directory:join(root,"journal"),initializationPath:join(root,"receipt")}),
   confirmSource:async()=>snapshot,producer:async r=>{sends++;return {...r,content:"verified public summary"};}});
  expect(JSON.parse(result).sourceDigest).toBe(snapshot.digest);expect(sends).toBe(1);
 }finally{await rm(root,{recursive:true,force:true});}
});

test("production request-prefix serialization reuses unchanged fragments across head growth",async()=>{
 const {nativeRequestPrefixSnapshot}=await import("./native-request-planner");
 const root=await mkdtemp(join(tmpdir(),"tela-request-prefix-"));
 const options={directory:join(root,"journal"),initializationPath:join(root,"receipt")};
 const base={mode:"full" as const,headRevisionId:"original",logicalTokens:1,transferTokens:1,
  segments:[{type:"revision" as const,kind:"user" as const,revisionId:"original",content:"large canonical prefix ".repeat(35000)}]};
 const original=nativeRequestPrefixSnapshot("thread","active",base);
 const grown=nativeRequestPrefixSnapshot("thread","new-owner",{...base,headRevisionId:"appended",
  segments:[...base.segments,{type:"revision",kind:"user",revisionId:"appended",content:"new suffix"}]});
 const calls:any[]=[];
 const run=(snapshot:typeof original)=>produceNativePrefixCheckpoint({source:snapshot,accountNamespace:"account",effort:"medium",
  journal:new FileNativeVisiblePrefixStageJournal(options),confirmSource:async()=>snapshot,
  producer:async r=>{const body=JSON.parse(r.physicalContext.segments[0]!.content);calls.push(body);return {...r,content:"summary "+hash(JSON.stringify(body))};}});
 try{
  await run(original);const cold=calls.filter(x=>x.mode==="fragment").length;expect(cold).toBeGreaterThan(2);
  calls.length=0;await run(grown);
  const changed=calls.filter(x=>x.mode==="fragment");expect(changed.length).toBeLessThan(cold);
  expect(changed.every(x=>x.startByte>0)).toBe(true);
  calls.length=0;await run(grown);expect(calls).toHaveLength(0);
  // A genuine edited branch replaces the suffix under new Native authority.
  // It must neither resend the unchanged prefix nor reuse the old suffix/merge.
  const edited=nativeRequestPrefixSnapshot("thread","edited-owner",{...base,headRevisionId:"edited",
   segments:[...base.segments,{type:"revision",kind:"user",revisionId:"edited",content:"replacement suffix"}]});
  calls.length=0;await run(edited);
  const editedFragments=calls.filter(x=>x.mode==="fragment");
  expect(editedFragments.length).toBeGreaterThan(0);expect(editedFragments.length).toBeLessThan(cold);
  expect(editedFragments.every(x=>x.startByte>0)).toBe(true);
  expect(editedFragments.map(x=>x.fragment).join("")).toContain("replacement suffix");
  expect(editedFragments.map(x=>x.fragment).join("")).not.toContain("new suffix");
  expect(calls.filter(x=>x.mode==="merge")).toHaveLength(1);
  calls.length=0;await run({...edited,currentTurnId:"another-proven-owner"});expect(calls).toHaveLength(0);
 }finally{await rm(root,{recursive:true,force:true});}
},30000);

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
