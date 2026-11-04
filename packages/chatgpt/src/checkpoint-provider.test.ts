import { runInNewContext } from 'node:vm';
import { expect, test } from 'bun:test';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type { BrowserSurfaceLease } from '@chatgpt-tela/browser-host';
import type { WebContextCheckpointRequest, WebTurnRequest, WebContextAttachmentPreloadRequest } from './index';
import { ChatGptContextCheckpointProvider, chatGptCheckpointInputTokens } from './checkpoint-provider';
import { serializeChatGptContextAttachment } from './context-attachment';
import { decodeNativeInlineEvidence, nativeEvidenceRef } from '@chatgpt-tela/core';
import { webEvidenceFilename } from './turn-media';
import { formatWebPhysicalContext } from './semantic-provider';
import { chatGptWebCheckpointSourceTokenLimit, chatGptWebPhysicalLimits } from './physical-limits';
import { formatInertSourceAttachment } from './context-attachment';
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
        answer: 'private response', plainAnswer: ''}, evidence: []};
    },
  }));
  try {
    await expect(provider.createContextCheckpoint(surface, source)).rejects.toThrow();
    expect(submissions).toBe(1);
    const rows = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows.find(row => row.stage === 'checkpoint_operation_failed')).toMatchObject({
      phase, submission_accepted: phase !== 'submitting', completion_observed: phase === 'completed',
      reason_class: phase === 'completed' ? 'summary_empty' : 'provider_error',
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
function fixture(change: (value: string) => string = value => value,
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
      const summary = 'Keep abc; result observed; action pending.';
      const receipt = submitted!.inertSourceAttachment
        ? `\nTELA_CONTEXT_ACK ${submitted!.inertSourceAttachment.receipt}` : '';
      const plainAnswer = change(summary + receipt);
      return {state:'proven',value:{kind:'completed',providerTurnId:handle.providerTurnId,
        ...complete({answer:presentation(plainAnswer),plainAnswer})},evidence:[]};
    },
  }));
  return {provider, submitted:()=>submitted!, preloads:()=>preloads, submits:()=>submits};
}
test('dedicated summary is tool-free and keeps the complete source inert', async () => {
  const f = fixture();
  const result = await f.provider.createContextCheckpoint(surface,source);
  expect(result.state).toBe('proven');
  if (result.state !== 'proven') throw new Error('expected proof');
  expect(result.value.sourceRevisionId).toBe('r2');
  expect(result.value.content).toContain('abc');
  expect(f.submitted().chatTools).toBeUndefined();
  expect(f.submitted().physicalContext.segments.at(-1)!.content).toContain('summary as plain text');
  expect(JSON.parse(f.submitted().physicalContext.segments[1]!.content).segments).toEqual(source.physicalContext.segments);
  expect(f.preloads()).toBe(0);
});
test('checkpoint preserves literal unformatted text including JSON-like fragments and Markdown characters', async () => {
  const summary = 'Preserve file_name, **bold**, `code`, [link], \\\\path and {\\\"json\\\": broken}\n다음 작업';
  const f = fixture(() => summary, event => {
    expect(event.answer).not.toBe(summary);
    expect(event.plainAnswer).toBe(summary);
    return event;
  });
  const result = await f.provider.createContextCheckpoint(surface,source);
  expect(result.state === 'proven' && result.value.content).toBe(summary);
});
test('checkpoint never infers a missing unformatted body from the presentation', async () => {
  await expect(fixture(value=>value, ({plainAnswer})=>({answer:plainAnswer}))
    .provider.createContextCheckpoint(surface,source)).rejects.toThrow('no proven unformatted body');
});
test('empty and oversized plain summaries are rejected after a proven completion', async () => {
  for (const summary of ['', ' ', '한'.repeat(12000)]) {
    await expect(fixture(() => summary).provider.createContextCheckpoint(surface,source)).rejects.toThrow('checkpoint summary');
  }
});
test('foreign completed providerTurnId cannot be used as checkpoint success', async () => {
  const f = fixture(value=>value, value=>value);
  const base = (f.provider as any).transportFactory;
  const provider = new ChatGptContextCheckpointProvider(() => {
    const transport = base();
    return { ...transport, async waitForTurnEvent(surface: any, handle: any, signal: any) {
      const completed = await transport.waitForTurnEvent(surface,handle,signal);
      return { ...completed, value: {...completed.value,providerTurnId:'foreign'} };
    }};
  });
  await expect(provider.createContextCheckpoint(surface,source)).rejects.toThrow('different operation');
  expect(f.submits()).toBe(1);
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

test('file-only receipt must appear in the owned plain answer without retry or ACK fallback', async () => {
  const large = {...source, physicalContext: {...source.physicalContext, segments: [source.physicalContext.segments[0]!,
    {type:'revision' as const,revisionId:'r2',kind:'assistant' as const,content:'x'.repeat(250000)}]}};
  for (const change of [
    (value:string)=>value.replace(/TELA_CONTEXT_ACK ctxr_[a-f0-9]{32}/,'TELA_CONTEXT_ACK ctxr_'+'z'.repeat(32)),
    (value:string)=>value.replace(/TELA_CONTEXT_ACK ctxr_[a-f0-9]{32}/,''),
  ]) {
    const f=fixture(change);
    await expect(f.provider.createContextCheckpoint(surface,large)).rejects.toThrow('file receipt');
    expect(f.submits()).toBe(1); expect(f.preloads()).toBe(0);
  }
  for (const change of [
    (value:string)=>value.slice(value.indexOf('TELA_CONTEXT_ACK ')),
    (value:string)=>' \r\n'+value.slice(value.indexOf('TELA_CONTEXT_ACK ')),
  ]) {
    const f=fixture(change);
    await expect(f.provider.createContextCheckpoint(surface,large)).rejects.toThrow('checkpoint summary is empty');
    expect(f.submits()).toBe(1); expect(f.preloads()).toBe(0);
  }
  const f=fixture(); const result=await f.provider.createContextCheckpoint(surface,large);
  expect(result.state === 'proven' && result.value.content).toBe('Keep abc; result observed; action pending.\n');
  expect(JSON.stringify(f.submitted().physicalContext)).not.toContain(f.submitted().inertSourceAttachment!.receipt);
  expect(f.submitted().inertSourceAttachment!.attachment.contextJson).toBe(serializeChatGptContextAttachment(large.physicalContext));
});

test('file receipt is removed at any position and multiplicity without changing other summary bytes', async () => {
  const large = {...source, physicalContext: {...source.physicalContext, segments: [source.physicalContext.segments[0]!,
    {type:'revision' as const,revisionId:'r2',kind:'assistant' as const,content:'x'.repeat(250000)}]}};
  const cases: readonly [(value: string) => string, string][] = [
    [value=>value.replace('\nTELA_CONTEXT_ACK', 'TELA_CONTEXT_ACK')+'\nmore', 'Keep abc; result observed; action pending.\nmore'],
    [value=>value.replace('\nTELA_CONTEXT_ACK', '\r\nTELA_CONTEXT_ACK')+'\r\n', 'Keep abc; result observed; action pending.\r\n\r\n'],
    [value=>value+'\n'+value.split('\n').at(-1), 'Keep abc; result observed; action pending.\n\n'],
    [value=>value.slice(value.indexOf('TELA_CONTEXT_ACK '))+value.slice(0,value.indexOf('TELA_CONTEXT_ACK ')), 'Keep abc; result observed; action pending.\n'],
    [value=>value.replace('Keep abc; result observed; action pending.', '{"value":"**literal**_\\\\path"}\n다음 작업'), '{"value":"**literal**_\\\\path"}\n다음 작업\n'],
  ];
  for (const [change, expected] of cases) {
    const f=fixture(change);
    const result=await f.provider.createContextCheckpoint(surface,large);
    expect(result.state === 'proven' && result.value.content).toBe(expected);
    expect(f.submits()).toBe(1); expect(f.preloads()).toBe(0);
  }
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
 expect(f.submitted().chatTools).toBeUndefined();
 const sent=f.submitted();
 const actualTransfer=Math.ceil((Buffer.byteLength(formatWebPhysicalContext(sent.physicalContext,undefined,sent.media),'utf8')+inline.bytes.byteLength)/4);
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
  expect(f.submitted().chatTools).toBeUndefined();
});

test('inline checkpoint budget measures serialized UTF8 including escaped source and policy',async()=>{
 const f=fixture();
 const request={...source,physicalContext:{...source.physicalContext,segments:source.physicalContext.segments.map(segment=>({
  ...segment,content:'한글😀\\\"\n'.repeat(1000),
 }))}};
 await f.provider.createContextCheckpoint(surface,request);
 const physical=f.submitted().physicalContext;
 const actual=Math.ceil(Buffer.byteLength(formatWebPhysicalContext(physical),'utf8')/4);
 expect(physical.transferTokens).toBe(actual);
 expect(chatGptCheckpointInputTokens(request.physicalContext)).toBe(actual);
 expect(actual).toBeGreaterThan(Math.ceil(serializeChatGptContextAttachment(request.physicalContext).length/4));
});
test('file-backed checkpoint input counts the exact attachment and composer wire once',async()=>{
  expect(chatGptWebCheckpointSourceTokenLimit('medium')).toBe(98_905);
  for (const bytes of [428_110,441_985]) {
    const request={...source,physicalContext:{...source.physicalContext,segments:[{
      type:'revision' as const,revisionId:'r2',kind:'user' as const,content:'x'.repeat(bytes)}]}};
    const f=fixture();await f.provider.createContextCheckpoint(surface,request);
    const sent=f.submitted(), attachment=sent.inertSourceAttachment!;
    expect(attachment).toBeDefined();
    const wire=Buffer.byteLength(formatWebPhysicalContext(sent.physicalContext),'utf8')
      +formatInertSourceAttachment(attachment.attachment,attachment.receipt).file.bytes.byteLength;
    expect(sent.physicalContext.transferTokens).toBe(Math.ceil(wire/4));
    expect(chatGptCheckpointInputTokens(request.physicalContext)).toBe(Math.ceil(wire/4));
    expect(formatWebPhysicalContext(sent.physicalContext).length)
      .toBeLessThan(chatGptWebPhysicalLimits('medium').composerCharLimit);
    expect(sent.physicalContext.transferTokens).toBeGreaterThan(98_905);
  }
});

test('checkpoint failure diagnostics omit private text but distinguish terminal summary reasons', async () => {
  const root=mkdtempSync(join(tmpdir(),'tela-checkpoint-rejection-'));
  const file=join(root,'events.jsonl'), previous=process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  try {
    process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=file;
    for (const text of ['', 'private-summary-marker'.repeat(2000)]) {
      const f=fixture(()=>text);
      await expect(f.provider.createContextCheckpoint(surface,source)).rejects.toThrow('checkpoint summary');
      expect(f.submits()).toBe(1);
    }
    const rows=readFileSync(file,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
    expect(rows.filter(row=>row.stage==='checkpoint_response_rejected').map(row=>row.reason_class))
      .toEqual(['summary_empty','summary_budget']);
    expect(JSON.stringify(rows)).not.toContain('private-summary-marker');
  } finally {
    if(previous===undefined)delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=previous;
    rmSync(root,{recursive:true,force:true});
  }
});
