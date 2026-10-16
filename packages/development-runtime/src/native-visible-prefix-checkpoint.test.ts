import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { NativeVisiblePrefixSnapshot } from "@chatgpt-tela/codex";
import { chatGptCheckpointInputTokens, chatGptWebCheckpointSourceTokenLimit } from "@chatgpt-tela/chatgpt";
import {
 produceNativePrefixCheckpoint, NativePrefixCheckpointInterrupted,
 type NativeVisiblePrefixStageIdentity, type NativeVisiblePrefixStageReceipt,
 type NativeVisiblePrefixStageJournal, type NativePrefixCheckpointInput,
} from "./native-visible-prefix-checkpoint";

class Journal implements NativeVisiblePrefixStageJournal {
 readonly records = new Map<string, {identity:NativeVisiblePrefixStageIdentity;claimId:string;receipt?:NativeVisiblePrefixStageReceipt}>();
 async claim(identity:NativeVisiblePrefixStageIdentity) {
  const old=this.records.get(identity.key);
  if(old){
   if(old.identity.inputDigest!==identity.inputDigest||old.identity.sourceDigest!==identity.sourceDigest)throw Error('foreign stage');
   return old.receipt ?? {status:'unknown' as const};
  }
  const claimId=`nonce-${this.records.size}`;
  this.records.set(identity.key,{identity,claimId});
  return {status:'claimed' as const,claimId};
 }
 async complete(input:NativeVisiblePrefixStageReceipt & {claimId:string}) {
  const old=this.records.get(input.key);
  if(!old||old.claimId!==input.claimId||old.identity.inputDigest!==input.inputDigest
   ||old.identity.sourceDigest!==input.sourceDigest)throw Error('unowned completion');
  old.receipt={key:input.key,status:'completed',sourceDigest:input.sourceDigest,inputDigest:input.inputDigest,summary:input.summary};
 }
}
function fixture(text='visible prior answer') {
 const content=JSON.stringify({type:'tela_native_visible_prefix_v1',items:[{turnId:'prior',item:{id:'old',type:'agentMessage',text}}]});
 const source:NativeVisiblePrefixSnapshot={kind:'native-visible-prefix',threadId:'thread',currentTurnId:'current',
  digest:createHash('sha256').update(content).digest('hex'),sourceItemCount:1,content,
  inlineAssets:[],references:[],localImageCandidates:[]};
 const calls:any[]=[];
 const journal=new Journal();
 let confirmations=0;
 const input:NativePrefixCheckpointInput={source,accountNamespace:'account-fixture',journal,effort:'medium',
  confirmSource:async()=>{confirmations++;return source;},producer:async request=>{
   calls.push(request);
   expect(chatGptCheckpointInputTokens(request.physicalContext)).toBeLessThanOrEqual(chatGptWebCheckpointSourceTokenLimit('medium'));
   return {nativeTaskId:request.nativeTaskId,sourceRevisionId:request.sourceRevisionId,content:'Bounded source-specific derived summary.'};
  }};
 return {source,input,journal,calls,confirmations:()=>confirmations};
}
function payload(request:any){return JSON.parse(request.physicalContext.segments[0].content);}

test('checkpoint presentation follows real phases and observer failure cannot authorize extra calls',async()=>{
 const f=fixture(),messages:string[]=[];
 const preparation={signal:new AbortController().signal,onProgress:(message:string)=>{messages.push(message);throw Error('presentation observer unavailable');}};
 await produceNativePrefixCheckpoint({...f.input,preparation});
 expect(messages).toEqual(['Preparing conversation context (1/1).','Conversation context prepared.']);
 expect(f.calls).toHaveLength(1);
 await produceNativePrefixCheckpoint({...f.input,preparation});
 expect(f.calls).toHaveLength(1);
});

test('large Korean and escaped source has exact contiguous UTF8 byte coverage and bounded ordered merge',async()=>{
 const f=fixture(('한글😀\\\"\n').repeat(80_000));
 const result=JSON.parse(await produceNativePrefixCheckpoint(f.input));
 const fragments=f.calls.map(payload).filter(x=>x.mode==='fragment');
 expect(fragments.length).toBeGreaterThan(1);
 let end=0;
 for(const fragment of fragments){
  expect(fragment.startByte).toBe(end);
  expect(Buffer.byteLength(fragment.fragment,'utf8')).toBe(fragment.endByte-fragment.startByte);
  expect(fragment.fragment).not.toContain('\ufffd');end=fragment.endByte;
 }
 expect(end).toBe(Buffer.byteLength(f.source.content,'utf8'));
 expect(fragments.map(x=>x.fragment).join('')).toBe(f.source.content);
 const merges=f.calls.map(payload).filter(x=>x.mode==='merge');
 expect(merges.length).toBeGreaterThan(0);
 for(const merge of merges){
  expect(merge.startByte).toBe(merge.summaries[0].startByte);
  expect(merge.endByte).toBe(merge.summaries.at(-1).endByte);
  for(let i=1;i<merge.summaries.length;i++)expect(merge.summaries[i].startByte).toBe(merge.summaries[i-1].endByte);
 }
 expect(result.sourceDigest).toBe(f.source.digest);
 expect(result.coverage).toBe('complete-visible-prefix-before-current-native-turn');
 expect(result.evidence).toContain('lossy-summary');
 expect(result).not.toHaveProperty('compactionItemId');
 expect(f.confirmations()).toBe(2);
 const calls=f.calls.length;
 expect(await produceNativePrefixCheckpoint(f.input)).toBe(JSON.stringify(result));
 expect(f.calls).toHaveLength(calls);
 expect(f.confirmations()).toBe(4);
},30_000);

test('completed stages resume after a later ambiguous submission; uncertain stage is never resent after a new invocation',async()=>{
 const f=fixture('한글'.repeat(150_000));
 const producer=f.input.producer;
 let attempts=0;
 const failing={...f.input,producer:async (...args:Parameters<typeof producer>)=>{
  if(++attempts===2)throw Error('connection lost after possible submission');
  return producer(...args);
 }};
 await expect(produceNativePrefixCheckpoint(failing)).rejects.toBeInstanceOf(NativePrefixCheckpointInterrupted);
 expect(attempts).toBe(2);
 expect([...f.journal.records.values()].filter(x=>x.receipt)).toHaveLength(1);
 await expect(produceNativePrefixCheckpoint(failing)).rejects.toBeInstanceOf(NativePrefixCheckpointInterrupted);
 expect(attempts).toBe(2);
});

test('changed source prevents fresh or reused final return',async()=>{
 for(const cached of [false,true]){
  const f=fixture();if(cached)await produceNativePrefixCheckpoint(f.input);
  let checks=0;
  await expect(produceNativePrefixCheckpoint({...f.input,confirmSource:async()=>({
   ...f.source,digest:++checks===1?f.source.digest:'0'.repeat(64),
  })})).rejects.toThrow('source changed');
 }
 const f=fixture();
 await expect(produceNativePrefixCheckpoint({...f.input,confirmSource:async()=>({...f.source,currentTurnId:'foreign'})}))
  .rejects.toThrow('source changed');
 expect(f.calls).toHaveLength(0);
});

test('producer foreign identity and oversized output cannot be completed',async()=>{
 for(const failure of ['task','revision','oversized'] as const){
  const f=fixture();
  await expect(produceNativePrefixCheckpoint({...f.input,producer:async request=>({
   nativeTaskId:failure==='task'?'foreign':request.nativeTaskId,
   sourceRevisionId:failure==='revision'?'foreign':request.sourceRevisionId,
   content:failure==='oversized'?'한'.repeat(12_000):'summary',
  })})).rejects.toBeInstanceOf(NativePrefixCheckpointInterrupted);
  expect([...f.journal.records.values()].every(x=>!x.receipt)).toBe(true);
 }
});

test('cancellation and journal uncertainty do not grant permission to resubmit',async()=>{
 const f=fixture(),abort=new AbortController();abort.abort();
 await expect(produceNativePrefixCheckpoint({...f.input,signal:abort.signal})).rejects.toThrow();
 expect(f.journal.records.size).toBe(0);
 const g=fixture(),cancel=new AbortController();
 await expect(produceNativePrefixCheckpoint({...g.input,signal:cancel.signal,producer:async request=>{
  cancel.abort();return {nativeTaskId:request.nativeTaskId,sourceRevisionId:request.sourceRevisionId,content:'completed summary'};
 }})).rejects.toThrow();
 expect([...g.journal.records.values()][0]?.receipt?.summary).toBe('completed summary');
 const calls=g.calls.length;
 await produceNativePrefixCheckpoint(g.input);
 expect(g.calls).toHaveLength(calls);
 const unknown=fixture();
 await expect(produceNativePrefixCheckpoint({...unknown.input,journal:{
  claim:async()=>({status:'unknown'}),complete:async()=>{throw Error('unreachable');},
 }})).rejects.toBeInstanceOf(NativePrefixCheckpointInterrupted);
 expect(unknown.calls).toHaveLength(0);
});

test('inline media and insufficient finite call budgets are explicit failures before producer calls',async()=>{
 const f=fixture();
 await expect(produceNativePrefixCheckpoint({...f.input,source:{...f.source,inlineAssets:[{} as any]}})).rejects.toThrow('inline media');
 expect(f.calls).toHaveLength(0);
 const large=fixture('x'.repeat(1_400_000));
 await expect(produceNativePrefixCheckpoint({...large.input,maxModelStages:1})).rejects.toThrow('stage budget');
 expect(large.calls).toHaveLength(0);
 expect(large.journal.records.size).toBe(0);
});

test('journal receipt binding is strict and account namespaces cannot reuse submitted stages',async()=>{
 const f=fixture();await produceNativePrefixCheckpoint(f.input);
 const first=f.calls.length;
 await produceNativePrefixCheckpoint({...f.input,accountNamespace:'different-account'});
 expect(f.calls.length).toBeGreaterThan(first);
 const other=fixture();
 await expect(produceNativePrefixCheckpoint({...other.input,journal:{claim:async identity=>({
  ...identity,status:'completed',sourceDigest:'0'.repeat(64),summary:'foreign summary',
 }),complete:async()=>{throw Error('unreachable');}}})).rejects.toThrow('foreign or invalid receipt');
 expect(other.calls).toHaveLength(0);
});

test('large escaped summaries require bounded multi-level hierarchical merges with strict coverage reduction',async()=>{
 const f=fixture('x'.repeat(1_400_000));
 const producer=f.input.producer;
 const result=await produceNativePrefixCheckpoint({...f.input,producer:async request=>{
  await producer(request);
  return {nativeTaskId:request.nativeTaskId,sourceRevisionId:request.sourceRevisionId,content:'"'.repeat(16*1024)};
 }});
 const stages=f.calls.map(payload),merges=stages.filter(x=>x.mode==='merge');
 expect(merges.length).toBeGreaterThan(1);
 expect(merges.at(-1).startByte).toBe(0);
 expect(merges.at(-1).endByte).toBe(Buffer.byteLength(f.source.content,'utf8'));
 expect(JSON.parse(result).summary.length).toBe(16*1024);
},30_000);

test('failed journal completion remains explicitly uncertain and never authorizes replay',async()=>{
 const f=fixture();
 await expect(produceNativePrefixCheckpoint({...f.input,journal:{
  claim:identity=>f.journal.claim(identity),complete:async()=>{throw Error('durable write failure');},
 }})).rejects.toBeInstanceOf(NativePrefixCheckpointInterrupted);
 expect(f.calls).toHaveLength(1);
 await expect(produceNativePrefixCheckpoint(f.input)).rejects.toBeInstanceOf(NativePrefixCheckpointInterrupted);
 expect(f.calls).toHaveLength(1);
});
