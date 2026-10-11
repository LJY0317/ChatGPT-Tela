import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  NativeCompactionHistoryProjection, NativeReadableHistoryAnchor,
} from "@chatgpt-tela/codex";
import { FileContextCheckpointCache } from "./context-cache";
import {
  maybeProduceNativeHistoryCheckpoint, readNativeHistoryCheckpoint,
} from "./native-history-checkpoint";

function fixture(){
  const anchor:NativeReadableHistoryAnchor={
    threadId:"thread-1",currentTurnId:"current",compactionTurnId:"compressed",
    compactionItemId:"compaction-1",
  };
  const history:NativeCompactionHistoryProjection={
    ...anchor,
    content:JSON.stringify({type:"tela_native_visible_history_v1",
      compactionItemId:anchor.compactionItemId,
      items:[{turnId:"old",item:{type:"agentMessage",id:"old-answer",
        text:"A".repeat(110_000)}}]}),
    inlineAssets:[],references:[],localImageCandidates:[],
  };
  return {anchor,history};
}
function root(){return mkdtempSync(join(tmpdir(),"tela-history-checkpoint-"));}
function produce(){
  let calls=0;
  return {
    calls:()=>calls,
    async create(input:{nativeTaskId:string;sourceRevisionId:string;physicalContext:unknown}){
      calls++;
      return {nativeTaskId:input.nativeTaskId,sourceRevisionId:input.sourceRevisionId,
        content:"Verified source-specific history summary; no original tool evidence implied."};
    },
  };
}

describe("Native readable historical checkpoint boundary",()=>{
  test("persists an exact-compaction, source-bound derived summary and restores without raw source",async()=>{
    const directory=root();
    try{
      const {anchor,history}=fixture();
      const cache=new FileContextCheckpointCache({directory});
      const provider=produce();
      let confirmations=0;
      const produced=await maybeProduceNativeHistoryCheckpoint({
        anchor,history,cache,producer:provider.create,effort:"medium",
        confirmAnchor:async()=>{confirmations++;return anchor;},
      });
      expect(provider.calls()).toBe(1);
      expect(confirmations).toBe(1);
      expect(produced).toContain("summary-only-requires-native-readback");
      expect(produced).not.toContain("A".repeat(256));
      const reopened=new FileContextCheckpointCache({directory});
      expect(await readNativeHistoryCheckpoint(reopened,anchor)).toBe(produced);
      expect(await readNativeHistoryCheckpoint(reopened,{...anchor,compactionItemId:"new-compaction"})).toBeUndefined();
      expect(await readNativeHistoryCheckpoint(reopened,{...anchor,compactionTurnId:"other-turn"})).toBeUndefined();
      expect(await readNativeHistoryCheckpoint(reopened,{...anchor,threadId:"other-thread"})).toBeUndefined();
      expect(await new FileContextCheckpointCache({directory:join(directory,"different-account")})
        .list(anchor.threadId)).toEqual([]);
    }finally{rmSync(directory,{recursive:true,force:true});}
  });

  test("checkpoint integrity failure degrades to a cold source, not a fabricated or cross-account continuation",async()=>{
    const directory=root();
    try{
      const {anchor,history}=fixture();
      const cache=new FileContextCheckpointCache({directory});
      await maybeProduceNativeHistoryCheckpoint({anchor,history,cache,
        producer:produce().create,effort:"medium",confirmAnchor:async()=>anchor});
      const [filename]=readdirSync(directory);
      if(!filename)throw Error("checkpoint test file missing");
      const location=join(directory,filename);
      const stored=JSON.parse(readFileSync(location,"utf8"));
      stored.checkpoints[0].content=stored.checkpoints[0].content.replace(
        "summary-only-requires-native-readback","original-content-authoritative");
      writeFileSync(location,JSON.stringify(stored)+"\n","utf8");
      expect(await readNativeHistoryCheckpoint(new FileContextCheckpointCache({directory}),anchor))
        .toBeUndefined();
    }finally{rmSync(directory,{recursive:true,force:true});}
  });

  test("a foreign producer response, changed marker or cancellation is never cached",async()=>{
    for(const failure of ["foreign","marker","cancelled"] as const){
      const directory=root();
      try{
        const {anchor,history}=fixture();
        const cache=new FileContextCheckpointCache({directory});
        const signal=new AbortController();
        await expect(maybeProduceNativeHistoryCheckpoint({
          anchor,history,cache,effort:"medium",signal:signal.signal,
          producer:async input=>{
            if(failure==="cancelled")signal.abort();
            return {nativeTaskId:failure==="foreign"?"another-thread":input.nativeTaskId,
              sourceRevisionId:input.sourceRevisionId,content:"Untrusted summary"};
          },
          confirmAnchor:async()=>failure==="marker"
            ? {...anchor,compactionItemId:"stale-revised"}:anchor,
        })).rejects.toThrow();
        expect(await cache.list(anchor.threadId)).toEqual([]);
      }finally{rmSync(directory,{recursive:true,force:true});}
    }
  });

  test("oversized initial source refuses a model call even when historical content is structurally valid",async()=>{
    const directory=root();
    try{
      const {anchor,history}=fixture();
      const cache=new FileContextCheckpointCache({directory});
      const provider=produce();
      const veryLarge={...history,content:JSON.stringify({
        type:"tela_native_visible_history_v1",compactionItemId:anchor.compactionItemId,
        items:[{turnId:"old",item:{type:"agentMessage",text:"A".repeat(430_000)}}],
      })};
      expect(await maybeProduceNativeHistoryCheckpoint({
        anchor,history:veryLarge,cache,producer:provider.create,effort:"medium",
        confirmAnchor:async()=>{throw Error("oversized checkpoint must not confirm");},
      })).toBeUndefined();
      expect(provider.calls()).toBe(0);
      expect(await cache.list(anchor.threadId)).toEqual([]);
    }finally{rmSync(directory,{recursive:true,force:true});}
  });
});
