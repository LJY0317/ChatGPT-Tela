import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { expect, test } from 'bun:test';
import {mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type { BrowserSurfaceLease } from '@chatgpt-tela/browser-host';
import type { WebContextCheckpointRequest, WebTurnRequest, WebContextAttachmentPreloadRequest } from './index';
import { ChatGptContextCheckpointProvider, chatGptCheckpointInputTokens } from './checkpoint-provider';
import { serializeChatGptContextAttachment } from './context-attachment';
import { decodeNativeInlineEvidence, nativeEvidenceRef, setPrivateDiagnosticCapture, withDiagnosticContext } from '@chatgpt-tela/core';
import { webEvidenceFilename } from './turn-media';
import { formatWebPhysicalContext } from './semantic-provider';
import { assistantMarkdown } from './answer-markdown';

const surface = {} as BrowserSurfaceLease;
const source: WebContextCheckpointRequest = {
  nativeTaskId:'task', webEpochId:'checkpoint-epoch', sourceRevisionId:'r2',
  physicalContext:{ mode:'full', headRevisionId:'r2', logicalTokens:20, transferTokens:20,
    segments:[{type:'revision',revisionId:'r1',kind:'user',content:'Keep identifier abc; do not edit.'},
      {type:'revision',revisionId:'r2',kind:'assistant',content:'Observed result; next action remains pending.'}] },
};

test.each(['submitting', 'accepted', 'completed'] as const)('checkpoint failure preserves the observed operation phase without resending: %s', async phase => {
  const root = mkdtempSync(join(tmpdir(), 'tela-checkpoint-phase-'));
  const file = join(root, 'events.jsonl'), prior = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = file;
  let submissions = 0;
  const provider = new ChatGptContextCheckpointProvider(() => ({
    async observeCapabilities() { return {state: 'proven', value: {observed: new Set(['composer'])}, evidence: []}; },
    async submitTurn(_surface, request) {
      submissions++;
      if (phase === 'submitting') throw Error('private submission detail');
      return {state: 'proven', value: {nativeTaskId: request.nativeTaskId, nativeTurnId: request.nativeTurnId,
        webEpochId: request.webEpochId, providerTurnId: 'synthetic-operation'}, evidence: []};
    },
    async waitForTurnEvent(_surface, handle) {
      if (phase === 'accepted') throw Error('private observation detail');
      return {state: 'proven', value: {kind: 'completed', providerTurnId: handle.providerTurnId,
        answer: 'private response', plainAnswer: '{}'}, evidence: []};
    },
  }));
  try {
    await expect(provider.createContextCheckpoint(surface, source)).rejects.toThrow();
    expect(submissions).toBe(1);
    const rows = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows.find(row => row.stage === 'checkpoint_operation_failed')).toMatchObject({
      phase, submission_accepted: phase !== 'submitting', completion_observed: phase === 'completed',
      reason_class: phase === 'completed' ? 'envelope_invalid' : 'provider_error',
    });
    expect(JSON.stringify(rows)).not.toContain('private');
    expect(JSON.stringify(rows)).not.toContain('synthetic-operation');
  } finally {
    if (prior === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = prior;
    rmSync(root, {recursive: true, force: true});
  }
});
function presentation(plain: string): string {
  class Element {
    readonly childNodes = [{nodeType:3,textContent:plain}];
  }
  return runInNewContext(`(${assistantMarkdown.toString()})(root)`, {root:new Element(),HTMLElement:Element});
}
function fixture(change: (value: any) => any = value => value,
  complete: (value: {answer:string;plainAnswer:string}) => {answer:string;plainAnswer?:string} = value => value) {
  let submitted: WebTurnRequest | undefined;
  let preloads = 0;
  let submits = 0;
  const provider = new ChatGptContextCheckpointProvider(() => ({
    async observeCapabilities() { return {state:'proven',value:{observed:new Set(['composer'])},evidence:[]}; },
    async preloadContextAttachment(_surface: BrowserSurfaceLease,
      request: WebContextAttachmentPreloadRequest) {
      preloads++;
      return {state:'proven',value:{nativeTaskId:request.nativeTaskId,webEpochId:request.webEpochId,
        attachmentName:request.attachment.name,attachmentSha256:request.attachment.sha256,providerOperationId:'preload'},evidence:[]};
    },
    async submitTurn(_surface, request) {
      submits++; submitted = request;
      return {state:'proven',value:{nativeTaskId:request.nativeTaskId,nativeTurnId:request.nativeTurnId,
        webEpochId:request.webEpochId,providerTurnId:'accepted-op'},evidence:[]};
    },
    async waitForTurnEvent(_surface, handle) {
      const data = submitted!.inertSourceAttachment?.attachment.contextJson ?? submitted!.physicalContext.segments[1]!.content;
      const plainAnswer = JSON.stringify(change({type:'tela_context_checkpoint_v1',operation:handle.nativeTurnId,
        sourceDigest:createHash('sha256').update(data).digest('hex'),
        ...(submitted!.inertSourceAttachment ? {receipt:`TELA_CONTEXT_ACK ${submitted!.inertSourceAttachment.receipt}`} : {}),summary:'Keep abc; result observed; action pending.'}));
      return {state:'proven',value:{kind:'completed',providerTurnId:handle.providerTurnId,
        ...complete({answer:presentation(plainAnswer),plainAnswer})},evidence:[]};
    },
  }));
  return {provider, submitted:()=>submitted!, preloads:()=>preloads, submits:()=>submits};
}
test('dedicated summary has no tool bridge and keeps the complete source inert', async () => {
  const f = fixture();
  const result = await f.provider.createContextCheckpoint(surface,source);
  expect(result.state).toBe('proven');
  if (result.state !== 'proven') throw new Error('expected proof');
  expect(result.value.sourceRevisionId).toBe('r2');
  expect(result.value.content).toContain('abc');
  expect(f.submitted().toolBridge).toBeUndefined();
  expect(JSON.parse(f.submitted().physicalContext.segments[1]!.content).segments).toEqual(source.physicalContext.segments);
  expect(f.preloads()).toBe(0);
});
test('checkpoint consumes unformatted JSON while Markdown preserves literal syntax for display', async () => {
  const summary = 'Preserve file_name, **bold**, `code`, [link], \\path and the exact identifier.\n다음 작업';
  const f = fixture(value=>({...value,summary}), event=> {
    expect(()=>JSON.parse(event.answer)).toThrow();
    expect(event.answer).toContain('tela\\_context\\_checkpoint\\_v1');
    expect(JSON.parse(event.plainAnswer).summary).toBe(summary);
    return event;
  });
  const result = await f.provider.createContextCheckpoint(surface,source);
  expect(result.state === 'proven' && result.value.content).toBe(summary);
});
test('missing or malformed unformatted body cannot fall back to presentation text', async () => {
  await expect(fixture(value=>value, ({plainAnswer})=>({answer:plainAnswer}))
    .provider.createContextCheckpoint(surface,source)).rejects.toThrow('no proven unformatted body');
  await expect(fixture(value=>value, ({plainAnswer})=>({answer:plainAnswer,plainAnswer:'not JSON'}))
    .provider.createContextCheckpoint(surface,source)).rejects.toThrow('not an exact JSON envelope');
});
test('foreign source, empty and oversized summaries are rejected rather than cached', async () => {
  for (const change of [
    (x: any)=>({...x,sourceDigest:'foreign'}), (x: any)=>({...x,operation:'foreign'}),
    (x: any)=>({...x,summary:''}), (x: any)=>({...x,summary:'한'.repeat(12000)}),
  ]) {
    await expect(fixture(change).provider.createContextCheckpoint(surface,source)).rejects.toThrow('does not prove');
  }
});
test('large prefixes use one source-and-receipt summary submission with no preload response', async () => {
  const large: WebContextCheckpointRequest = {...source,physicalContext:{...source.physicalContext,
    segments:[source.physicalContext.segments[0]!,{type:'revision',revisionId:'r2',kind:'tool-result',content:'x'.repeat(210000)}]}};
  const f = fixture();
  await f.provider.createContextCheckpoint(surface,large);
  expect(f.preloads()).toBe(0); expect(f.submits()).toBe(1);
  expect(f.submitted().contextAttachment).toBeUndefined();
  expect(f.submitted().inertSourceAttachment?.attachment.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(f.submitted().physicalContext.activeRequestRevisionId).toBe(f.submitted().physicalContext.headRevisionId);
});

test('file-only receipt is required in the SAME summary; no missing receipt retry or ACK fallback', async () => {
  const large = {...source, physicalContext: {...source.physicalContext, segments: [source.physicalContext.segments[0]!,
    {type:'revision' as const,revisionId:'r2',kind:'assistant' as const,content:'x'.repeat(250000)}]}};
  for (const change of [(v:any)=>({...v,receipt:'foreign'}),(v:any)=>{delete v.receipt;return v;}]) {
    const f=fixture(change);
    await expect(f.provider.createContextCheckpoint(surface,large)).rejects.toThrow('does not prove');
    expect(f.submits()).toBe(1); expect(f.preloads()).toBe(0);
  }
  const f=fixture(); await f.provider.createContextCheckpoint(surface,large);
  expect(JSON.stringify(f.submitted().physicalContext)).not.toContain(f.submitted().inertSourceAttachment!.receipt);
  expect(f.submitted().inertSourceAttachment!.attachment.contextJson).toBe(serializeChatGptContextAttachment(large.physicalContext));
});

test('checkpoint source rebinds media references to the inert summary request without tool authority',async()=>{
 const data='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9RwvWgAAAABJRU5ErkJggg==';
 const inline=decodeNativeInlineEvidence(data);
 const evidence=nativeEvidenceRef({
  threadId:'task',itemKey:'old:item',partKey:'0',kind:'image',origin:'historical-user',
  source:'native_thread_read',sha256:inline.sha256,bytes:inline.bytes.byteLength,
 });
 const withImage:WebContextCheckpointRequest={
  ...source,physicalContext:{...source.physicalContext,
   segments:[{type:'revision',revisionId:'r1',kind:'user',content:`Older picture\n${JSON.stringify(evidence)}`,evidence:[evidence]},
     source.physicalContext.segments[1]!] },
  media:[{revisionId:'r1',evidence,file:{
   name:webEvidenceFilename(inline.sha256,inline.mimeType),
   mimeType:inline.mimeType,bytes:inline.bytes,
  }}],
 };
 const f=fixture();
 const result=await f.provider.createContextCheckpoint(surface,withImage);
 expect(result.state).toBe('proven');
 expect(f.submitted().media).toHaveLength(1);
 const mediaSource=f.submitted().physicalContext.segments[1]!;
 expect(mediaSource.type).toBe('revision');
 if(mediaSource.type!=='revision') throw new Error('expected physical source revision');
 expect(f.submitted().media![0]!.revisionId).toBe(mediaSource.revisionId);
 expect(f.submitted().media![0]!.evidence.id).toBe(evidence.id);
 expect(f.submitted().media![0]!.file.bytes).toEqual(inline.bytes);
 expect(f.submitted().toolBridge).toBeUndefined();
 const sent=f.submitted();
 const actualTransfer=Math.ceil((Buffer.byteLength(formatWebPhysicalContext(sent.physicalContext,undefined,undefined,sent.media),'utf8')+inline.bytes.byteLength)/4);
 expect(sent.physicalContext.transferTokens).toBe(actualTransfer);
 expect(chatGptCheckpointInputTokens(withImage.physicalContext,withImage.media)).toBe(actualTransfer);
 expect(f.submitted().physicalContext.segments[1]!.content).not.toContain(data);
 const foreign=fixture();
 await expect(foreign.provider.createContextCheckpoint(surface,{
  ...withImage,media:[{...withImage.media![0]!,revisionId:'foreign'}],
 })).rejects.toThrow('ownership');
 expect(foreign.submitted()).toBeUndefined();
});
test('opaque, partial and mismatched source requests never submit', async () => {
  for (const physicalContext of [ {...source.physicalContext, mode:'checkpoint-delta' as const},
    {...source.physicalContext,headRevisionId:'foreign'} ]) {
    const f = fixture();
    await expect(f.provider.createContextCheckpoint(surface,{...source,physicalContext})).rejects.toThrow('exact complete source');
    expect(f.submitted()).toBeUndefined();
  }
});

test('checkpoint forwards only proven public progress, preserving the source/result contract', async () => {
  const f = fixture();
  // Wrap the exact existing fixture transport to interleave a public progress event.
  const base = (f.provider as any).transportFactory;
  let waits = 0;
  const p = new ChatGptContextCheckpointProvider(() => {
    const transport = base();
    return { ...transport, async waitForTurnEvent(surface: any, handle: any, signal: any) {
      if (waits++ === 0) return {state:'proven' as const,value:{kind:'progress' as const,
        providerTurnId:handle.providerTurnId,summary:'Checking the prior decisions'},evidence:[]};
      return transport.waitForTurnEvent(surface,handle,signal);
    } };
  });
  const progress: string[] = [];
  const result = await p.createContextCheckpoint(surface,source,undefined,value=>progress.push(value));
  expect(progress).toEqual(['Checking the prior decisions']);
  expect(result.state).toBe('proven');
  expect(f.submitted().toolBridge).toBeUndefined();
});

test('inline checkpoint budget measures serialized UTF8 including escaped source and policy',async()=>{
 const f=fixture();
 const request={...source,physicalContext:{...source.physicalContext,segments:source.physicalContext.segments.map(segment=>({
  ...segment,content:'한글😀\\\"\n'.repeat(1000),
 }))}};
 await f.provider.createContextCheckpoint(surface,request);
 const physical=f.submitted().physicalContext;
 const actual=Math.ceil(Buffer.byteLength(formatWebPhysicalContext(physical,undefined),'utf8')/4);
 expect(physical.transferTokens).toBe(actual);
 expect(chatGptCheckpointInputTokens(request.physicalContext)).toBe(actual);
 expect(actual).toBeGreaterThan(Math.ceil(serializeChatGptContextAttachment(request.physicalContext).length/4));
});

test('checkpoint rejection diagnostics distinguish validation causes without saving source or summary', async () => {
  const {mkdtempSync,readFileSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const root=mkdtempSync(join(tmpdir(),'tela-checkpoint-rejection-'));
  const file=join(root,'events.jsonl');const previous=process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  const large={...source,physicalContext:{...source.physicalContext,segments:[
    {type:'revision' as const,revisionId:'r2',kind:'user' as const,content:'private-source-marker'.repeat(12000)}]}};
  try {
    process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=file;
    const cases:[string,(value:any)=>any][]=[
      ['envelope_invalid',v=>({...v,type:'foreign'})],
      ['operation_mismatch',v=>({...v,operation:'foreign'})],
      ['source_mismatch',v=>({...v,sourceDigest:'foreign'})],
      ['receipt_mismatch',v=>({...v,receipt:'foreign'})],
      ['summary_empty',v=>({...v,summary:''})],
      ['summary_budget',v=>({...v,summary:'private-summary-marker'.repeat(2000)})],
    ];
    for(const [,change] of cases){
      const f=fixture(change);
      await expect(f.provider.createContextCheckpoint(surface,large)).rejects.toThrow('does not prove');
      expect(f.submits()).toBe(1);expect(f.preloads()).toBe(0);
    }
    const malformed='{"summary":"private-summary-marker\nvalue"}';
    const invalid=fixture(v=>v,()=>({answer:'unused',plainAnswer:malformed}));
    await expect(invalid.provider.createContextCheckpoint(surface,large)).rejects.toThrow('exact JSON');
    const lines=readFileSync(file,'utf8');
    const rows=lines.split('\n').filter(Boolean).map(s=>JSON.parse(s));
    expect(rows.filter(d=>d.stage==='checkpoint_response_rejected').map(d=>d.reason_class)).toEqual([...cases.map(([reason])=>reason),'json_invalid']);
    expect(rows.find(d=>d.stage==='checkpoint_json_parse_failed')).toMatchObject({
      body_characters:malformed.length,body_bytes:Buffer.byteLength(malformed),line_break_count:1,
    });
    expect(lines).not.toContain('private-source-marker');expect(lines).not.toContain('private-summary-marker');
  } finally {
    if(previous===undefined)delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=previous;
    rmSync(root,{recursive:true,force:true});
  }
});

test.each([false, true])('invalid checkpoint JSON captures both renderer representations only with existing opt-in=%s', async enabled => {
  const root = mkdtempSync(join(tmpdir(), 'tela-checkpoint-private-'));
  const file = join(root, 'events.jsonl');
  const prior = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = file;
  if (enabled) setPrivateDiagnosticCapture(join(root, 'diagnostics'), 1);
  const malformed = '{"summary":"synthetic\\qbad"}';
  const formatted = '```json\n' + malformed + '\n```';
  const f = fixture(value => value, () => ({answer: formatted, plainAnswer: malformed}));
  try {
    await expect(withDiagnosticContext({ operation_fingerprint: 'a'.repeat(24) }, () =>
      f.provider.createContextCheckpoint(surface, source))).rejects.toThrow('exact JSON');
    expect(f.submits()).toBe(1);
    const rows = readFileSync(file, 'utf8');
    expect(rows).toContain('checkpoint_json_parse_failed');
    expect(rows).not.toContain(malformed);
    expect(rows).not.toContain(formatted);
    const directory = join(root, 'diagnostics', 'private');
    const files = enabled ? readdirSync(directory).filter(name => name.endsWith('.json') && !name.endsWith('.meta.json')) : [];
    expect(files).toHaveLength(enabled ? 1 : 0);
    if (enabled) {
      const record = JSON.parse(readFileSync(join(directory, files[0]!), 'utf8'));
      expect(record.phase).toBe('web_execution_failure');
      expect(record.context.operation_fingerprint).toBe('a'.repeat(24));
      expect(record.value).toMatchObject({ checkpointPhase: 'json_parse_failed', plainDomText: malformed,
        formattedMarkdown: formatted });
      expect(record.value.jsonErrorOffset).toBe(-1); // Runtime-dependent SyntaxError wording.
    }
  } finally {
    if (prior === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = prior;
    rmSync(root, {recursive: true, force: true});
  }
});
