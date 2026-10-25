import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDiagnosticTail } from "@chatgpt-tela/core";
import type { NativeRequestPrefixSnapshot } from "./native-visible-prefix-checkpoint";
import { chatGptCheckpointInputTokens, chatGptWebCheckpointSourceTokenLimit } from "@chatgpt-tela/chatgpt";
import {
 produceNativePrefixCheckpoint, NativePrefixCheckpointInterrupted,
 type NativeVisiblePrefixStageIdentity, type NativeVisiblePrefixStageReceipt,
 type NativeVisiblePrefixStageJournal, type NativePrefixCheckpointInput,
} from "./native-visible-prefix-checkpoint";

class Journal implements NativeVisiblePrefixStageJournal {
 async completedReceipts() { return [...this.records.values()].flatMap(record => record.receipt ? [record.receipt] : []); }
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
 const content=JSON.stringify({type:'tela_native_request_prefix_v1',items:[{type:'revision',kind:'assistant',revisionId:'old',content:text}]});
 const source:NativeRequestPrefixSnapshot={kind:'native-request-prefix',threadId:'thread',currentTurnId:'current',
  contentDigest: createHash('sha256').update(content).digest('hex'), digest:createHash('sha256').update(content).digest('hex'),sourceItemCount:1,content,
  inlineAssets:[],references:[],localImageCandidates:[]};
 const calls:any[]=[];
 const journal=new Journal();
 let confirmations=0;
 const input:NativePrefixCheckpointInput={preparationPolicy:{maxModelCalls:128,maxInputTokens:20_000_000,maxElapsedMs:600_000},source,accountNamespace:'account-fixture',journal,effort:'medium',
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
 expect(messages).toEqual(['Preparing conversation context.','Conversation context prepared.']);
 expect(f.calls).toHaveLength(1);
 await produceNativePrefixCheckpoint({...f.input,preparation});
 expect(f.calls).toHaveLength(1);
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
  completedReceipts:()=>unknown.journal.completedReceipts(),claim:async()=>({status:'unknown'}),complete:async()=>{throw Error('unreachable');},
 }})).rejects.toBeInstanceOf(NativePrefixCheckpointInterrupted);
 expect(unknown.calls).toHaveLength(0);
});

test('inline media and insufficient finite call budgets are explicit failures before producer calls',async()=>{
 const f=fixture();
 await expect(produceNativePrefixCheckpoint({...f.input,source:{...f.source,inlineAssets:[{} as any]}})).rejects.toThrow('inline media');
 expect(f.calls).toHaveLength(0);
 const large=fixture('x'.repeat(1_400_000));
 await expect(produceNativePrefixCheckpoint({...large.input,preparationPolicy:{maxModelCalls:1,maxInputTokens:1_000_000,maxElapsedMs:600_000}})).rejects.toMatchObject({recoveryReason:'source_budget'});
 expect(large.calls).toHaveLength(0);
 expect(large.journal.records.size).toBe(0);
});

test('journal receipt binding is strict and account namespaces cannot reuse submitted stages',async()=>{
 const f=fixture();await produceNativePrefixCheckpoint(f.input);
 const first=f.calls.length;
 await produceNativePrefixCheckpoint({...f.input,accountNamespace:'different-account'});
 expect(f.calls.length).toBeGreaterThan(first);
 const other=fixture();
 await expect(produceNativePrefixCheckpoint({...other.input,journal:{completedReceipts:async()=>[],claim:async identity=>({
  ...identity,status:'completed',sourceDigest:'0'.repeat(64),summary:'foreign summary',
 }),complete:async()=>{throw Error('unreachable');}}})).rejects.toThrow('foreign or invalid receipt');
 expect(other.calls).toHaveLength(0);
});

test('failed journal completion remains explicitly uncertain and never authorizes replay',async()=>{
 const f=fixture();
 await expect(produceNativePrefixCheckpoint({...f.input,journal:{
  completedReceipts:()=>f.journal.completedReceipts(),claim:identity=>f.journal.claim(identity),complete:async()=>{throw Error('durable write failure');},
 }})).rejects.toBeInstanceOf(NativePrefixCheckpointInterrupted);
 expect(f.calls).toHaveLength(1);
 await expect(produceNativePrefixCheckpoint(f.input)).rejects.toBeInstanceOf(NativePrefixCheckpointInterrupted);
 expect(f.calls).toHaveLength(1);
});

test('preflight rejects costly cold preparation without claiming or sending; exact warm reuse costs zero',async()=>{
 const f=fixture('x'.repeat(9_000));
 const zero={maxModelCalls:0,maxInputTokens:0,maxElapsedMs:0};
 await expect(produceNativePrefixCheckpoint({...f.input,preparationPolicy:zero}))
  .rejects.toMatchObject({recoveryReason:'source_budget',budgetReason:'model_calls'});
 expect(f.journal.records.size).toBe(0);expect(f.calls).toHaveLength(0);
 const result=await produceNativePrefixCheckpoint(f.input);const calls=f.calls.length;
 expect(calls).toBe(1);
 expect(await produceNativePrefixCheckpoint({...f.input,preparationPolicy:zero})).toBe(result);
 expect(f.calls).toHaveLength(calls);
});
test('default preparation policy refuses oversized cold work instead of launching a long stage chain',async()=>{
 const f=fixture('x'.repeat(2_000_000));
 const {preparationPolicy:_,...productionDefaults}=f.input;
 await expect(produceNativePrefixCheckpoint(productionDefaults)).rejects.toMatchObject({recoveryReason:'source_budget'});
 expect(f.calls).toHaveLength(0);expect(f.journal.records.size).toBe(0);
});

test('escaped Korean source is embedded once in one complete snapshot and reused without another call', async()=>{
 const f=fixture(('한글😀\\\"\n').repeat(1000));
 const result=JSON.parse(await produceNativePrefixCheckpoint(f.input));
 expect(f.calls).toHaveLength(1);
 expect(payload(f.calls[0])).toMatchObject({mode:'snapshot',source:JSON.parse(f.source.content)});
 expect(result.summary).toBe('Bounded source-specific derived summary.');
 expect(result.sourceBytes).toBe(Buffer.byteLength(f.source.content));
 await produceNativePrefixCheckpoint({...f.input, preparationPolicy:{maxModelCalls:0,maxInputTokens:0,maxElapsedMs:0}});
 expect(f.calls).toHaveLength(1);
});

test('oversized source diagnostic fields persist through privacy and file readback', async()=>{
 const root=mkdtempSync(join(tmpdir(),'checkpoint-diagnostic-'));
 const before=process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
 try {
  process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=join(root,'events.jsonl');
  const items=[{type:'checkpoint',content:'prior'}, {type:'revision',kind:'developer',content:'directive'}, {type:'revision',kind:'user',content:'x'.repeat(500_000)}];
  const content=JSON.stringify({type:'tela_native_request_prefix_v1',items});
  const digest=createHash('sha256').update(content).digest('hex');
  const f=fixture();
  await expect(produceNativePrefixCheckpoint({...f.input,source:{...f.source,kind:'native-request-prefix',content,contentDigest:digest,digest,sourceItemCount:3},confirmSource:async()=>({threadId:f.source.threadId,currentTurnId:f.source.currentTurnId,digest})})).rejects.toMatchObject({recoveryReason:'source_budget'});
  expect(f.calls).toHaveLength(0);
  expect(readDiagnosticTail(process.env.CHATGPT_TELA_DIAGNOSTIC_FILE).events.find(e=>e.stage==='native_context_source_rejected')).toMatchObject({
   instruction_item_count:1,instruction_bytes:Buffer.byteLength(JSON.stringify(items[1])),
   checkpoint_item_count:1,checkpoint_bytes:Buffer.byteLength(JSON.stringify(items[0])),
   largest_item_bytes:Buffer.byteLength(JSON.stringify(items[2])),entry_class:'revision',request_role:'user',
  });
 } finally {
  if(before===undefined)delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=before;
  rmSync(root,{recursive:true,force:true});
 }
});
