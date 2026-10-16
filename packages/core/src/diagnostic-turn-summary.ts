import { configuredDiagnosticRoot, emitDiagnosticEvent, observeDiagnosticEvents } from './diagnostic-events';
import { withDiagnosticContext } from './diagnostic-context';
import { structuralDiagnosticEvent, type StructuralDiagnosticEvent } from './diagnostic-store';

const fp = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{24}$/.test(x);
const number = (x: unknown): x is number => Number.isSafeInteger(x) && Number(x) >= 0;
const relevant = (stage: string) => /^(native_|web_turn_|web_context_|web_send_|browser_message_prepared|context_checkpoint_|http_transport_|inspection_ownership_revoked|tool_started|tool_settled|tool_failed|tool_error|web_media_upload_started|mcp_native_result_projected|approval_turn_resolution)/.test(stage);

/** Counts observed local events, never provider billing, comprehension or effect authority. */
export function summarizeTurnDiagnostics(events: readonly StructuralDiagnosticEvent[]) {
  const ordered = events.slice(-512).flatMap(e => { const s=structuralDiagnosticEvent(e);return s?[s]:[]; }).sort((a,b)=>a.ts.localeCompare(b.ts));
  let begin=-1;
  for(let i=ordered.length-1;i>=0;i--)if(ordered[i]!.stage==='native_cycle_observation_started'||ordered[i]!.stage==='native_steering_cycle_started'){begin=i;break;}
  const rows = begin>=0?ordered.slice(begin):ordered;
  const at = (stage: string) => rows.filter(e=>e.stage===stage);
  const sum = (stage: string, field: string) => {
    const selected=at(stage), values=selected.map(e=>e[field]).filter(number);
    return { observed:values.length, total:values.reduce((a,b)=>Math.min(Number.MAX_SAFE_INTEGER,a+b),0), complete:selected.length>0&&values.length===selected.length };
  };
  const unique = (stage: string) => new Set(at(stage).map(e=>e.operation_fingerprint).filter(fp)).size;
  const plans=at('web_turn_plan'), lastPlan=plans.at(-1), acceptance=at('web_turn_identity_accepted').at(-1);
  const final=rows.some(e=>e.stage==='native_outcome_committed'&&e.outcome==='final');
  const failure=rows.find(e=>/^(web_turn_acceptance_timeout|native_execution_failed|web_preparation_failed)$/.test(e.stage));
  const last=rows.at(-1), retired=at('native_turn_retired').at(-1);
  const state=final?'completed':failure?'failed':retired?'retired_without_final':events.length>512?'unknown':'in_progress';
  const bytes=sum('web_send_activation_started','composer_wire_bytes');
  const protocol=sum('web_send_activation_started','protocol_wire_bytes');
  const body=sum('web_send_activation_started','context_wire_bytes');
  const results=sum('mcp_native_result_projected','text_bytes');
  const expectedResults=unique('native_tool_result_received')+unique('native_tool_result_error')+unique('native_tool_result_signal_anomaly');
  results.complete=results.complete&&at('mcp_native_result_projected').every(e=>e.text_measurement_complete!==false)&&expectedResults>0&&unique('mcp_native_result_projected')===expectedResults;
  const mcpRequest=sum('tool_started','request_bytes'),mcpResult=sum('tool_settled','result_bytes');
  mcpRequest.complete=mcpRequest.complete&&expectedResults>0&&unique('tool_started')===expectedResults;
  mcpResult.complete=mcpResult.complete&&expectedResults>0&&unique('tool_settled')===expectedResults;
  const terminal = rows.filter(e=>e.stage==='native_outcome_committed'&&e.outcome==='final').at(-1)??retired;
  const end=terminal??last;
  const duration=rows.length&&end?Math.max(0,Date.parse(end.ts)-Date.parse(rows[0]!.ts)):undefined;
  const elapsed=(from:string,to:string)=>{const a=at(from)[0],b=at(to)[0];return a&&b&&b.ts>=a.ts?Date.parse(b.ts)-Date.parse(a.ts):undefined;};
  const activationKeys=at('web_send_activation_started').filter(e=>fp(e.operation_fingerprint))
    .map(e=>[e.operation_fingerprint,e.phase].join(':'));
  const repeatActivations=activationKeys.length-new Set(activationKeys).size;
  const warnings=[...(events.length>512?['event_window_clipped']:[]),...(failure&&!final?['execution_or_acceptance_failed']:[]),
    ...(failure&&final?['recovered_failure_observed']:[]),...(!final&&retired?['retired_without_final']:[]),
    ...(bytes.complete&&body.complete&&protocol.complete&&bytes.total!==body.total+protocol.total?['composer_byte_partition_mismatch']:[]),...(repeatActivations?['repeated_send_boundary']:[]),...(at('native_tool_result_error').length?['tool_reported_error']:[])];
  return {
    contractVersion:1, state, localFinalCommitted:final, durationMs:duration,completedAt:terminal?.ts,observationThrough:last?.ts,warnings,
    timing:{preparationToPlanMs:elapsed('native_response_observer_started','web_turn_plan'),
      sendToAcceptanceMs:elapsed('web_send_activation_started','web_turn_identity_accepted'),
      acceptedToFirstToolMs:elapsed('web_turn_identity_accepted','native_tool_queued'),
      acceptedToFinalMs:rows.find(e=>e.stage==='native_outcome_committed'&&e.outcome==='final')&&at('web_turn_identity_accepted')[0]
        ?Date.parse(rows.find(e=>e.stage==='native_outcome_committed'&&e.outcome==='final')!.ts)-Date.parse(at('web_turn_identity_accepted')[0]!.ts):undefined},
    submission:{activations:at('web_send_activation_started').length, accepted:at('web_turn_identity_accepted').length,
      causal:acceptance?.causal_receipt===true, observedPayloadMatched:typeof acceptance?.accepted_fingerprint_matches==='boolean'?acceptance.accepted_fingerprint_matches:undefined,
      firstFailure:failure?.first_reason_class??failure?.reason_class??failure?.stage,
      transientIdentityWaits:at('web_turn_identity_pending').length, identityResumes:at('web_turn_identity_resumed').length,
      observationTimeouts:at('web_turn_acceptance_timeout').length, repeatedActivationKeys:repeatActivations},
    transport:{responseObservers:at('native_response_observer_started').length, observerReplacements:at('native_response_observer_replaced').length,
      disconnects:at('http_transport_closed').length},
    tools:{queued:unique('native_tool_queued'), results:unique('native_tool_result_received')+unique('native_tool_result_error')+unique('native_tool_result_signal_anomaly'),
      released:unique('native_tool_result_released'), releaseCoverage:unique('native_tool_result_released')>0?'observed':'unmeasured', reportedErrors:at('native_tool_result_error').length,
      incompleteSignalInspections:rows.filter(e=>e.stage.startsWith('native_tool_result_')&&e.inspection_complete===false).length,
      projection:results},
    context:{plans:plans.length, mode:lastPlan?.context_mode, checkpointReused:typeof lastPlan?.request_checkpoint_reused==='boolean'?lastPlan.request_checkpoint_reused:undefined,
      checkpointProduced:typeof lastPlan?.request_checkpoint_produced==='boolean'?lastPlan.request_checkpoint_produced:undefined,
      logicalEstimate:number(lastPlan?.logical_estimate)?lastPlan.logical_estimate:undefined,
      transferEstimate:number(lastPlan?.transfer_estimate)?lastPlan.transfer_estimate:undefined,
      summaryAttempts:at('native_checkpoint_model_started').length, summaryCompleted:rows.filter(e=>e.stage==='native_visible_prefix_stage_settled'&&e.outcome==='completed').length,
      summaryReused:rows.filter(e=>e.stage==='native_visible_prefix_stage_settled'&&e.outcome==='reused').length,
      settled:at('web_context_settled').some(e=>e.status==='completed')},
    cost:{composer:bytes, context:body, protocol, preparedComposer:sum('browser_message_prepared','composer_wire_bytes'), attachments:sum('web_media_upload_started','total_bytes'), toolText:results,
      mcpRequestEnvelope:mcpRequest,mcpResultEnvelope:mcpResult, billedUsage:'unmeasured', semanticRecall:'not_evaluated'},
    evidence:{rows:rows.length, clipped:events.length>512,postTerminalEvents:terminal?rows.filter(e=>e.ts>terminal.ts).length:0, scope:'observed_local_events', hostDisplay:'not_observed'},
  };
}

/** Per planner cycle, event-driven and process-local. No history reads, timers or model calls. */
export function startTurnDiagnosticSummary(scope: string, turn: string, request?: string) {
  if(!fp(scope)||!fp(turn)||!configuredDiagnosticRoot())return;
  const startedAt=performance.now();
  const rows:StructuralDiagnosticEvent[]=[];const requests=new Set<string>(fp(request)?[request]:[]);
  let clipped=false,closed=false;
  const stop=observeDiagnosticEvents(row=>{
    if(closed||row.stage==='native_cycle_summary'||!relevant(row.stage))return;
    const direct=fp(row.scope_fingerprint)&&fp(row.turn_fingerprint);
    if(direct?(row.scope_fingerprint!==scope||row.turn_fingerprint!==turn):!fp(row.request_fingerprint)||!requests.has(row.request_fingerprint))return;
    if(fp(row.request_fingerprint)&&requests.size<64)requests.add(row.request_fingerprint);
    if(rows.length>=512){clipped=true;rows.shift();}rows.push(row);
  });
  if(!stop)return;
  withDiagnosticContext({scope_fingerprint:scope,turn_fingerprint:turn,...(fp(request)?{request_fingerprint:request}:{})},()=>
    emitDiagnosticEvent('chatgpt_tela_work','native_cycle_observation_started'));
  return {finish(){
    if(closed)return;closed=true;stop();
    try{
      const s=summarizeTurnDiagnostics(rows);
      withDiagnosticContext({scope_fingerprint:scope,turn_fingerprint:turn},()=>emitDiagnosticEvent('chatgpt_tela_work','native_cycle_summary',{
        contract_version:1,state:s.state,local_final_committed:s.localFinalCommitted,summary_complete:!clipped,process_local_only:true,
        observed_event_count:rows.length,web_send_count:s.submission.activations,web_accept_count:s.submission.accepted,
        causal_receipt:s.submission.causal,observer_count:s.transport.responseObservers,observer_replacement_count:s.transport.observerReplacements,
        disconnect_count:s.transport.disconnects,tool_queued_count:s.tools.queued,tool_result_count:s.tools.results,tool_release_count:s.tools.released,
        summary_attempt_count:s.context.summaryAttempts,summary_reuse_count:s.context.summaryReused,
        ...(s.submission.firstFailure?{first_reason_class:String(s.submission.firstFailure)}:{}),
        context_settled:s.context.settled,composer_measured:s.cost.composer.complete,protocol_measured:s.cost.protocol.complete,
        composer_wire_bytes:s.cost.composer.total,context_wire_bytes:s.cost.context.total,protocol_wire_bytes:s.cost.protocol.total,
        duration_ms:Math.max(0,Math.round(performance.now()-startedAt)),
        ...(s.context.mode?{context_mode:String(s.context.mode)}:{}),
        ...(s.context.checkpointReused===undefined?{}:{request_checkpoint_reused:s.context.checkpointReused}),
        ...(s.context.logicalEstimate===undefined?{}:{logical_estimate:s.context.logicalEstimate}),
        ...(s.context.transferEstimate===undefined?{}:{transfer_estimate:s.context.transferEstimate}),
      }));
    }catch{/* Diagnostics never affect lifecycle. */}
  }};
}
