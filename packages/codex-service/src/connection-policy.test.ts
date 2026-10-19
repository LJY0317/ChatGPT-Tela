import { expect, test } from "bun:test";
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
    targetState:slot===3?'running':'stopped',targetSessionState:slot===3?'ready':'available',controlState:'stopped'}));
  let reads=0; const started:number[]=[];
  await restoreWorkProfiles({async profiles(){reads++;return profiles;},async startProfile(slot,options){
    expect(options).toEqual({requireStopped:true});started.push(slot);
    if(slot===1)throw new Error('synthetic launch failure');return profiles[slot-1]!;
  }},['target1','target2','target3'],new AbortController().signal);
  expect(reads).toBe(1);expect(started).toEqual([1,2]);
});
