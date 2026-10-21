import { expect, test } from "bun:test";
import { diagnosticFingerprint, observeDiagnosticEvents } from "@chatgpt-tela/core";
import { restorableWorkProfiles, restoreWorkProfiles } from "./connection-policy";
import type { CodexProfileStatus } from "./controller";

test("saved intent restores stopped targets only; running, foreign and orphaned routes stay untouched", () => {
  const base: CodexProfileStatus = { slot: 1, targetId: "default", targetDisplayName: "ChatGPT", targetState: "stopped", targetSessionState: "available", controlState: "stopped" };
  const variants: CodexProfileStatus[] = [base,
    { ...base, slot: 2, targetId: "second", targetState: "running", controlState: "restart-required" },
    { ...base, slot: 3, targetId: "third", targetSessionState: "ready" },
    { ...base, slot: 4, targetId: "fourth", controlState: "orphaned" },
    { ...base, slot: 5, targetId: "unselected" }];
  expect(restorableWorkProfiles(variants, ["default", "second", "third", "fourth", "missing"])).toEqual([1]);
  expect(restorableWorkProfiles(variants, [])).toEqual([]);
});


test("startup restoration checks inventory once, isolates failures and preserves already-open apps", async () => {
  const profiles: CodexProfileStatus[] = [1,2,3].map(slot => ({slot,targetId:`target${slot}`,targetDisplayName:'ChatGPT',
    targetState:slot===3?'running':'stopped',targetSessionState:slot===3?'restart-required':'available',
    controlState:slot===3?'restart-required':'stopped',...(slot===3?{desktopProcessId:21381}:{})}));
  profiles.push({slot:4,targetId:'target4',targetDisplayName:'ChatGPT',targetState:'running',targetSessionState:'ready',
    controlState:'orphaned',childProcessId:24680,desktopProcessId:13579});
  let reads=0; const started:number[]=[];
  const diagnostics: Record<string, any>[] = [];
  const dispose = observeDiagnosticEvents(event => { if(event.stage==='profile_restore_skipped') diagnostics.push(event as Record<string, any>); });
  try {
    await restoreWorkProfiles({async profiles(){reads++;return profiles;},async startProfile(slot,options){
      expect(options).toEqual({requireStopped:true});started.push(slot);
      if(slot===1)throw new Error('synthetic launch failure');return profiles[slot-1]!;
    }},['target1','target2','target3','target4'],new AbortController().signal);
  } finally { dispose?.(); }
  expect(reads).toBe(1);expect(started).toEqual([1,2]);
  expect(diagnostics.filter(event=>event.slot===3).map(({phase,state})=>[phase,state])).toEqual([
    ['target_state','running'],['session_state','restart-required'],['control_state','restart-required'],
  ]);
  expect(diagnostics.filter(event=>event.slot===3).every(event=>event.desktop_process_fingerprint===diagnosticFingerprint('21381'))).toBe(true);
  expect(diagnostics.filter(event=>event.slot===4).every(event=>event.runtime_process_fingerprint===diagnosticFingerprint('24680')
    &&event.desktop_process_fingerprint===diagnosticFingerprint('13579'))).toBe(true);
});
