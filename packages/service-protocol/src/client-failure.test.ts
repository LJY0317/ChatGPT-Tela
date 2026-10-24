import {expect,test} from 'bun:test';
import {observeDiagnosticEvents,structuralDiagnosticEvent} from '@chatgpt-tela/core';
import {CodexServiceClient,LocalServiceClient,ServiceHttpError,ServiceShutdownNotStartedError} from './client';

test('profile client forwards explicit PID consent once and rejects invalid PIDs before dispatch',async()=>{
 const bodies:unknown[]=[];
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){bodies.push(await request.json());return Response.json({slot:2,targetId:'default',targetDisplayName:'ChatGPT',targetState:'running',targetSessionState:'ready',controlState:'running'});}});
 const client=new CodexServiceClient({version:1,service:'codex',instanceId:'fixture',installId:'fixture',pid:process.pid,endpoint:`http://127.0.0.1:${server.port}/`,bearerToken:'fixture',startedAt:new Date().toISOString()});
 try{
  await expect(client.startProfile(2,undefined,{expectedDesktopProcessId:1234})).resolves.toMatchObject({slot:2,controlState:'running'});
  await expect(client.startProfile(2)).resolves.toMatchObject({slot:2});
  for(const pid of [0,-1,1.5,Number.NaN])await expect(client.startProfile(2,undefined,{expectedDesktopProcessId:pid})).rejects.toThrow('positive integer');
  expect(bodies).toEqual([{expectedDesktopProcessId:1234},{}]);
 }finally{await server.stop(true)}
});

test("only an exact shutdown admission receipt proves that no shutdown started", async () => {
 const receipt = { contractVersion: 1, service: "chat", instanceId: "fixture", shutdown: "not-started" };
 let body: unknown = receipt, status = 409;
 const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return Response.json(body, { status }); } });
 const client = new LocalServiceClient({ version: 1, service: "chat", instanceId: "fixture", installId: "fixture", pid: process.pid,
  endpoint: `http://127.0.0.1:${server.port}/`, bearerToken: "fixture-token", startedAt: new Date().toISOString() });
 try {
  await expect(client.shutdown()).rejects.toBeInstanceOf(ServiceShutdownNotStartedError);
  for (const invalid of [{ error: { type: "tela_chat_shutdown_blocked", message: "not-started" } },
   { ...receipt, instanceId: "successor" }, { ...receipt, service: "codex" }, { ...receipt, contractVersion: 2 }, { ...receipt, shutdown: "unknown" }, null]) {
   body = invalid;
   try { await client.shutdown(); throw Error("expected rejection"); }
   catch (error) { expect(error).toBeInstanceOf(ServiceHttpError); expect(error).not.toBeInstanceOf(ServiceShutdownNotStartedError); }
  }
  body = receipt; status = 503;
  await expect(client.shutdown()).rejects.not.toBeInstanceOf(ServiceShutdownNotStartedError);
 } finally { await server.stop(true); }
});

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
