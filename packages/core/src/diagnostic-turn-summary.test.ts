import {expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
import {summarizeTurnDiagnostics,startTurnDiagnosticSummary} from './diagnostic-turn-summary';
import {emitDiagnosticEvent} from './diagnostic-events';import{withDiagnosticContext}from'./diagnostic-context';
import type{StructuralDiagnosticEvent}from'./diagnostic-store';
const scope='1'.repeat(24),turn='2'.repeat(24),request='3'.repeat(24),op='4'.repeat(24);
let tick=0;
const e=(stage:string,x:object={}):StructuralDiagnosticEvent=>({ts:new Date(1000+tick++).toISOString(),event:'chatgpt_tela_work',stage,scope_fingerprint:scope,turn_fingerprint:turn,...x});
test('successful causal receipt, tool cycles and retirement are not reconnect failures',()=>{
 const rows=[e('native_response_observer_started'),e('web_turn_plan',{context_mode:'checkpoint-delta',request_checkpoint_reused:true,request_checkpoint_produced:false}),
 e('browser_message_prepared',{composer_wire_bytes:120,context_wire_bytes:100,protocol_wire_bytes:20}),
 e('web_send_activation_started',{operation_fingerprint:op,phase:'turn',composer_wire_bytes:120,context_wire_bytes:100,protocol_wire_bytes:20}),e('web_turn_identity_accepted',{causal_receipt:true,accepted_fingerprint_matches:false}),
 e('web_turn_identity_pending'),e('web_turn_identity_resumed'),e('native_tool_queued',{operation_fingerprint:op}),
 e('native_tool_result_received',{operation_fingerprint:op,inspection_complete:false}),e('native_tool_result_released',{operation_fingerprint:op}),
 e('native_response_observer_started'),e('native_outcome_committed',{outcome:'final'}),e('native_turn_retired',{turn_phase:'completed'})];
 const r=summarizeTurnDiagnostics(rows);
 expect(r.state).toBe('completed');expect(r.warnings).toEqual([]);
 expect(r.transport).toEqual({responseObservers:2,observerReplacements:0,disconnects:0});
 expect(r.submission).toMatchObject({causal:true,observedPayloadMatched:false,activations:1});
 expect(r.tools).toMatchObject({queued:1,results:1,released:1,incompleteSignalInspections:1});
 expect(r.cost.composer).toEqual({observed:1,total:120,complete:true});
 expect(r.cost.toolText.complete).toBe(false);expect(r.context).toMatchObject({checkpointReused:true,summaryAttempts:0});
});
test('missing and partial measurements never become complete totals or semantic proof',()=>{
 const r=summarizeTurnDiagnostics([e('web_send_activation_started',{composer_wire_bytes:5}),e('web_send_activation_started'),e('web_turn_acceptance_timeout',{reason_class:'new_author_unavailable',first_reason_class:'ambiguous_author_root'}),e('native_turn_retired')]);
 expect(r.cost.composer).toEqual({observed:1,total:5,complete:false});expect(r.cost.protocol.complete).toBe(false);
 expect(r.submission.firstFailure).toBe('ambiguous_author_root');expect(r.localFinalCommitted).toBe(false);
 expect(r.cost.billedUsage).toBe('unmeasured');expect(r.cost.semanticRecall).toBe('not_evaluated');
 expect(summarizeTurnDiagnostics(Array.from({length:513},()=>e('native_response_observer_started'))).evidence.clipped).toBe(true);
});
test('process-local cycle summary closes once, isolates scope and releases its observer',()=>{
 const root=mkdtempSync(join(tmpdir(),'tela-cycle-summary-')),file=join(root,'events.jsonl');
 const old=process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=file;
 const observer=startTurnDiagnosticSummary(scope,turn,request)!;
 try{
  withDiagnosticContext({scope_fingerprint:scope,turn_fingerprint:turn,request_fingerprint:request},()=>{
   emitDiagnosticEvent('chatgpt_tela_work','web_turn_plan',{context_mode:'retained-delta',request_checkpoint_reused:true});
   emitDiagnosticEvent('chatgpt_tela_work','native_outcome_committed',{outcome:'final'});
  });
  withDiagnosticContext({scope_fingerprint:'9'.repeat(24),turn_fingerprint:turn},()=>emitDiagnosticEvent('chatgpt_tela_work','web_send_activation_started'));
  observer.finish();observer.finish();
  const rows=readFileSync(file,'utf8').trim().split('\n').map(s=>JSON.parse(s));
  const summaries=rows.filter(x=>x.stage==='native_cycle_summary');expect(summaries).toHaveLength(1);
  expect(summaries[0]).toMatchObject({local_final_committed:true,state:'completed',web_send_count:0,composer_measured:false});
 }finally{observer.finish();if(old===undefined)delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=old;rmSync(root,{recursive:true,force:true});}
});

test('late inspection cannot inflate completed duration and a new cycle cannot inherit the old final',()=>{
 const first=e('native_cycle_observation_started'),final=e('native_outcome_committed',{outcome:'final'});
 const late=e('inspection_input_observed');(late as any).ts=new Date(Date.parse(final.ts)+600000).toISOString();
 const finished=summarizeTurnDiagnostics([first,final,late]);
 expect(finished.durationMs).toBe(Date.parse(final.ts)-Date.parse(first.ts));expect(finished.evidence.postTerminalEvents).toBe(1);
 const next=e('native_cycle_observation_started');
 expect(summarizeTurnDiagnostics([first,final,next]).state).toBe('in_progress');
});

test('partial tool projection and repeated send boundary remain explicit',()=>{
 const r=summarizeTurnDiagnostics([e('native_tool_result_received',{operation_fingerprint:op}),
 e('native_tool_result_received',{operation_fingerprint:'8'.repeat(24)}),
 e('mcp_native_result_projected',{operation_fingerprint:op,text_bytes:10}),
 e('web_send_activation_started',{operation_fingerprint:op,phase:'turn'}),
 e('web_send_activation_started',{operation_fingerprint:op,phase:'turn'})]);
 expect(r.cost.toolText).toMatchObject({total:10,complete:false});
 expect(r.warnings).toContain('repeated_send_boundary');
});

test('preflight budget cause survives generic retirement and replay without claiming actual calls',()=>{
 const rows=[e('native_cycle_observation_started'),e('native_checkpoint_preparation_planned',{
  planned_model_calls:59,planned_transfer_estimate:5784080,model_call_budget:8,transfer_budget:791240,
  fragment_count:30,source_bytes:12000000,completed_receipt_count:0}),
  e('native_checkpoint_preparation_rejected',{reason_class:'model_calls',admitted_model_calls:0}),
  e('web_preparation_failed',{reason_class:'history_bootstrap_required',phase:'context_plan',planner_stage:'native_continuity'}),
  e('native_execution_failed'),e('native_turn_retired'),e('native_replay_rejected',{reason_class:'retired_turn'})];
 const r=summarizeTurnDiagnostics(rows);
 expect(r.diagnosis.firstFailure).toMatchObject({stage:'native_checkpoint_preparation_rejected',reason:'model_calls',plannerStage:'native_continuity'});
 expect(r.diagnosis.checkpointPlan).toMatchObject({estimateKind:'conservative_upper_bound',modelCalls:59,callBudget:8,completedReceipts:0});
 expect(r.diagnosis.budgetRefusal).toEqual({reason:'model_calls',admittedCalls:0});
 expect(r.diagnosis.replayDenials).toBe(1);expect(r.context.summaryAttempts).toBe(0);expect(r.submission.activations).toBe(0);
});

test('cycle receipt includes preparation before generic execution failure',()=>{
 const root=mkdtempSync(join(tmpdir(),'tela-cycle-preflight-')),file=join(root,'events.jsonl');
 const old=process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=file;
 const observer=startTurnDiagnosticSummary(scope,turn,request)!;
 try{
  withDiagnosticContext({scope_fingerprint:scope,turn_fingerprint:turn,request_fingerprint:request},()=>{
   emitDiagnosticEvent('chatgpt_tela_work','web_preparation_failed',{reason_class:'unclassified',planner_stage:'physical_context_fit',phase:'context_plan'});
   emitDiagnosticEvent('chatgpt_tela_work','native_execution_failed');
  });observer.finish();
  const rows=readFileSync(file,'utf8').trim().split('\n').map(s=>JSON.parse(s));
  expect(rows.find(x=>x.stage==='native_cycle_summary').first_reason_class).toBe('unclassified');
  expect(summarizeTurnDiagnostics(rows).diagnosis.certainty).toBe('insufficient_evidence');
 }finally{observer.finish();if(old===undefined)delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=old;rmSync(root,{recursive:true,force:true});}
});

test('generic unknown failure cannot claim a classified cause',()=>{
 const r=summarizeTurnDiagnostics([e('native_execution_failed',{reason_class:'unknown'}),e('native_turn_retired')]);
 expect(r.diagnosis.certainty).toBe('insufficient_evidence');
 const composer=summarizeTurnDiagnostics([e('native_context_fit_rejected',{reason_class:'composer_window_exceeded',phase:'composer_preflight',required_chars:5000,composer_limit:1000})]);
 expect(composer.diagnosis.fitRefusal).toMatchObject({phase:'composer_preflight',requiredChars:5000,composerLimit:1000});
 expect(composer.diagnosis.certainty).toBe('classified_boundary');
});

test('optional checkpoint refusal is not the cause of a later admitted task failure or a successful final',()=>{
 const optional=[e('native_checkpoint_preparation_rejected',{reason_class:'model_calls',admitted_model_calls:0}),
  e('native_working_checkpoint_deferred'),e('web_turn_plan',{context_mode:'retained-delta'})];
 const success=summarizeTurnDiagnostics([...optional,e('native_outcome_committed',{outcome:'final'})]);
 expect(success.diagnosis.firstFailure).toBeUndefined();expect(success.warnings).toEqual([]);
 const failed=summarizeTurnDiagnostics([...optional,e('native_execution_failed',{reason_class:'unknown'})]);
 expect(failed.diagnosis.firstFailure).toMatchObject({stage:'native_execution_failed',reason:'unknown'});
 expect(failed.diagnosis.certainty).toBe('insufficient_evidence');
});
