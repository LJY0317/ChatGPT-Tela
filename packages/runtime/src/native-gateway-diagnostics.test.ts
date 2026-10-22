import {expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {diagnosticFingerprint, nativeInputReceipt, nativeTextHash, readDiagnosticTail} from "@chatgpt-tela/core";
import type {CanonicalCurrentTurnSource} from "@chatgpt-tela/codex";
import {NativeResponsesGateway} from "./native-gateway";
import {ActiveTurnRegistry} from "./registry";

const source:CanonicalCurrentTurnSource={async currentTurn(threadId){return{threadId,turnId:"fixture-turn",cwd:"/fixture",workspaceRoots:["/fixture"],sandbox:{kind:"read-only",network:"restricted"},proof:"turn-context",environmentSourceTurnId:"fixture-turn"};}};
const request=()=>({client_metadata:{"x-codex-turn-metadata":{request_kind:"turn",thread_id:"fixture-thread",turn_id:"fixture-turn"}},input:[],tools:[]});
async function captured(run:()=>Promise<void>){
 const root=mkdtempSync(join(tmpdir(),"tela-gateway-evidence-")),file=join(root,"events.jsonl");
 const previous=process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
 process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=file;
 try{await run();return readDiagnosticTail(file).events as Record<string, any>[];}
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
 const commit=rows.find(r=>r.stage==="native_outcome_committed")!,replay=rows.find(r=>r.stage==="native_replay_rejected")!;
 expect(commit.outcome).toBe("final");
 expect(commit.native_terminal_observed).toBe(false);
 expect(replay.current_authority_proven).toBe(false);
 expect(replay.scope_fingerprint).toBe(commit.scope_fingerprint);
 expect(replay.turn_fingerprint).toBe(diagnosticFingerprint("fixture-turn"));
 expect(replay.retryable).toBe(false);
 const retired=rows.find(r=>r.stage==="native_turn_retired")!;
 expect(retired).toMatchObject({reason_class:"owner_signal",turn_phase:"completed",retryable:false,execution_proven:false});
 expect(rows.indexOf(retired)).toBeLessThan(rows.indexOf(replay));
 expect(rows.filter(r=>r.stage==="native_cycle_summary")).toHaveLength(1);
 expect(rows.find(r=>r.stage==="native_cycle_summary")).toMatchObject({state:"completed",local_final_committed:true,composer_measured:false});
 expect(JSON.stringify(rows)).not.toMatch(/fixture-thread|fixture-turn|private fixture answer/);
});
test("first execution failure remains distinct from subsequent replay denial",async()=>{
 const rows=await captured(async()=>{
  const gateway=new NativeResponsesGateway(source,new ActiveTurnRegistry(),async()=>{throw Object.assign(new Error("private command failure"),{name:"TimeoutError"});});
  await expect(gateway.handle(request())).rejects.toThrow("private command failure");
  await expect(gateway.handle(request())).rejects.toMatchObject({code:"tela_native_turn_already_retired"});
 });
 const failure=rows.find(r=>r.stage==="native_execution_failed")!,replay=rows.find(r=>r.stage==="native_replay_rejected")!;
 expect(failure.status).toBe("timeout");
 expect(failure.turn_phase).toBe("prepared");
 expect(failure.turn_fingerprint).toBe(replay.turn_fingerprint);
 expect(rows.indexOf(failure)).toBeLessThan(rows.indexOf(replay));
 expect(rows.find(r=>r.stage==="native_cycle_summary")).toMatchObject({state:"failed",local_final_committed:false});
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

test("cycle failure evidence separates prior final, new message and canonical input proof without payloads", async () => {
  for (const scenario of ["prior_final_missing", "new_input_missing", "input_witness_missing", "input_witness_mismatch"] as const) {
    const rows = await captured(async () => {
      const inputs: NonNullable<ReturnType<typeof nativeInputReceipt>>[] = [];
      const owner = new AbortController();
      let launches = 0;
      const gateway = new NativeResponsesGateway({ ...source, async watchTurn() {
        return { signal: owner.signal, inputs: () => inputs, async close() {} };
      } }, new ActiveTurnRegistry(), async turn => {
        launches++; turn.channel.markSubmitted(); turn.channel.markAccepted(); turn.channel.complete("PRIVATE ANSWER");
      });
      const first = await gateway.handle(request()); gateway.commit(first);
      if (scenario === "input_witness_mismatch") inputs.push(nativeInputReceipt({
        type: "userMessage", id: "PRIVATE ID", content: [{ type: "text", text: "PRIVATE FOLLOWUP" }],
      })!);
      if (scenario === "input_witness_mismatch") for (let index = 0; index < 12; index++) inputs.push(nativeInputReceipt({
        type: "userMessage", id: `PRIVATE EXTRA ID ${index}`, content: [{ type: "text", text: `PRIVATE OTHER ${index}` }],
      })!);
      const messages = [
        ...(scenario === "prior_final_missing" ? [] : [{ role: "assistant", content: "PRIVATE ANSWER" }]),
        ...(scenario === "new_input_missing" ? [] : [{ role: "user", content: "PRIVATE FOLLOWUP" }]),
        ...(scenario === "input_witness_mismatch" ? [{ type: "context_compaction" }, { role: "user", content: "PRIVATE UNPROVEN" }] : []),
      ];
      await expect(gateway.handle({ ...request(), input: messages })).rejects.toMatchObject({ code: "tela_native_response_cycle_conflict" });
      expect(launches).toBe(1);
      await gateway.close();
    });
    expect(rows.find(row => row.stage === "native_cycle_proof_rejected")).toMatchObject({
      reason_class: scenario, prior_final_present: scenario !== "prior_final_missing",
      fresh_input_count: scenario === "input_witness_mismatch" ? 1 : 0,
    });
    const rejected = rows.find(row => row.stage === "native_cycle_proof_rejected")!;
    if (scenario !== "prior_final_missing") expect(rejected.prior_final_fingerprint).toBe(diagnosticFingerprint(nativeTextHash("PRIVATE ANSWER")));
    const evidence = rows.filter(row => row.stage === "native_cycle_input_evidence");
    if (scenario === "new_input_missing") expect(evidence).toEqual([]);
    if (scenario === "input_witness_missing") {
      expect(evidence).toEqual([expect.objectContaining({ kind: "request", index: 0,
        body_fingerprint: diagnosticFingerprint(nativeTextHash("PRIVATE FOLLOWUP")) })]);
    }
    if (scenario === "input_witness_mismatch") {
      expect(evidence.filter(row => row.kind === "request")).toHaveLength(2);
      expect(evidence).toContainEqual(expect.objectContaining({ kind: "request", index: 0,
        source_index: 1, mode: "string", preceded_by_compaction: false,
        matched: true }));
      expect(evidence).toContainEqual(expect.objectContaining({ kind: "request", index: 1,
        source_index: 3, mode: "string", preceded_by_compaction: true,
        matched: false }));
      expect(evidence.filter(row => row.kind === "witness")).toHaveLength(13);
      expect(evidence).toContainEqual(expect.objectContaining({ kind: "witness", index: 0,
        item_fingerprint: diagnosticFingerprint("PRIVATE ID"),
        body_fingerprint: diagnosticFingerprint(nativeTextHash("PRIVATE FOLLOWUP")), consumed: false, matched: true }));
    }
    expect(JSON.stringify(rows)).not.toContain("PRIVATE");
  }
});
