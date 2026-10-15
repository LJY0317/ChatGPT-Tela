import {expect,test} from "bun:test";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {diagnosticFingerprint} from "@chatgpt-tela/core";
import type {CanonicalCurrentTurnSource} from "@chatgpt-tela/codex";
import {NativeResponsesGateway} from "./native-gateway";
import {ActiveTurnRegistry} from "./registry";

const source:CanonicalCurrentTurnSource={async currentTurn(threadId){return{threadId,turnId:"fixture-turn",cwd:"/fixture",workspaceRoots:["/fixture"],sandbox:{kind:"read-only",network:"restricted"},proof:"turn-context",environmentSourceTurnId:"fixture-turn"};}};
const request=()=>({client_metadata:{"x-codex-turn-metadata":{request_kind:"turn",thread_id:"fixture-thread",turn_id:"fixture-turn"}},input:[],tools:[]});
async function captured(run:()=>Promise<void>){
 const root=mkdtempSync(join(tmpdir(),"tela-gateway-evidence-")),file=join(root,"events.jsonl");
 const previous=process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
 process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=file;
 try{await run();return readFileSync(file,"utf8").trim().split("\n").map(x=>JSON.parse(x));}
 finally{if(previous===undefined)delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=previous;rmSync(root,{recursive:true,force:true});}
}
test("committed model outcome and denied replay correlate without claiming Native termination",async()=>{
 const rows=await captured(async()=>{
  let launches=0;
  const owner=new AbortController();
  const watched={...source,async watchTurn(){return {signal:owner.signal,async close(){}};}};
  const gateway=new NativeResponsesGateway(watched,new ActiveTurnRegistry(),async turn=>{launches++;turn.channel.markSubmitted();turn.channel.markAccepted();turn.channel.complete("private fixture answer");});
  const outcome=await gateway.handle(request());gateway.commit(outcome);
  owner.abort(new Error("Native completed"));
  await expect(gateway.handle(request())).rejects.toMatchObject({code:"tela_native_turn_already_retired"});
  expect(launches).toBe(1);
 });
 const commit=rows.find(r=>r.stage==="native_outcome_committed"),replay=rows.find(r=>r.stage==="native_replay_rejected");
 expect(commit.outcome).toBe("final");
 expect(commit.native_terminal_observed).toBe(false);
 expect(replay.current_authority_proven).toBe(false);
 expect(replay.scope_fingerprint).toBe(commit.scope_fingerprint);
 expect(replay.turn_fingerprint).toBe(diagnosticFingerprint("fixture-turn"));
 expect(replay.retryable).toBe(false);
 const retired=rows.find(r=>r.stage==="native_turn_retired");
 expect(retired).toMatchObject({reason_class:"owner_signal",turn_phase:"completed",retryable:false,execution_proven:false});
 expect(rows.indexOf(retired)).toBeLessThan(rows.indexOf(replay));
 expect(JSON.stringify(rows)).not.toMatch(/fixture-thread|fixture-turn|private fixture answer/);
});
test("first execution failure remains distinct from subsequent replay denial",async()=>{
 const rows=await captured(async()=>{
  const gateway=new NativeResponsesGateway(source,new ActiveTurnRegistry(),async()=>{throw Object.assign(new Error("private command failure"),{name:"TimeoutError"});});
  await expect(gateway.handle(request())).rejects.toThrow("private command failure");
  await expect(gateway.handle(request())).rejects.toMatchObject({code:"tela_native_turn_already_retired"});
 });
 const failure=rows.find(r=>r.stage==="native_execution_failed"),replay=rows.find(r=>r.stage==="native_replay_rejected");
 expect(failure.status).toBe("timeout");
 expect(failure.turn_phase).toBe("prepared");
 expect(failure.turn_fingerprint).toBe(replay.turn_fingerprint);
 expect(rows.indexOf(failure)).toBeLessThan(rows.indexOf(replay));
 const retired=rows.find(r=>r.stage==="native_turn_retired");
 expect(retired).toMatchObject({reason_class:"execution_failed",turn_phase:"failed-before-acceptance",retryable:false});
 expect(JSON.stringify(rows)).not.toContain("private command failure");
});
test("duplicate local tool commit is rejected without another success witness",async()=>{
  const rows=await captured(async()=>{
    const gateway=new NativeResponsesGateway(source,new ActiveTurnRegistry(),async turn=>{
      turn.channel.markSubmitted();turn.channel.markAccepted();
      await turn.channel.requestTool({callId:"private-call",wireName:"fixture_tool",
        mode:"structured",arguments:{payload:"private"}});
    });
    const body={...request(),tools:[{type:"function",name:"fixture_tool",
      description:"fixture",parameters:{type:"object"}}]};
    const outcome=await gateway.handle(body);
    expect(outcome.type).toBe("tool-call");
    gateway.commit(outcome);
    expect(()=>gateway.commit(outcome)).toThrow("already committed");
    await gateway.close();
  });
  expect(rows.filter(row=>row.stage==="native_outcome_committed"&&row.outcome==="tool_call")).toHaveLength(1);
  expect(rows.filter(row=>row.stage==="native_tool_delivery_committed")).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toMatch(/private-call|private|fixture_tool/);
});
