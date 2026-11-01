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
