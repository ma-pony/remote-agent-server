import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {AttributionFilter, Capability, ModelContextInput, TokenEstimate} from '../src/agent-usage/core/context-types.js';
import {UsageStore} from '../src/agent-usage/storage/usage-store.js';
import {AttributionStore} from '../src/agent-usage/storage/attribution-store.js';
import {RuntimeConversationCollector} from '../src/agent-usage/runtime-conversation.js';
const baselineModule=process.argv[2];
if(!baselineModule) throw new Error('Usage: tsx scripts/verify-usage-ranking-versions.ts <baseline-module>');
const {AttributionStore: Before}=await import(pathToFileURL(resolve(baselineModule)).href) as {AttributionStore: typeof AttributionStore};
const db=new Database(':memory:');const store=new UsageStore(db),actual=new AttributionStore(store),before=new Before(store);
new RuntimeConversationCollector(store,actual,'fixture');
const bindings=[store.bindSession('fixture','agent','session'),store.bindSession('fixture','agent','second'),
  store.bindSession('fixture','other-agent','third'),store.bindSession('other','agent','session')];
const caps: Capability[]=[{kind:'builtin_tool',id:'read',name:'Read'}, {kind:'mcp_tool',id:'search',name:'Search',serverId:'docs'},
  {kind:'cli',id:'build',name:'Build'},{kind:'unknown',id:'unavailable',name:'Unavailable'}];
const estimates: TokenEstimate[]=(['model_missing','unsupported_content',null] as const).map((reason,index)=>({measurement:'estimated',method:'text_heuristic',model:'model-'+index,
  modelProvider:null,tokenizer:null,tokenizerVersion:null,encoding:null,tokenizerId:'fixture-'+index,tokenizerRevision:'1',reason}));
const sorts: Array<Parameters<AttributionStore['rankingsPage']>[2]['sort']>=['observedTotalTokens','observedArgumentTokens','observedResultTokens','totalInputTokens','inputBytes','calls','definitionInputTokens',
  'argumentInputTokens','firstResultInputTokens','repeatedResultInputTokens','failures','latencyMsP95'];
const filters: AttributionFilter[]=[{}, {namespace:'fixture'}, {namespace:'fixture',agentId:'agent'}, {namespace:'fixture',sessionId:'session'},
  {namespace:'other',sessionId:'session'}, {namespace:'fixture',runtimeKind:'codex'}, {namespace:'fixture',runtimeKind:'claude_code'},
  {namespace:'fixture',from:'2026-10-05T16:00:00Z',to:'2026-10-12T16:00:00Z'},
  {namespace:'fixture',from:'2026-10-12T00:00:00Z'}, {namespace:'fixture',to:'2026-10-06T16:00:00Z'},
  {namespace:'fixture',from:'2026-10-13T00:00:00Z',to:'2026-10-14T00:00:00Z'},
  {namespace:'fixture',agentId:'missing'}, {namespace:'fixture',runtimeKind:'codex',sessionId:'session',from:'2026-10-06T16:00:00Z',to:'2026-10-07T16:00:00Z'}];
const context=(index:number,revision=1): ModelContextInput=>({invocationId:'context-'+index,providerEpochId:'epoch',sourceId:'fixture',revision,
  occurredAt:index%7===0?null:new Date(Date.UTC(2026,9,5+index%8,16)).toISOString(),runtimeKind:index%2?'codex':'claude_code',model:'model',
  coverage:(['full','partial','opaque','none'] as const)[index%4]!,historyComplete:index%3!==0,blocks:Array.from({length:36},(_,position)=>{
    const capability={...caps[position%4],name:'Version '+revision+' / '+index};
    const kind=(['definition','arguments','result','other'] as const)[Math.floor(position/4)%4]!;
    const profile=(Math.floor(position/8)+index)%3;
    return {position,kind,toolInvocationId:'call-'+position%4,
      content:{identity:'content-'+position,modality:'text',text:'fixture'},
      measured:{tokens:profile===1?null:position%6,byteLength:position*3,partial:profile===1,estimate:estimates[profile]},
      resultFirstUse:kind==='result'&&position%3===0?'unknown':undefined,
      capabilities:[{capability,evidence:(['direct','matched','inferred'] as const)[position%3]!}]};})});
// Public writes exercise projection invalidation and first-use maintenance; content rows also cover legacy profiles.
try {
  for(const [b,binding]of bindings.entries()) {
    for(let index=0;index<12;index++) actual.observeInvocation(binding,{invocationId:'call-'+index,providerEpochId:'epoch',executionId:'run',capability:caps[index%4],
      startedAt:index%2?'2026-10-06T16:00:00Z':null,endedAt:'2026-10-06T16:00:01Z',runtimeKind:index%2?'codex':'claude_code',
      origin:index<4?'context':'execution',status:(['running','succeeded','tool_error','cancelled'] as const)[index%4]!,sourceId:'fixture',revision:1,rawResultBytes:index%5?index*13:null,
      argumentEstimate:{tokens:index%3?index:null,byteLength:10,partial:false,estimate:estimates[index%3]},
      resultEstimate:{tokens:index%2?index*2:null,byteLength:20,partial:true,estimate:estimates[(index+1)%3]}});
    for(let index=0;index<12;index++) await actual.upsertContext(binding,context(index));
    const insert=db.prepare(`INSERT INTO agent_usage_conversation_content(namespace,agent_id,session_id,run_id,event_key,category,occurred_at,runtime_kind,tokens,bytes,partial,estimate_json,estimate_id) VALUES(?,?,?,?,?,?,?,?,?,8,0,?,?)`);
    for(let index=0;index<16;index++) insert.run(binding.namespace,binding.agentId,binding.sessionId,b*100+index+1,'event-'+index,
      ['configured_instructions','user_prompt','assistant_output','assistant_thought'][index%4],new Date(Date.UTC(2026,9,5+index%8,16)).toISOString(),index%2?'codex':'claude_code',index%3?index:null,
      index%5?'':JSON.stringify(estimates[index%3]),index%5?actual.tokenEstimateId(estimates[index%3]):null);
  }
  let comparisons=0;
  function verify(stage:string) {
    for(const filter of filters) for(const dimension of ['all','mcp_tool','assistant_output','skill'] as const) for(const sort of sorts)
      for(const [limit,offset]of [[50,0],[2,1],[2,50]]) {
        const options={sort,limit,offset};
        assert.deepEqual(actual.rankingsPage(filter,dimension,options),before.rankingsPage(filter,dimension,options),JSON.stringify({stage,filter,dimension,options}));
        comparisons++;
      }
    console.log(JSON.stringify({stage,comparisons,equal:true}));
  }
  const warm=()=>{while(actual.dailyRankings.discover(7)){}let job;while((job=actual.dailyRankings.nextJob()))
    assert.equal(actual.dailyRankings.commit(actual.dailyRankings.project(job)),true)};
  filters.push({namespace:'fixture',from:'2026-10-06T00:00:00.000Z',to:'2026-10-13T00:00:00.000Z'},
    {namespace:'fixture',from:'2026-10-06T00:00:00.000Z',to:'2026-10-12T00:00:00.000Z',runtimeKind:'claude_code'});
  verify('compact');
  warm();verify('daily');
  db.exec('UPDATE agent_usage_contexts SET ranking_inputs_ready=0');verify('detailed');
  while(actual.backfillRankingInputs(5)){}
  await actual.upsertContext(bindings[0],{...context(0,2),occurredAt:'2026-10-04T00:00:00Z',blocks:context(0,2).blocks.slice(5)});
  await actual.upsertContext(bindings[1],{...context(1,2),historyComplete:false});
  actual.deleteSession('fixture','third');store.deleteSession('fixture','third');
  db.prepare('DELETE FROM agent_usage_conversation_content WHERE namespace=? AND session_id=?').run('fixture','third');
  verify('daily-dirty-late-revised-deleted');
  warm();verify('daily-rebuilt');
} finally {await actual.close();await before.close();db.close()}
