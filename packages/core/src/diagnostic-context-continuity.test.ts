import { expect, test } from "bun:test";
import { summarizeContextContinuity } from "./diagnostic-context-continuity";
import type { StructuralDiagnosticEvent } from "./diagnostic-store";

const scope = "1".repeat(24), turn1 = "2".repeat(24), turn2 = "3".repeat(24), request = "4".repeat(24);
const epoch = "5".repeat(24), surface = "6".repeat(24), head = "7".repeat(24), operation = "8".repeat(24);
let n = 0;
function event(stage: string, fields: object = {}): StructuralDiagnosticEvent {
  return { ts: new Date(1000 + n++).toISOString(), event: "chatgpt_tela_work", stage,
    scope_fingerprint: scope, turn_fingerprint: turn1, ...fields };
}
function plan(mode: string, fields: object = {}) {
  return event("web_turn_plan", { context_mode: mode, operation_fingerprint: operation,
    epoch_fingerprint: epoch, lease_fingerprint: surface, head_revision_fingerprint: head, retained_input_head_fingerprint: head,
    document_generation: 1, logical_estimate: 200000, transfer_estimate: 8000, ...fields });
}
function settled(fields: object = {}) {
  return event("web_context_settled", { operation_fingerprint: operation, status: "completed",
    epoch_fingerprint: epoch, lease_fingerprint: surface, head_revision_fingerprint: head, document_generation: 1, ...fields });
}

test("seed byte partitions and pressure warnings remain observed estimates, missing historical fields stay unknown", () => {
  const row=plan('checkpoint-delta',{fresh_seed_target:24000,fresh_seed_exceeds_target:true,
    fresh_seed_exceeds_rollover:true,prior_settlement_present:true,seed_authority_bytes:100,
    seed_user_bytes:200,seed_checkpoint_bytes:300,seed_protected_tool_bytes:400,seed_other_bytes:50});
  const report=summarizeContextContinuity({events:[row],atMs:5000,scope});
  expect(report.turns[0].summary.context.seedCost).toMatchObject({targetEstimate:24000,
    exceedsTarget:true,exceedsRollover:true,priorSettlementPresent:true,authorityBytes:100,userBytes:200,
    checkpointBytes:300,protectedToolBytes:400,otherBytes:50});
  const old=summarizeContextContinuity({events:[plan('checkpoint-delta')],atMs:5000,scope});
  expect(old.turns[0].summary.context.seedCost.authorityBytes).toBeUndefined();
  expect(report.semanticRecall).toBe('not_evaluated');
});

test("context reuse links only to an exact locally committed predecessor without claiming semantic recall", () => {
  const rows = [plan("checkpoint-delta"), settled(), plan("retained-delta", {
    turn_fingerprint: turn2, base_revision_fingerprint: head, head_revision_fingerprint: "9".repeat(24), transfer_estimate: 50,
  })];
  const r = summarizeContextContinuity({ events: rows, atMs: 5000, scope });
  expect(r.turns[1].plans[0].retentionLink).toBe("verified_local_link");
  expect(r.turns[1].summary.context.retentionLink).toBe("verified_local_link");
  expect(r.turns[1].plans[0].transferTokenEstimate).toBe(50);
  expect(r.semanticRecall).toBe("not_evaluated"); expect(r.tokenAccounting).toBe("local_estimates_only");
  const missing = summarizeContextContinuity({ events: [rows[0]!, rows[2]!], atMs: 5000 });
  expect(missing.turns[1].plans[0].retentionLink).toBe("incomplete_evidence");
  const changed = summarizeContextContinuity({ events: [rows[0]!, rows[1]!, plan("retained-delta", {
    turn_fingerprint: turn2, base_revision_fingerprint: head, document_generation: 2,
  })], atMs: 5000 });
  expect(changed.turns[1].plans[0].retentionLink).toBe("unmatched_local_link");
});

test("early checkpoint and reconnect transport evidence join through an unambiguous request only", () => {
  const early = event("native_visible_prefix_checkpoint_started", { request_fingerprint: request, source_bytes: 1098833, fragment_count: 5 });
  delete (early as any).scope_fingerprint; delete (early as any).turn_fingerprint;
  const rows = [early, event("native_response_observer_started", { request_fingerprint: request }),
    event("http_transport_closed", { request_fingerprint: request, last_socket_write_age_ms: 300006, socket_write_count: 6 }),
    event("native_turn_retired")];
  const report = summarizeContextContinuity({ events: rows, atMs: 5000, scope });
  expect(report.turns[0].checkpoint.sourceBytes).toBe(1098833);
  expect(report.turns[0].disconnects[0].idleSinceLocalWriteMs).toBe(300006);
  expect(report.turns[0].outcome).toBe("retired_without_observed_final");
  const ambiguous = summarizeContextContinuity({ events: [...rows, event("native_response_observer_started", {
    request_fingerprint: request, scope_fingerprint: "a".repeat(24), turn_fingerprint: turn2,
  })], atMs: 5000, scope });
  expect(ambiguous.evidenceLimits.ambiguousRequests).toBe(1);
  expect(ambiguous.turns[0].checkpoint.sourceBytes).toBeUndefined();
});

test("reports omit unclassified private payloads, exclude test origins and expose clipping", () => {
  const row = plan("retained-delta", { prompt: "PRIVATE_TEXT", surface_fingerprint: "PRIVATE_ID", context_mode: "PRIVATE_MODE" });
  const report = summarizeContextContinuity({ events: [row, event("web_turn_plan", { environment: "test", turn_fingerprint: turn2 })], atMs: 5000 });
  expect(report.turns).toHaveLength(1); expect(JSON.stringify(report)).not.toContain("PRIVATE");
  expect(report.turns[0].plans[0].mode).toBe("unknown");
  expect(summarizeContextContinuity({ events: Array.from({ length: 4097 }, () => event("unrelated")), atMs: 100000 }).evidenceLimits.eventLimitReached).toBe(false);
  expect(() => summarizeContextContinuity({ events: [], atMs: 5000, scope: "private account" })).toThrow();
});

test('tool projection links through unique operation, contradictory owners stay unassigned',()=>{
 const projected=event('mcp_native_result_projected',{operation_fingerprint:operation,text_bytes:42});
 delete (projected as any).scope_fingerprint;delete (projected as any).turn_fingerprint;
 const native=event('native_tool_result_received',{operation_fingerprint:operation});
 const r=summarizeContextContinuity({events:[projected,native],atMs:100000});
 expect(r.turns[0].summary.cost.toolText).toMatchObject({total:42,complete:true});
 const conflict=event('native_tool_result_received',{operation_fingerprint:operation,turn_fingerprint:turn2});
 const ambiguous=summarizeContextContinuity({events:[projected,native,conflict],atMs:100000});
 expect(ambiguous.evidenceLimits.ambiguousOperations).toBe(1);
 expect(ambiguous.turns[0].summary.cost.toolText.complete).toBe(false);
});
test('renderer stream failures join only through a unique surface lease and active Web plan',()=>{
 const lease='a'.repeat(24),surface='b'.repeat(24),op='c'.repeat(24),request='d'.repeat(24);
 const bound=event('renderer_surface_bound',{event:'chatgpt_tela_browser',lease_fingerprint:lease,surface_fingerprint:surface});
 const planned=plan('retained-delta',{operation_fingerprint:op,request_fingerprint:request,lease_fingerprint:lease});
 const network=event('renderer_request_failed',{event:'chatgpt_tela_browser',surface_fingerprint:surface,
   network_request_fingerprint:'d'.repeat(24),browser_response:'event_stream',request_role:'stream_candidate',
   failure_class:'err_aborted',http_status:200,surface_correlated:true});
 delete (network as any).scope_fingerprint; delete (network as any).turn_fingerprint;
 const ended=event('native_execution_failed',{request_fingerprint:request,operation_fingerprint:op});
 const [turn]=summarizeContextContinuity({events:[bound,planned,network,ended],atMs:100000,scope}).turns;
 expect(turn.browserNetworkFailures).toEqual([{at:network.ts,requestFingerprint:'d'.repeat(24),response:'event_stream',
   requestRole:'stream_candidate',failureClass:'err_aborted',httpStatus:200,surfaceCorrelated:true,
   attribution:'surface_lease_and_active_plan'}]);
 const ambiguous=event('renderer_surface_bound',{event:'chatgpt_tela_browser',scope_fingerprint:'e'.repeat(24),
   lease_fingerprint:lease,surface_fingerprint:surface});
 const report=summarizeContextContinuity({events:[bound,planned,network,ended,ambiguous],atMs:100000,scope});
 expect(report.turns[0].browserNetworkFailures).toHaveLength(0);
 const unclosed=summarizeContextContinuity({events:[bound,planned,network],atMs:100000,scope});
 expect(unclosed.turns[0].browserNetworkFailures).toHaveLength(0);
});
test('a bounded terminal receipt survives missing raw final without pretending its bytes were measured',()=>{
 const r=summarizeContextContinuity({events:[event('native_cycle_summary',{contract_version:1,state:'completed',local_final_committed:true,summary_complete:true,composer_measured:false,composer_wire_bytes:0})],atMs:100000});
 expect(r.turns[0].completionEvidence).toBe('cycle_receipt');expect(r.turns[0].outcome).toBe('local_final_committed');
 expect(r.turns[0].cycleReceipts[0].composerBytes).toBeUndefined();
 expect(r.turns[0].summary.evidence.hostDisplay).toBe('not_observed');
});

test('previous cycle summary cannot mark a newly started cycle complete',()=>{
 const r=summarizeContextContinuity({events:[event('native_cycle_summary',{contract_version:1,state:'completed',local_final_committed:true,summary_complete:true}),event('native_cycle_observation_started')],atMs:100000});
 expect(r.turns[0].completionEvidence).toBe('not_observed');expect(r.turns[0].summary.state).toBe('in_progress');
});
test('one Native turn exposes distinct request dispatches without counting progress as inference',()=>{
 const another='a'.repeat(24), secondOperation='b'.repeat(24);
 const rows=[
  plan('retained-delta',{request_fingerprint:request}),
  event('web_send_activation_started',{request_fingerprint:request,operation_fingerprint:operation}),
  event('web_turn_identity_accepted',{request_fingerprint:request,operation_fingerprint:operation,causal_receipt:true}),
  event('web_public_progress_extraction',{request_fingerprint:request}),
  event('native_cycle_summary',{request_fingerprint:request,contract_version:1,state:'completed',web_send_count:1,web_accept_count:1}),
  plan('retained-delta',{request_fingerprint:another,operation_fingerprint:secondOperation}),
  event('web_send_activation_started',{request_fingerprint:another,operation_fingerprint:secondOperation}),
  event('web_turn_identity_accepted',{request_fingerprint:another,operation_fingerprint:secondOperation,causal_receipt:true}),
  event('native_cycle_summary',{request_fingerprint:another,contract_version:1,state:'completed',web_send_count:1,web_accept_count:1}),
 ];
 const [turn]=summarizeContextContinuity({events:rows,atMs:100000,scope}).turns;
 expect(turn.plans.map((p:any)=>p.requestFingerprint)).toEqual([request,another]);
 expect(turn.cycleReceipts.map((r:any)=>r.requestFingerprint)).toEqual([request,another]);
 expect(turn.requestBoundaries.map((r:any)=>r.stage)).toEqual([
  'web_turn_plan','web_send_activation_started','web_turn_identity_accepted','native_cycle_summary',
  'web_turn_plan','web_send_activation_started','web_turn_identity_accepted','native_cycle_summary']);
 expect(turn.requestBoundaries.filter((r:any)=>r.stage==='web_turn_identity_accepted').map((r:any)=>r.requestFingerprint)).toEqual([request,another]);
});
test('retained boundary structure survives report sanitation without request prose',()=>{
 const row=event('web_retained_context_decision',{reason_class:'answer_boundary_missing',retained_revision_count:8,
  retained_input_head_found:true,retained_input_head_fingerprint:head,retained_input_head_index:2,
  retained_tail_count:5,retained_scanned_count:0,retained_assistant_count:0,
  retained_stop_kind:'steering',retained_stop_index:3,private_text:'PRIVATE'});
 const report=summarizeContextContinuity({events:[row],atMs:100000,scope});
 expect(report.turns[0].retentionDecisions[0].boundary).toMatchObject({revisionCount:8,
  headMatched:true,headIndex:2,stopKind:'steering',stopIndex:3});
 expect(JSON.stringify(report)).not.toContain('PRIVATE');
});
