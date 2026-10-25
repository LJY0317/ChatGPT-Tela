import {expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
import {summarizeTurnDiagnostics,startTurnDiagnosticSummary} from './diagnostic-turn-summary';
import {emitDiagnosticEvent} from './diagnostic-events';import{withDiagnosticContext}from'./diagnostic-context';
import {listDiagnosticIncidents,readDiagnosticIncident,readDiagnosticTail} from './diagnostic-store';
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
   emitDiagnosticEvent('chatgpt_tela_work','web_preparation_failed',{reason_class:'unclassified',error_kind:'type_error',planner_stage:'checkpoint_lookup',planner_substage:'working_checkpoint_publication_read',phase:'context_plan'});
   emitDiagnosticEvent('chatgpt_tela_work','native_execution_failed');
  });observer.finish();
  const rows=readFileSync(file,'utf8').trim().split('\n').map(s=>JSON.parse(s));
  expect(rows.find(x=>x.stage==='native_cycle_summary').first_reason_class).toBe('unclassified');
   expect(rows.find(x=>x.stage==='native_cycle_summary').first_error_kind).toBe('type_error');
   expect(rows.find(x=>x.stage==='native_cycle_summary').first_planner_substage).toBe('working_checkpoint_publication_read');
   expect(readDiagnosticTail(file).events.find(x=>x.stage==='native_cycle_summary')?.first_planner_substage).toBe('working_checkpoint_publication_read');
    expect(summarizeTurnDiagnostics(rows).diagnosis.firstFailure).toMatchObject({reason:'unclassified',errorKind:'type_error',plannerSubstage:'working_checkpoint_publication_read'});
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

test('checkpoint rejection keeps its exact reason through the live cycle receipt',()=>{
 const root=mkdtempSync(join(tmpdir(),'tela-checkpoint-rejection-')),file=join(root,'events.jsonl');
 const old=process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=file;
 const observer=startTurnDiagnosticSummary(scope,turn,request)!;
 try{
  // Isolated summarizer events have the preparation request, not the Native turn context.
  withDiagnosticContext({request_fingerprint:request,operation_fingerprint:op},()=>{
   emitDiagnosticEvent('chatgpt_tela_work','checkpoint_json_parse_failed',{body_bytes:9379,json_error_offset:2724});
   emitDiagnosticEvent('chatgpt_tela_work','checkpoint_response_rejected',{reason_class:'json_invalid'});
   emitDiagnosticEvent('chatgpt_tela_work','checkpoint_operation_failed',{phase:'completed',completion_observed:true,reason_class:'json_invalid'});
  },false);
  withDiagnosticContext({scope_fingerprint:scope,turn_fingerprint:turn,request_fingerprint:request},()=>{
   emitDiagnosticEvent('chatgpt_tela_work','web_preparation_failed',{reason_class:'history_bootstrap_required'});
   emitDiagnosticEvent('chatgpt_tela_work','native_turn_retired');
  });
  observer.finish();
  const rows=readFileSync(file,'utf8').trim().split('\n').map(s=>JSON.parse(s));
  expect(rows.find(x=>x.stage==='native_cycle_summary').first_reason_class).toBe('json_invalid');
  expect(summarizeTurnDiagnostics(rows).diagnosis.firstFailure).toMatchObject({stage:'checkpoint_response_rejected',reason:'json_invalid'});
  const diagnostics=join(root,'diagnostics'),incidents=listDiagnosticIncidents(diagnostics);
  expect(incidents.some(item=>JSON.stringify(readDiagnosticIncident(diagnostics,item.ref)).includes('checkpoint_response_rejected'))).toBe(true);
 }finally{observer.finish();if(old===undefined)delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=old;rmSync(root,{recursive:true,force:true});}
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

test('exact Native interrupted status has unknown human actor even after transport cleanup',()=>{
 const interrupted=summarizeTurnDiagnostics([
  e('native_watch_terminated',{reason_class:'native_interrupted'}),
  e('http_transport_closed',{close_source:'response_closed'}),
  e('native_turn_retired',{reason_class:'owner_signal'}),
 ]);
 expect(interrupted.state).toBe('interrupted');
 expect(interrupted.diagnosis.termination).toMatchObject({
  cause:'native_interrupted_observed',confidence:'confirmed_boundary',actor:'unknown',
  userStopConfirmed:false,firstObservedStage:'native_watch_terminated',nextAction:'inspect_host_stop_receipt',
 });
 const completed=summarizeTurnDiagnostics([
  e('native_outcome_committed',{outcome:'final'}),
  e('native_response_observer_ended',{reason_class:'gateway_shutdown'}),
 ]);
 expect(completed.diagnosis.termination).toMatchObject({
  cause:'not_interrupted',userStopConfirmed:false,nextAction:'none',
 });
});

test('progress summary distinguishes local body delivery from host rendering',()=>{
 const result=summarizeTurnDiagnostics([e('web_public_progress_title_only'),e('web_public_progress_ready'),e('public_progress_published'),e('public_progress_sse_queued'),e('public_progress_sse_pulled'),e('public_progress_transport_observed',{accepted:false})]);
 expect(result.progress).toEqual({titleOnlyObservations:1,ready:1,published:1,queued:1,pulled:1,transportRefusals:1,hostDisplay:'not_observed'});
 expect(result.state).toBe('in_progress');
});

test('task input and checkpoint preparation costs remain separate',()=>{
 const preparation='5'.repeat(24);
 const result=summarizeTurnDiagnostics([
  e('web_turn_plan',{operation_fingerprint:op,context_mode:'retained-delta'}),
  e('web_send_activation_started',{operation_fingerprint:op,composer_wire_bytes:100}),
  e('web_send_activation_started',{operation_fingerprint:preparation,composer_wire_bytes:50}),
  e('checkpoint_transfer_planned',{operation_fingerprint:preparation,transfer_estimate:23000}),
  e('context_checkpoint_provider_invoked',{operation_fingerprint:preparation}),
   e('checkpoint_operation_observed',{operation_fingerprint:preparation,submission_accepted:true}),
  e('native_checkpoint_efficiency_settled',{model_calls:1}),
  e('native_visible_prefix_stage_settled',{operation_fingerprint:preparation,duration_ms:10000}),
  e('native_tool_request_rejected',{reason_class:'duplicate_call'}),
 ]);
 expect(result.state).toBe('in_progress');
 expect(result.cost.taskComposer).toEqual({observed:1,total:100,complete:true});
 expect(result.cost.composer.total).toBe(150);
 expect(result.cost.preparationTransfer.total).toBe(23000);
 expect(result.cost.preparationModelDuration.total).toBe(10000);
});

test('failed and duplicate provider events count one real invocation and its failed duration',()=>{
 const stage='5'.repeat(24);
 const r=summarizeTurnDiagnostics([
  e('native_checkpoint_model_started',{operation_fingerprint:stage}),
  e('context_checkpoint_provider_invoked',{operation_fingerprint:stage}),
  e('context_checkpoint_provider_invoked',{operation_fingerprint:stage}),
  e('checkpoint_operation_observed',{operation_fingerprint:stage,submission_accepted:true}),
  e('checkpoint_transfer_planned',{operation_fingerprint:stage,model_calls:1}),
  e('checkpoint_response_rejected',{operation_fingerprint:stage,reason_class:'json_invalid'}),
  e('native_checkpoint_model_failed',{operation_fingerprint:stage,duration_ms:34601}),
  e('native_checkpoint_model_failed',{operation_fingerprint:stage,duration_ms:34601})]);
 expect(r.cost.preparationModelCalls).toEqual({observed:1,total:1,complete:true});
 expect(r.cost.preparationModelDuration).toEqual({observed:1,total:34601,complete:true});
 expect(r.cost.billedUsage).toBe('unmeasured');
});

test('planned, rejected and reused stages without provider invocation cost zero',()=>{
 const r=summarizeTurnDiagnostics([
  e('native_checkpoint_preparation_planned',{planned_model_calls:1}),
  e('native_checkpoint_model_started',{operation_fingerprint:op}),
  e('checkpoint_transfer_planned',{operation_fingerprint:op,model_calls:1}),
  e('native_checkpoint_model_failed',{operation_fingerprint:op,duration_ms:42}),
  e('native_visible_prefix_stage_settled',{outcome:'reused',duration_ms:100}),
  e('native_checkpoint_efficiency_settled',{model_calls:1})]);
 expect(r.cost.preparationModelCalls.total).toBe(0);
 expect(r.cost.preparationModelDuration.total).toBe(0);
});

test('cycle closure archives sparse context evidence locally without private prose',()=>{
 const root=mkdtempSync(join(tmpdir(),'tela-durable-cycle-')),file=join(root,'events.jsonl');
 const prior=process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=file;
 const observer=startTurnDiagnosticSummary(scope,turn,request)!;
 try{
  withDiagnosticContext({scope_fingerprint:scope,turn_fingerprint:turn,request_fingerprint:request},()=>{
   emitDiagnosticEvent('chatgpt_tela_work','web_retained_context_decision',{reason_class:'retained_match',reuse_eligible:true});
   emitDiagnosticEvent('chatgpt_tela_work','web_turn_plan',{context_mode:'retained-delta',transfer_estimate:4});
   withDiagnosticContext({operation_fingerprint:op},()=>{
    emitDiagnosticEvent('chatgpt_tela_work','context_checkpoint_provider_invoked');
    emitDiagnosticEvent('chatgpt_tela_work','checkpoint_operation_observed',{submission_accepted:true});
    emitDiagnosticEvent('chatgpt_tela_work','native_checkpoint_model_failed',{duration_ms:34601});
   });
   emitDiagnosticEvent('chatgpt_tela_work','native_outcome_committed',{outcome:'final'});
  });
  observer.finish();observer.finish();
  const incidents=listDiagnosticIncidents(join(root,'diagnostics'));
  expect(incidents).toHaveLength(1);
  const incident=readDiagnosticIncident(join(root,'diagnostics'),incidents[0]!.ref) as {stage:string;timeline:StructuralDiagnosticEvent[]};
  expect(incident.stage).toBe('native_cycle_summary');
  expect(incident.timeline.map((row:any)=>row.stage)).toEqual(['web_retained_context_decision','web_turn_plan',
   'context_checkpoint_provider_invoked','checkpoint_operation_observed','native_checkpoint_model_failed','native_cycle_summary']);
  const restored=summarizeTurnDiagnostics(incident.timeline);
  expect(restored.cost.preparationModelCalls.total).toBe(1);
  expect(restored.cost.preparationModelDuration.total).toBe(34601);
 }finally{observer.finish();if(prior===undefined)delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=prior;rmSync(root,{recursive:true,force:true});}
});

test('cycle incident retains checkpoint selection and distinct request decisions after log rotation',()=>{
 const root=mkdtempSync(join(tmpdir(),'tela-context-cycle-')),file=join(root,'events.jsonl');
 const prior=process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=file;
 const observer=startTurnDiagnosticSummary(scope,turn,request)!;
 try{
  withDiagnosticContext({scope_fingerprint:scope,turn_fingerprint:turn},()=>{
   for(const [id,reason,chosen] of [[request,'no_committed_context',false],['6'.repeat(24),'retained_match',true]] as const){
    withDiagnosticContext({request_fingerprint:id},()=>{
     emitDiagnosticEvent('chatgpt_tela_work','web_retained_context_decision',{reason_class:reason,reuse_eligible:chosen});
     emitDiagnosticEvent('chatgpt_tela_codex','native_working_checkpoint_selected',{
      candidate_count:1,covered_revision_count:chosen?4:0,checkpoint_reused:chosen,
      reason_class:chosen?'selected':'canonical_ancestry_mismatch'});
    });
   }
  });
  observer.finish();
  const incidents=listDiagnosticIncidents(join(root,'diagnostics'));
  expect(incidents).toHaveLength(1);
  const incident=readDiagnosticIncident(join(root,'diagnostics'),incidents[0]!.ref) as {timeline:StructuralDiagnosticEvent[]};
  expect(incident.timeline.filter(row=>row.stage==='web_retained_context_decision').map(row=>row.reason_class))
   .toEqual(['no_committed_context','retained_match']);
  expect(incident.timeline.filter(row=>row.stage==='native_working_checkpoint_selected').map(row=>row.checkpoint_reused))
   .toEqual([false,true]);
  expect(incident.timeline.filter(row=>row.stage==='native_working_checkpoint_selected').map(row=>row.reason_class))
   .toEqual(['canonical_ancestry_mismatch','selected']);
  expect(incident.timeline.filter(row=>row.stage==='native_working_checkpoint_selected').map(row=>row.request_fingerprint))
   .toEqual([request,'6'.repeat(24)]);
 }finally{observer.finish();if(prior===undefined)delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=prior;rmSync(root,{recursive:true,force:true});}
});
