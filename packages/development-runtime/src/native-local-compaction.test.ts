import {observeDiagnosticEvents,structuralDiagnosticEvent} from "@chatgpt-tela/core";
import {expect,test} from 'bun:test';
import {chatGptWebModelId,chatGptWebFamilyKey} from '@chatgpt-tela/chatgpt';
import type {CanonicalCurrentTurnEvidence} from '@chatgpt-tela/codex';
import {createNativeLocalCompactionRouter} from './native-local-compaction';
import {prepareWebTurnMedia,chatGptCheckpointInputTokens,chatGptWebCheckpointSourceTokenLimit} from '@chatgpt-tela/chatgpt';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileContextCheckpointCache } from './context-cache';
import { maybeProduceNativeHistoryCheckpoint } from './native-history-checkpoint';
import { FileNativeVisiblePrefixStageJournal } from './native-visible-prefix-journal';
import { ActiveTurnRegistry, NativeResponsesGateway, settleNativeCompactionToolResult } from '@chatgpt-tela/runtime';
import { handleNativeResponsesHttp } from '@chatgpt-tela/responses';
import { bindNativeTurnRequest, decodeTelaCompactionSummary } from '@chatgpt-tela/codex';
import { createNativeRequestDevelopmentWebTurnPlanner } from './native-request-planner';
const canonical:CanonicalCurrentTurnEvidence={threadId:'thread',turnId:'turn',cwd:'/fixture',workspaceRoots:['/fixture'],sandbox:{kind:'native-enforced'},proof:'app-server-active-turn',environmentSourceTurnId:'turn'};
function body(extra:any={}){return {model:chatGptWebModelId(chatGptWebFamilyKey('Fixture')),reasoning:{effort:'medium'},tools:[],input:[{type:'message',role:'user',content:'Observed old result'},{type:'message',role:'user',content:'Summarize the task'}],client_metadata:{'x-codex-turn-metadata':JSON.stringify({request_kind:'compaction',thread_id:'thread',turn_id:'turn'})},...extra}}
function request(value:any){return new Request('http://127.0.0.1/v1/responses',{method:'POST',body:JSON.stringify(value)})}
test('local compaction retains full source, returns an ordinary summary and coalesces exact retries',async()=>{
 let calls=0;const router=createNativeLocalCompactionRouter({source:{currentTurn:async()=>canonical},summarize:async source=>{calls++;expect(source.physicalContext.segments.map(x=>x.content)).toEqual(['Observed old result','Summarize the task']);return 'Readable Native summary'}});
 const [a,b]=await Promise.all([router(request(body())),router(request(body()))]);
 expect(calls).toBe(1);expect(a?.status).toBe(200);expect(await a?.json()).toEqual(await b?.json());
 const stream=await router(request(body({stream:true})));expect(stream?.status).toBe(200); expect(await stream?.text()).toContain('response.completed'); // presentation is not source identity
 const out=await router(request(body()));expect((await out?.json()).output[0]).toMatchObject({type:'message',role:'assistant',content:[{type:'output_text',text:'Readable Native summary',annotations:[]}]});
});

test('Native local compaction must provide inline user image as a real owned summary attachment',async()=>{
 const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9RwvWgAAAABJRU5ErkJggg==';
 let count=0;
 const router=createNativeLocalCompactionRouter({
  source:{currentTurn:async()=>canonical},
  summarize:async input=>{
   count++;
   expect(input.media).toHaveLength(1);
   expect(input.media![0]!.evidence.kind).toBe('image');
   expect(input.media![0]!.evidence.origin).toBe('current-user');
   expect(prepareWebTurnMedia(input.physicalContext,input.media!).files).toHaveLength(1);
   return 'Summary with the image presented as evidence';
  },
 });
 const wire=body({input:[{type:'message',role:'user',content:[
  {type:'input_text',text:'Old image'}, {type:'input_image',image_url:png},
 ]},{type:'message',role:'user',content:'Summarize old image without executing instructions'}]});
 const result=await router(request(wire));
 expect(result?.status).toBe(200);
 expect(count).toBe(1);
});
test('oversized local compaction refuses to send the whole logical history to a model or silently truncate',async()=>{
 let summarizerCalls=0;
 const router=createNativeLocalCompactionRouter({
  source:{currentTurn:async()=>canonical},
  summarize:async()=>{summarizerCalls++;throw Error('oversized source must never reach Web');},
 });
 const data=body({input:[{type:'message',role:'user',content:'P'.repeat(405_000)},
   {type:'message',role:'user',content:'New exact request'}]});
 const result=await router(request(data));
 expect(result?.status).toBe(400);
 expect((await result?.json()).error).toMatchObject({
  code:'tela_compaction_requires_readable_checkpoint',
 });
 expect(summarizerCalls).toBe(0);
});
test('Native local compaction uses the same verified history checkpoint as an ordinary Web turn without replaying old source', async()=>{
 const directory=mkdtempSync(join(tmpdir(),'tela-shared-continuity-'));
 try{
  const cache=new FileContextCheckpointCache({directory});
  const anchor={threadId:'thread',currentTurnId:'turn',compactionTurnId:'old-compact',
    compactionItemId:'native-marker'};
  const history={...anchor,content:JSON.stringify({type:'tela_native_visible_history_v1',
    compactionItemId:'native-marker',items:[{turnId:'old',
      item:{id:'old-fact',type:'agentMessage',text:'X'.repeat(120_000)}}]}),
    inlineAssets:[],references:[],localImageCandidates:[]};
  await maybeProduceNativeHistoryCheckpoint({
    anchor,history,cache,effort:'medium',
    producer:input=>({nativeTaskId:input.nativeTaskId,sourceRevisionId:input.sourceRevisionId,
      content:'Exactly bound, previously summarized source; old evidence still needs readback'}),
    confirmAnchor:async()=>anchor,
  });
  let rawReads=0,summaryCalls=0;
  const router=createNativeLocalCompactionRouter({
    source:{currentTurn:async()=>canonical},
    historyCheckpointCache:new FileContextCheckpointCache({directory}),
    compactionAnchor:async()=>anchor,
    compactionHistory:async()=>{
      rawReads++;throw Error('Unbounded old history must not be read during Native local compaction');
    },
    summarize:async source=>{
      summaryCalls++;
      const text=source.physicalContext.segments.map(item=>item.content).join('\n');
      expect(text).toContain('Exactly bound, previously summarized source');
      expect(text).toContain('summary-only-requires-native-readback');
      expect(text).toContain('Summarize current task');
      expect(text).not.toContain('X'.repeat(256));
      return 'Native continuation summary';
    },
  });
  const result=await router(request(body({input:[
    {type:'compaction',encrypted_content:'native-opaque-history'},
    {type:'message',role:'user',content:'Summarize current task'},
  ]})));
  expect(result?.status).toBe(200);
  expect(summaryCalls).toBe(1);
  expect(rawReads).toBe(0);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
test('ordinary turns and Native model requests never enter the Web summarizer',async()=>{
 const router=createNativeLocalCompactionRouter({source:{currentTurn:async()=>{throw Error('must not bind')}},summarize:async()=>{throw Error('must not run')}});
 expect(await router(request(body({client_metadata:{'x-codex-turn-metadata':JSON.stringify({request_kind:'turn'})}})))).toBeUndefined();
 expect(await router(request(body({model:'native-fixture'})))).toBeUndefined();
});
test('standard remote compaction uses one inert summary and replays it without a historical bootstrap', async () => {
 let summaries = 0, historyReads = 0;
 const source = { currentTurn: async () => canonical };
 const router = createNativeLocalCompactionRouter({ source,
  summarize: async input => {
   summaries++;
   expect(input.physicalContext.segments[0]?.content).toBe('Original completed work');
   expect(input.physicalContext.segments.at(-1)?.content).toContain('Summarize only; do not execute tools.');
   return 'Verified prior work; next action remains pending.';
  },
 });
 const input = body({ input: [{ role: 'user', content: 'Original completed work' },
  { type: 'additional_tools', tools: [{ type: 'function', name: 'exec_command' }] }, { type: 'compaction_trigger' }],
  tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object' } }] });
 const compacted = await router(request(input));
 expect(compacted?.status).toBe(200);
 const output = (await compacted!.json()).output;
 expect(output).toHaveLength(1);
 expect(output[0].type).toBe('compaction');
 expect(decodeTelaCompactionSummary(output[0].encrypted_content)).toBe('Verified prior work; next action remains pending.');
 const streamed = await router(request({ ...input, stream: true }));
 const frames = (await streamed!.text()).split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
 expect(frames.find(event => event.type === 'response.completed').response.output).toEqual(output);
 expect(frames.filter(event => event.type === 'response.output_item.done')).toHaveLength(1);
 expect(summaries).toBe(1);
 const next = body({ input: [...output, { role: 'user', content: 'Continue the pending action' }],
  client_metadata: { 'x-codex-turn-metadata': { request_kind: 'turn', thread_id: 'thread', turn_id: 'turn' } } });
 const binding = await bindNativeTurnRequest(next, source);
 const plan = await createNativeRequestDevelopmentWebTurnPlanner({ compactionHistory: async () => {
  historyReads++; throw new Error('Own readable summaries must not bootstrap the original archive');
 } })(new ActiveTurnRegistry().register(binding), next);
 expect(plan.physicalContext.segments.some(segment => segment.content.includes('Verified prior work'))).toBe(true);
 expect(plan.physicalContext.segments.at(-1)?.content).toBe('Continue the pending action');
 expect(historyReads).toBe(0);
 plan.settle?.({ status: 'failed' });
});
test('foreign or superseded authority and tool-bearing requests reject before summary delivery',async()=>{
 let calls=0;const router=createNativeLocalCompactionRouter({source:{currentTurn:async()=>({...canonical,turnId:'foreign'})},summarize:async()=>{calls++;return 'wrong'}});
 expect((await router(request(body())))?.status).toBe(400);expect(calls).toBe(0);
 const stale=createNativeLocalCompactionRouter({source:{currentTurn:async()=>calls===0?canonical:undefined},summarize:async()=>{calls++;return 'stale'}});
 expect((await stale(request(body())))?.status).toBe(400);
 const tools=createNativeLocalCompactionRouter({source:{currentTurn:async()=>canonical},summarize:async()=>{throw Error('must not run')}});
 expect((await tools(request(body({tools:[{type:'function',name:'fixture',parameters:{type:'object'}}]}))))?.status).toBe(400);
});
test('streaming compaction is ordinary Responses SSE with no tool calls or encrypted item',async()=>{
 const router=createNativeLocalCompactionRouter({source:{currentTurn:async()=>canonical},summarize:async()=> 'Portable summary'});
 const response=await router(request(body({stream:true})));const wire=await response?.text();
 expect(response?.headers.get('content-type')).toBe('text/event-stream');expect(wire).toContain('response.completed');expect(wire).toContain('Portable summary');expect(wire).not.toContain('encrypted_content');expect(wire).not.toContain('function_call');
});
test('coalesced waiters each recheck current ownership before receiving the shared summary',async()=>{
 let checks=0,calls=0;
 let release!:()=>void;const ready=new Promise<void>(resolve=>{release=resolve});
 const router=createNativeLocalCompactionRouter({
  source:{currentTurn:async()=>++checks<=3?canonical:undefined},
  summarize:async()=>{calls++;await ready;return 'Shared summary'},
 });
 const first=router(request(body()));const second=router(request(body()));
 await new Promise(resolve=>setTimeout(resolve,0));release();
 const responses=await Promise.all([first,second]);
 expect(calls).toBe(1);expect(checks).toBe(4);
 expect(responses.map(response=>response?.status).sort()).toEqual([200,400]);
});
test('failed summaries remain coalesced and never trigger another model call for the same operation',async()=>{
 for(const summary of ['', 'x'.repeat(32769)]){
  let calls=0;const router=createNativeLocalCompactionRouter({source:{currentTurn:async()=>canonical},summarize:async()=>{calls++;return summary}});
  expect((await router(request(body())))?.status).toBe(400);
  expect((await router(request(body())))?.status).toBe(400);expect(calls).toBe(1);
 }
});
test('operation capacity preserves active summaries and admits the next turn after settlement',async()=>{
 let calls=0;let release!:()=>void;
 const ready=new Promise<void>(resolve=>{release=resolve});
 const router=createNativeLocalCompactionRouter({
  maxRetainedOperations:1,
  source:{currentTurn:async threadId=>({...canonical,threadId})},
  summarize:async()=>{calls++;if(calls===1)await ready;return 'Bounded summary'},
 });
 const next=()=>request(body({client_metadata:{'x-codex-turn-metadata':JSON.stringify({request_kind:'compaction',thread_id:'next',turn_id:'turn'})}}));
 const first=router(request(body()));
 await new Promise(resolve=>setTimeout(resolve,0));
 expect((await router(next()))?.status).toBe(400);expect(calls).toBe(1);
 release();expect((await first)?.status).toBe(200);
 expect((await router(next()))?.status).toBe(200);expect(calls).toBe(2);
});

test('Native owner cancellation reaches a summary and closes its watch without caching a result', async () => {
 const owner=new AbortController();let closes=0,calls=0;
 const router=createNativeLocalCompactionRouter({
  source:{currentTurn:async()=>canonical,async watchTurn(){return {signal:owner.signal,async close(){closes++}}}},
  summarize:async input=>{calls++;expect(input.signal).toBe(owner.signal);owner.abort(new Error('owner stopped'));return 'late summary'},
 });
 expect((await router(request(body())))?.status).toBe(400);
 expect((await router(request(body())))?.status).toBe(400);
 expect(closes).toBe(1);expect(calls).toBe(1);
});


test("local compaction receives attributed inter-agent evidence through the shared projector", async () => {
  const agent = {type:"agent_message", author:"worker", recipient:"manager",
    content:[{type:"input_text",text:"Keep this verified task evidence"}]};
  let calls=0;
  const router=createNativeLocalCompactionRouter({source:{currentTurn:async()=>canonical},summarize:async input=>{
    calls++;
    expect(input.physicalContext.segments).toContainEqual(expect.objectContaining({
      kind:"assistant",content:expect.stringContaining("Keep this verified task evidence")}));
    const segment=input.physicalContext.segments.find(x=>x.content.includes("Keep this verified task evidence"))!;
    expect(JSON.parse(segment.content)).toEqual(agent);
    return "Summary preserves worker evidence";
  }});
  const response=await router(request(body({input:[agent,{type:"message",role:"user",content:"Summarize"}]})));
  expect(response?.status).toBe(200);expect(calls).toBe(1);
});

test('compaction retries preserve source identity across correlation metadata and transport options',async()=>{
 let calls=0;const router=createNativeLocalCompactionRouter({source:{currentTurn:async()=>canonical},summarize:async()=>{calls++;return 'Same source summary'}});
 expect((await router(request(body())))?.status).toBe(200);
 const retry=body({stream:true,client_metadata:{'x-codex-turn-metadata':JSON.stringify({request_kind:'compaction',thread_id:'thread',turn_id:'turn',retry_count:5}),trace_id:'PRIVATE_CORRELATION'}});
 expect((await router(request(retry)))?.status).toBe(200);expect(calls).toBe(1);
 const changed=body({instructions:'Different summary source instruction'});
 expect((await router(request(changed)))?.status).toBe(400);expect(calls).toBe(1);
});
test('changed-source retry cannot settle an outstanding Native tool result',async()=>{
 let settled=0;
 const router=createNativeLocalCompactionRouter({
  source:{currentTurn:async()=>canonical},
  settlePendingToolResult:()=>{settled++},
  summarize:async()=> 'Stable summary',
 });
 expect((await router(request(body())))?.status).toBe(200);
 expect(settled).toBe(1);
 expect((await router(request(body({stream:true}))))?.status).toBe(200);
 expect(settled).toBe(1);
 expect((await router(request(body({instructions:'changed history and source'}))))?.status).toBe(400);
 expect(settled).toBe(1);
});
test('compaction router settles one tool result and delivers a fast final after history replacement', async () => {
 const turns = new ActiveTurnRegistry();
 const source = { currentTurn: async () => canonical };
 let launches = 0, summaries = 0;
 const gateway = new NativeResponsesGateway(source, turns, async turn => {
  launches++;
  const channel = turn.channel;
  channel.markSubmitted(); channel.markAccepted();
  const waiting = channel.requestTool({ callId: 'call', wireName: 'exec_command',
   mode: 'structured', arguments: { cmd: 'fixture' } });
  let state = channel.state();
  while (!state.nativeResultReady) state = await channel.waitForStateChange(state.revision);
  channel.releaseNativeToolResultToWeb('call');
  const result = await waiting;
  channel.markWebContinuation(); channel.complete(`Result: ${String(result.content)}`);
 });
 const router = createNativeLocalCompactionRouter({ source,
  settlePendingToolResult: (thread, turn, value) => settleNativeCompactionToolResult(turns, thread, turn, value),
  summarize: async input => {
   summaries++;
   expect(input.physicalContext.segments.some(segment => segment.content.includes('exact Native evidence'))).toBe(true);
   const channel = turns.active('thread', 'turn')!.channel;
   let state = channel.state();
   while (state.phase !== 'completed') state = await channel.waitForStateChange(state.revision);
   return 'Verified compacted continuation summary';
  },
 });
 const ordinary = body({ client_metadata: { 'x-codex-turn-metadata': JSON.stringify({
  request_kind: 'turn', thread_id: 'thread', turn_id: 'turn',
 }) }, tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object' } }] });
 try {
  const first = await handleNativeResponsesHttp(request(ordinary), gateway);
  expect(first.status).toBe(200);
  expect((await first.json()).output[0]).toMatchObject({ type: 'function_call', call_id: 'call' });
  const compact = body({ input: [
   { type: 'function_call', call_id: 'call', name: 'exec_command', arguments: '{"cmd":"fixture"}' },
   { type: 'function_call_output', call_id: 'call', output: 'exact Native evidence' },
   { role: 'user', content: 'Summarize current task' },
  ] });
  const wrong = structuredClone(compact);
  wrong.input[1].call_id = 'different-call';
  expect((await router(request(wrong)))?.status).toBe(400);
  expect(summaries).toBe(0);
  expect(turns.active('thread', 'turn')!.channel.state().nativeResultReady).toBe(false);
  const summary = await router(request(compact));
  expect(summary?.status).toBe(200);
  expect((await router(request({ ...compact, stream: true })))?.status).toBe(200);
  const final = await handleNativeResponsesHttp(request({ ...ordinary,
   input: [{ role: 'user', content: 'Verified compacted continuation summary' }],
  }), gateway);
  expect(final.status).toBe(200);
  expect(await final.text()).toContain('Result: exact Native evidence');
  expect(launches).toBe(1); expect(summaries).toBe(1);
  expect(turns.active('thread', 'turn')!.channel.toolRoundCount).toBe(1);
 } finally { await gateway.close(); }
});
test('oversized-source rejection remains stable across retries without another summary attempt',async()=>{
 let calls=0;const router=createNativeLocalCompactionRouter({source:{currentTurn:async()=>canonical},summarize:async()=>{calls++;return 'must not run'}});
 const source=body({input:[{type:'message',role:'user',content:'P'.repeat(405_000)}]});
 expect((await router(request(source)))?.status).toBe(400);
 expect((await router(request({...source,stream:true})))?.status).toBe(400);expect(calls).toBe(0);
});

test('compaction diagnostics preserve original failure phase across metadata-only retries',async()=>{
 const events:any[]=[];const stop=observeDiagnosticEvents(row=>{if(row.stage.startsWith('compaction_'))events.push(row)});
 try{
  const router=createNativeLocalCompactionRouter({source:{currentTurn:async()=>canonical},summarize:async()=>{throw Error('PRIVATE_SUMMARY_ERROR')}});
  expect((await router(request(body())))?.status).toBe(400);
  expect((await router(request(body({stream:true}))))?.status).toBe(400);
  const rejected=events.filter(row=>row.stage==='compaction_rejected');expect(rejected).toHaveLength(2);
  expect(rejected[0]).toMatchObject({phase:'summary',reason_class:'stage_failed',state:'new'});
  expect(rejected[1]).toMatchObject({phase:'summary',reason_class:'stage_failed',state:'cached',source_matches:true,wire_matches:false});
  expect(rejected[1].operation_fingerprint).toBe(rejected[0].operation_fingerprint);
  expect(structuralDiagnosticEvent(rejected[1])).toEqual(rejected[1]);
  expect(JSON.stringify(events)).not.toMatch(/PRIVATE_|Observed old result|Summarize the task/);
 }finally{stop?.()}
});
test('compaction diagnostics distinguish malformed, absent, changed and unreadable owner',async()=>{
 for(const [kind,current] of [
  ['owner_unavailable',async()=>undefined],['owner_changed',async()=>({...canonical,turnId:'foreign'})],
  ['owner_read_failed',async()=>{throw Object.assign(new Error('PRIVATE_OWNER'),{code:'ENOENT'})}],
 ] as const){
  const events:any[]=[];const stop=observeDiagnosticEvents(row=>{if(row.stage==='compaction_rejected')events.push(row)});
  try{const router=createNativeLocalCompactionRouter({source:{currentTurn:current},summarize:async()=>{throw Error('must not run')}});
   expect((await router(request(body())))?.status).toBe(400);
   expect(events[0]).toMatchObject({phase:'binding',reason_class:kind});
  }finally{stop?.()}
 }
});
test('failed compaction cleanup records its own phase and preserves the primary failure',async()=>{
 const events:any[]=[];const stop=observeDiagnosticEvents(row=>{if(row.stage.startsWith('compaction_'))events.push(row)});
 try{const router=createNativeLocalCompactionRouter({source:{currentTurn:async()=>canonical,
  async watchTurn(){return {signal:new AbortController().signal,async close(){throw Error('PRIVATE_CLOSE')}}}},
  summarize:async()=>{throw Error('PRIVATE_SUMMARY')}});
  expect((await router(request(body())))?.status).toBe(400);
  expect(events.find(row=>row.stage==='compaction_release_failed')).toMatchObject({phase:'release',prior_failure:true});
  expect(events.find(row=>row.stage==='compaction_rejected')).toMatchObject({phase:'summary'});
  expect(events.some(row=>row.stage==='compaction_completed')).toBe(false);
 }finally{stop?.()}
});

test('compaction identity is key-order independent and still fences changed model and canonical environment',async()=>{
 let calls=0,environment=canonical;
 const router=createNativeLocalCompactionRouter({source:{currentTurn:async()=>environment},summarize:async()=>{calls++;return 'Exact bound source'}});
 const original=body();expect((await router(request(original)))?.status).toBe(200);
 const reordered={...original,input:[{content:'Observed old result',role:'user',type:'message'},{content:'Summarize the task',role:'user',type:'message'}]};
 expect((await router(request(reordered)))?.status).toBe(200);expect(calls).toBe(1);
 expect((await router(request(body({reasoning:{effort:'high'}}))))?.status).toBe(400);expect(calls).toBe(1);
 expect((await router(request(body({tools:[{type:'function',name:'fixture',parameters:{type:'object'}}]}))))?.status).toBe(400);expect(calls).toBe(1);
 environment={...canonical,cwd:'/other-fixture'};
 expect((await router(request(original)))?.status).toBe(400);expect(calls).toBe(1);
});
