import {test,expect} from 'bun:test';
import {AppServerCurrentTurnSource} from './app-server';
import type {CanonicalCurrentTurnEvidence} from './rollout';
const bound:CanonicalCurrentTurnEvidence={threadId:'original-thread',turnId:'active-turn',cwd:'/workspace',
 workspaceRoots:['/workspace'],sandbox:{kind:'native-enforced'},proof:'app-server-active-turn',environmentSourceTurnId:'active-turn'};
function fixture(retireDuringRead=false){
 let head='active-turn',mode='paginated',closed=0;
 const calls:{method:string;params:any}[]=[];
 const source=new AppServerCurrentTurnSource(async()=>({
  async request(method,params:any){
   calls.push({method,params});
   if(method==='thread/read')return {thread:{id:bound.threadId,historyMode:mode,cwd:'/workspace',status:{type:'active'}}};
   if(method==='thread/turns/list')return {data:[{id:head,status:'inProgress',itemsView:'notLoaded',items:[]}]};
   if(method==='thread/items/list'){
    if(retireDuringRead)head='replacement-turn';
    return {data:[{turnId:params.turnId,item:{id:'selected-item',type:'agentMessage',text:'원문'}}],nextCursor:null};
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
 expect(f.calls.filter(c=>c.method==='thread/items/list')).toEqual([{method:'thread/items/list',params:{threadId:bound.threadId,turnId:'historical-turn',limit:1,sortDirection:'asc'}}]);
 expect(f.closed).toBe(1);
 expect(f.calls.filter(c=>c.method==='thread/read').every(c=>c.params.includeTurns===false)).toBe(true);
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
