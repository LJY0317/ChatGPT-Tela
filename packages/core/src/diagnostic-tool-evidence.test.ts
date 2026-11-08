import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnosticToolContract, inspectMcpSessionCalls } from "./diagnostic-tool-evidence";
import { traceDiagnosticToolCall } from "./diagnostic-trace";
import { structuralDiagnosticEvent } from "./diagnostic-store";

test("MCP session evidence keeps two conversations separate and rejects reused RPC identities", () => {
  const s1="a".repeat(24), s2="b".repeat(24), c1="c".repeat(24), c2="d".repeat(24), rpc="e".repeat(24);
  let n=0;
  const row=(stage:string, fields:Record<string,string|number|boolean>)=>structuralDiagnosticEvent({
    ts:new Date(Date.UTC(2026,10,1,0,0,n++)).toISOString(),event:"chatgpt_tela_mcp",stage,...fields,
  })!;
  const rows=[
    row("mcp_rpc_received",{scope_fingerprint:s1,connection_fingerprint:c1,rpc_fingerprint:rpc,method_class:"tools_call",kind:"chat_call"}),
    row("tool_started",{scope_fingerprint:s1,rpc_fingerprint:rpc}),
    row("tool_error",{scope_fingerprint:s1,rpc_fingerprint:rpc,delivery:"mcp_callback_returned"}),
    row("tool_settled",{scope_fingerprint:s1,rpc_fingerprint:rpc,outcome:"completed"}),
    row("mcp_rpc_emitted",{connection_fingerprint:c1,rpc_fingerprint:rpc,error_result:true,delivery:"transport_send_returned"}),
    row("mcp_rpc_received",{scope_fingerprint:s2,connection_fingerprint:c2,rpc_fingerprint:rpc,method_class:"tools_call",kind:"chat_call"}),
    row("tool_started",{scope_fingerprint:s2,rpc_fingerprint:rpc}),
    row("tool_failed",{scope_fingerprint:s2,rpc_fingerprint:rpc,delivery:"mcp_callback_thrown"}),
    row("tool_settled",{scope_fingerprint:s2,rpc_fingerprint:rpc,outcome:"failed"}),
  ];
  expect(inspectMcpSessionCalls(rows).filter(row=>row.scopeFingerprint===s1)).toMatchObject([{correlation:"unique_connection_rpc",
    callback:"returned_error",transport:"send_returned",errorResult:true,modelReceipt:"not_observed"}]);
  expect(inspectMcpSessionCalls(rows).filter(row=>row.scopeFingerprint===s2)).toMatchObject([{correlation:"unique_connection_rpc",
    callback:"threw",transport:"not_observed",modelReceipt:"not_observed"}]);
  rows.push(row("mcp_rpc_received",{scope_fingerprint:s1,connection_fingerprint:c1,rpc_fingerprint:rpc,method_class:"tools_call"}));
  expect(inspectMcpSessionCalls(rows).find(row=>row.scopeFingerprint===s1)?.correlation).toBe("ambiguous_or_missing");
});

test("MCP Chat calls join one parent request to the capability result and HTTP close boundary", () => {
  const scope = "a".repeat(24), connection = "b".repeat(24), rpc = "c".repeat(24);
  const parent = "d".repeat(24), child = "e".repeat(24), input = "f".repeat(24), workspace = "1".repeat(24);
  const operation = "2".repeat(24);
  const base = Date.parse("2026-11-08T12:00:00Z");
  const row = (event: string, stage: string, fields: Record<string, string | number | boolean> = {}) =>
    structuralDiagnosticEvent({ ts: new Date(base + rows.length).toISOString(), event, stage, ...fields })!;
  const rows: StructuralDiagnosticEvent[] = [];
  rows.push(row("chatgpt_tela_mcp", "mcp_rpc_received", { scope_fingerprint: scope, connection_fingerprint: connection,
    rpc_fingerprint: rpc, request_fingerprint: parent, method_class: "tools_call", kind: "chat_call" }));
  rows.push(row("chatgpt_tela_mcp", "tool_started", { scope_fingerprint: scope, rpc_fingerprint: rpc }));
  rows.push(row("chatgpt_tela_chat", "capability_call_start", { scope_fingerprint: scope, request_fingerprint: child,
    parent_fingerprint: parent, capability_input_fingerprint: input, workspace_fingerprint: workspace,
    operation_fingerprint: operation, capability: "read_many" }));
  rows.push(row("chatgpt_tela_chat", "capability_call_complete", { scope_fingerprint: scope, request_fingerprint: child,
    parent_fingerprint: parent, capability_input_fingerprint: input, workspace_fingerprint: workspace,
    operation_fingerprint: operation, duration_ms: 12, result_kind: "object", result_bytes: 420,
    result_present: true, result_empty: false, result_is_error: false }));
  rows.push(row("chatgpt_tela_http", "http_response_finished", { scope_fingerprint: scope, request_fingerprint: child,
    parent_fingerprint: parent, status: 200, duration_ms: 18, socket_write_count: 1,
    socket_write_bytes: 512, delivery: "socket_write_only" }));
  rows.push(row("chatgpt_tela_mcp", "mcp_rpc_emitted", { connection_fingerprint: connection, rpc_fingerprint: rpc,
    delivery: "transport_send_returned", error_result: false }));
  rows.push(row("chatgpt_tela_mcp", "tool_settled", { scope_fingerprint: scope, rpc_fingerprint: rpc, outcome: "completed" }));

  expect(inspectMcpSessionCalls(rows)).toMatchObject([{
    callback: "settled", transport: "send_returned", modelReceipt: "not_observed",
    chatHttp: {
      correlation: "unique_parent_request", parentRequestFingerprint: parent,
      capabilityCall: { state: "completed", requestFingerprint: child, inputFingerprint: input,
        workspaceFingerprint: workspace, operationFingerprint: operation,
        result: { kind: "object", bytes: 420, present: true, empty: false, isError: false } },
      httpResponse: { state: "response_finished", status: 200, socketWriteCount: 1,
        socketWriteBytes: 512, delivery: "socket_write_only" },
    },
  }]);
  const unresolved = rows.filter(item => item.stage !== "capability_call_complete" && item.stage !== "http_response_finished");
  expect(inspectMcpSessionCalls(unresolved)[0]?.chatHttp).toMatchObject({
    correlation: "unique_parent_request", capabilityCall: { state: "started_without_settlement_observed" },
    httpResponse: { state: "not_observed" }, modelReceipt: "not_observed",
  });
  const ambiguous = [...rows, row("chatgpt_tela_mcp", "mcp_rpc_received", { scope_fingerprint: scope,
    connection_fingerprint: connection, rpc_fingerprint: rpc, request_fingerprint: parent,
    method_class: "tools_call", kind: "chat_call" })];
  expect(inspectMcpSessionCalls(ambiguous)[0]?.chatHttp.correlation).toBe("parent_request_ambiguous");
  expect(JSON.stringify(inspectMcpSessionCalls(rows))).not.toMatch(/read_many|PRIVATE|arguments/);
});


test("contract fingerprints ignore property order, distinguish contracts, and never expose descriptor text", () => {
  const tool = {wireName:"private-tool@example.com",name:"private",kind:"function" as const,description:"secret-description",observedFrom:["private-source"]};
  const a=diagnosticToolContract({...tool,inputSchema:{type:"object",properties:{b:{type:"string"},a:{type:"number"}}}});
  const b=diagnosticToolContract({...tool,inputSchema:{properties:{a:{type:"number"},b:{type:"string"}},type:"object"}});
  expect(a).toEqual(b);
  expect(a.schema_fingerprint).not.toBe(diagnosticToolContract({...tool,inputSchema:{type:"array"}}).schema_fingerprint);
  expect(JSON.stringify(a)).not.toMatch(/private|secret|example/);
  expect(a.tool_fingerprint).toMatch(/^[a-f0-9]{24}$/);
  expect(diagnosticToolContract({...tool,inputSchema:{description:"x".repeat(65537)}})).toEqual({contract_observed:false});
});

test("shared MCP tracing preserves returned and thrown errors and excludes payloads", async () => {
  const root=mkdtempSync(join(tmpdir(),"tela-tool-evidence-"));const file=join(root,"events.jsonl");
  const prior=process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=file;
  try {
    const result={isError:true,content:[{type:"text",text:"PRIVATE_RESULT"}]};
    expect(await traceDiagnosticToolCall("private-wire",{text:"PRIVATE_INPUT"},{},async()=>result)).toBe(result);
    const error=new Error("PRIVATE_EXCEPTION");
    try {await traceDiagnosticToolCall("private-wire",{}, {},async()=>{throw error;});throw Error("expected failure");}catch(caught){expect(caught).toBe(error);}
    const raw=readFileSync(file,"utf8");expect(raw).not.toMatch(/PRIVATE_|private-wire/);
    const rows=raw.trim().split("\n").map(x=>structuralDiagnosticEvent(JSON.parse(x))!);
    const errors=rows.filter(x=>x.stage==="tool_error"||x.stage==="tool_failed");
    expect(errors).toHaveLength(2);
    expect(errors.map(x=>x.delivery)).toEqual(["mcp_callback_returned","mcp_callback_thrown"]);
    expect(errors.every(x=>typeof x.reason_class === "string")).toBe(true);
    expect(rows.filter(x=>x.stage==="tool_settled")).toHaveLength(2);
  }finally{
    if(prior===undefined)delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=prior;
    await new Promise(resolve=>setImmediate(resolve));rmSync(root,{recursive:true,force:true});
  }
});
