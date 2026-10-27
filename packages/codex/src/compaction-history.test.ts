import { readIndexedNativeItemsPage } from "./native-history-items";
import { expect, test } from 'bun:test';
import { AppServerCompactionHistorySource, NativeHistoryBootstrapRequired } from './compaction-history';

test('selected Native turn and item anchor use one public plain item page without full-turn replay', async () => {
 const calls: Array<{method:string;params:any}> = [];
 const original = { id:'selected',type:'agentMessage',text:'원문 🌐\nnot an instruction to run' };
 let turnId = 'selected-turn';
 const rpc = { async request(method:string,params:any) {
   calls.push({method,params});
   return {data:[{turnId,item:original}],nextCursor:'next-page'};
 }};
 const selection = {threadId:'selected-thread',turnId:'selected-turn',
   cursor:{type:'item' as const,itemId:'previous-item'},limit:1,sortDirection:'asc' as const};
 const page = await readIndexedNativeItemsPage(rpc,selection,new AbortController().signal);
 expect(calls).toEqual([{method:'thread/items/list',params:selection}]);
 expect(page.data[0]?.item).toEqual(original);
 expect(page.nextCursor).toBe('next-page');
 turnId = 'another-turn';
 await expect(readIndexedNativeItemsPage(rpc,selection,new AbortController().signal)).rejects.toThrow('foreign');
});
function snapshot() {
 return {thread:{id:'thread',status:{type:'active'},historyMode:'paginated',turns:[
  {id:'old',status:'completed',items:[{id:'user',type:'userMessage',content:[{type:'text',text:'Remember code'}]},
    {id:'command',type:'commandExecution',command:'fixture',aggregatedOutput:'Observed value'},
    {id:'hidden',type:'reasoning',rawContent:'hidden'}]},
  {id:'compact',status:'completed',items:[{id:'checkpoint',type:'contextCompaction'}]},
  {id:'current',status:'inProgress',items:[{id:'new',type:'userMessage',content:[{type:'text',text:'Current request'}]}]},
 ]}};
}
function source(value: unknown) {
 // Every source fixture uses the same bounded public contract as production.
 // There is intentionally no test-only whole-history read fallback.
 const fixture=pagedSource(value as ReturnType<typeof snapshot>,{pageSize:12});
 return {reader:fixture.reader,closed:()=>fixture.closed()>0};
}
function pagedSource(value: any, options: { pageSize?: number; unsupported?: boolean } = {}) {
 const calls: Array<{method:string;params:any}>=[];
 let closed=0;
 const all=[...value.thread.turns].reverse().map((turn:any)=>({
   ...turn,itemsView:turn.itemsView??'full',
 }));
 const indexed=[...value.thread.turns].reverse().flatMap((turn:any)=>
   [...turn.items].reverse().map((item:any)=>({turnId:turn.id,item})));
 const pageSize=options.pageSize??2;
 const rpc={
   async request(method:string,params:any){
     calls.push({method,params});
     if(method==='thread/read'){
       if(params.includeTurns!==false)throw Error('unbounded Native history read forbidden');
       const {turns:_,...metadata}=value.thread;
       return {thread:metadata};
     }
     if(method==='thread/turns/list'){
       if(options.unsupported)throw Error('thread/turns/list not supported yet');
       if(params.itemsView==='notLoaded')return {data:[
         {id:all[0].id,status:all[0].status,itemsView:'notLoaded',items:[]},
       ],nextCursor:all.length>1?'older':null};
       const offset=params.cursor?Number(params.cursor):0;
       return {data:all.slice(offset,offset+pageSize),
         nextCursor:offset+pageSize<all.length?String(offset+pageSize):null};
     }
     if(method==='thread/items/list'){
       const offset=params.cursor?Number(params.cursor):0;
       return {data:indexed.slice(offset,offset+params.limit),
         nextCursor:offset+params.limit<indexed.length?String(offset+params.limit):null};
     }
     throw Error('Unexpected method');
   },
   async close(){closed++;},
 };
 return {reader:new AppServerCompactionHistorySource(async()=>rpc),
   calls,closed:()=>closed};
}
test('bounded paginated visible history preserves Native compaction order without whole-history RPC',async()=>{
 const x:any=snapshot();
 x.thread.turns.splice(2,0,
   {id:'middle',status:'completed',items:[{id:'middle-user',type:'userMessage',
     content:[{type:'text',text:'After the first compaction'}]}]},
   {id:'second',status:'completed',items:[{id:'second-compaction',type:'contextCompaction'}]});
 const f=pagedSource(x);
 const out=await f.reader.project('thread','current');
 expect(out.compactionItemId).toBe('second-compaction');
 const structured=JSON.parse(out.content);
 expect(structured.items.map((entry:any)=>entry.item.id))
   .toEqual(['user','command','middle-user']);
 expect(JSON.stringify(structured.items)).not.toContain('Current request');
 expect(f.calls.some(call=>call.method==='thread/read'&&call.params.includeTurns===true))
   .toBe(false);
 expect(f.calls.filter(call=>call.method==='thread/turns/list').length)
   .toBeGreaterThanOrEqual(2);
 expect(f.closed()).toBe(1);
});
test('oversized cold Native history stops at a bounded checkpoint requirement, not a partial Web summary',async()=>{
 const x:any=snapshot();
 const huge='X'.repeat(3*1024*1024);
 x.thread.turns=[
  {id:'one',status:'completed',items:[{id:'first',type:'commandExecution',aggregatedOutput:huge}]},
  {id:'two',status:'completed',items:[{id:'second',type:'commandExecution',aggregatedOutput:huge}]},
  {id:'three',status:'completed',items:[{id:'third',type:'commandExecution',aggregatedOutput:huge}]},
  {id:'compaction',status:'completed',items:[{id:'latest-checkpoint',type:'contextCompaction'}]},
  {id:'current',status:'inProgress',items:[]},
 ];
 const f=pagedSource(x,{pageSize:1});
 await expect(f.reader.project('thread','current')).rejects.toBeInstanceOf(NativeHistoryBootstrapRequired);
 expect(f.closed()).toBe(1);
 expect(f.calls.filter(call=>call.method==='thread/turns/list').length).toBeLessThan(6);
 expect(f.calls.every(call=>call.method!=='thread/read'||call.params.includeTurns===false)).toBe(true);
});
test('missing Native pagination cannot fall back to an unbounded legacy read',async()=>{
 const f=pagedSource(snapshot(),{unsupported:true});
 await expect(f.reader.project('thread','current')).rejects.toThrow('full history was not fetched');
 expect(f.calls.map(call=>call.method)).toEqual(['thread/read','thread/turns/list']);
 expect(f.closed()).toBe(1);
});
test('593-turn, 99-compaction Native history stays paginated and never repeats a whole-history RPC',async()=>{
 const turns:any[]=[];
 for(let index=0;index<592;index++){
   const items:any[]=[{id:'user-'+index,type:'userMessage',content:[
     {type:'text',text:'Small non-sensitive turn '+index}]}];
   if(index<99)items.push({id:'compact-'+index,type:'contextCompaction'});
   turns.push({id:'past-'+index,status:'completed',items});
 }
 turns.push({id:'current',status:'inProgress',items:[]});
 const f=pagedSource({thread:{id:'thread',status:{type:'active'},historyMode:'paginated',turns}},{pageSize:12});
 const result=await f.reader.project('thread','current');
 expect(result.compactionItemId).toBe('compact-98');
 const items=JSON.parse(result.content).items;
 expect(items).toHaveLength(99);
 expect(result.content).not.toContain('Small non-sensitive turn 99');
 expect(f.calls.filter(x=>x.method==='thread/turns/list')).toHaveLength(50);
 expect(f.calls.filter(x=>x.method==='thread/read').map(x=>x.params.includeTurns))
   .toEqual([false,false]);
 expect(f.closed()).toBe(1);
});
test('paged history detects duplicated source cursors before assuming complete evidence',async()=>{
 let closed=0;
 let pages=0;
 const rpc={
   async request(method:string,params:any){
     if(method==='thread/read')return {thread:{id:'thread',status:{type:'active'},historyMode:'paginated'}};
     return {data:[{id:'item-'+(++pages),status:'inProgress',itemsView:'full',items:[]}],
       nextCursor:'unchanging'};
   },
   async close(){closed++},
 };
 const f=new AppServerCompactionHistorySource(async()=>rpc);
 await expect(f.project('thread','current')).rejects.toThrow('repeated');
 expect(closed).toBe(1);
});
test('latest Native compaction anchor is discoverable from indexed public items only',async()=>{
 const f=pagedSource(snapshot(),{pageSize:2});
 const anchor=await f.reader.latestAnchor('thread','current');
 expect(anchor).toEqual({threadId:'thread',currentTurnId:'current',
   compactionTurnId:'compact',compactionItemId:'checkpoint'});
 expect(f.calls.filter(call=>call.method==='thread/turns/list')).toHaveLength(1);
 expect(f.calls.filter(call=>call.method==='thread/items/list').length).toBeGreaterThan(0);
 expect(f.calls.filter(call=>call.method==='thread/turns/list')
   .every(call=>call.params.itemsView==='notLoaded')).toBe(true);
 expect(f.calls.filter(call=>call.method==='thread/read').map(call=>call.params.includeTurns))
   .toEqual([false,false]);
 expect(f.closed()).toBe(1);
});
test('paginated Native history finds an indexed compaction marker without full-turn payloads or legacy replay',async()=>{
 const calls:Array<{method:string;params:any}>=[];
 let closed=0;
 const rpc={
   async request(method:string,params:any){
     calls.push({method,params});
     if(method==='thread/read'){
       if(params.includeTurns!==false)throw Error('Unexpected unbounded thread hydration');
       return {thread:{id:'thread',historyMode:'paginated',status:{type:'active'}}};
     }
     if(method==='thread/turns/list'){
       if(params.itemsView!=='notLoaded'||params.limit!==1) {
         throw Error('Indexed path must not download full turn items');
       }
       return {data:[{id:'current',status:'inProgress',itemsView:'notLoaded',items:[]}],
         nextCursor:'older'};
     }
     if(method==='thread/items/list'){
       if(params.itemsView!==undefined || params.sortDirection!=='desc'||params.limit!==4){
         throw Error('Indexed path requested incorrect source');
       }
       return !params.cursor?{data:[
         {turnId:'recent',item:{id:'latest-user',type:'userMessage',content:[]}},
         {turnId:'recent',item:{id:'latest-answer',type:'agentMessage',text:'short'}},
       ],nextCursor:'next-page'}:{data:[
         {turnId:'compaction-turn',item:{id:'exact-marker',type:'contextCompaction'}},
       ],nextCursor:'old-heavy-history'};
     }
     throw Error('Unsupported method');
   },
   async close(){closed++;},
 };
 const result=await new AppServerCompactionHistorySource(async()=>rpc)
   .latestAnchor('thread','current');
 expect(result).toEqual({threadId:'thread',currentTurnId:'current',
   compactionTurnId:'compaction-turn',compactionItemId:'exact-marker'});
 expect(calls.map(x=>x.method)).toEqual([
   'thread/read','thread/turns/list','thread/items/list',
   'thread/items/list','thread/read',
 ]);
 expect(closed).toBe(1);
});

test('anchor discovery uses bounded indexed data rather than a 192-item correctness cutoff',async()=>{
 for(const markerPresent of [true,false]){
  let pages=0,closed=0,metadataReads=0;
  const rpc={
   async request(method:string,params:any){
    if(method==='thread/read'){
     metadataReads++;
     expect(params.includeTurns).toBe(false);
     return {thread:{id:'thread',historyMode:'paginated',status:{type:'active'}}};
    }
    if(method==='thread/turns/list')return {data:[
     {id:'current',status:'inProgress',itemsView:'notLoaded',items:[]},
    ]};
    if(method!=='thread/items/list')throw Error('Unexpected source');
    const start=pages++*4;
    const data=Array.from({length:Math.min(4,245-start)},(_,i)=>({
     turnId:'prior',item:{id:`item-${start+i}`,
      type:markerPresent&&start+i===244?'contextCompaction':'commandExecution'},
    }));
    return {data,nextCursor:start+4<245?String(pages):null};
   },async close(){closed++;},
  };
  const pending=new AppServerCompactionHistorySource(async()=>rpc).latestAnchor('thread','current');
  if(markerPresent)expect((await pending).compactionItemId).toBe('item-244');
  else await expect(pending).rejects.toBeInstanceOf(NativeHistoryBootstrapRequired);
  expect(pages).toBe(62);
  expect(metadataReads).toBe(markerPresent?2:1);
  expect(closed).toBe(1);
 }
});

test('indexed anchor search still stops at its aggregate byte budget without guessing a marker',async()=>{
 let pages=0,closed=0;
 const rpc={async request(method:string){
  if(method==='thread/read')return {thread:{id:'thread',historyMode:'paginated',status:{type:'active'}}};
  if(method==='thread/turns/list')return {data:[{id:'current',status:'inProgress',itemsView:'notLoaded',items:[]}]};
  if(method!=='thread/items/list')throw Error('Unexpected source');
  pages++;
  return {data:[{turnId:'prior',item:{id:`item-${pages}`,type:'commandExecution',aggregatedOutput:'x'.repeat(1024*1024)}}],nextCursor:String(pages)};
 },async close(){closed++;}};
 await expect(new AppServerCompactionHistorySource(async()=>rpc).latestAnchor('thread','current'))
  .rejects.toBeInstanceOf(NativeHistoryBootstrapRequired);
 expect(pages).toBe(4);
 expect(closed).toBe(1);
});

test('Legacy Native anchor discovery fails before replaying even a shallow server-side page',async()=>{
 const old:any=snapshot();
 old.thread.historyMode='legacy';
 const f=pagedSource(old,{pageSize:2});
 await expect(f.reader.latestAnchor('thread','current'))
   .rejects.toBeInstanceOf(NativeHistoryBootstrapRequired);
 expect(f.calls.some(call=>call.method==='thread/items/list')).toBe(false);
 expect(f.calls.map(call=>call.method)).toEqual(['thread/read']);
 expect(f.closed()).toBe(1);
});
test('Legacy visible history reconstruction is disabled before any paging or whole thread read',async()=>{
 const old:any=snapshot();
 old.thread.historyMode='legacy';
 const f=pagedSource(old,{pageSize:2});
 await expect(f.reader.project('thread','current'))
   .rejects.toBeInstanceOf(NativeHistoryBootstrapRequired);
 expect(f.calls.filter(call=>call.method==='thread/read')
   .map(call=>call.params.includeTurns)).toEqual([false]);
 expect(f.calls.filter(call=>call.method==='thread/turns/list').length).toBe(0);
 expect(f.closed()).toBe(1);
});

test('unknown Native history modes and malformed indexed pages fail closed without whole-history fallback',async()=>{
 for(const broken of ['foreign-turn','duplicated-item','oversized-item','bad-cursor'] as const){
   const called:Array<{method:string;params:any}>=[];
   let closed=0;
   let pageNumber=0;
   const rpc={
     async request(method:string,params:any){
       called.push({method,params});
       if(method==='thread/read'){
         if(params.includeTurns!==false)throw Error('Unbounded history forbidden');
         return {thread:{id:'thread',historyMode:'paginated',status:{type:'active'}}};
       }
       if(method==='thread/turns/list'){
         return {data:[{id:broken==='foreign-turn'?'other':'current',
           status:'inProgress',itemsView:'notLoaded',items:[]}]};
       }
       if(method==='thread/items/list'){
         pageNumber++;
         if(broken==='oversized-item')return {data:[
           {turnId:'old',item:{id:'huge',type:'commandExecution',
             aggregatedOutput:'a'.repeat(2*1024*1024+50)}},
         ],nextCursor:null};
         if(broken==='duplicated-item')return {data:[
           {turnId:'old',item:{id:'dup',type:'agentMessage',text:'first'}},
           {turnId:'old',item:{id:'dup',type:'agentMessage',text:'again'}},
         ],nextCursor:'next'};
         return {data:[{turnId:'old',item:{
           id:'item-'+pageNumber,type:'agentMessage',text:'short'}}],nextCursor:'same'};
       }
       throw Error('Unknown RPC');
     },
     async close(){closed++;},
   };
   await expect(new AppServerCompactionHistorySource(async()=>rpc)
     .latestAnchor('thread','current')).rejects.toThrow();
   expect(called.some(call=>call.method==='thread/turns/list')).toBe(true);
   expect(called.every(call=>call.method!=='thread/read'
     || call.params.includeTurns===false)).toBe(true);
   expect(called.every(call=>call.method!=='thread/turns/list'
     || call.params.itemsView==='notLoaded')).toBe(true);
   expect(closed).toBe(1);
 }
 const unknown={
   async request(method:string,params:any){
     if(method==='thread/read')return {thread:{
       id:'thread',status:{type:'active'},historyMode:'unknown-future-mode'}};
     throw Error('Unknown history mode must not trigger paging');
   },
   async close(){},
 };
 await expect(new AppServerCompactionHistorySource(async()=>unknown)
   .latestAnchor('thread','current')).rejects.toBeInstanceOf(NativeHistoryBootstrapRequired);
});
test('foreign or moved Native anchor is never treated as a valid checkpoint source',async()=>{
 const f=pagedSource(snapshot(),{pageSize:2});
 await expect(f.reader.latestAnchor('thread','foreign')).rejects.toThrow('current turn');
 expect(f.closed()).toBe(1);
});
test('visible history stops at Native checkpoint and never exposes hidden reasoning or a later request',async()=>{
 const f=source(snapshot());const result=await f.reader.project('thread','current');const data=JSON.parse(result.content);
 expect(result.compactionItemId).toBe('checkpoint');expect(data.items).toHaveLength(2);
 expect(result.content).toContain('Observed value');expect(result.content).not.toContain('hidden');
 expect(JSON.stringify(data.items)).not.toContain('Current request');expect(f.closed()).toBe(true);
});
test('stale turn, missing checkpoint, foreign thread, and unreadable projection fail closed and release RPC',async()=>{
 const cases:any[]=[];
 let x:any=snapshot();x.thread.id='foreign';cases.push(x);
 x=snapshot();x.thread.turns.at(-1).id='foreign';cases.push(x);
 x=snapshot();x.thread.turns[1].items=[];cases.push(x);
 x=snapshot();x.thread.turns[0].items[0].content=null;cases.push(x);
 x=snapshot();x.thread.turns[0].items[0].content=[{type:'text'}];cases.push(x);
 x=snapshot();x.thread.turns[0].itemsView='summary';cases.push(x);
 x=snapshot();x.thread.turns[0].itemsView='notLoaded';cases.push(x);
 x=snapshot();x.thread.turns[0].id='';cases.push(x);
 x=snapshot();x.thread.turns[0].id=x.thread.turns[1].id;cases.push(x);
 for(const value of cases){const f=source(value);await expect(f.reader.project('thread','current')).rejects.toThrow();expect(f.closed()).toBe(true);}
});

test('public image, localImage, audio, skill and unknown history are ordered references, not claimed uploads',async()=>{
 const x:any=snapshot();
 x.thread.turns[0].items[0].content = [
   {type:'text',text:'Compare the attached photo'},
   {type:'localImage',path:'/secrets/old.png'},
   {type:'image',url:'https://secret.example/remote.png'},
   {type:'audio',url:'data:audio/wav;base64,private'},
   {type:'skill',name:'example',path:'/private/skill.md'},
   {type:'futureAttachment',fileId:'remote-secret'},
 ];
 x.thread.turns[0].items[1] = {id:'tool',type:'dynamicToolCall',
   contentItems:[{type:'inputImage',imageUrl:'data:image/png;base64,private-image'}]};
 const f=source(x); const first=await f.reader.project('thread','current');
 const second=await source(x).reader.project('thread','current');
 expect(first.content).toBe(second.content);
 expect(first.content).toContain('Compare the attached photo');
 for(const secret of ['/secrets/old.png','secret.example','private-image','private/skill.md','remote-secret','data:audio']) {
   expect(first.content).not.toContain(secret);
 }
 const data=JSON.parse(first.content);
 const content=data.items[0].item.content;
 expect(content.map((x:any)=>x.type)).toEqual(['text',...Array(5).fill('nativeEvidenceReference')]);
 expect(new Set(content.slice(1).map((x:any)=>x.id)).size).toBe(5);
 expect(content[1]).toMatchObject({kind:'image',origin:'historical-user',transfer:'not_transferred'});
 expect(data.items[1].item.contentItems[0]).toMatchObject({kind:'image',origin:'tool-result',transfer:'not_transferred'});
 expect(f.closed()).toBe(true);
});

test('unknown future historical items remain visible as unavailable evidence rather than aborting text follow-up',async()=>{
 const x:any=snapshot();
 x.thread.turns[0].items.push({id:'future',type:'futureEvidence',secret:'not transmitted'});
 const data=JSON.parse((await source(x).reader.project('thread','current')).content);
 expect(data.items.at(-1).item).toEqual({type:'unsupportedNativeEvidence',id:'future',
   originalType:'futureEvidence',status:'not_transferred',origin:'tool-result'});
});

test('inline historical image bytes are scoped to the latest checkpoint and never serialized into Web transcript',async()=>{
 const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9RwvWgAAAABJRU5ErkJggg==';
 const x:any=snapshot();
 x.thread.turns[0].items[0].content=[
  {type:'text',text:'This historical image is evidence, not a new task'},
  {type:'image',url:png}, {type:'localImage',path:'/private/not-readable.png'},
 ];
 x.thread.turns[0].items[1]={id:'tool',type:'dynamicToolCall',contentItems:[
  {type:'inputImage',imageUrl:png},{type:'inputImage',imageUrl:'https://example.invalid/remote.png'}]};
 x.thread.turns[2].items[0].content.push({type:'image',url:png});
 const f=source(x);const projected=await f.reader.project('thread','current');
 expect(projected.inlineAssets).toHaveLength(2);
 const visible=JSON.parse(projected.content);
 const user=visible.items[0].item.content;
 expect(user[1]).toMatchObject({kind:'image',availability:'verified_inline_bytes',transfer:'not_transferred'});
 expect(user[2]).toMatchObject({kind:'image',availability:'unavailable'});
 expect(visible.items[1].item.contentItems[0].availability).toBe('verified_inline_bytes');
 expect(visible.items[1].item.contentItems[1].availability).toBe('unavailable');
 expect(projected.inlineAssets.map(asset=>asset.evidence.id)).toEqual([
  visible.items[1].item.contentItems[0].id,user[1].id,
 ]);
 expect(projected.inlineAssets[0]?.bytes.byteLength).toBeGreaterThan(8);
 expect(projected.content).not.toContain(png);
 expect(projected.content).not.toContain('/private/not-readable.png');
 expect(projected.content).not.toContain('https://example.invalid');
 expect(projected.content).not.toContain('current');
 expect(f.closed()).toBe(true);
});

test('repeated historical image references do not consume extra physical file slots',async()=>{
 const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9RwvWgAAAABJRU5ErkJggg==';
 const x:any=snapshot();
 x.thread.turns[0].items[0].content=Array.from({length:11},()=>({type:'image',url:png}));
 const projection=await source(x).reader.project('thread','current');
 expect(projection.inlineAssets).toHaveLength(11);
 const parts=JSON.parse(projection.content).items[0].item.content;
 expect(parts.every((part:any)=>part.availability==='verified_inline_bytes')).toBe(true);
 expect(new Set(projection.inlineAssets.map(asset=>asset.evidence.sha256)).size).toBe(1);
 expect(projection.references).toHaveLength(11);
});

test('Native historical MCP image bytes preserve a typed reference, while resource links never expose URLs',async()=>{
 const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9RwvWgAAAABJRU5ErkJggg==';
 const x:any=snapshot();
 x.thread.turns[0].items[1]={
   id:'mcp-result',type:'mcpToolCall',output:{content:[
     {type:'image',mimeType:'image/png',data:png.split(',')[1]},
     {type:'resource_link',uri:'https://secret.example/resource?access=token'},
   ]},
 };
 const projected=await source(x).reader.project('thread','current');
 const data=JSON.parse(projected.content);
 const tool=data.items[1].item.output.content;
 expect(tool[0]).toMatchObject({kind:'image',origin:'tool-result',availability:'verified_inline_bytes'});
 expect(tool[1]).toMatchObject({kind:'file',origin:'tool-result',availability:'unavailable'});
 expect(projected.inlineAssets).toHaveLength(1);
 expect(projected.content).not.toContain(png.split(',')[1]);
 expect(projected.content).not.toContain('secret.example');
 expect(projected.content).not.toContain('access=token');
});

test('historical MCP embedded documents remain owned assets across compaction and encrypted tool fields stay opaque',async()=>{
 const pdf=Buffer.from('%PDF-1.5\nA tiny historical document');
 const sealed='MCP-encrypted-opaque-tool-result-not-model-text';
 const x:any=snapshot();
 x.thread.turns[0].items[1]={
   id:'mcp-document',type:'mcpToolCall',output:{content:[
     {type:'resource',resource:{uri:'file:///private/history/document.pdf',
       mimeType:'application/pdf',blob:pdf.toString('base64')}},
     {type:'encrypted_content',encrypted_content:sealed},
     {type:'text',text:'meta-hidden-tool-text',_meta:{'codex/encryptedContent':true}},
     {type:'resource_link',uri:'https://private.invalid/resource?secret=token'},
   ]},
 };
 const projection=await source(x).reader.project('thread','current');
 const tool=JSON.parse(projection.content).items[1].item.output.content;
 expect(tool.map((item:any)=>item.kind)).toEqual(['file','unsupported','unsupported','file']);
 expect(tool[0].availability).toBe('verified_inline_bytes');
 expect(tool[1].availability).toBe('unavailable');
 expect(tool[2].availability).toBe('unavailable');
 expect(tool[3].availability).toBe('unavailable');
 expect(projection.inlineAssets).toHaveLength(1);
 expect(projection.inlineAssets[0]?.bytes).toEqual(pdf);
 expect(projection.references).toHaveLength(4);
 for(const forbidden of [pdf.toString('base64'),'file:///private',sealed,
   'meta-hidden-tool-text','private.invalid','secret=token']){
   expect(projection.content).not.toContain(forbidden);
 }
});

test('historical tool embedded MIME not supported by the adapter is unavailable without leaking blobs',async()=>{
 const x:any=snapshot();
 x.thread.turns[0].items[1]={id:'unsupported',type:'mcpToolCall',output:{content:[
   {type:'resource',resource:{uri:'file:///secret',mimeType:'application/x-custom',
     blob:'bm90IGEgc3VwcG9ydGVkIGZpbGU='}},
 ]}};
 const projection=await source(x).reader.project('thread','current');
 expect(projection.inlineAssets).toHaveLength(0);
 const tool=JSON.parse(projection.content).items[1].item.output.content[0];
 expect(tool).toMatchObject({kind:'file',availability:'unavailable',origin:'tool-result'});
 expect(projection.content).not.toContain('file:///secret');
 expect(projection.content).not.toContain('bm90IGEgc3VwcG9ydGVkIGZpbGU=');
});

test('historical Native-normalized MCP PDF fallback is a binary evidence reference, not raw input_text JSON', async()=>{
  const pdf=Buffer.from('%PDF-1.7\nSynthetic historical data');
  const fallback=JSON.stringify({resource:{
    mimeType:'application/pdf', uri:'file:///private/secret.pdf?auth=hidden',
    blob:pdf.toString('base64'),
  },type:'resource'});
  const x:any=snapshot();
  x.thread.turns[0].items[1]={
    id:'native-normalized', type:'mcpToolCall',
    output:{contentItems:[{type:'input_text',text:fallback}]},
  };
  const projected=await source(x).reader.project('thread','current');
  expect(projected.inlineAssets).toHaveLength(1);
  expect(projected.inlineAssets[0]?.bytes).toEqual(pdf);
  expect(projected.references.some(ref=>ref.kind==='file'&&ref.availability==='verified_inline_bytes')).toBe(true);
  for(const forbidden of [pdf.toString('base64'),'file:///private','auth=hidden']){
    expect(projected.content).not.toContain(forbidden);
  }
});

test('latest checkpoint preserves visible intervening history across repeated compactions', async () => {
 const x:any=snapshot();
 x.thread.turns.splice(2,0,
  {id:'between',status:'completed',items:[{id:'middle-user',type:'userMessage',content:[{type:'text',text:'Intervening task'}]}]},
  {id:'compact2',status:'completed',items:[{id:'checkpoint2',type:'contextCompaction'}]});
 const f=source(x);const result=await f.reader.project('thread','current');
 expect(result.compactionItemId).toBe('checkpoint2');
 const data=JSON.parse(result.content);expect(data.items).toHaveLength(3);
 expect(result.content).toContain('Intervening task');
 expect(data.items.some((x:any)=>x.item.type==='contextCompaction')).toBe(false);
});

function prefixSource(options: {
 entries?: any[]; mode?: string;
 change?: (method: string, result: any, call: number) => any;
} = {}) {
 const calls: string[] = [];
 let closed = 0;
 const entries = options.entries ?? [];
 const rpc = {
  async request(method: string, params: any) {
   calls.push(method);
   let result: any;
   if (method === 'thread/read') {
    expect(params.includeTurns).toBe(false);
    result = {thread:{id:'thread',status:{type:'active'},historyMode:options.mode ?? 'paginated',
      cwd:'/fixture',source:'appServer',environments:[]}};
   } else if (method === 'thread/turns/list') {
    expect(params).toEqual({threadId:'thread',sortDirection:'desc',itemsView:'notLoaded',limit:1});
    result = {data:[{id:'current',status:'inProgress',itemsView:'notLoaded',items:[]}]};
   } else if (method === 'thread/items/list') {
    expect(params.limit).toBe(4);
    expect(params.sortDirection).toBe('desc');
    const offset = params.cursor ? Number(params.cursor) : 0;
    result = {data:entries.slice(offset,offset+4),nextCursor:offset+4<entries.length?String(offset+4):null};
   } else throw Error('Unexpected public source');
   return options.change?.(method,result,calls.filter(x=>x===method).length) ?? result;
  }, async close() { closed++; },
 };
 return {reader:new AppServerCompactionHistorySource(async()=>rpc),calls,closed:()=>closed};
}
const prefixEntry = (id:string, turnId='prior', text=id) => ({turnId,
 item:{id,type:'agentMessage',text}});

test('complete visible prefix exhausts more than 192 indexed items without requiring any marker',async()=>{
 const entries=Array.from({length:245},(_,i)=>prefixEntry(`item-${244-i}`));
 const f=prefixSource({entries});
 const result=await f.reader.visibleHistory('thread','current');
 expect(result.kind).toBe('native-visible-prefix');
 expect(result.sourceItemCount).toBe(245);
 const parsed=JSON.parse(result.content);
 expect(parsed.items[0].item.id).toBe('item-0');
 expect(parsed.items.at(-1).item.id).toBe('item-244');
 expect(result).not.toHaveProperty('compactionItemId');
 expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
 expect(f.calls.filter(x=>x==='thread/items/list')).toHaveLength(62);
 expect(f.calls.filter(x=>x==='thread/turns/list')).toHaveLength(2);
 expect(f.closed()).toBe(1);
});

test('complete prefix excludes all current-turn evidence and hidden reasoning, preserving real markers and sanitized assets',async()=>{
 const entries=[prefixEntry('current-answer','current','not historical'),
  {turnId:'current',item:{id:'current-tool',type:'commandExecution',aggregatedOutput:'current output'}},
  prefixEntry('old'),{turnId:'prior',item:{id:'reason',type:'reasoning',rawContent:'hidden'}},
  {turnId:'prior',item:{id:'real-marker',type:'contextCompaction'}},
  {turnId:'prior',item:{id:'image',type:'userMessage',content:[{type:'localImage',path:'/private/image.png'}]}}];
 const result=await prefixSource({entries}).reader.visibleHistory('thread','current');
 expect(result.sourceItemCount).toBe(3);
 expect(result.content).not.toContain('not historical');
 expect(result.content).not.toContain('current output');
 expect(result.content).not.toContain('hidden');
 expect(result.content).not.toContain('/private/image.png');
 expect(JSON.parse(result.content).items[1].item).toEqual({id:'real-marker',type:'contextCompaction'});
 expect(result.localImageCandidates).toHaveLength(1);
 expect(result.references).toHaveLength(1);
});

test('empty complete prefix is valid and stable; digest binds source and owner but not current turn identity',async()=>{
 const first=await prefixSource().reader.visibleHistory('thread','current');
 const repeat=await prefixSource().reader.visibleHistory('thread','current');
 expect(first.sourceItemCount).toBe(0);
 expect(JSON.parse(first.content).items).toEqual([]);
 expect(first.digest).toBe(repeat.digest);
 const otherTurn=prefixSource({change(method,result){
  if(method==='thread/turns/list')result.data[0].id='next';
  return result;
 }});
 expect((await otherTurn.reader.visibleHistory('thread','next')).digest).toBe(first.digest);
 const owner=prefixSource({change(method,result){
  if(method==='thread/read')result.thread.cwd='/other';
  return result;
 }});
 expect((await owner.reader.visibleHistory('thread','current')).digest).not.toBe(first.digest);
 const source=await prefixSource({entries:[prefixEntry('old')]}).reader.visibleHistory('thread','current');
 expect(source.digest).not.toBe(first.digest);
});

test('prefix rejects foreign ownership, head changes, legacy mode, and incomplete indexed streams',async()=>{
 for(const broken of ['foreign-owner','owner-change','foreign-turn','head-change','legacy','duplicate','cursor','empty-page','order'] as const){
  const entries=broken==='duplicate'?[prefixEntry('same'),prefixEntry('same')]
   :broken==='order'?[prefixEntry('old'),prefixEntry('new','current')]
   :Array.from({length:8},(_,i)=>prefixEntry(`item-${i}`));
  const f=prefixSource({entries,mode:broken==='legacy'?'legacy':'paginated',change(method,result,call){
   if(method==='thread/read'&&broken==='foreign-owner')result.thread.id='foreign';
   if(method==='thread/read'&&broken==='owner-change'&&call===2)result.thread.cwd='/changed';
   if(method==='thread/turns/list'&&(broken==='foreign-turn'||broken==='head-change'&&call===2))result.data[0].id='foreign';
   if(method==='thread/items/list'&&broken==='cursor')result.nextCursor='same';
   if(method==='thread/items/list'&&broken==='empty-page')result.data=[];
   return result;
  }});
  await expect(f.reader.visibleHistory('thread','current')).rejects.toThrow();
  expect(f.closed()).toBe(1);
  if(broken==='legacy'||broken==='foreign-owner'||broken==='foreign-turn')
   expect(f.calls.includes('thread/items/list')).toBe(false);
 }
});

test('prefix enforces per-response and aggregate byte budgets and caller cancellation',async()=>{
 for(const size of [2*1024*1024,1024*1024]){
  const entries=Array.from({length:12},(_,i)=>prefixEntry(`item-${i}`,'prior','x'.repeat(size)));
  const f=prefixSource({entries,change(method,result){
   // Single-item pages exercise the aggregate limit independently of page limit.
   if(method==='thread/items/list'&&size===1024*1024){
    const index=Number(result.data[0].item.id.slice(5));
    return {data:[result.data[0]],nextCursor:index+1<entries.length?String(index+1):null};
   }
   return result;
  }});
  await expect(f.reader.visibleHistory('thread','current')).rejects.toBeInstanceOf(NativeHistoryBootstrapRequired);
  expect(f.closed()).toBe(1);
 }
 const f=prefixSource();
 const abort=new AbortController();abort.abort();
 await expect(f.reader.visibleHistory('thread','current',abort.signal)).rejects.toThrow();
 expect(f.calls).toHaveLength(0);
});

test('prefix digest is independent of JSON member order but changes for visible evidence',async()=>{
 const first=await prefixSource({entries:[prefixEntry('old')]}).reader.visibleHistory('thread','current');
 const reordered=await prefixSource({entries:[{item:{text:'old',type:'agentMessage',id:'old'},turnId:'prior'}],
  change(method,result){
   if(method==='thread/read')result.thread={source:'appServer',cwd:'/fixture',environments:[],
    status:{type:'active'},historyMode:'paginated',id:'thread'};
   return result;
  }}).reader.visibleHistory('thread','current');
 expect(reordered.digest).toBe(first.digest);
 const changed=await prefixSource({entries:[prefixEntry('old','prior','different')]}).reader.visibleHistory('thread','current');
 expect(changed.digest).not.toBe(first.digest);
});


test('bounded history keeps complete recent exchanges without enumerating or reading the entire archive', async () => {
 const entries=[prefixEntry('current-item','current'),prefixEntry('recent-answer','past-249','Recent answer'),
  prefixEntry('recent-user','past-249','Recent request'),prefixEntry('cut-tool','past-248','X'.repeat(2*1024*1024)),
  ...Array.from({length:20},(_,i)=>prefixEntry(`unread-${i}`,'past-248','Must not fetch'))];
 const f=prefixSource({entries});
 const result=await f.reader.visibleHistory('thread','current',undefined,4096);
 expect(JSON.parse(result.content).items.map((entry:any)=>entry.item.id)).toEqual(['recent-user','recent-answer']);
 expect(JSON.parse(result.content).deferredHistory).toEqual({scope:"prior-native-history"});
 expect(result.content).toContain('not supplied or summarized');
 expect(result.content).not.toContain('X'.repeat(100));
 expect(f.calls.filter(method=>method==='thread/items/list')).toHaveLength(1);
 expect(f.calls.filter(method=>method==='thread/turns/list')).toHaveLength(2);
 expect(result.sourceItemCount).toBe(2); expect(f.closed()).toBe(1);
});

test('a giant first historical exchange remains readable by reference instead of exhausting the archive', async () => {
 const f=prefixSource({entries:[prefixEntry('large','prior','X'.repeat(3*1024*1024))]});
 const result=await f.reader.visibleHistory('thread','current',undefined,4096);
 expect(result.sourceItemCount).toBe(0); expect(JSON.parse(result.content).deferredHistory).toEqual({scope:'prior-native-history'});
 expect(JSON.parse(result.content).items).toEqual([]);
 expect(f.calls.filter(method=>method==='thread/items/list')).toHaveLength(1);
});

test('an oversized turn inside a page defers its partial exchange and all older turns', async () => {
 const f=prefixSource({entries:[prefixEntry('recent','recent'),prefixEntry('huge-answer','huge'),
  prefixEntry('huge-request','huge','X'.repeat(17*1024*1024)),prefixEntry('older','older')]});
 const result=await f.reader.visibleHistory('thread','current',undefined,4096);
 expect(JSON.parse(result.content).items.map((entry:any)=>entry.item.id)).toEqual(['recent']);
 expect(JSON.parse(result.content).deferredHistory).toEqual({scope:'prior-native-history'});
 expect(f.calls.filter(method=>method==='thread/items/list')).toHaveLength(1);
});
