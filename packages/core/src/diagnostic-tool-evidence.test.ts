import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnosticToolContract } from "./diagnostic-tool-evidence";
import { traceDiagnosticToolCall } from "./diagnostic-trace";
import { structuralDiagnosticEvent } from "./diagnostic-store";


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
