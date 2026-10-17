import { expect, test } from 'bun:test';
import { startCodexBridgeMcpHttpServer } from './http-server';
import { connectCodexTurnBridge } from './remote-turn-bridge';

test('remote bridge remains usable after idle session reclamation and never replays calls', async () => {
  let calls = 0;
  const server = await startCodexBridgeMcpHttpServer({
    sessionIdleTimeoutMs: 20,
    bridge: {
      inventory() { return [{wireName:'fixture_read', name:'fixture_read', kind:'function' as const,
        description:'Read fixture', inputSchema:{type:'object'}, observedFrom:['fixture']}]; },
      async invoke(_capability, invocation) {
        calls++;
        if(invocation.callId==="reject-call") throw new Error("Controlled fixture failure");
        return {callId:invocation.callId, content:'fixture result', isError:false};
      },
    },
  });
  const bridge = await connectCodexTurnBridge({endpoint:server.endpointUrl, bearerToken:server.bearerToken!});
  try {
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(server.activeSessionCount).toBe(0);
    expect((await bridge.inventory('turnr_Fixture1_opaque_capability')).length).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 60));
    const result = await bridge.invoke('turnr_Fixture1_opaque_capability', {
      callId:'fixture-call', wireName:'fixture_read', mode:'structured', arguments:{},
    });
    expect(result.content).toBe('fixture result');
    expect(calls).toBe(1);
    expect(server.activeSessionCount).toBe(0);
    const rejected = await bridge.invoke('turnr_Fixture1_opaque_capability', {
      callId:'reject-call', wireName:'fixture_read', mode:'structured', arguments:{},
    });
    expect(rejected.isError).toBe(true);
    expect(calls).toBe(2);
    expect(server.activeSessionCount).toBe(0);
    await bridge.close();
    await expect(bridge.inventory('turnr_Fixture1_opaque_capability')).rejects.toThrow('closed');
  } finally { await bridge.close(); await server.stop(); }
});

test('SDK request timeouts record the observed adapter phase and never replay a Native invocation',async()=>{
 const {ErrorCode}=await import('@modelcontextprotocol/sdk/types.js');
 const {observeDiagnosticEvents}=await import('@chatgpt-tela/core');
 const events:any[]=[];const stop=observeDiagnosticEvents(row=>{if(row.stage==='native_mcp_call_failed')events.push(row)});
 let calls=0;
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
  if(request.method!=='POST')return new Response(null,{status:200});
  const row=await request.json() as any;
  if(row.method==='initialize')return Response.json({jsonrpc:'2.0',id:row.id,result:{protocolVersion:row.params.protocolVersion,
   capabilities:{tools:{}},serverInfo:{name:'fixture',version:'0'}}});
  if(row.method==='tools/call'){calls++;return Response.json({jsonrpc:'2.0',id:row.id,error:{code:ErrorCode.RequestTimeout,message:'PRIVATE_TIMEOUT'}})}
  return new Response(null,{status:202});
 }});
 let bridge:Awaited<ReturnType<typeof connectCodexTurnBridge>>|undefined;
 try{
  bridge=await connectCodexTurnBridge({endpoint:`http://127.0.0.1:${server.port}/mcp`,bearerToken:'h'.repeat(48)});
  await expect(bridge.invoke('turnr_Fixture1_opaque_capability',{callId:'fixture',wireName:'fixture',mode:'structured',arguments:{}})).rejects.toThrow();
  expect(calls).toBe(1);expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({phase:'invoke',reason_class:'timeout'});
  expect(JSON.stringify(events)).not.toMatch(/PRIVATE_|127\.0\.0\.1|opaque_capability/);
 }finally{stop?.();await bridge?.close();await server.stop(true)}
});
