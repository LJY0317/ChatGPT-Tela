import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppServerAutomaticNativeHandoffSource,
  NativeAutoHandoffUnavailable,
  appServerAutomaticNativeHandoffSource,
  automaticNativeHandoffText,
  parseStructuredNativeHandoff,
} from "./automatic-handoff";
import type { CodexAppServerRpc } from "./app-server";

const answer = JSON.stringify({
  type: "tela_native_auto_web_handoff_v1",
  objective: "Continue source-bound Web work",
  constraints: ["Only authorized Native tools have authority"],
  completed: ["Initial Native implementation reviewed"],
  decisions: ["Keep Native as task owner"],
  pending: ["Test Web follow-ups"],
  files: ["packages/runtime/src/native-gateway.ts (hint, not re-read)"],
  evidence: ["Old tool output not reverified"],
  limitations: ["Historical command results unavailable in the visible summary"],
});

function fake(options: {
  readonly oldTurnStatus?: string;
  readonly hasNativeDefault?: boolean;
  readonly toolEvent?: boolean;
  readonly malformedFork?: boolean;
  readonly forkNativeModel?: boolean;
  readonly historyMode?: string;
} = {}) {
  const calls: Array<{ method: string; params: any }> = [];
  let notify = (_method: string, _params: unknown) => {};
  let closed = 0;
  const rpc: CodexAppServerRpc = {
    subscribe(onEvent) {
      notify = onEvent;
      return () => { notify = () => {}; };
    },
    async request(method, params) {
      calls.push({ method, params });
      const p = params as any;
      if (method === "thread/read") return {thread:{
        id:p.threadId, status:{type:"active"}, historyMode:options.historyMode??"paginated",
        cwd:"/authorized/read-only",
        environments:[{cwd:"/authorized/read-only"}],
      }};
      if (method === "thread/turns/list") return {data:[
        {id:"web-current", status:"inProgress",itemsView:"notLoaded",items:[]},
        {id:"prior-native",status:options.oldTurnStatus??"completed",
          itemsView:"notLoaded",items:[]},
      ],nextCursor:null};
      if (method === "model/list") return {data:[
        {model:"chatgpt-tela-web/some-web-model",isDefault:true,hidden:false},
        {model:"verified-native-fixture",isDefault:options.hasNativeDefault!==false,hidden:false},
        ...(options.hasNativeDefault===false ? [{model:"another-native-model",hidden:false}] : []),
      ],nextCursor:null};
      if (method === "thread/fork") return {thread:{
        id:options.malformedFork?"native-source":"ephemeral-fork",
        forkedFromId:"native-source",ephemeral:!options.malformedFork,
        ...(options.forkNativeModel ? {model:"verified-native-fixture"} : {}),
      }};
      if (method === "thread/goal/clear") return {cleared:false};
      if (method === "thread/goal/get") return {goal:null};
      if (method === "turn/start") {
        queueMicrotask(() => {
          if (options.toolEvent) {
            notify("item/started", {threadId:"ephemeral-fork",turnId:"summary-turn",
              item:{id:"bad-tool",type:"commandExecution"}});
          } else {
            notify("item/completed", {threadId:"ephemeral-fork",turnId:"summary-turn",
              item:{id:"summary-item",type:"agentMessage",phase:"finalAnswer",text:answer}});
            notify("turn/completed", {threadId:"ephemeral-fork",
              turn:{id:"summary-turn",status:"completed"}});
          }
        });
        return {turn:{id:"summary-turn"}};
      }
      if (method === "turn/interrupt") return {};
      throw new Error("Unexpected public API operation");
    },
    async close() { closed++; },
  };
  return {source:new AppServerAutomaticNativeHandoffSource(async()=>rpc,{
      unsafePermitModelToolsInIsolatedSyntheticFixture:true,
    }),
    calls,closed:()=>closed};
}

test("production default denies prepare and source checks before opening the connector",async()=>{
  let connections=0;
  const source=new AppServerAutomaticNativeHandoffSource(async()=>{
    connections++;
    throw Error("Production must not connect or run a model");
  });
  await expect(source.prepare("thread","active-turn"))
    .rejects.toBeInstanceOf(NativeAutoHandoffUnavailable);
  await expect(source.verifySource("thread","active-turn","previous"))
    .rejects.toBeInstanceOf(NativeAutoHandoffUnavailable);
  expect(await source.verifyRecent("thread","active-turn","previous")).toBe(false);
  expect(connections).toBe(0);
  // Also test the endpoint factory used by native-first-profile.ts.
  const endpoint=appServerAutomaticNativeHandoffSource("ws://127.0.0.1:1");
  await expect(endpoint.prepare("thread","active-turn"))
    .rejects.toBeInstanceOf(NativeAutoHandoffUnavailable);
  await expect(endpoint.verifySource("thread","active-turn","previous"))
    .rejects.toBeInstanceOf(NativeAutoHandoffUnavailable);
  expect(await endpoint.verifyRecent("thread","active-turn","previous")).toBe(false);
});

test("production Native auto-handoff refusal explains the denied phase without exposing identifiers",async()=>{
  const original = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  const base=mkdtempSync(join(tmpdir(),"tela-handoff-diagnostics-"));
  const path=join(base,"events.jsonl");
  process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=path;
  const privateThread="thread-not-for-logs";
  const source=new AppServerAutomaticNativeHandoffSource(async()=>{
    throw Error("must not connect");
  });
  try {
    await expect(source.prepare(privateThread,"private-turn")).rejects.toBeInstanceOf(NativeAutoHandoffUnavailable);
    await expect(source.verifySource(privateThread,"private-turn","private-previous"))
      .rejects.toBeInstanceOf(NativeAutoHandoffUnavailable);
    expect(await source.verifyRecent(privateThread,"private-turn","private-previous")).toBe(false);
    const log=readFileSync(path,"utf8");
    const stages=log.trim().split("\n").map(row=>JSON.parse(row))
      .filter(row=>row.stage==="native_auto_handoff_rejected");
    expect(stages.map(row=>row.phase)).toEqual(["prepare","verify_source","verify_recent"]);
    expect(stages.every(row=>row.reason_class==="production_disabled")).toBe(true);
    expect(log).not.toContain(privateThread);
    expect(log).not.toContain("private-turn");
  } finally {
    if(original===undefined)delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=original;
    rmSync(base,{recursive:true,force:true});
  }
});

test("synthetic Legacy history never enters turns/list or starts a fork",async()=>{
  const fixture=fake({historyMode:"legacy"});
  await expect(fixture.source.prepare("native-source","web-current"))
    .rejects.toBeInstanceOf(NativeAutoHandoffUnavailable);
  expect(fixture.calls.map(c=>c.method)).toEqual(["thread/read"]);
  expect(await fixture.source.verifyRecent("native-source","web-current","prior-native"))
    .toBe(false);
  expect(fixture.calls.map(c=>c.method)).toEqual(["thread/read","thread/read"]);
  expect(fixture.calls.some(c=>c.method==="turn/start")).toBe(false);
});

test("automatic Native handoff uses exactly one read-only model turn on an isolated ephemeral fork",async()=>{
  const f=fake();
  const result=await f.source.prepare("native-source","web-current");
  expect(result.threadId).toBe("native-source");
  expect(result.currentTurnId).toBe("web-current");
  expect(result.sourceTurnId).toBe("prior-native");
  expect(parseStructuredNativeHandoff(result.content).objective)
    .toBe("Continue source-bound Web work");
  const webInput = JSON.parse(automaticNativeHandoffText(result));
  expect(webInput.type).toBe("tela_native_automatic_web_continuation_v1");
  expect(webInput.sourceTurnId).toBe("prior-native");
  expect(webInput.semantics).toContain("does not export encrypted Native model state");
  const fork=f.calls.find(c=>c.method==="thread/fork")!;
  expect(fork.params).toEqual({
    threadId:"native-source",lastTurnId:"prior-native",ephemeral:true,
    excludeTurns:true,deferGoalContinuation:true,
  });
  const goals=f.calls.filter(c=>c.method==="thread/goal/clear");
  expect(goals).toHaveLength(1);
  expect(goals[0]!.params.threadId).toBe("ephemeral-fork");
  expect(f.calls.filter(c=>c.method==="thread/goal/get")).toHaveLength(1);
  const turns=f.calls.filter(c=>c.method==="turn/start");
  expect(turns).toHaveLength(1);
  expect(turns[0]!.params.threadId).toBe("ephemeral-fork");
  expect(turns[0]!.params.model).toBe("verified-native-fixture");
  expect(turns[0]!.params.sandboxPolicy).toEqual({type:"readOnly"});
  expect(turns[0]!.params.approvalPolicy).toBe("never");
  expect(f.calls.filter(c=>c.method==="turn/interrupt")).toHaveLength(0);
  expect(f.closed()).toBe(1);
});

test("current Web turn cannot fork from a source that is still in progress",async()=>{
  const f=fake({oldTurnStatus:"inProgress"});
  await expect(f.source.prepare("native-source","web-current")).rejects.toThrow("unavailable");
  expect(f.calls.some(c=>c.method==="thread/fork")).toBe(false);
  expect(f.calls.some(c=>c.method==="turn/start")).toBe(false);
});

test("ambiguous native model catalogs cannot initiate an unproven second model",async()=>{
  const f=fake({hasNativeDefault:false});
  await expect(f.source.prepare("native-source","web-current")).rejects.toThrow("unavailable");
  // A disposable fork may be needed to discover its actual prior Native model.
  // An ambiguous catalog without that proof must not start an inference turn.
  expect(f.calls.some(c=>c.method==="thread/fork")).toBe(true);
  expect(f.calls.some(c=>c.method==="turn/start")).toBe(false);
  expect(f.calls.some(c=>c.method==="thread/goal/clear")).toBe(false);
  expect(f.closed()).toBe(1);
});
test("synthetic fork configuration selects a Native model but is not historical provenance",async()=>{
  const f=fake({hasNativeDefault:false,forkNativeModel:true});
  const result=await f.source.prepare("native-source","web-current");
  expect(result.sourceTurnId).toBe("prior-native");
  expect(f.calls.filter(c=>c.method==="turn/start")[0]?.params.model)
    .toBe("verified-native-fixture");
});

test("fork ownership mismatch cannot start any background Native model",async()=>{
  const f=fake({malformedFork:true});
  await expect(f.source.prepare("native-source","web-current")).rejects.toThrow("unavailable");
  expect(f.calls.some(c=>c.method==="turn/start")).toBe(false);
});

test("an unsolicited tool event rejects the summary and interrupts only its exact ephemeral turn",async()=>{
  const f=fake({toolEvent:true});
  await expect(f.source.prepare("native-source","web-current")).rejects.toThrow("unavailable");
  const interrupted=f.calls.filter(c=>c.method==="turn/interrupt");
  expect(interrupted).toHaveLength(1);
  expect(interrupted[0]!.params).toEqual({
    threadId:"ephemeral-fork",turnId:"summary-turn",
  });
  expect(f.calls.filter(c=>c.method==="turn/start"
    && c.params.threadId==="native-source")).toHaveLength(0);
  expect(f.closed()).toBe(1);
});

test("cached checkpoint ancestry must be a completed earlier source, not just a matching turn ID",async()=>{
  const valid=fake();
  expect(await valid.source.verifyRecent("native-source","web-current","prior-native")).toBe(true);
  expect(await valid.source.verifyRecent("native-source","web-current","missing")).toBe(false);
  const invalid=fake({oldTurnStatus:"interrupted"});
  expect(await invalid.source.verifyRecent("native-source","web-current","prior-native")).toBe(false);
});

test("structured Native handoff rejects fabricated evidence schema and missing limitations",()=>{
  expect(()=>parseStructuredNativeHandoff(JSON.stringify({
    ...JSON.parse(answer),limitations:[],
  }))).toThrow("evidence limits");
  expect(()=>parseStructuredNativeHandoff(JSON.stringify({
    ...JSON.parse(answer),extra:"authority",
  }))).toThrow("schema");
});
