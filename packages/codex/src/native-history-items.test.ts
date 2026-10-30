import {test,expect} from 'bun:test';
import {resolve} from 'node:path';
import {AppServerCurrentTurnSource} from './app-server';
import type {CanonicalCurrentTurnEvidence} from './rollout';
const bound:CanonicalCurrentTurnEvidence={threadId:'original-thread',turnId:'active-turn',cwd:resolve('/workspace'),
 workspaceRoots:[resolve('/workspace')],sandbox:{kind:'native-enforced'},proof:'app-server-active-turn',environmentSourceTurnId:'active-turn'};
function fixture(retireDuringRead=false,items:Record<string,unknown>[]=[{id:'selected-item',type:'agentMessage',text:'원문'}]){
 let head='active-turn',mode='paginated',closed=0;
 const calls:{method:string;params:any}[]=[];
 const source=new AppServerCurrentTurnSource(async()=>({
  async request(method,params:any){
   calls.push({method,params});
   if(method==='thread/read')return {thread:{id:bound.threadId,historyMode:mode,cwd:resolve('/workspace'),status:{type:'active'}}};
   if(method==='thread/turns/list'){
    if(params.limit===4)return {data:[{id:head,status:'inProgress',itemsView:'notLoaded',items:[]},
      {id:'prior',status:'completed',itemsView:'notLoaded',items:[],privateField:'must not leak'}],nextCursor:'older-index-page'};
    return {data:[{id:head,status:'inProgress',itemsView:'notLoaded',items:[]}]};
   }
   if(method==='thread/items/list'){
    if(retireDuringRead)head='replacement-turn';
    return {data:(params.sortDirection==='desc'?[...items].reverse():items).slice(0,params.limit).map(item=>({turnId:params.turnId,item})),
      nextCursor:items.length>params.limit?'older-items':null};
   }
   throw Error('unexpected request');
  },async close(){closed++;}
 }));
 return {source,calls,get closed(){return closed;},setHead(v:string){head=v;},setMode(v:string){mode=v;}};
}
test('history source binds the original thread and never accepts a caller thread override',async()=>{
 const f=fixture();
 const result=await f.source.readHistoryPage(bound,{turnId:'historical-turn',threadId:'foreign-thread',limit:1} as any,new AbortController().signal);
 expect(result.data[0]?.item.text).toBe('원문');
 expect(f.calls.filter(c=>c.method==='thread/items/list')).toEqual([{method:'thread/items/list',params:{threadId:bound.threadId,turnId:'historical-turn',limit:1,sortDirection:'desc'}}]);
 expect(f.closed).toBe(1);
 expect(f.calls.filter(c=>c.method==='thread/read').every(c=>c.params.includeTurns===false)).toBe(true);
});
test('a final answer is readable before a large earlier item while older originals remain paginated',async()=>{
 const f=fixture(false,[{id:'large-old-result',type:'commandExecution',output:'old output'.repeat(70_000)},
  {id:'final',type:'agentMessage',phase:'final_answer',text:'Verified final result'}]);
 const page=await f.source.readHistoryPage(bound,{turnId:'historical-turn',limit:1},new AbortController().signal);
 expect(page.data.map(entry=>entry.item.id)).toEqual(['final']);
 expect(page.nextCursor).toBe('older-items');
 expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(1_000);
});
test('a turn retiring during item read never releases its stale page',async()=>{
 const f=fixture(true);
 await expect(f.source.readHistoryPage(bound,{turnId:'historical-turn',limit:1},new AbortController().signal))
  .rejects.toThrow('owner changed during read');
 expect(f.closed).toBe(1);
});
test('retired current owner, current-turn access and unindexed history do not read bodies',async()=>{
 const f=fixture(),signal=new AbortController().signal;
 await expect(f.source.readHistoryPage(bound,{turnId:bound.turnId},signal)).rejects.toThrow('active turn');
 f.setHead('different-active-turn');
 await expect(f.source.readHistoryPage(bound,{turnId:'historical-turn'},signal)).rejects.toMatchObject({
  code:'tela_native_binding_unproven',reason:'owner_changed',
 });
 f.setMode('legacy');
 await expect(f.source.readHistoryPage(bound,{turnId:'historical-turn'},signal)).rejects.toMatchObject({code:'native_history_bootstrap_required'});
 expect(f.calls.some(c=>c.method==='thread/items/list')).toBe(false);
});


test('original-history index is paginated through the same owner and returns metadata without bodies or account overrides',async()=>{
 const f=fixture();
 const result=await f.source.readHistoryIndex(bound,{cursor:'index-cursor',threadId:'foreign'} as any,new AbortController().signal);
 expect(result).toEqual({data:[{turnId:'prior',status:'completed'}],nextCursor:'older-index-page'});
 expect(f.calls.find(c=>c.method==='thread/turns/list'&&c.params.limit===4)).toEqual({method:'thread/turns/list',params:{
  cursor:'index-cursor',threadId:bound.threadId,sortDirection:'desc',itemsView:'notLoaded',limit:4,
 }});
 expect(f.calls.some(c=>c.method==='thread/items/list')).toBe(false);
 expect(JSON.stringify(result)).not.toContain('must not leak');
 expect(f.closed).toBe(1);
});
