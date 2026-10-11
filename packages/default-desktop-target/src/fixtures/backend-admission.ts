import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { startDefaultDesktopTargetRuntime } from '../runtime';
import { createDefaultDesktopResponsesRoute } from '../route';
const wsPath=createRequire(join(process.cwd(), 'packages/default-desktop-target/package.json')).resolve('ws');
async function check(rejectProof: boolean) {
  const root=mkdtempSync(join(tmpdir(),'tela-admission-'));
  const backendFile=join(root,'backend-pid'); const desktopFile=join(root,'desktop-started');
  const engine=join(root,'engine'); const desktop=join(root,'desktop');
  writeFileSync(engine, `#!${process.execPath}\nconst {WebSocketServer}=require(${JSON.stringify(wsPath)});const fs=require('node:fs');const s=new WebSocketServer({host:'127.0.0.1',port:0});s.on('connection',w=>w.on('message',b=>{const v=JSON.parse(b.toString());if(v.method==='initialize')w.send(JSON.stringify({id:v.id,result:{}}))}));s.on('listening',()=>{fs.writeFileSync(${JSON.stringify(backendFile)},String(process.pid));console.error('codex app-server (WebSockets)');console.error('  listening on: ws://127.0.0.1:'+s.address().port)});process.on('SIGTERM',()=>process.exit(0));\n`,{mode:0o700});
  writeFileSync(desktop, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(desktopFile)},'started');const ws=new WebSocket(process.env.CODEX_APP_SERVER_WS_URL);ws.addEventListener('error',()=>process.exit(1));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);\n`,{mode:0o700});
  let permit: () => void; let fail: (error: Error) => void;
  const proof=new Promise<void>((resolve,reject)=>{permit=resolve;fail=reject});
  void proof.catch(()=>{});
  let runtime: Awaited<ReturnType<typeof startDefaultDesktopTargetRuntime>> | undefined;
  let entered: () => void; const atAdmission=new Promise<void>(resolve=>{entered=resolve});
  const pending=startDefaultDesktopTargetRuntime({
    installation:{platform:'linux',codexExecutable:engine,chatGptExecutable:desktop,codexHome:root,userDataDir:join(root,'data'),normalQuitSupported:true},
    route:createDefaultDesktopResponsesRoute({baseUrl:'http://127.0.0.1:18919/v1',envKey:'TELA_GATE_FIXTURE',credential:'g'.repeat(48)}),credential:'g'.repeat(48),environment:{OPENAI_ORGANIZATION:'g'.repeat(48)},
    processIds:async()=>runtime?[runtime.desktopPid]:[],normalQuit:async(_,pid)=>{process.kill(pid,'SIGTERM')},
    beforeDesktopLaunch:async()=>{entered!();await proof},
  });
  void pending.catch(()=>{});
  try {
    await Promise.race([atAdmission,pending.then(()=>{throw Error('unexpected early Desktop')})]);
    assert.ok(existsSync(backendFile)); assert.equal(existsSync(desktopFile),false);
    const backendPid=Number(readFileSync(backendFile,'utf8'));
    if(rejectProof){fail!(new Error('fixture Web proof rejected'));await assert.rejects(pending,/fixture Web proof rejected/);assert.equal(existsSync(desktopFile),false);assert.throws(()=>process.kill(backendPid,0));}
    else {permit!();runtime=await pending;assert.ok(existsSync(desktopFile));await runtime.stop();runtime=undefined;assert.throws(()=>process.kill(backendPid,0));}
  } finally {fail!(new Error('fixture teardown'));if(runtime)await runtime.stop();await pending.catch(()=>{});rmSync(root,{recursive:true,force:true});}
}
await check(false); await check(true);
console.log('Prepared backend overlaps Web proof; Desktop is gated; rejected proof leaves no app or backend');
