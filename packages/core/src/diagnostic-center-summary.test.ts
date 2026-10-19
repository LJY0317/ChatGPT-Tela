import{expect,test}from'bun:test';import{mkdtempSync,writeFileSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';
import { writeDiagnosticIncident } from './diagnostic-store';
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

test('context reads a bounded durable cycle after detailed events rotate away',()=>{
 const root=mkdtempSync(join(tmpdir(),'tela-cycle-archive-')),file=join(root,'events.jsonl');
 const ts=new Date().toISOString(),scope='a'.repeat(24),turn='b'.repeat(24);
 try{
  const base={ts,event:'chatgpt_tela_work',scope_fingerprint:scope,turn_fingerprint:turn};
  writeDiagnosticIncident(root,{stage:'native_cycle_summary',observedAt:ts,timeline:[
   {...base,stage:'web_turn_plan',context_mode:'retained-delta',logical_estimate:1000,transfer_estimate:4},
   {...base,stage:'native_cycle_summary',contract_version:1,state:'completed',local_final_committed:true,summary_complete:true},
  ]});
  writeFileSync(file,'');
  const flags:Record<string,string>={'--at':ts,'--scope':scope};
  const report:any=diagnosticCenter(root,[file],'context',key=>flags[key]);
  expect(report.archivedCycleEvents).toBe(2);
  expect(report.turns[0].plans[0]).toMatchObject({mode:'retained-delta',transferTokenEstimate:4});
  expect(report.turns[0].completionEvidence).toBe('cycle_receipt');
  expect(report.turns[0].cycleReceipts[0].preparationTransferEstimate).toBeUndefined();
  writeFileSync(file,[
   {...base,stage:'web_turn_plan',context_mode:'retained-delta',logical_estimate:1000,transfer_estimate:4},
   {...base,stage:'native_cycle_summary',contract_version:1,state:'completed',local_final_committed:true,summary_complete:true},
  ].map(row=>JSON.stringify(row)).join('\n'));
  const merged:any=diagnosticCenter(root,[file],'context',key=>flags[key]);
  expect(merged.turns[0].plans).toHaveLength(1);
  expect(merged.turns[0].cycleReceipts).toHaveLength(1);
  writeFileSync(file,Array.from({length:4097},()=>JSON.stringify({...base,scope_fingerprint:'c'.repeat(24),stage:'native_response_observer_started'})).join('\n'));
  const busy:any=diagnosticCenter(root,[file],'context',key=>flags[key]);
  expect(busy.turns).toHaveLength(1);
  expect(busy.turns[0].plans[0].transferTokenEstimate).toBe(4);
 }finally{rmSync(root,{recursive:true,force:true});}
});
