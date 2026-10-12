import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { UsageStore } from "../src/agent-usage/storage/usage-store.js";
import { AttributionStore } from "../src/agent-usage/storage/attribution-store.js";
import { RuntimeConversationCollector } from "../src/agent-usage/runtime-conversation.js";
import { openUsageQueryReader } from "../src/agent-usage/query-reader.js";
import type { ModelContextInput, TokenEstimate } from "../src/agent-usage/core/context-types.js";

// Synthetic SQLite only: no Provider, credentials, network, or persistent application data.
const contexts = Number(process.argv[2] ?? 2000), blocks = Number(process.argv[3] ?? 100);
if (!Number.isInteger(contexts) || contexts < 1 || contexts > 4000 || !Number.isInteger(blocks) || blocks < 1 || blocks > 200)
  throw new Error("Expected 1-4000 contexts and 1-200 blocks per context");
const root = mkdtempSync(join(tmpdir(),"usage-query-benchmark-"));
const db = new Database(join(root,"usage.sqlite"));
db.pragma("journal_mode=WAL"); db.pragma("cache_size=-8192");
const store = new UsageStore(db), attribution = new AttributionStore(store);
new RuntimeConversationCollector(store,attribution,"benchmark");
let reader: ReturnType<typeof openUsageQueryReader> | undefined;
const estimate: TokenEstimate = { measurement:"estimated",method:"text_heuristic",model:null,modelProvider:null,
  tokenizer:null,tokenizerVersion:null,encoding:null,tokenizerId:null,tokenizerRevision:null,reason:"model_missing" };
const content = db.prepare(`INSERT INTO agent_usage_conversation_content
  (namespace,session_id,agent_id,run_id,event_key,category,occurred_at,runtime_kind,tokens,bytes,partial,estimate_json,estimate_id)
  VALUES('benchmark',?,'agent',?,?,'assistant_output',?,'codex',2,7,0,'',?)`);
const profile = attribution.tokenEstimateId(estimate);
const measure = (compute: () => unknown) => {
  const samples: number[] = [];
  for (let sample=0;sample<3;sample++) { const started=performance.now(); compute(); samples.push(performance.now()-started); }
  return Number(samples.sort((a,b)=>a-b)[1]!.toFixed(2));
};
try {
  for (let index=0;index<contexts;index++) {
    const sessionId=String(index%20+1), binding=store.bindSession("benchmark","agent",sessionId);
    const occurredAt=new Date(Date.UTC(2026,8,1+index%28)).toISOString();
    const input: ModelContextInput = { invocationId:`request-${index}`,providerEpochId:`epoch-${sessionId}`,sourceId:"fixture",
      revision:1,occurredAt,runtimeKind:"codex",model:null,coverage:"full",historyComplete:true,
      blocks:Array.from({length:blocks},(_,position)=>({ position,kind:position%5===0?"definition":"result",
        content:{identity:`block-${position}`,modality:"text",text:"fixture"},
        measured:{tokens:2,byteLength:7,partial:false,estimate},
        capabilities:[{capability:{kind:"builtin_tool",id:`tool-${position%10}`,name:`Tool ${position%10}`},evidence:"direct"}]
      })) };
    await attribution.upsertContext(binding,input);
    store.observe(binding,{eventId:`usage-${index}`,sourceId:"fixture",sourceVersion:"1",scope:"model_request",semantics:"delta",
      coverageId:`request-${index}`,invocationId:`request-${index}`,executionId:String(index),providerEpochId:input.providerEpochId,
      occurredAt,finality:"final",revision:1,measurement:"reported",normalizationProfile:"synthetic",runtimeKind:"codex",
      metrics:{inputTotalTokens:10,outputTotalTokens:2}});
    db.transaction(()=>{ for(let position=0;position<blocks;position++) content.run(sessionId,index,String(position),occurredAt,profile); })();
  }
  db.exec("UPDATE agent_usage_contexts SET ranking_inputs_ready=0");
  reader=openUsageQueryReader(db.name);
  const filter={namespace:"benchmark"};
  const totalQuery={kind:"rankings",args:[filter,"all",{sort:"totalInputTokens",limit:50,offset:0}]} as const;
  const observedQuery={kind:"rankings",args:[filter,"all",{sort:"observedTotalTokens",limit:50,offset:0}]} as const;
  // Mutable tuples match the internal worker protocol.
  const totals=()=>reader!.read({kind:totalQuery.kind,args:[...totalQuery.args]});
  const observed=()=>reader!.read({kind:observedQuery.kind,args:[...observedQuery.args]});
  const overview=()=>reader!.read({kind:"overview",args:[filter,"UTC","day"]});
  const expectedTotal=totals(), expectedObserved=observed(), expectedOverview=overview();
  const detailed={rankingsInputMs:measure(totals),rankingsObservedMs:measure(observed),overviewMs:measure(overview)};
  while (attribution.backfillRankingInputs(5)) { /* Latest-first bounded migration. */ }
  let job=store.nextAccountingProjection();
  while(job) { store.commitAccountingProjection(store.projectEpoch(job)); job=store.nextAccountingProjection(); }
  const projected={rankingsInputMs:measure(totals),rankingsObservedMs:measure(observed),overviewMs:measure(overview)};
  assert.deepEqual(totals(),expectedTotal); assert.deepEqual(observed(),expectedObserved);
  const actualOverview=overview() as ReturnType<UsageStore["overview"]>;
  const previousOverview=expectedOverview as ReturnType<UsageStore["overview"]>;
  assert.deepEqual({...actualOverview,summary:{...actualOverview.summary,asOf:"ignored"}},
    {...previousOverview,summary:{...previousOverview.summary,asOf:"ignored"}});
  console.log(JSON.stringify({node:process.version,contexts,exposures:contexts*blocks,contentFragments:contexts*blocks,
    compactInputRows:(db.prepare("SELECT COUNT(*) AS n FROM agent_usage_context_inputs").get() as {n:number}).n,
    detailed,projected,measurement:"median of three warm reads on the same synthetic file; not production p95"},null,2));
} finally { reader?.close(); await attribution.close(); db.close(); rmSync(root,{recursive:true,force:true}); }
