import {expect,test}from'bun:test';import{mkdtempSync,readFileSync,rmSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
import type{McpServer}from'@modelcontextprotocol/sdk/server/mcp.js';
import{registerTurnBridgeTools}from'./turn-server';import{diagnosticFingerprint}from'@chatgpt-tela/core';

test.each([false,true])('Native MCP projection bounds UTF-8 measurement without changing payload/invocations: large=%s',async large=>{
 const root=mkdtempSync(join(tmpdir(),'tela-mcp-size-')),file=join(root,'events.jsonl'),previous=process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
 process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=file;
 const handlers=new Map<string,(request:any,extra:any)=>Promise<any>>();let invoked=0;
 const text=large?'x'.repeat(1_048_577):'PRIVATE_BODY 한글 😀';
 try{
  registerTurnBridgeTools({registerTool(name:string,_config:unknown,handler:any){handlers.set(name,handler);}}as unknown as McpServer,
   {inventory:()=>[],async invoke(_capability,invocation){invoked++;return{callId:invocation.callId,content:text,isError:false};}},
   {inventory:'inventory',call:'call'},{inventoryTitle:'Inventory',inventoryDescription:'Inventory',callTitle:'Call',callDescription:'Call'});
  const result=await handlers.get('call')!({turn_capability:'PRIVATE_CAPABILITY_0123456789',call_id:'PRIVATE_CALL',wire_name:'test',mode:'structured',arguments:{}},{});
  expect(result.content).toEqual([{type:'text',text}]);expect(invoked).toBe(1);
  const raw=readFileSync(file,'utf8'),rows=raw.trim().split('\n').map(line=>JSON.parse(line));
  const measurement=rows.find(row=>row.stage==='mcp_native_result_projected');
  expect(measurement).toMatchObject({operation_fingerprint:diagnosticFingerprint('PRIVATE_CALL'),text_measurement_complete:!large,part_count:1,image_bytes:0});
  if(large)expect(measurement.text_bytes).toBeUndefined();else expect(measurement.text_bytes).toBe(Buffer.byteLength(text));
  expect(raw).not.toContain('PRIVATE_');
 }finally{if(previous===undefined)delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=previous;rmSync(root,{recursive:true,force:true});}
});
