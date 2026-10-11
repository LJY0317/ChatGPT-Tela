import {expect,test} from "bun:test";
import {mkdtempSync,readFileSync,rmSync}from"node:fs";
import{tmpdir}from"node:os";import{join}from"node:path";
import{observeDiagnosticInventory,observeDiagnosticContextPressure}from"./diagnostic-inventory";
import{readDiagnosticTail}from"./diagnostic-store";
test("inventory changes and refill estimates expose counts without names, schema or contents",()=>{
 const root=mkdtempSync(join(tmpdir(),"tela-inventory-proof-"));const prior=process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;const file=join(root,"events.jsonl");process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=file;
 try{
  const tool={wireName:"private-tool-name",name:"private-tool-name",kind:"function" as const,description:"private description",inputSchema:{secretShape:"private schema"},observedFrom:["test"]};
  observeDiagnosticInventory("inventory-proof",[tool]);observeDiagnosticInventory("inventory-proof",[tool]);observeDiagnosticInventory("inventory-proof",[]);
  const rows=readDiagnosticTail(file).events;expect(rows).toHaveLength(2);expect(rows[1]).toMatchObject({changed:true,count:0,count_delta:-1});
  observeDiagnosticContextPressure("pressure-proof",1000,3,true,{toolResultCount:1,toolResultBytes:200});observeDiagnosticContextPressure("pressure-proof",1100,4,true,{toolResultCount:2,toolResultBytes:300});
  expect(readDiagnosticTail(file).events.at(-1)).toMatchObject({estimate_delta:100,revision_delta:1,tool_result_count:2,tool_result_bytes:300});
  const text=readFileSync(file,"utf8");expect(text).not.toContain("private-tool-name");expect(text).not.toContain("private schema");expect(text).not.toContain("private description");
 }finally{if(prior)process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=prior;else delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;rmSync(root,{recursive:true,force:true});}
});
