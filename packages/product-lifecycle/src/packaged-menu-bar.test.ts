import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyPackagedInstallFromPayload, planPackagedInstallFromPayload } from "./packaged-install";
import { applyPackagedRepairFromPayload, planPackagedRepairFromPayload } from "./packaged-repair";
import { readOwnershipManifest, writeOwnershipManifest } from "./ownership";
import { ServiceRegistrationInstaller, ServiceRegistrationManager, serviceRegistrationResourceForDefinition } from "./service-registration";
import { installPackagedMenuBarRegistration, refreshPackagedMenuBar, packagedMenuBarReadyPath, waitForPackagedMenuBar } from "./packaged-menu-bar";
import type { ServiceRegistrationCommandRunner } from "./service-registration";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tela-menu-refresh-")), home = join(root, "home"); mkdirSync(home);
  const paths = new Map<string, string>();
  let readyBlueprint: Awaited<ReturnType<typeof planPackagedInstallFromPayload>>["blueprint"];
  const calls: string[] = [], events: string[] = [];
  const runner: ServiceRegistrationCommandRunner = { async run(command, args) {
    if (command !== "/bin/launchctl") throw Error("unexpected platform command");
    calls.push(args.join(" "));
    const id = args.at(-1)!.split("/").at(-1)!;
    if (args[0] === "bootstrap") {
      paths.set(id.replace(/\.plist$/, ""), args.at(-1)!);
      if (id.includes("menu-bar") && readyBlueprint) {
        events.push("refresh-ui");
        mkdirSync(readyBlueprint.paths.runtimeRoot,{recursive:true});
        const ownership=readOwnershipManifest(readyBlueprint.paths.installManifest)!;
        // A directly relaunched GUI has no launcher parent PID.
        writeFileSync(packagedMenuBarReadyPath(readyBlueprint.paths),JSON.stringify({pid:process.pid,parentPid:1,productVersion:ownership.productVersion}));
      }
      return {exitCode:0,stdout:"",stderr:""};
    }
    if (args[0] === "print") return {exitCode:paths.has(id)?0:1,
      stdout:paths.has(id)?`job = {\n path = ${paths.get(id)}\n state = running\n}\n`:"",stderr:""};
    if (args[0] === "bootout") { paths.delete(id); return {exitCode:0,stdout:"",stderr:""}; }
    if (args[0] === "kickstart") return {exitCode:0,stdout:"",stderr:""};
    throw Error("unexpected launchd action");
  }};
  function payload(version: string) {
    const p=join(root, version);mkdirSync(p);writeFileSync(join(p,"tela"),version,{mode:0o755});
    writeFileSync(join(p,"menu"),version,{mode:0o755});
    writeFileSync(join(p,"chatgpt-tela-package-v1.json"),JSON.stringify({version:1,product:"chatgpt-tela",productVersion:version,
      launcher:{executable:"tela"},profileRuntime:{executable:"tela",entrypoint:"tela"},
      menuBar:{executable:"menu"},
      lifecycle:{transitionLaunch:1,sourceCancellation:1},services:Object.fromEntries(["gateway","chat","codex"].map(service=>[service,{executable:"tela",arguments:["service",service]}]))}));return p;
  }
  const source=payload("1.0.0"),options={platform:"darwin" as const,home,environment:{},runner};
  const planned=await planPackagedInstallFromPayload({payloadSourcePath:source,...options});
  await applyPackagedInstallFromPayload({planned,payloadSourcePath:source,...options});
  readyBlueprint=planned.blueprint;

  const states=new Map(["gateway","codex","chat"].map(s=>[s,true]));
  const services={async inspect(s:string){return states.get(s)?"running" as const:"stopped" as const;},
    async quiesce(s:string){events.push("stop-"+s);states.set(s,false);},async resume(s:string){events.push("start-"+s);states.set(s,true);}};
  return {root,source,options,blueprint:planned.blueprint,services,calls,events};
}

test("menu startup observes a valid receipt even when fs.watch omits the filename", async()=>{
 const moduleUrl=new URL('./packaged-menu-bar.ts',import.meta.url).href;
 const source=`
  import {mock} from 'bun:test';
  import * as fs from 'node:fs';
  import {join} from 'node:path';
  import {tmpdir} from 'node:os';
  import {EventEmitter} from 'node:events';
  let notify;
  mock.module('node:fs',()=>({...fs,watch:(_path,listener)=>{
   notify=listener;const observer=new EventEmitter();observer.close=()=>{};return observer;
  }}));
  const {waitForPackagedMenuBar,packagedMenuBarReadyPath}=await import(${JSON.stringify(moduleUrl)});
  const runtimeRoot=fs.mkdtempSync(join(tmpdir(),'tela-menu-watch-'));
  try {
   const paths={runtimeRoot},abort=new AbortController();
   const pending=waitForPackagedMenuBar({paths,productVersion:'2.0.0',signal:abort.signal});
   fs.writeFileSync(packagedMenuBarReadyPath(paths),JSON.stringify({pid:process.pid,parentPid:4321,productVersion:'2.0.0'}));
   notify('rename',null);
   abort.abort();
   await pending;
  } finally {fs.rmSync(runtimeRoot,{recursive:true,force:true});}
 `;
 const child=Bun.spawn([process.execPath,'--eval',source],{stdout:'pipe',stderr:'pipe'});
 const error=await new Response(child.stderr).text();
 expect({code:await child.exited,error}).toEqual({code:0,error:''});
});

const macTest=process.platform === "darwin" ? test : test.skip;
macTest("healthy repair also refreshes UI; changed registration never receives restart authority",async()=>{
 const f=await fixture();try{
  const plan=await planPackagedRepairFromPayload({payloadSourcePath:f.source,...f.options});
  await applyPackagedRepairFromPayload({plan,payloadSourcePath:f.source,services:f.services,...f.options});
  expect(f.events).toEqual(["refresh-ui"]);
  expect(f.calls.some(call=>call.startsWith("kickstart -"))).toBe(false);
  expect(f.calls.some(call=>call.startsWith("bootout"))).toBe(true);
  const manifest=readOwnershipManifest(plan.blueprint.paths.installManifest)!;
  const before=f.calls.length;
  await expect(refreshPackagedMenuBar({blueprint:plan.blueprint,manifest:{...manifest,resources:manifest.resources.filter(r=>r.id!==plan.blueprint.menuBar!.resource.id)},runner:f.options.runner})).rejects.toThrow("ownership");
  expect(f.calls).toHaveLength(before);
  writeFileSync(join(plan.blueprint.paths.binaryRoot,"menu"),"damaged-ui");
  const damaged=await planPackagedRepairFromPayload({payloadSourcePath:f.source,...f.options});
  expect(damaged.payload.action).toBe("repair");
  await applyPackagedRepairFromPayload({plan:damaged,payloadSourcePath:f.source,services:f.services,...f.options});
  expect(readFileSync(join(plan.blueprint.paths.binaryRoot,"menu"),"utf8")).toBe("1.0.0");
  expect(f.events.slice(-7)).toEqual(["stop-gateway","stop-codex","stop-chat","start-chat","start-codex","start-gateway","refresh-ui"]);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

macTest("GUI acknowledgement accepts Sparkle parentage but rejects an old version",async()=>{
 const f=await fixture();try{
  const paths=f.blueprint.paths;mkdirSync(paths.runtimeRoot,{recursive:true});
  writeFileSync(packagedMenuBarReadyPath(paths),JSON.stringify({pid:process.pid,parentPid:1234,productVersion:"1.0.0"}));
  const abort=new AbortController();
  const pending=waitForPackagedMenuBar({paths,productVersion:"2.0.0",signal:abort.signal});
  abort.abort();await expect(pending).rejects.toThrow("did not acknowledge startup");
  const ready=waitForPackagedMenuBar({paths,productVersion:"2.0.0",signal:new AbortController().signal});
  await new Promise<void>(resolve=>setImmediate(()=>{
   // Match the Swift UI's Data.write(options: .atomic): publish a new
   // directory entry instead of relying on in-place file-write notifications.
   const receipt=packagedMenuBarReadyPath(paths);
   writeFileSync(receipt+".tmp",JSON.stringify({pid:process.pid,parentPid:4321,productVersion:"2.0.0"}));
   renameSync(receipt+".tmp",receipt);
   resolve();
  }));
  await ready;
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

macTest("renewal replaces an owned old executable registration and preserves foreign edits", async()=>{
 const f=await fixture();try{
  const menu=f.blueprint.menuBar!,path=f.blueprint.paths.installManifest;
  let manifest=readOwnershipManifest(path)!;
  await new ServiceRegistrationManager({platform:'darwin',runner:f.options.runner}).release(menu.resource,manifest);
  const definition={platform:'darwin' as const,content:menu.definition.platform==='darwin'?menu.definition.content.replace('/usr/bin/open','/old/owned/launcher'):''};
  const resource=serviceRegistrationResourceForDefinition({resourceId:menu.resource.id,owner:'product',registrationId:menu.resource.registrationId,markerPath:menu.resource.identity!.markerPath,definitionPath:menu.resource.identity!.definitionPath!,definition});
  manifest={...manifest,resources:manifest.resources.map(r=>r.id===resource.id?resource:r)};writeOwnershipManifest(path,manifest);
  await new ServiceRegistrationInstaller({platform:'darwin',runner:f.options.runner}).install({manifestPath:path,manifest,resource,definition});
  await refreshPackagedMenuBar({blueprint:f.blueprint,manifest,runner:f.options.runner});
  expect(readFileSync(menu.resource.identity!.definitionPath!,'utf8')).toContain('/usr/bin/open');
  expect(readOwnershipManifest(path)!.resources.find(r=>r.id===resource.id)).toEqual(menu.resource);
  writeFileSync(menu.resource.identity!.definitionPath!,'foreign edited definition');const before=f.calls.length;
  await expect(installPackagedMenuBarRegistration({blueprint:f.blueprint,manifest:readOwnershipManifest(path)!,runner:f.options.runner})).rejects.toThrow('ownership');
  expect(f.calls.slice(before).some(x=>x.startsWith('bootout'))).toBe(false);
  expect(readFileSync(menu.resource.identity!.definitionPath!,'utf8')).toBe('foreign edited definition');
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
