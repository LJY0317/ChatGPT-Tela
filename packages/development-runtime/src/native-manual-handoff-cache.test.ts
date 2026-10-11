import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileContextCheckpointCache } from "./context-cache";
import {
  manualHandoffText, recentManualHandoff, storeManualHandoff,
} from "./native-manual-handoff-cache";

const original = {
  threadId: "thread-one", currentTurnId: "turn-current",
  handoffTurnId: "native-requested-handoff", handoffItemId: "native-final",
  answerDigest: "a".repeat(64),
  summary: "Bounded Native-owned task-continuation summary",
  limitations: "Past tool outputs and attachments were not independently verified",
};
const state = "b".repeat(64);

test("manual Native handoff cache is a source-bound hint, not a cross-account or cross-compaction authority", async () => {
  const root=mkdtempSync(join(tmpdir(),"tela-native-manual-handoff-"));
  try {
    const first = new FileContextCheckpointCache({directory:join(root,"account-A")});
    const second = new FileContextCheckpointCache({directory:join(root,"account-B")});
    await storeManualHandoff(first,original,state);
    expect(await recentManualHandoff(first,"thread-one",state))
      .toMatchObject({handoffTurnId:original.handoffTurnId,
        answerDigest:original.answerDigest,summary:original.summary});
    expect(await recentManualHandoff(second,"thread-one",state)).toBeUndefined();
    expect(await recentManualHandoff(first,"other-thread",state)).toBeUndefined();
    expect(await recentManualHandoff(first,"thread-one","c".repeat(64))).toBeUndefined();
    const found=await recentManualHandoff(new FileContextCheckpointCache({
      directory:join(root,"account-A"),
    }),"thread-one",state);
    expect(found?.summary).toBe(original.summary);
    expect(manualHandoffText(original)).toContain("tela_native_explicit_web_handoff_v1");
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("manual cache tampering and oversized summaries cannot turn the hint into a usable proof",async()=>{
  const root=mkdtempSync(join(tmpdir(),"tela-native-manual-handoff-"));
  try{
    const cache=new FileContextCheckpointCache({directory:root});
    await expect(storeManualHandoff(cache,{
      ...original,summary:"z".repeat(40*1024),
    },state)).rejects.toThrow("bounded");
    await storeManualHandoff(cache,original,state);
    const [file]=readdirSync(root);
    if(!file)throw Error("Cache file missing");
    const path=join(root,file);
    const json=JSON.parse(readFileSync(path,"utf8"));
    json.checkpoints[0].content=json.checkpoints[0].content.replace(
      original.summary,"Unverified replacement summary");
    writeFileSync(path,JSON.stringify(json),"utf8");
    expect(await recentManualHandoff(new FileContextCheckpointCache({directory:root}),
      original.threadId,state)).toBeUndefined();
  }finally{rmSync(root,{recursive:true,force:true});}
});
