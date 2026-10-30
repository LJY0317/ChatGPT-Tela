import {expect} from 'bun:test';
import {startCodexService} from '../controller';
import type {CodexNativeTargetAdapter} from '../native-target';

async function verify() {
  const {mkdtempSync,writeFileSync,rmSync} = await import('node:fs');
  const {join,resolve} = await import('node:path');
  const {tmpdir} = await import('node:os');
  const dir=mkdtempSync(join(tmpdir(),'tela-cleanup-test-'));
  const child=join(dir,'child.ts'), state=join(dir,'native-state');
  writeFileSync(state,'active');
  const serverModule=resolve(import.meta.dir,'../../../mcp/src/http-server.ts');
  const supervisionModule=resolve(import.meta.dir,'../../../../apps/profile-runtime/src/supervision.ts');
  writeFileSync(child,`import {startCodexBridgeMcpHttpServer} from ${JSON.stringify(serverModule)};
import {createProfileSupervisorLifecycle} from ${JSON.stringify(supervisionModule)};
const lifecycle=await createProfileSupervisorLifecycle();
const server=await startCodexBridgeMcpHttpServer({bridge:{inventory(){return []},async invoke(){throw new Error('unused')}},authentication:{kind:'bearer',token:process.env.CHATGPT_TELA_PRODUCT_INTERNAL_MCP_TOKEN}});
console.log(JSON.stringify({stage:"product-profile-ready",routeId:"stdout-is-not-authority"}));
const {readFileSync}=await import("node:fs");
const busy=()=>readFileSync(${JSON.stringify(state)},"utf8")==="active";
const native=Bun.serve({hostname:"127.0.0.1",port:0,fetch(r,s){return s.upgrade(r)?undefined:new Response(null,{status:400})},websocket:{message(ws,message){const request=JSON.parse(String(message));if(request.method==="initialize")ws.send(JSON.stringify({id:request.id,result:{}}));else if(request.method==="thread/loaded/list")ws.send(JSON.stringify({id:request.id,result:{data:busy()?["owned-thread"]:[],nextCursor:null}}));else if(request.method==="thread/read")ws.send(JSON.stringify({id:request.id,result:{thread:{id:"owned-thread",status:{type:"active"}}}}));}}});
const preview=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){
if(new URL(request.url).pathname==='/v1/shutdown-readiness'&&request.headers.get('authorization')==='Bearer '+process.env.CHATGPT_TELA_PRODUCT_UI_TOKEN)return Response.json({contractVersion:1,slot:1,shutdownReadiness:'ready'});
if(request.method==='POST'&&new URL(request.url).pathname==='/v1/profile-stop'&&request.headers.get('authorization')==='Bearer '+process.env.CHATGPT_TELA_PRODUCT_UI_TOKEN)return Response.json({contractVersion:1,slot:1,phase:'cleanup-complete',responsesRouteFingerprint:'a'.repeat(64)});
return new Response(null,{status:404});}});
await lifecycle.publishReady({stage:'product-profile-ready',runtimeProcessId:process.pid,slot:1,routeId:process.env.CHATGPT_TELA_PRODUCT_ROUTE_ID,targetId:'fixture',nativeTargetKind:'multi-profile',nativeReady:true,webState:'preparing',profileId:'fixture',internalMcpUrl:server.endpointUrl.href,bridgePreviewUrl:preview.url.href,responsesUrl:'http://127.0.0.1:1',terminalEndpoint:'ws://127.0.0.1:'+native.port+'/',responsesRouteFingerprint:'a'.repeat(64)});
await lifecycle.shutdownRequested;await server.stop();await preview.stop(true);native.stop(true);lifecycle.dispose();
`);
  const lifecycle=new AbortController();let started=false;let quits=0;
  const target={slot:1,adapterKind:'multi-profile' as const,id:'fixture',displayName:'Fixture',state:'stopped',managed:true};
  const session=()=>({targetId:'fixture',state:started?'ready':'available',...(started?{responsesRouteFingerprint:'a'.repeat(64)}:{})});
  const adapter:CodexNativeTargetAdapter={kind:'multi-profile',
    async profiles(){return [{target,session:session()}]},async resolve(){return {target,session:session()}},
    async session(_id,signal){signal?.throwIfAborted();return session()},
    async quit(_id,signal){signal?.throwIfAborted();quits++;started=false;return session()},
    profileRuntimeEnvironment(){started=true;return {}},
  };
  const childBundled=join(dir,'child.mjs');
  await Bun.build({entrypoints:[child],target:'node',outdir:dir,naming:'child.mjs'});
  const service=await startCodexService({config:{},profileRuntimeCommand:[process.execPath,childBundled],nativeTargetAdapter:adapter,signal:lifecycle.signal});
  try {
    await service.startProfile(1);expect(service.activeProfileCount).toBe(1);
    lifecycle.abort();
    await expect(service.close()).rejects.toThrow("active or unverifiable");
    expect(service.activeProfileCount).toBe(1);expect(quits).toBe(0);
    writeFileSync(state,"idle");await service.close();
    expect(quits).toBe(1);expect(service.activeProfileCount).toBe(0);
  } finally {await service.close();rmSync(dir,{recursive:true,force:true})}
}
await verify();console.log(JSON.stringify({cleanupAfterAbort:true}));
