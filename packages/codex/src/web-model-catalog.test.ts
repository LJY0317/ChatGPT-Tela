import {expect,test} from 'bun:test';
import {readDynamicWebModelCatalog,refreshAdmittedWebModelCatalog} from './web-model-catalog';
import {observeDiagnosticEvents,structuralDiagnosticEvent} from '@chatgpt-tela/core';
const ids=['chatgpt-tela-web/fixture'];
const catalog={data:[{model:'fixture-native',hidden:false},{model:ids[0],hidden:false}],nextCursor:null};
test('explicit Tela refresh verifies admission; ordinary list uses upstream method',async()=>{
 const calls:string[]=[];
 const rpc={async request(method:string){calls.push(method);return method==='model/list'?catalog:{contractVersion:1,catalog};}};
 expect(await refreshAdmittedWebModelCatalog(rpc,ids,new AbortController().signal)).toEqual(ids);
 expect(await readDynamicWebModelCatalog(rpc,new AbortController().signal)).toEqual(ids);
 expect(calls).toEqual(['tela/modelCatalog/refresh','model/list']);
});
test('last-good catalog, hidden rows, unsupported contract and pagination cannot prove admission',async()=>{
 for(const response of [
  {contractVersion:1,catalog:{data:[{model:'fixture-native'}],nextCursor:null}},
  {contractVersion:1,catalog:{data:[{model:ids[0],hidden:true}],nextCursor:null}},
  {contractVersion:2,catalog},
  {contractVersion:1,catalog:{...catalog,nextCursor:'more'}},
  {contractVersion:1,catalog:{...catalog,data:[...catalog.data,{model:'chatgpt-tela-web/obsolete'}]}},
 ]){let calls=0;const rpc={async request(){calls++;return response;}};
  await expect(refreshAdmittedWebModelCatalog(rpc,ids,new AbortController().signal)).rejects.toThrow();expect(calls).toBe(1);
 }
});
test('unsupported engine is not retried and invalid admission makes no request',async()=>{
 let calls=0;const rpc={async request(){calls++;throw Error('method not found');}};
 await expect(refreshAdmittedWebModelCatalog(rpc,ids,new AbortController().signal)).rejects.toThrow('method not found');
 expect(calls).toBe(1);
 await expect(refreshAdmittedWebModelCatalog(rpc,[],new AbortController().signal)).rejects.toThrow('Invalid admitted');
 expect(calls).toBe(1);
});
test('refresh failures distinguish request, protocol and admission without leaking model or exception data',async()=>{
 const events:any[]=[];
 const stop=observeDiagnosticEvents(row=>{if(row.stage==='web_catalog_refresh_failed')events.push(row)});
 const failure=new DOMException('PRIVATE_TIMEOUT','TimeoutError');
 try{
  let calls=0;
  await expect(refreshAdmittedWebModelCatalog({async request(){calls++;throw failure;}},ids,new AbortController().signal)).rejects.toBe(failure);
  expect(calls).toBe(1);
  expect(events.at(-1)).toMatchObject({phase:'request',reason_class:'timeout',admitted_count:1,abort_observed:false});
  await expect(refreshAdmittedWebModelCatalog({async request(){return {contractVersion:99}}},ids,new AbortController().signal)).rejects.toThrow();
  expect(events.at(-1)).toMatchObject({phase:'response_validation'});
  await expect(refreshAdmittedWebModelCatalog({async request(){return {contractVersion:1,catalog:{data:[{model:'chatgpt-tela-web/PRIVATE_FOREIGN'}]}}}},ids,new AbortController().signal)).rejects.toThrow();
  expect(events.at(-1)).toMatchObject({phase:'admission_match',visible_count:1});
  expect(events).toHaveLength(3);
  for(const event of events)expect(structuralDiagnosticEvent(event)).toEqual(event);
  expect(JSON.stringify(events)).not.toMatch(/PRIVATE_|chatgpt-tela-web/);
 }finally{stop?.();}
});
