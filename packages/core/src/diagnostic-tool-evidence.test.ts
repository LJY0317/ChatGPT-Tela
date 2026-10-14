import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnosticToolContract, diagnosticToolFailureEvidence, diagnosticToolResultEvidence } from "./diagnostic-tool-evidence";
import { traceDiagnosticToolCall } from "./diagnostic-trace";
import { structuralDiagnosticEvent } from "./diagnostic-store";

const signal = "This tool call was blocked by OpenAI because we couldn't determine the safety status of the request.";

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

test("failure inspection is bounded and distinguishes observed prose from proven origin/execution", () => {
  expect(diagnosticToolFailureEvidence({content:[{type:"text",text:signal+" /private/path secret"}]})).toMatchObject({reason_class:"safety_status_undetermined",message_signal_observed:true,origin_proven:false,execution_proven:false,inspection_complete:true});
  expect(diagnosticToolFailureEvidence({content:"x".repeat(16385)+signal})).toMatchObject({reason_class:"unknown",inspection_complete:false});
  expect(diagnosticToolFailureEvidence(new Proxy({}, {get(){throw Error("private");}}))).toMatchObject({reason_class:"unknown",inspection_complete:false});
});

test("shared MCP tracing preserves returned and thrown errors, retains structural evidence and excludes payloads", async () => {
  const root=mkdtempSync(join(tmpdir(),"tela-tool-evidence-"));const file=join(root,"events.jsonl");
  const prior=process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=file;
  try {
    const result={isError:true,content:[{type:"text",text:signal+" PRIVATE_RESULT"}]};
    expect(await traceDiagnosticToolCall("private-wire",{text:"PRIVATE_INPUT"},{},async()=>result)).toBe(result);
    const error=new Error(signal+" PRIVATE_EXCEPTION");
    try {await traceDiagnosticToolCall("private-wire",{}, {},async()=>{throw error;});throw Error("expected failure");}catch(caught){expect(caught).toBe(error);}
    await traceDiagnosticToolCall("private-wire",{}, {},async()=>({isError:false,content:signal}));
    const raw=readFileSync(file,"utf8");expect(raw).not.toMatch(/PRIVATE_|private-wire|couldn't determine/);
    const rows=raw.trim().split("\n").map(x=>structuralDiagnosticEvent(JSON.parse(x))!);
    const errors=rows.filter(x=>x.stage==="tool_error"||x.stage==="tool_failed");
    expect(errors).toHaveLength(2);
    expect(errors.map(x=>x.delivery)).toEqual(["mcp_callback_returned","mcp_callback_thrown"]);
    expect(errors.every(x=>x.reason_class==="safety_status_undetermined"&&x.origin_proven===false&&x.execution_proven===false)).toBe(true);
    expect(rows.filter(x=>x.stage==="tool_settled")).toHaveLength(3);
  }finally{
    if(prior===undefined)delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=prior;
    await new Promise(resolve=>setImmediate(resolve));rmSync(root,{recursive:true,force:true});
  }
});

test("unflagged refusal envelopes are signals, not a reclassified host error", () => {
  for (const value of [signal, "Error: " + signal, { content: [{ type: "text", text: signal }] },
    JSON.stringify({ isError: true, content: [{type:"text", text:signal}] })]) {
    expect(diagnosticToolResultEvidence(value, false)).toMatchObject({ error_result_reported:false,
      message_signal_observed:true, reason_class:"safety_status_undetermined", origin_proven:false, execution_proven:false });
  }
  for (const text of ["const example = '" + signal + "';", "tool log:\n" + signal, "ordinary output"]) {
    expect(diagnosticToolResultEvidence(text, false).message_signal_observed).toBe(false);
  }
  expect(diagnosticToolResultEvidence("x".repeat(20000)+signal, false)).toMatchObject({message_signal_observed:false,inspection_complete:false});
  expect(diagnosticToolResultEvidence(new Proxy({}, {get(){throw Error("private");}}), false).inspection_complete).toBe(false);
  const cyclic:any={};cyclic.error=cyclic;
  expect(diagnosticToolResultEvidence(cyclic, false).inspection_complete).toBe(false);
  expect(JSON.stringify(diagnosticToolResultEvidence(signal+" /private/path secret",false))).not.toMatch(/private|secret|couldn't/);
});
