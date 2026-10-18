import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnosticFingerprint, emitDiagnosticEvent } from "./diagnostic-events";
import { diagnosticContext, withDiagnosticContext } from "./diagnostic-context";
import { traceDiagnosticToolCall } from "./diagnostic-trace";
import { analyzeDiagnosticEvents, DIAGNOSTIC_LIMITS, listDiagnosticIncidents, privateDiagnosticCaptureEnabled, readDiagnosticIncident,
  readDiagnosticSources, readDiagnosticTail, setPrivateDiagnosticCapture, structuralDiagnosticEvent, writeDiagnosticIncident, writePrivateDiagnosticArtifact } from "./diagnostic-store";
const directories: string[] = [];
const original = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
function fixture() { const root = mkdtempSync(join(tmpdir(),"tela-diagnostics-test-")); directories.push(root); return root; }
afterEach(async () => { await new Promise<void>(resolve => setImmediate(resolve)); if (original) process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=original; else delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE; for (const root of directories.splice(0)) rmSync(root,{recursive:true,force:true}); });
const fp = (value: string) => diagnosticFingerprint(value);
const event = (stage: string, extra: Record<string,unknown> = {}, at = "2026-10-05T00:00:00.000Z") => structuralDiagnosticEvent({ts:at,event:"chatgpt_tela_test",stage,...extra})!;
test("preparation provenance survives emitted failure and canonical incident inspection", async () => {
  const root = fixture(), file = join(root, "events.jsonl");
  process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = file;
  emitDiagnosticEvent("chatgpt_tela_profile_startup", "web_admission_failed", {
    proof_stage: "model-discovery", reason_class: "unknown",
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(readDiagnosticTail(file).events.at(-1)).toMatchObject({
    stage: "web_admission_failed", proof_stage: "model-discovery", reason_class: "unknown",
  });
  const center = join(root, "diagnostics");
  const records = listDiagnosticIncidents(center);
  expect(records).toHaveLength(1);
  const inspected = readDiagnosticIncident(center, records[0]!.ref);
  expect(inspected).toMatchObject({ timeline: expect.arrayContaining([expect.objectContaining({
    stage: "web_admission_failed", proof_stage: "model-discovery", reason_class: "unknown",
  })]) });
});
test("proof stages accept only classified preparation stages", () => {
  for (const stage of ["account", "model-discovery", "connector", "readiness"]) {
    expect(event("web_admission_failed", { proof_stage: stage }).proof_stage).toBe(stage);
  }
  for (const stage of ["unclassified_private_detail", "/private/fixture", true, 1, null]) {
    expect(event("web_admission_failed", { proof_stage: stage })).not.toHaveProperty("proof_stage");
  }
});
test("checkpoint source kinds remain classified and content-free in incident records", () => {
  for (const kind of ["native-visible-prefix", "native-request-prefix"]) {
    expect(event("native_visible_prefix_checkpoint_started", { source_kind: kind }).source_kind).toBe(kind);
  }
  expect(event("native_visible_prefix_checkpoint_started", { source_kind: "private_source_text" })).not.toHaveProperty("source_kind");
});
test("planner substages survive canonical filtering and reject arbitrary strings", async () => {
  const root = fixture(), file = join(root, "events.jsonl");
  process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = file;
  emitDiagnosticEvent("chatgpt_tela_work", "web_preparation_failed", {
    phase: "context_plan", planner_stage: "native_continuity", reason_class: "unclassified",
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(readDiagnosticTail(file).events.at(-1)).toMatchObject({
    planner_stage: "native_continuity", reason_class: "unclassified",
  });
  const incidents = listDiagnosticIncidents(join(root, "diagnostics"));
  expect(incidents).toHaveLength(1);
  expect(readDiagnosticIncident(join(root, "diagnostics"), incidents[0]!.ref)).toMatchObject({
    timeline: expect.arrayContaining([expect.objectContaining({planner_stage: "native_continuity"})]),
  });
  expect(event("web_preparation_failed", { planner_stage: "private_source_location" }))
    .not.toHaveProperty("planner_stage");
});
test("incident selection preserves early approval evidence despite later unrelated event pressure", () => {
  const root = fixture(), file = join(root,"events.jsonl"), at = Date.parse("2026-10-05T00:00:00Z");
  const selected = event("approval_wait_transition",{phase:"input_received",operation_fingerprint:fp("owned")});
  writeFileSync(file,[selected,...Array.from({length:DIAGNOSTIC_LIMITS.events+5},()=>event("tool_started",{},"2026-10-05T01:00:00Z"))].map(row=>JSON.stringify(row)).join("\n")+"\n");
  expect(readDiagnosticTail(file).events.some(row=>row.phase==="input_received")).toBe(false);
  const read=readDiagnosticSources([file],{fromMs:at-1000,toMs:at+1000});
  expect(read.events).toEqual([selected]);expect(read.coverage[0]).toMatchObject({windowSelected:true,outsideWindowRows:DIAGNOSTIC_LIMITS.events+5,eventLimitReached:false,truncated:false});
});
test("coverage records malformed and oversized evidence without leaking skipped content",()=>{
  const root=fixture(),file=join(root,"events.jsonl");
  writeFileSync(file,"private malformed\n"+"PRIVATE".repeat(1500)+"\n"+JSON.stringify(event("tool_started"))+"\n");
  const read=readDiagnosticTail(file);expect(read).toMatchObject({malformedRows:1,oversizedRows:1});expect(read.events).toHaveLength(1);
  expect(JSON.stringify(read)).not.toMatch(/PRIVATE|private malformed/);
  expect(()=>readDiagnosticTail(file,1024,{fromMs:2,toMs:1})).toThrow("invalid diagnostic window");
});
test("approval and admitted tool receipts do not prove a later host review or execution",()=>{
  const operation=fp("owned"),other=fp("unrelated"),at=Date.parse("2026-10-05T00:00:10Z");
  const rows=[event("approval_wait_transition",{operation_fingerprint:operation,phase:"dispatch_sent"}),
    event("approval_wait_transition",{operation_fingerprint:operation,phase:"input_received"}),
    event("approval_wait_transition",{operation_fingerprint:operation,phase:"card_cleared"}),
    event("native_tool_queued",{operation_fingerprint:operation}),event("native_tool_delivery_committed",{operation_fingerprint:operation}),
    event("native_tool_result_received",{operation_fingerprint:operation}),
    event("native_tool_result_error",{operation_fingerprint:other,message_signal_observed:true}),
    event("native_tool_result_error",{operation_fingerprint:operation},"2026-10-05T00:00:11Z")];
  const report=analyzeDiagnosticEvents({events:rows,atMs:at,operationFingerprint:operation,symptom:"tool-review-blocked",reportOrigin:"worker-report"});
  expect(report.hostReported).toMatchObject({symptom:"tool-review-blocked",origin:"worker-report",originProven:false});
  expect(report.boundaries.toolEvidence).toEqual({correlationSelected:true,approvalDispatches:1,approvalInputReceipts:1,approvalCardsCleared:1,
    nativeQueued:1,nativeDelivered:1,nativeResults:1,reportedErrors:0,incompleteInspections:0,
    preDispatchCoverage:"external-host-unobservable",
    originProven:false,executionProven:false});
  expect(report.gaps.join()).toContain("before Tela ingress");
});
test("ownership and inspection witnesses survive canonical filtering without payload or input details", () => {
  const row = event("web_turn_ownership_observed", { payload_state: "unavailable", anchor_state: "matching", first_reason_class: "ambiguous_author_root",
    author_root_available: false, action: "close_to_hide", owned_input: false, input_count: 1,
    key: "private keystroke", prompt: "private question", coordinates: "private position" });
  expect(row).toMatchObject({ payload_state: "unavailable", anchor_state: "matching", author_root_available: false,
    action: "close_to_hide", owned_input: false, input_count: 1, first_reason_class: "ambiguous_author_root" });
  expect(JSON.stringify(row)).not.toContain("private");
});
test("rendered author state and checkpoint lifecycle remain distinct structural evidence", () => {
  const row = event("web_turn_ownership_observed", {payload_state: "causal", rendered_payload_state: "changed",
    causal_receipt: true, anchor_state: "matching", input_boundary_available: true,
    submission_accepted: true, completion_observed: false, result_persisted: false, surface_released: true,
    prompt: "private prompt", body: "private body", providerOperationId: "private operation"});
  expect(row).toMatchObject({payload_state: "causal", rendered_payload_state: "changed", causal_receipt: true,
    submission_accepted: true, completion_observed: false, result_persisted: false, surface_released: true});
  expect(JSON.stringify(row)).not.toContain("private");
  expect(event("web_turn_ownership_observed", {rendered_payload_state: "arbitrary_display"}).rendered_payload_state).toBeUndefined();
});
test("bounded reader explicitly reports truncation and never follows source symlinks", () => {
  const root=fixture(); const file=join(root,"events.jsonl"); const row=JSON.stringify(event("completed", {prompt:"private", path:"/private/path", count:1}))+"\n";
  writeFileSync(file,row.repeat(50)); const result=readDiagnosticTail(file,512);
  expect(result.truncated).toBe(true); expect(result.bytesRead).toBe(512); expect(JSON.stringify(result)).not.toContain("private");
  symlinkSync(file,join(root,"link")); expect(readDiagnosticTail(join(root,"link")).state).toBe("unavailable");
  expect(readDiagnosticSources([file,file]).sourceLimitReached).toBe(false);
});
test("parent transport correlation and report-time process state remain separate from host continuation", () => {
  const operation=fp("operation"), request=fp("request"), child=fp("child"), scope=fp("scope");
  const rows=[event("process_started",{operation_fingerprint:operation,request_fingerprint:request,scope_fingerprint:scope}),
    event("http_response_finished",{request_fingerprint:child,parent_fingerprint:request},"2026-10-05T00:00:01Z"),
    event("process_settled",{operation_fingerprint:operation,scope_fingerprint:scope},"2026-10-05T00:00:03Z")];
  const report=analyzeDiagnosticEvents({events:rows,atMs:Date.parse("2026-10-05T00:00:02Z"),operationFingerprint:operation,symptom:"response-stalled"});
  expect(report.timeline).toHaveLength(3); expect(report.boundaries.transportEvents).toBe(1);
  expect(report.boundaries.processEvidence?.stage).toBe("process_started"); expect(report.boundaries.hostContinuation).toBe("unverified");
  expect(report.boundaries.otherScopeCount).toBe(0);
});
test("owned incident retention preserves foreign data and rebuilds discovery", () => {
  const root=fixture(); for (let i=0;i<DIAGNOSTIC_LIMITS.incidents+2;i++) writeDiagnosticIncident(root,{stage:"test_failed",observedAt:new Date().toISOString(),timeline:[event("test_failed")]});
  const foreign=join(root,"incidents","incident_00000000-0000-0000-0000-000000000000.json"); writeFileSync(foreign,JSON.stringify({owner:"other",secret:"foreign"}));
  const records=listDiagnosticIncidents(root); expect(records).toHaveLength(DIAGNOSTIC_LIMITS.incidents);
  expect(readFileSync(foreign,"utf8")).toContain("foreign"); expect(readDiagnosticIncident(root,records[0]!.ref)).toMatchObject({owner:"chatgpt-tela-diagnostics-v1"});
  expect(readFileSync(join(root,"START-HERE.md"),"utf8")).toContain("diagnostics inspect");
  expect(()=>readDiagnosticIncident(root,"../../secret")).toThrow();
});
test("private capture is off, expires without polling, and pairs are bounded", () => {
  const root=fixture(); const capture=()=>writePrivateDiagnosticArtifact(root,{kind:"html",bytes:Buffer.from("private conversation"),operationFingerprint:fp("op")});
  expect(privateDiagnosticCaptureEnabled(root)).toBe(false); expect(capture()).toBeUndefined();
  setPrivateDiagnosticCapture(root,1); for (let i=0;i<20;i++) capture();
  expect(readdirSync(join(root,"private")).length).toBeLessThanOrEqual(DIAGNOSTIC_LIMITS.privateFiles);
  const ref=writeDiagnosticIncident(root,{stage:"approval_card_anomaly",observedAt:new Date().toISOString(),timeline:[event("approval_card_anomaly",{operation_fingerprint:fp("op")})]});
  const incident=JSON.stringify(readDiagnosticIncident(root,ref)); expect(incident).toContain("privateArtifacts"); expect(incident).not.toContain("private conversation");
  writeFileSync(join(root,"capture-policy.json"),JSON.stringify({owner:"chatgpt-tela-diagnostics-v1",enabledUntil:Date.now()-1})); expect(capture()).toBeUndefined();
});
test("ongoing private capture persists with the same retention and can be explicitly stopped", () => {
  const root=fixture();
  const enabled=setPrivateDiagnosticCapture(root,"until-disabled");
  expect(enabled).toMatchObject({ enabled:true, mode:"until-disabled", minutes:null, privacy:"private-local-only", retention:{days:7,bytes:64*1024*1024,files:24} });
  expect(privateDiagnosticCaptureEnabled(root)).toBe(true);
  for(let i=0;i<20;i++)writePrivateDiagnosticArtifact(root,{kind:"json",bytes:Buffer.from("private evidence"),operationFingerprint:fp("ongoing")});
  expect(readdirSync(join(root,"private")).length).toBeLessThanOrEqual(DIAGNOSTIC_LIMITS.privateFiles);
  setPrivateDiagnosticCapture(root,0);
  expect(privateDiagnosticCaptureEnabled(root)).toBe(false);
  expect(writePrivateDiagnosticArtifact(root,{kind:"json",bytes:Buffer.from("stopped"),operationFingerprint:fp("ongoing")})).toBeUndefined();
});
test("ongoing capture refuses malformed or foreign policy and symlink policy files", () => {
  const root=fixture();setPrivateDiagnosticCapture(root,"until-disabled");
  const path=join(root,"capture-policy.json");
  for(const record of [{owner:"other",mode:"until-disabled",enabledUntil:0},
    {owner:"chatgpt-tela-diagnostics-v1",mode:"until-disabled",enabledUntil:1},
    {owner:"chatgpt-tela-diagnostics-v1",mode:"unknown",enabledUntil:Date.now()+60000}]) {
    writeFileSync(path,JSON.stringify(record));expect(privateDiagnosticCaptureEnabled(root)).toBe(false);
  }
  rmSync(path);const target=join(root,"target.json");
  writeFileSync(target,JSON.stringify({owner:"chatgpt-tela-diagnostics-v1",mode:"until-disabled",enabledUntil:0}));
  symlinkSync(target,path);expect(privateDiagnosticCaptureEnabled(root)).toBe(false);
});
test("concurrent tool calls retain originating request even when abort is delivered elsewhere", async () => {
  const root=fixture(); const file=join(root,"events.jsonl"); process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=file;
  const controller=new AbortController(); let finish!: (value:unknown)=>void;
  const first=withDiagnosticContext({request_fingerprint:fp("first")},()=>traceDiagnosticToolCall("read",{secret:"never log"},{signal:controller.signal,requestId:1},()=>new Promise(resolve=>{finish=resolve;})));
  await withDiagnosticContext({request_fingerprint:fp("second")},()=>traceDiagnosticToolCall("read",{}, {},async()=>{controller.abort(); return {isError:true};}));
  finish({content:"private result"}); await first;
  const rows=readDiagnosticTail(file).events; expect(rows.find(row=>row.stage==="tool_abort_signalled")?.request_fingerprint).toBe(fp("first"));
  expect(rows.filter(row=>row.stage==="tool_settled")).toHaveLength(2); expect(diagnosticContext()).toEqual({});
  expect(readFileSync(file,"utf8")).not.toContain("private result"); expect(readFileSync(file,"utf8")).not.toContain("never log");
});
test("invalid diagnostic metadata cannot stop primary tools; original exception survives", async () => {
  expect(await traceDiagnosticToolCall("x".repeat(20000),{}, {requestId:"x".repeat(20000)},async()=>42)).toBe(42);
  const error=new Error("primary"); try { await traceDiagnosticToolCall("read",{}, {},async()=>{throw error;}); throw new Error("missing failure"); } catch (caught) { expect(caught).toBe(error); }
});
test("failure bursts create a canonical incident asynchronously and coalesce file work", async () => {
  const root=fixture(); process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=join(root,"events.jsonl");
  emitDiagnosticEvent("chatgpt_tela_test","turn_failed"); emitDiagnosticEvent("chatgpt_tela_test","turn_failed");
  await new Promise<void>(resolve=>setImmediate(resolve)); const records=listDiagnosticIncidents(join(root,"diagnostics"));
  expect(records).toHaveLength(1); expect(readDiagnosticIncident(join(root,"diagnostics"),records[0]!.ref)).toMatchObject({occurrences:2});
});
test("same RPC number on different requests does not join unrelated conversations",()=>{
  const operation=fp("target"), request=fp("target-request"), other=fp("other-request");
  const rows=[event("tool_started",{operation_fingerprint:operation,request_fingerprint:request,rpc_fingerprint:fp("1")}),event("tool_settled",{request_fingerprint:other,rpc_fingerprint:fp("1")})];
  const report=analyzeDiagnosticEvents({events:rows,atMs:Date.parse(rows[0]!.ts),operationFingerprint:operation});expect(report.timeline).toHaveLength(1);
});
test("explicit private tool evidence redacts credential fields and never enters structural JSONL",async()=>{
  const root=fixture();process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=join(root,"events.jsonl");setPrivateDiagnosticCapture(join(root,"diagnostics"),1);
  await withDiagnosticContext({request_fingerprint:fp("private-request")},()=>traceDiagnosticToolCall("read",{token:"sensitive-token",text:"private prompt"}, {},async()=>({text:"private result",password:"sensitive-password"})));
  const privateFiles=readdirSync(join(root,"diagnostics","private")).filter(name=>name.endsWith(".json")&&!name.endsWith(".meta.json"));expect(privateFiles).toHaveLength(2);
  const privateText=privateFiles.map(name=>readFileSync(join(root,"diagnostics","private",name),"utf8")).join();
  expect(privateText).toContain("private prompt");expect(privateText).not.toContain("sensitive-token");expect(privateText).not.toContain("sensitive-password");
  const structural=readFileSync(join(root,"events.jsonl"),"utf8");expect(structural).not.toContain("private prompt");expect(structural).not.toContain("private result");
});
test("common analysis distinguishes isolated test-origin evidence from runtime incidents",()=>{
  const root=fixture();const file=join(root,"events.jsonl");writeFileSync(file,[event("turn_failed",{environment:"test"}),event("turn_completed",{environment:"runtime"})].map(row=>JSON.stringify(row)).join("\n")+"\n");
  const result=readDiagnosticSources([file]);expect(result.events).toHaveLength(1);expect(result.excludedTestEvents).toBe(1);expect(result.events[0]?.stage).toBe("turn_completed");
});

test("model selection proof keeps only pseudonymous identity and finite effort categories", () => {
  const row = event("web_model_selected", { provider_kind:"web", effort:"xhigh", family_fingerprint:fp("private-model-label"), family_readback_proven:true, effort_readback_proven:true, model:"private-model-label" });
  expect(row).toMatchObject({provider_kind:"web",effort:"xhigh",family_readback_proven:true,effort_readback_proven:true});
  expect(row.family_fingerprint).toBe(fp("private-model-label"));expect(JSON.stringify(row)).not.toContain("private-model-label");
  expect(event("web_model_selected",{effort:"private_value"}).effort).toBeUndefined();
});
