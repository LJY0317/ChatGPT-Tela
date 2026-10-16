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
  return {kind:"native-visible-prefix",threadId:"thread",currentTurnId:"active",digest:hash(content),sourceItemCount:1,
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
