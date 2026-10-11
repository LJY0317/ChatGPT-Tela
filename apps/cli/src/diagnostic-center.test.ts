import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnosticCenter } from "@chatgpt-tela/core";
test("host report preserves explicit recovery and missing-source coverage without raw paths/content",()=>{
  const root=mkdtempSync(join(tmpdir(),"tela-center-test-"));
  try{
    const file=join(root,"events.jsonl");writeFileSync(file,JSON.stringify({ts:"2026-10-05T00:00:00Z",event:"chatgpt_tela_work",stage:"web_turn_timeout",prompt:"private user",url:"https://private",deadline_ms:120000})+"\n");
    const flags:Record<string,string>={"--at":"2026-10-05T00:00:01Z","--symptom":"response-stalled","--recovered-at":"2026-10-05T00:01:00Z"};
    const report=diagnosticCenter(join(root,"diagnostics"),[file,join(root,"missing")],"record",name=>flags[name]) as {ref:string};
    expect(report.ref).toMatch(/^incident_/); const value=JSON.stringify(diagnosticCenter(join(root,"diagnostics"),[],"inspect",name=>name==="--ref"?report.ref:undefined));
    expect(value).toContain("recoveredAt");expect(value).toContain("unavailable");expect(value).not.toContain(root);expect(value).not.toContain("private user");expect(value).not.toContain("https://private");
    expect(()=>diagnosticCenter(join(root,"diagnostics"),[],"record",()=>undefined)).toThrow();
  }finally{rmSync(root,{recursive:true,force:true});}
});
