import{expect,test}from'bun:test';import{mkdtempSync,writeFileSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';
import{diagnosticCenter}from'./diagnostic-center';
test('compact context view keeps evidence limits, explicit omissions and unknown cost',()=>{
 const root=mkdtempSync(join(tmpdir(),'tela-context-view-')),file=join(root,'events.jsonl');
 try{
  const ts='2026-10-16T00:00:00.000Z';
  writeFileSync(file,[1,2].map(n=>JSON.stringify({ts,event:'chatgpt_tela_work',stage:'native_outcome_committed',outcome:'final',scope_fingerprint:'a'.repeat(24),turn_fingerprint:String(n).repeat(24)})).join('\n')+'\n');
  const options:Record<string,string>={'--view':'summary','--limit':'1','--at':ts};
  const report:any=diagnosticCenter(root,[file],'context',key=>options[key]);
  expect(report.contractVersion).toBe(2);expect(report.turns).toHaveLength(1);expect(report.selection.turnsOmitted).toBe(1);
  expect(report.turns[0].plans).toBeUndefined();expect(report.turns[0].summary.cost.composer.complete).toBe(false);
  expect(report.sourceCoverage).toHaveLength(1);expect(report.evidenceLimits.eventLimitReached).toBe(false);
  options['--limit']='0';expect(()=>diagnosticCenter(root,[file],'context',key=>options[key])).toThrow('view or limit');
 }finally{rmSync(root,{recursive:true,force:true});}
});
