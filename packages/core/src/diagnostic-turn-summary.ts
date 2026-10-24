import { configuredDiagnosticRoot, emitDiagnosticEvent, observeDiagnosticEvents } from './diagnostic-events';
import { withDiagnosticContext } from './diagnostic-context';
import { DIAGNOSTIC_LIMITS, structuralDiagnosticEvent, writeDiagnosticIncident, type StructuralDiagnosticEvent } from './diagnostic-store';

const fp = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{24}$/.test(x);
const number = (x: unknown): x is number => Number.isSafeInteger(x) && Number(x) >= 0;
const relevant = (stage: string) => /^(native_|web_turn_|web_context_|web_retained_context_|web_send_|web_tool_bridge_|web_public_progress_|web_model_picker_|public_progress_|mcp_rpc_|mcp_native_inventory_|mcp_chat_inventory_|web_preparation_failed|browser_message_prepared|context_checkpoint_|checkpoint_(transfer_|response_|json_|operation_)|http_transport_|inspection_ownership_revoked|tool_started|tool_settled|tool_failed|tool_error|web_media_upload_started|mcp_native_result_projected|approval_turn_resolution)/.test(stage);

/** A Native interrupted status proves the turn ended, but never who pressed Stop.
 * Transport closure proves even less. Later cleanup cannot replace the first
 * observed boundary or turn an earlier completed final into an interruption. */
function diagnoseTermination(rows: readonly StructuralDiagnosticEvent[], finalCommitted: boolean, clipped: boolean) {
  const observed = rows.filter(e =>
    e.stage === 'native_watch_terminated'
    || e.stage === 'native_response_observer_ended'
    || e.stage === 'native_turn_retired'
    || e.stage === 'native_execution_failed'
    || e.stage === 'web_preparation_failed'
    || e.stage === 'http_transport_closed'
    || e.stage === 'http_transport_error');
  const watcher = observed.find(e => e.stage === 'native_watch_terminated' &&
    ['native_interrupted', 'native_failed', 'native_completed', 'observer_disconnected'].includes(String(e.reason_class)));
  const failure = observed.find(e => e.stage === 'native_execution_failed' || e.stage === 'web_preparation_failed');
  const shutdown = observed.find(e => e.stage === 'native_response_observer_ended' && e.reason_class === 'gateway_shutdown'
    || e.stage === 'native_turn_retired' && e.reason_class === 'gateway_closed');
  const transportError = observed.find(e => e.stage === 'http_transport_error');
  const disconnect = observed.find(e => e.stage === 'http_transport_closed'
    || e.stage === 'native_response_observer_ended' && e.reason_class === 'client_cancel_or_disconnect');
  const ownerChange = observed.find(e => e.stage === 'native_turn_retired' && e.reason_class === 'owner_changed');
  const cause = finalCommitted ? 'not_interrupted'
    : watcher?.reason_class === 'native_interrupted' ? 'native_interrupted_observed'
      : watcher?.reason_class === 'native_failed' ? 'native_failure_observed'
        : watcher?.reason_class === 'native_completed' ? 'native_completed_result_unobserved'
          : failure ? 'execution_failure_observed'
            : shutdown ? 'owner_shutdown_confirmed'
              : ownerChange ? 'native_owner_changed'
                : watcher?.reason_class === 'observer_disconnected' ? 'native_lifecycle_observer_lost'
                  : transportError ? 'network_error_observed'
                    : disconnect ? 'transport_disconnect_observed' : 'unknown';
  const confidence = cause === 'not_interrupted' || cause === 'native_interrupted_observed'
    || cause === 'native_failure_observed' || cause === 'native_completed_result_unobserved'
    || cause === 'owner_shutdown_confirmed' ? 'confirmed_boundary'
    : cause === 'unknown' ? 'unknown' : 'partial';
  const nextAction = cause === 'native_interrupted_observed' ? 'inspect_host_stop_receipt'
    : cause === 'native_completed_result_unobserved' ? 'reconcile_exact_native_turn'
      : cause === 'owner_shutdown_confirmed' ? 'inspect_service_lifecycle'
        : cause === 'execution_failure_observed' || cause === 'native_failure_observed' ? 'inspect_first_failure'
          : cause === 'not_interrupted' ? 'none'
            : cause === 'unknown' ? 'inspect_host_or_missing_evidence' : 'inspect_client_or_owner_evidence';
  return { cause, confidence, actor: 'unknown', userStopConfirmed: false,
    firstObservedAt: observed[0]?.ts, lastObservedAt: observed.at(-1)?.ts,
    firstObservedStage: observed[0]?.stage, evidenceStages: observed.slice(0, 16).map(e => e.stage),
    coverage: clipped ? 'local_events_clipped' : 'local_events_only',
    uncertainties: cause === 'not_interrupted' ? [] : ['host_stop_button_not_observed'],
    nextAction };
}

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
  const terminalFailure=rows.find(e=>/^(web_turn_acceptance_timeout|native_execution_failed|web_preparation_failed)$/.test(e.stage));
  const terminalIndex=terminalFailure?rows.indexOf(terminalFailure):rows.length;
  // Optional maintenance may refuse its budget while the retained task still succeeds.
  // A later admitted plan or explicit deferral separates that refusal from execution failure.
  const causalRefusal=rows.slice(0,terminalIndex).find((e,index)=>
    /^(native_checkpoint_preparation_rejected|native_context_source_rejected|native_context_fit_rejected|checkpoint_response_rejected)$/.test(e.stage)
    && (terminalFailure || e.stage!=='native_checkpoint_preparation_rejected')
    && !rows.slice(index+1,terminalIndex).some(next=>
      /^(native_working_checkpoint_deferred|web_turn_plan|web_turn_identity_accepted)$/.test(next.stage)));
  const failure=causalRefusal??terminalFailure;
  const firstFailureReason=failure?.first_reason_class??failure?.reason_class;
  const preparationFailure=at('web_preparation_failed')[0];
  const checkpointPlan=at('native_checkpoint_preparation_planned').at(-1);
  const budgetRefusal=at('native_checkpoint_preparation_rejected')[0];
  const fitRefusal=at('native_context_fit_rejected')[0];
  const last=rows.at(-1), retired=at('native_turn_retired').at(-1);
  const nativeInterrupted=at('native_watch_terminated').some(e=>e.reason_class==='native_interrupted');
  const state=final?'completed':failure?'failed':nativeInterrupted?'interrupted':retired?'retired_without_final':events.length>512?'unknown':'in_progress';
  const bytes=sum('web_send_activation_started','composer_wire_bytes');
  const protocol=sum('web_send_activation_started','protocol_wire_bytes');
  const body=sum('web_send_activation_started','context_wire_bytes');
  const results=sum('mcp_native_result_projected','text_bytes');
  const expectedResults=unique('native_tool_result_received')+unique('native_tool_result_error');
  results.complete=results.complete&&at('mcp_native_result_projected').every(e=>e.text_measurement_complete!==false)&&expectedResults>0&&unique('mcp_native_result_projected')===expectedResults;
  const mcpRequest=sum('tool_started','request_bytes'),mcpResult=sum('tool_settled','result_bytes');
  mcpRequest.complete=mcpRequest.complete&&expectedResults>0&&unique('tool_started')===expectedResults;
  mcpResult.complete=mcpResult.complete&&expectedResults>0&&unique('tool_settled')===expectedResults;
  const taskOperations = new Set(at('web_turn_plan').map(e=>e.operation_fingerprint).filter(fp));
  const taskSends = at('web_send_activation_started').filter(e=>fp(e.operation_fingerprint)&&taskOperations.has(e.operation_fingerprint));
  const taskComposer = {observed:taskSends.length,total:taskSends.reduce((n,e)=>n+(number(e.composer_wire_bytes)?e.composer_wire_bytes:0),0),
    complete:taskSends.length>0&&taskSends.every(e=>number(e.composer_wire_bytes))};
  const terminal = rows.filter(e=>e.stage==='native_outcome_committed'&&e.outcome==='final').at(-1)??retired;
  const end=terminal??last;
  const duration=rows.length&&end?Math.max(0,Date.parse(end.ts)-Date.parse(rows[0]!.ts)):undefined;
  const elapsed=(from:string,to:string)=>{const a=at(from)[0],b=at(to)[0];return a&&b&&b.ts>=a.ts?Date.parse(b.ts)-Date.parse(a.ts):undefined;};
  const activationKeys=at('web_send_activation_started').filter(e=>fp(e.operation_fingerprint))
    .map(e=>[e.operation_fingerprint,e.phase].join(':'));
  const repeatActivations=activationKeys.length-new Set(activationKeys).size;
  // Count only operations that reached the provider, including failed results.
  // A claimed stage, planned transfer or completed receipt is not a model invocation.
  const invoked=new Set(at('context_checkpoint_provider_invoked').map(e=>e.operation_fingerprint).filter(fp));
  const accepted=new Set(at('checkpoint_operation_observed')
    .filter(e=>e.submission_accepted===true).map(e=>e.operation_fingerprint).filter(fp));
  const invokedOperations=new Set([...invoked].filter(operation=>accepted.has(operation)));
  const preparationModelCalls={observed:invokedOperations.size,total:invokedOperations.size,complete:invokedOperations.size>0};
  const settledDurations=new Map<string,number>();
  for(const row of rows.filter(e=>e.stage==='native_visible_prefix_stage_settled'||e.stage==='native_checkpoint_model_failed')){
    if(fp(row.operation_fingerprint)&&invokedOperations.has(row.operation_fingerprint)&&number(row.duration_ms))
      settledDurations.set(row.operation_fingerprint,row.duration_ms);
  }
  const preparationModelDuration={observed:settledDurations.size,total:[...settledDurations.values()].reduce((n,ms)=>n+ms,0),
    complete:invokedOperations.size>0&&settledDurations.size===invokedOperations.size};
  const warnings=[...(events.length>512?['event_window_clipped']:[]),...(failure&&!final?['execution_or_acceptance_failed']:[]),
    ...(failure&&final?['recovered_failure_observed']:[]),...(!final&&retired?['retired_without_final']:[]),
    ...(bytes.complete&&body.complete&&protocol.complete&&bytes.total!==body.total+protocol.total?['composer_byte_partition_mismatch']:[]),...(repeatActivations?['repeated_send_boundary']:[]),...(at('native_tool_result_error').length?['tool_reported_error']:[])];
  return {
    diagnosis:{ firstFailure:failure?{at:failure.ts,stage:failure.stage,reason:failure.first_reason_class??failure.reason_class??failure.stage,
      phase:failure.phase,plannerStage:preparationFailure?.planner_stage}:undefined,
      preparation:preparationFailure?{phase:preparationFailure.phase,plannerStage:preparationFailure.planner_stage,
        reason:preparationFailure.reason_class,requiredEstimate:preparationFailure.required_estimate,fitBudget:preparationFailure.fit_budget}:undefined,
      checkpointPlan:checkpointPlan?{estimateKind:'conservative_upper_bound',modelCalls:checkpointPlan.planned_model_calls,
        inputEstimate:checkpointPlan.planned_transfer_estimate,callBudget:checkpointPlan.model_call_budget,inputBudget:checkpointPlan.transfer_budget,
        sourceBytes:checkpointPlan.source_bytes,fragments:checkpointPlan.fragment_count,completedReceipts:checkpointPlan.completed_receipt_count}:undefined,
      budgetRefusal:budgetRefusal?{reason:budgetRefusal.reason_class,admittedCalls:budgetRefusal.admitted_model_calls}:undefined,
      fitRefusal:fitRefusal?{reason:fitRefusal.reason_class,phase:fitRefusal.phase,requiredChars:fitRefusal.required_chars,composerLimit:fitRefusal.composer_limit,logicalEstimate:fitRefusal.logical_estimate,budget:fitRefusal.fit_budget,
        revisions:fitRefusal.revision_count,checkpointSelected:fitRefusal.checkpoint_selected,largestRevisionBytes:fitRefusal.largest_revision_bytes,
        authorityBytes:fitRefusal.authority_bytes,userBytes:fitRefusal.user_bytes,toolBytes:fitRefusal.tool_bytes,mediaCount:fitRefusal.media_count}:undefined,
      termination:diagnoseTermination(rows,final,events.length>512),
      replayDenials:at('native_replay_rejected').length,
      certainty:typeof firstFailureReason==='string'&&!['unknown','unclassified'].includes(firstFailureReason)?'classified_boundary':'insufficient_evidence'},
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
    progress:{titleOnlyObservations:at('web_public_progress_title_only').length,
      ready:at('web_public_progress_ready').length,published:at('public_progress_published').length,
      queued:at('public_progress_sse_queued').length,pulled:at('public_progress_sse_pulled').length,
      transportRefusals:at('public_progress_transport_observed').filter(e=>e.accepted===false).length,
      hostDisplay:'not_observed'},
    tools:{queued:unique('native_tool_queued'), results:unique('native_tool_result_received')+unique('native_tool_result_error'),
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
    cost:{composer:bytes, context:body, protocol, taskComposer,
      preparationTransfer:sum('checkpoint_transfer_planned','transfer_estimate'),
      preparationModelCalls,
      preparationModelDuration, preparedComposer:sum('browser_message_prepared','composer_wire_bytes'), attachments:sum('web_media_upload_started','total_bytes'), toolText:results,
      mcpRequestEnvelope:mcpRequest,mcpResultEnvelope:mcpResult, billedUsage:'unmeasured', semanticRecall:'not_evaluated'},
    evidence:{rows:rows.length, clipped:events.length>512,postTerminalEvents:terminal?rows.filter(e=>e.ts>terminal.ts).length:0, scope:'observed_local_events', hostDisplay:'not_observed'},
  };
}

/** Per planner cycle, event-driven and process-local. No history reads, timers or model calls. */
export function startTurnDiagnosticSummary(scope: string, turn: string, request?: string) {
  if(!fp(scope)||!fp(turn)||!configuredDiagnosticRoot())return;
  const startedAt=performance.now();
  const durable = new Map<string,StructuralDiagnosticEvent>();
  const rows:StructuralDiagnosticEvent[]=[];const requests=new Set<string>(fp(request)?[request]:[]);
  let clipped=false,closed=false;
  let receipt: StructuralDiagnosticEvent | undefined;
  const stop=observeDiagnosticEvents(row=>{
    if(closed&&row.stage==='native_cycle_summary'&&row.scope_fingerprint===scope&&row.turn_fingerprint===turn){receipt=row;return;}
    if(closed||row.stage==='native_cycle_summary'||!relevant(row.stage))return;
    const direct=fp(row.scope_fingerprint)&&fp(row.turn_fingerprint);
    if(direct?(row.scope_fingerprint!==scope||row.turn_fingerprint!==turn):!fp(row.request_fingerprint)||!requests.has(row.request_fingerprint))return;
    if(fp(row.request_fingerprint)&&requests.size<64)requests.add(row.request_fingerprint);
    if (/^(web_turn_plan|web_retained_context_.*|web_context_settled|web_send_activation_started|native_seed_authority_observed|checkpoint_transfer_planned|checkpoint_operation_observed|checkpoint_response_rejected|checkpoint_json_parse_failed|native_checkpoint_efficiency_settled|native_checkpoint_model_started|native_checkpoint_model_failed|context_checkpoint_provider_invoked|native_visible_prefix_stage_settled|native_working_checkpoint_(selected|advanced)|web_model_picker_timeout|native_execution_failed|native_tool_request_rejected|web_preparation_failed)$/.test(row.stage)) {
      const key=JSON.stringify([row.stage,row.request_fingerprint,row.operation_fingerprint,row.phase]);
      if(durable.has(key)||durable.size<DIAGNOSTIC_LIMITS.timeline-1)durable.set(key,row);
    }
    if(rows.length>=512){clipped=true;rows.shift();}rows.push(row);
  });
  if(!stop)return;
  withDiagnosticContext({scope_fingerprint:scope,turn_fingerprint:turn,...(fp(request)?{request_fingerprint:request}:{})},()=>
    emitDiagnosticEvent('chatgpt_tela_work','native_cycle_observation_started'));
  return {finish(){
    if(closed)return;closed=true;
    try{
      const s=summarizeTurnDiagnostics(rows);
      const fields = {
        contract_version:1,state:s.state,local_final_committed:s.localFinalCommitted,summary_complete:!clipped,process_local_only:true,
        observed_event_count:rows.length,web_send_count:s.submission.activations,web_accept_count:s.submission.accepted,
        causal_receipt:s.submission.causal,observer_count:s.transport.responseObservers,observer_replacement_count:s.transport.observerReplacements,
        disconnect_count:s.transport.disconnects,tool_queued_count:s.tools.queued,tool_result_count:s.tools.results,tool_release_count:s.tools.released,
        summary_attempt_count:s.context.summaryAttempts,summary_reuse_count:s.context.summaryReused,
        ...(s.submission.firstFailure?{first_reason_class:String(s.submission.firstFailure)}:{}),
        context_settled:s.context.settled,composer_measured:s.cost.composer.complete,protocol_measured:s.cost.protocol.complete,
        composer_wire_bytes:s.cost.composer.total,context_wire_bytes:s.cost.context.total,protocol_wire_bytes:s.cost.protocol.total,
        task_composer_measured:s.cost.taskComposer.complete, task_composer_wire_bytes:s.cost.taskComposer.total,
        preparation_measured:s.cost.preparationTransfer.complete, preparation_transfer_estimate:s.cost.preparationTransfer.total, preparation_model_call_count:s.cost.preparationModelCalls.total,
        preparation_model_duration_ms:s.cost.preparationModelDuration.total,
        duration_ms:Math.max(0,Math.round(performance.now()-startedAt)),
        ...(s.context.mode?{context_mode:String(s.context.mode)}:{}),
        ...(s.context.checkpointReused===undefined?{}:{request_checkpoint_reused:s.context.checkpointReused}),
        ...(s.context.logicalEstimate===undefined?{}:{logical_estimate:s.context.logicalEstimate}),
        ...(s.context.transferEstimate===undefined?{}:{transfer_estimate:s.context.transferEstimate}),
      };
      withDiagnosticContext({scope_fingerprint:scope,turn_fingerprint:turn},()=>emitDiagnosticEvent('chatgpt_tela_work','native_cycle_summary',fields));
      const root=configuredDiagnosticRoot();
      if(root&&receipt)writeDiagnosticIncident(root,{stage:receipt.stage,observedAt:receipt.ts,timeline:[...durable.values(),receipt]});
    }catch{/* Diagnostics never affect lifecycle. */}
    finally{stop();}
  }};
}
