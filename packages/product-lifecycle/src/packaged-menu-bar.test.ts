import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyPackagedInstallFromPayload, planPackagedInstallFromPayload } from "./packaged-install";
import { applyPackagedUpgradeFromPayload, planPackagedUpgradeFromPayload, packagedUpgradeJournalPath, readPackagedUpgradeJournal } from "./packaged-upgrade";
import { applyPackagedRepairFromPayload, planPackagedRepairFromPayload } from "./packaged-repair";
import { assertPackagedLaunchAdmission } from "./packaged-launch-admission";
import { observeInstalledPackagedPayload } from "./packaged-payload";
import { readOwnershipManifest } from "./ownership";
import { refreshPackagedMenuBar, packagedMenuBarReadyPath, waitForPackagedMenuBar } from "./packaged-menu-bar";
import type { ServiceRegistrationCommandRunner } from "./service-registration";

async function fixture(sourceHasMenu = true) {
  const root = mkdtempSync(join(tmpdir(), "tela-menu-refresh-")), home = join(root, "home"); mkdirSync(home);
  const paths = new Map<string, string>(); let failRefresh = false;
  let readyBlueprint: Awaited<ReturnType<typeof planPackagedInstallFromPayload>>["blueprint"];
  const calls: string[] = [], events: string[] = [];
  const runner: ServiceRegistrationCommandRunner = { async run(command, args) {
    if (command !== "/bin/launchctl") throw Error("unexpected platform command");
    calls.push(args.join(" "));
    const id = args.at(-1)!.split("/").at(-1)!;
    if (args[0] === "bootstrap") {
      paths.set(id.replace(/\.plist$/, ""), args.at(-1)!);
      return {exitCode:0,stdout:"",stderr:""};
    }
    if (args[0] === "print") return {exitCode:paths.has(id)?0:1,
      stdout:paths.has(id)?`job = {\n path = ${paths.get(id)}\n state = running\n}\n`:"",stderr:""};
    if (args[0] === "kickstart") {
      if (args.includes("-k")) {
        events.push("refresh-ui");
        if (failRefresh) return {exitCode:1,stdout:"",stderr:"fixture launch failure"};
        mkdirSync(readyBlueprint.paths.runtimeRoot,{recursive:true});
        const ownership=readOwnershipManifest(readyBlueprint.paths.installManifest)!;
        writeFileSync(packagedMenuBarReadyPath(readyBlueprint.paths),JSON.stringify({pid:process.pid,parentPid:4321,productVersion:ownership.productVersion}));
      }
      return {exitCode:0,stdout:args.includes("-p")?"4321\n":"",stderr:""};
    }
    throw Error("unexpected launchd action");
  }};
  function payload(version: string) {
    const p=join(root, version);mkdirSync(p);writeFileSync(join(p,"tela"),version,{mode:0o755});
    writeFileSync(join(p,"menu"),version,{mode:0o755});
    writeFileSync(join(p,"chatgpt-tela-package-v1.json"),JSON.stringify({version:1,product:"chatgpt-tela",productVersion:version,
      launcher:{executable:"tela"},profileRuntime:{executable:"tela",entrypoint:"tela"},
      ...(sourceHasMenu || version!=="1.0.0" ? {menuBar:{executable:"menu"}} : {}),
      lifecycle:{transitionLaunch:1,sourceCancellation:1},services:Object.fromEntries(["gateway","chat","codex"].map(service=>[service,{executable:"tela",arguments:["service",service]}]))}));return p;
  }
  const source=payload("1.0.0"),target=payload("2.0.0"),options={platform:"darwin" as const,home,environment:{},runner};
  const planned=await planPackagedInstallFromPayload({payloadSourcePath:source,...options});
  await applyPackagedInstallFromPayload({planned,payloadSourcePath:source,...options});
  readyBlueprint=planned.blueprint;
  const plan=await planPackagedUpgradeFromPayload({payloadSourcePath:target,...options});
  const states=new Map(["gateway","codex","chat"].map(s=>[s,true]));
  const services={async inspect(s:string){return states.get(s)?"running" as const:"stopped" as const;},
    async quiesce(s:string){events.push("stop-"+s);states.set(s,false);},async resume(s:string){events.push("start-"+s);states.set(s,true);}};
  return {root,source,target,options,plan,services,calls,events,fail(){failRefresh=true;},recover(){failRefresh=false;}};
}

const macTest=process.platform === "darwin" ? test : test.skip;
macTest("upgrade refreshes the running UI last and retains its journal until refresh succeeds",async()=>{
 const f=await fixture();try{
  f.fail();
  await expect(applyPackagedUpgradeFromPayload({plan:f.plan,payloadSourcePath:f.target,services:f.services,...f.options})).rejects.toThrow("updated menu bar");
  const journal=packagedUpgradeJournalPath(f.plan.targetBlueprint.paths);
  expect(readPackagedUpgradeJournal(journal)).toMatchObject({phase:"manifest-updated",resumedServices:["chat","codex","gateway"]});
  expect(f.events).toEqual(["stop-gateway","stop-codex","stop-chat","start-chat","start-codex","start-gateway","refresh-ui"]);
  const ownership=readOwnershipManifest(f.plan.targetBlueprint.paths.installManifest)!;
  const observed=observeInstalledPackagedPayload(f.plan.targetBlueprint.payload.resource,ownership);
  if(observed.state!=="owned")throw Error("fixture payload lost ownership");
  expect(()=>assertPackagedLaunchAdmission({paths:f.plan.targetBlueprint.paths,ownership,receipt:observed.receipt,menuBar:true})).not.toThrow();
  expect(()=>assertPackagedLaunchAdmission({paths:f.plan.targetBlueprint.paths,ownership,receipt:observed.receipt})).toThrow("blocked");
  const saved=readFileSync(journal,"utf8");
  const waiting=JSON.parse(saved);waiting.resumedServices=[];writeFileSync(journal,JSON.stringify(waiting));
  expect(()=>assertPackagedLaunchAdmission({paths:f.plan.targetBlueprint.paths,ownership,receipt:observed.receipt,menuBar:true})).toThrow("blocked");
  writeFileSync(journal,saved);f.recover();
  await applyPackagedUpgradeFromPayload({plan:f.plan,payloadSourcePath:f.target,services:f.services,...f.options});
  expect(existsSync(journal)).toBe(false);
  expect(f.events.filter(e=>e.startsWith("stop-")||e.startsWith("start-"))).toHaveLength(6);
  expect(f.calls.filter(c=>c.startsWith("kickstart -k -p"))).toHaveLength(2);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
macTest("healthy repair also refreshes UI; changed registration never receives restart authority",async()=>{
 const f=await fixture();try{
  const plan=await planPackagedRepairFromPayload({payloadSourcePath:f.source,...f.options});
  await applyPackagedRepairFromPayload({plan,payloadSourcePath:f.source,services:f.services,...f.options});
  expect(f.events).toEqual(["refresh-ui"]);
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

macTest("a wrapper PID alone cannot acknowledge GUI startup, including an old instance lock",async()=>{
 const f=await fixture();try{
  const paths=f.plan.targetBlueprint.paths;mkdirSync(paths.runtimeRoot,{recursive:true});
  writeFileSync(packagedMenuBarReadyPath(paths),JSON.stringify({pid:process.pid,parentPid:1234,productVersion:"1.0.0"}));
  const abort=new AbortController();
  const pending=waitForPackagedMenuBar({paths,parentPid:4321,productVersion:"2.0.0",signal:abort.signal});
  abort.abort();await expect(pending).rejects.toThrow("did not acknowledge startup");
  const ready=waitForPackagedMenuBar({paths,parentPid:4321,productVersion:"2.0.0",signal:new AbortController().signal});
  writeFileSync(packagedMenuBarReadyPath(paths),JSON.stringify({pid:process.pid,parentPid:4321,productVersion:"2.0.0"}));
  await ready;
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

macTest("an older package without a menu registration gains the owned UI during upgrade",async()=>{
 const f=await fixture(false);try{
  await applyPackagedUpgradeFromPayload({plan:f.plan,payloadSourcePath:f.target,services:f.services,...f.options});
  expect(readOwnershipManifest(f.plan.targetBlueprint.paths.installManifest)!.resources.some(r=>r.id==="menu-bar-registration")).toBe(true);
  expect(f.events.at(-1)).toBe("refresh-ui");
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
