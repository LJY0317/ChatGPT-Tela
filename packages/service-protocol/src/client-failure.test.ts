import {expect,test} from 'bun:test';
import {observeDiagnosticEvents,structuralDiagnosticEvent} from '@chatgpt-tela/core';
import {LocalServiceClient,ServiceHttpError} from './client';

test('service boundary preserves HTTP/cancellation/decode evidence without response bodies or credentials',async()=>{
 const events:any[]=[];const stop=observeDiagnosticEvents(row=>{if(row.stage.startsWith('service_'))events.push(row)});
 let mode='http',requests=0;
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){requests++;
  return mode==='http'?Response.json({error:{message:'PRIVATE_PATH /some/user/source'}},{status:409}):new Response('PRIVATE_HTML',{headers:{'content-type':'text/plain'}});
 }});
 class Fixture extends LocalServiceClient{call(signal?:AbortSignal){return this.request('v1/fixture','POST',{},signal)}}
 const client=new Fixture({version:1,service:'chat',instanceId:'fixture',installId:'fixture',pid:process.pid,
  endpoint:`http://127.0.0.1:${server.port}/`,bearerToken:'PRIVATE_BEARER',startedAt:new Date().toISOString()});
 try{
  await expect(client.call()).rejects.toBeInstanceOf(ServiceHttpError);
  expect(events.find(row=>row.stage==='service_request_failed')).toMatchObject({phase:'http',reason_class:'http_rejected',http_status:409});
  mode='decode';expect(await client.call()).toBeUndefined();
  expect(events.find(row=>row.stage==='service_response_decode_failed')).toMatchObject({phase:'decode',http_status:200});
  const owner=new AbortController();owner.abort(new DOMException('PRIVATE_ABORT','AbortError'));
  await expect(client.call(owner.signal)).rejects.toThrow();expect(requests).toBe(2);
  expect(events.at(-1)).toMatchObject({stage:'service_request_failed',phase:'transport',reason_class:'aborted',abort_observed:true});
  expect(structuralDiagnosticEvent(events[0])).toEqual(events[0]);
  expect(JSON.stringify(events)).not.toMatch(/PRIVATE_|127\.0\.0\.1|some\/user/);
 }finally{stop?.();await server.stop(true)}
});
