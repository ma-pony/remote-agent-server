import { afterEach, expect, it } from "vitest";
import { HostUsageCollector } from "../src/agent-usage/host-collector.js";
import { createTestDatabase } from "./helpers.js";
import type { ModelContextInput, InvocationInput } from "../src/agent-usage/core/context-types.js";
import type { UsageFilter } from "../src/agent-usage/core/types.js";
import { fixtureTokenizers } from "./fixtures/agent-usage/tokenizers/helpers.js";
import { getRuntimeContentEvidence, listRuntimeContentEvidence } from "../src/agent-usage/runtime-content-evidence.js";
import { loadConfig } from "../src/config.js";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventStore } from "../src/events/event-store.js";
import { accountingRequests } from "./fixtures/agent-usage/accounting.js";
import { UsageDetailRetention } from "../src/agent-usage/detail-retention.js";
import { UsageSourceCoordinator, type UsageSourceAdapter } from "../src/agent-usage/source-coordinator.js";

const databases: ReturnType<typeof createTestDatabase>["db"][] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) rmSync(directory,{ recursive: true, force: true });
});
const now = Date.parse("2026-10-22T00:00:00.000Z");
const context = (id: string, occurredAt: string): ModelContextInput => ({
  invocationId: id, occurredAt, providerEpochId: "epoch", sourceId: "fixture", revision: 1,
  runtimeKind: "codex", model: null, coverage: "full", historyComplete: true,
  blocks: [{ position: 0, kind: "result", toolInvocationId: "call",
    content: { identity: "same-result", modality: "text", text: "a measured result" },
    capabilities: [{ capability: { kind: "builtin_tool", id: "read", name: "Read" }, evidence: "direct" }] }]
});

it("publishes expiry before deletion and prevents late writes or replay from reviving frozen history", async () => {
  const { db, collector, binding, run } = await setup();
  const filter = { namespace: collector.namespace };
  const contextEvidence = collector.attribution.contextEvidence(filter)[0]!;
  const content = listRuntimeContentEvidence(db, filter, { limit: 10 })[0]!;
  const prepared = await collector.conversationContent.prepareMessage(run.id,
    { stream: "output", text: "late response" }, { sequence: 50, occurredAt: "2026-10-10T12:00:00.000Z" });
  expect(collector.detailRetention.step(now)).toBe("archived");
  expect(db.prepare("SELECT COUNT(*) AS n FROM agent_usage_exposures").get()).toEqual({ n: 2 });
  expect(collector.attribution.contextEvidence(filter)).toEqual([]);
  expect(listRuntimeContentEvidence(db, filter, { limit: 10 })).toEqual([]);
  expect(() => collector.attribution.contextEvidenceDetail(collector.namespace,contextEvidence.id)).toThrow("usage_details_expired");
  expect(() => getRuntimeContentEvidence(db,collector.namespace,content.id)).toThrow("usage_details_expired");
  await expect(collector.attribution.upsertContext(binding, context("late","2026-10-10T13:00:00.000Z"))).rejects.toThrow("usage_details_expired");
  expect(() => prepared!.commit()).toThrow("usage_details_expired");
  collector.contentBackfill.schedule(run.id);
  expect(collector.contentBackfill.status()).toMatchObject({ status: "completed", errorCode: null });
  expect(await collector.contentBackfill.step()).toBe(false);
  for (let i = 0; i < 20; i++) collector.detailRetention.step(now);
  expect(() => getRuntimeContentEvidence(db,collector.namespace,content.id)).toThrow("usage_details_expired");
  const before=collector.attribution.rankings({},"all");
  db.exec("UPDATE runs SET resolved_model='fixture-model',total_tokens=10; UPDATE sessions SET total_tokens=10");
  db.exec("UPDATE agent_usage_runtime_backfills SET content_version=1,tokenizer_model=NULL");
  const restarted=new HostUsageCollector(db,{},undefined,fixtureTokenizers());
  expect(await restarted.contentBackfill.step()).toBe(false);
  expect(restarted.contentBackfill.status().status).toBe("completed");
  expect(()=>restarted.importLegacy()).not.toThrow();
  expect(restarted.attribution.rankings({},"all")).toEqual(before);
  const adapter: UsageSourceAdapter={ describe:()=>({usage:"model_request",context:"full",identity:"explicit",version:"1"}),
    freeze:async()=>"0",async *collect() {} };
  const sources=new UsageSourceCoordinator(collector.store,{fixture:adapter});
  expect(()=>sources.registerSource({ namespace:binding.namespace,sourceKey:"late",kind:"fixture",inputRef:{},
    mappings:[{sourceSessionKey:"late",agentId:binding.agentId,sessionId:binding.sessionId,providerEpochId:"epoch"}] })).toThrow("usage_details_expired");
  expect(db.prepare("SELECT COUNT(*) AS n FROM agent_usage_source_mappings").get()).toEqual({n:0});
});

it("keeps detail retention independent of the existing Session and raw-event retention settings", () => {
  const defaults = loadConfig({ API_TOKEN: "test" });
  expect(defaults.usageDetailRetentionMs).toBe(7 * 86_400_000);
  expect(defaults.sessionRetentionMs).toBe(7 * 86_400_000);
  expect(loadConfig({ API_TOKEN: "test", SESSION_RETENTION_HOURS: "120", USAGE_DETAIL_RETENTION_DAYS: "0" }))
    .toMatchObject({ sessionRetentionMs: 120 * 3_600_000, usageDetailRetentionMs: 0, usageEventRetentionMs: 7 * 86_400_000 });
  expect(() => loadConfig({ API_TOKEN: "test", USAGE_DETAIL_RETENTION_DAYS: "-1" })).toThrow();
});
const setup = async (path?: string) => {
  const { db, seed } = createTestDatabase(path); databases.push(db);
  const session = seed.session(); seed.run(session.id, "succeeded");
  const run = db.prepare("SELECT id FROM runs WHERE session_id=?").get(session.id) as { id: number };
  db.prepare("UPDATE runs SET created_at='2026-10-09T09:00:00.000Z',started_at='2026-10-09T09:00:00.000Z',finished_at='2026-10-10T12:00:00.000Z' WHERE id=?").run(run.id);
  db.prepare("UPDATE sessions SET storage_cleaned_at='2026-10-12T12:00:00.000Z' WHERE id=?").run(session.id);
  const collector = new HostUsageCollector(db, {}, undefined, fixtureTokenizers());
  const binding = collector.binding(session.id);
  await collector.attribution.upsertContext(binding, context("first", "2026-10-09T10:00:00.000Z"));
  await collector.attribution.upsertContext(binding, context("second", "2026-10-10T10:00:00.000Z"));
  while (await collector.contentBackfill.step()) { /* Finish the retained Run's counts. */ }
  const daily = collector.attribution.dailyRankings;
  while (daily.discover()) { /* Discover historical partitions. */ }
  let job;
  while ((job = daily.nextJob())) expect(daily.commit(daily.project(job))).toBe(true);
  return { db, seed, session, run, collector, binding };
};

it("recovers an interrupted retained source after reopening without blocking expiry or changing statistics", async () => {
  const root=mkdtempSync(join(tmpdir(),"usage-source-restart-")); directories.push(root);
  const path=join(root,"usage.sqlite");
  const { db,collector,binding }=await setup(path);
  const adapter: UsageSourceAdapter={ describe:()=>({usage:"model_request",context:"none",identity:"explicit",version:"1"}),
    freeze:async()=>"0",async *collect() {} };
  const sources=new UsageSourceCoordinator(collector.store,{fixture:adapter},30_000,collector.attribution);
  const source=sources.registerSource({namespace:binding.namespace,sourceKey:"retained",kind:"fixture",inputRef:{path:"fixture"},
    mappings:[{sourceSessionKey:"capture",agentId:binding.agentId,sessionId:binding.sessionId,providerEpochId:"epoch"}]});
  await sources.prepareMaintenance(binding,"cleanup","cleanup"); sources.finishMaintenance(binding);
  // Model the durable state after the process exits during a later manual collection.
  db.prepare("UPDATE agent_usage_sources SET status='collecting',collection_id='interrupted',checkpoint='saved' WHERE id=?").run(source.id);
  const rankings=collector.attribution.rankings({},"all"), summary=collector.attribution.contextSummary({});
  const usage=collector.store.summary({}).usage;
  db.close();
  const reopened=new Database(path); databases.push(reopened);
  const restarted=new HostUsageCollector(reopened,{},undefined,fixtureTokenizers());
  expect(restarted.sources.recoverySources()).toEqual([]);
  expect(restarted.detailRetention.step(now)).toBe("archived");
  expect(restarted.sources.listSources(binding.namespace)[0]).toMatchObject({status:"failed",
    errorCode:"usage_collection_interrupted",checkpoint:"saved",collectionId:"interrupted",mappings:[{state:"retained"}]});
  for(let i=0;i<20;i++) restarted.detailRetention.step(now);
  expect(restarted.detailRetention.status().retiredSessions).toBe(1);
  expect(restarted.attribution.rankings({},"all")).toEqual(rankings);
  expect(restarted.attribution.contextSummary({})).toEqual(summary);
  expect(restarted.store.summary({}).usage).toEqual(usage);
});

it("waits for a real retained-source collection before publishing expiry", async () => {
  const { collector,binding }=await setup();
  let release!: () => void;
  const barrier=new Promise<void>(resolve=>{release=resolve;});
  let collecting=false;
  const adapter: UsageSourceAdapter={ describe:()=>({usage:"model_request",context:"none",identity:"explicit",version:"1"}),
    freeze:async()=>{if(collecting) await barrier; return "0";},async *collect() {} };
  const sources=new UsageSourceCoordinator(collector.store,{fixture:adapter},30_000,collector.attribution);
  const source=sources.registerSource({namespace:binding.namespace,sourceKey:"retained",kind:"fixture",inputRef:{},
    mappings:[{sourceSessionKey:"capture",agentId:binding.agentId,sessionId:binding.sessionId,providerEpochId:"epoch"}]});
  await sources.prepareMaintenance(binding,"cleanup","cleanup"); sources.finishMaintenance(binding);
  collecting=true;
  const pending=sources.collect(source.id);
  try {
    expect(sources.listSources(binding.namespace)[0]?.status).toBe("collecting");
    expect(collector.detailRetention.step(now)).toBe("scanned");
    expect(collector.detailRetention.status().skippedByReason).toEqual({source_active:1});
    expect(collector.attribution.contextEvidence({}).length).toBeGreaterThan(0);
  } finally { release(); await pending; }
  expect(collector.detailRetention.step(now)).toBe("idle");
  for(let i=0;i<20;i++) collector.detailRetention.step(now+5*60_000);
  expect(collector.detailRetention.status().retiredSessions).toBe(1);
});

it.each(["not cleaned","recent","recent context","recent content","unfinished","queued","running","maintenance",
  "source active","source collecting","pending backfill","failed backfill","missing backfill","backfill behind","unknown content","dirty projection","missing totals"])(
  "retains details when %s prevents safe publication", async state => {
    const { db, seed, session, run, collector, binding } = await setup();
    if (state === "not cleaned") db.exec("UPDATE sessions SET storage_cleaned_at=NULL");
    if (state === "recent") db.prepare("UPDATE runs SET finished_at=?").run(new Date(now-1).toISOString());
    if (state === "recent context") await collector.attribution.upsertContext(binding,context("recent",new Date(now-1).toISOString()));
    if (state === "recent content") await collector.conversationContent.recordMessage(run.id,{ stream: "output",text: "recent" },{ sequence: 50, occurredAt: new Date(now-1).toISOString() });
    if (state === "unfinished") db.exec("UPDATE runs SET finished_at=NULL");
    if (state === "queued" || state === "running") seed.run(session.id,state);
    if (state === "maintenance") db.exec("UPDATE sessions SET pending_operation='reset'");
    if (state === "source active" || state === "source collecting") db.prepare(`INSERT INTO agent_usage_source_mappings
      (source_id,source_session_key,namespace,agent_id,session_id,epoch_id,subject_generation) VALUES('fixture','fixture',?,?,?,'epoch',1)`)
      .run(collector.namespace,binding.agentId,binding.sessionId);
    if (state === "source collecting") {
      db.exec("UPDATE agent_usage_source_mappings SET state='retained'");
      db.prepare(`INSERT INTO agent_usage_sources(id,namespace,source_key,kind,input_json,config_json,capabilities_json,status)
        VALUES('fixture',?,'fixture','fixture','{}','{}','{}','collecting')`).run(collector.namespace);
    }
    if (state === "pending backfill") db.exec("UPDATE agent_usage_runtime_backfills SET status='pending'");
    if (state === "failed backfill") db.exec("UPDATE agent_usage_runtime_backfills SET status='failed',error_code='usage_runtime_event_malformed'");
    if (state === "missing backfill") db.exec("DELETE FROM agent_usage_runtime_backfills");
    if (state === "backfill behind") new EventStore({ db }).append(run.id,"message",{ stream: "output",text: "not counted" });
    if (state === "unknown content") db.exec("UPDATE agent_usage_conversation_content SET tokens=NULL");
    if (state === "dirty projection") db.exec("UPDATE agent_usage_ranking_days SET ready=0");
    if (state === "missing totals") db.exec("UPDATE agent_usage_contexts SET estimated_input_ready=0");
    // Recent evidence must block retention even after its projections are ready.
    if (state.startsWith("recent ")) {
      let job; while ((job=collector.attribution.dailyRankings.nextJob()))
        expect(collector.attribution.dailyRankings.commit(collector.attribution.dailyRankings.project(job))).toBe(true);
    }
    const before=collector.attribution.rankings({},"all");
    expect(collector.detailRetention.step(now)).toBe(state === "not cleaned" ? "idle" : "scanned");
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_usage_detail_archives").get()).toEqual({ n: 0 });
    expect(collector.attribution.contextEvidence({}).length).toBeGreaterThan(0);
    expect(collector.attribution.rankings({},"all")).toEqual(before);
  }
);

it("archives at the seven-day boundary and handles a context without blocks", async () => {
  const { db, collector, binding } = await setup();
  db.prepare("UPDATE runs SET finished_at=?").run(new Date(now-7*86_400_000).toISOString());
  await collector.attribution.upsertContext(binding,{ ...context("empty","2026-10-11T00:00:00.000Z"),blocks: [] });
  let job; while ((job=collector.attribution.dailyRankings.nextJob()))
    expect(collector.attribution.dailyRankings.commit(collector.attribution.dailyRankings.project(job))).toBe(true);
  expect(collector.detailRetention.step(now)).toBe("archived");
});

it("continues other Sessions while an archived Session is temporarily busy, then resumes its deletion", async () => {
  const { db,seed,session,collector }=await setup();
  expect(collector.detailRetention.step(now)).toBe("archived");
  db.prepare("UPDATE sessions SET status='running',pending_operation='delete' WHERE id=?").run(session.id);
  const second=seed.session(); seed.run(second.id,"succeeded");
  db.prepare("UPDATE sessions SET storage_cleaned_at='2026-10-10T00:00:00.000Z' WHERE id=?").run(second.id);
  db.prepare("UPDATE runs SET created_at='2026-10-09T00:00:00.000Z',finished_at='2026-10-10T00:00:00.000Z' WHERE session_id=?").run(second.id);
  while(await collector.contentBackfill.step()) { /* Prepare the other Session. */ }
  let job; while((job=collector.attribution.dailyRankings.nextJob()))
    expect(collector.attribution.dailyRankings.commit(collector.attribution.dailyRankings.project(job))).toBe(true);
  for(let i=0;i<10;i++) collector.detailRetention.step(now);
  expect(collector.detailRetention.status().retiredSessions).toBe(1);
  expect(db.prepare("SELECT COUNT(*) AS n FROM agent_usage_exposures").get()).toEqual({n:2});
  db.prepare("UPDATE sessions SET status='idle',pending_operation=NULL WHERE id=?").run(session.id);
  for(let i=0;i<10;i++) collector.detailRetention.step(now+5*60_000);
  expect(collector.detailRetention.status().retiredSessions).toBe(2);
});

it("keeps content-only history discoverable and never returns partial-day archived totals", async () => {
  const { collector,binding }=await setup();
  collector.attribution.deleteSession(binding.namespace,binding.sessionId);
  let job; while ((job=collector.attribution.dailyRankings.nextJob()))
    expect(collector.attribution.dailyRankings.commit(collector.attribution.dailyRankings.project(job))).toBe(true);
  const before=collector.attribution.rankings({},"all");
  for(let i=0;i<20;i++) collector.detailRetention.step(now);
  expect(collector.detailRetention.status().retiredSessions).toBe(1);
  expect(collector.attribution.hasEvidence({namespace:binding.namespace})).toBe(true);
  expect(collector.attribution.hasEvidence({namespace:binding.namespace,runtimeKind:"missing"})).toBe(false);
  expect(collector.attribution.rankings({},"all")).toEqual(before);
  expect(()=>collector.attribution.rankings({from:"2026-10-09T00:00:00Z",to:"2026-10-09T12:00:00Z"},"all"))
    .toThrow("usage_details_expired");
});

it("resumes bounded, transactional deletion after reopening and preserves frozen projections through VACUUM", async () => {
  const root=mkdtempSync(join(tmpdir(),"usage-retention-")); directories.push(root);
  const path=join(root,"usage.sqlite");
  const { db, collector, binding, session }=await setup(path);
  const large=context("large","2026-10-10T11:00:00.000Z");
  large.blocks=Array.from({length: 510},(_,position)=>({ ...large.blocks[0]!,position }));
  await collector.attribution.upsertContext(binding,large);
  let job; while ((job=collector.attribution.dailyRankings.nextJob()))
    expect(collector.attribution.dailyRankings.commit(collector.attribution.dailyRankings.project(job))).toBe(true);
  const before=collector.attribution.rankings({},"all");
  db.exec("CREATE TRIGGER fail_archive BEFORE INSERT ON agent_usage_detail_archives BEGIN SELECT RAISE(ABORT,'archive failed'); END");
  expect(()=>collector.detailRetention.step(now)).toThrow("archive failed");
  expect(collector.attribution.contextEvidence({}).length).toBe(3);
  db.exec("DROP TRIGGER fail_archive");
  expect(collector.detailRetention.step(now)).toBe("archived");
  db.exec("CREATE TRIGGER fail_detail_delete AFTER DELETE ON agent_usage_exposures BEGIN SELECT RAISE(ABORT,'delete failed'); END");
  expect(()=>collector.detailRetention.step(now)).toThrow("delete failed");
  expect(db.prepare("SELECT COUNT(*) AS n FROM agent_usage_exposures").get()).toEqual({ n: 512 });
  db.exec("DROP TRIGGER fail_detail_delete");
  expect(collector.detailRetention.step(now)).toBe("retired");
  expect(db.prepare("SELECT COUNT(*) AS n FROM agent_usage_exposures").get()).toEqual({ n: 262 });
  db.exec("VACUUM"); db.close();
  const reopened=new Database(path); databases.push(reopened);
  const restarted=new HostUsageCollector(reopened,{},undefined,fixtureTokenizers());
  const disabled=new UsageDetailRetention(reopened,restarted.namespace,restarted.attribution.dailyRankings,0);
  expect(disabled.step(now)).toBe("idle");
  expect(restarted.attribution.contextEvidence({})).toEqual([]);
  for(let i=0;i<20;i++) restarted.detailRetention.step(now);
  restarted.attribution.cleanupUnusedEstimates(1000);
  expect(restarted.attribution.rankings({},"all")).toEqual(before);
  expect(reopened.prepare("SELECT COUNT(*) AS n FROM agent_usage_exposures").get()).toEqual({n: 0});
  expect(reopened.prepare("SELECT completed_at FROM agent_usage_detail_archives").get()).toEqual({ completed_at: new Date(now).toISOString() });
  // An old worker result cannot recreate a retired partition, and explicit deletion removes the archive.
  const partition=reopened.prepare("SELECT id,revision FROM agent_usage_ranking_days LIMIT 1").get() as {id: number;revision: number};
  expect(restarted.attribution.dailyRankings.commit({...partition,data:null})).toBe(false);
  restarted.deleteSession(session.id);
  expect(reopened.prepare("SELECT COUNT(*) AS n FROM agent_usage_detail_archives").get()).toEqual({n:0});
  expect(restarted.attribution.rankings({},"all")).toEqual([]);
});

it("retires old details of a storage-cleaned Session without changing historical rankings or context totals", async () => {
  const { db, session, collector } = await setup();
  const filter = { namespace: collector.namespace, sessionId: String(session.id) };
  const before = collector.attribution.rankings(filter, "all");
  const summary = collector.attribution.contextSummary(filter);
  expect(before.find(row => row.capability.id === "read")).toMatchObject({ exposureCount: 2 });
  for (let i = 0; i < 20; i++) collector.detailRetention.step(now);
  expect(db.prepare("SELECT COUNT(*) AS n FROM agent_usage_exposures").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM agent_usage_context_inputs").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM agent_usage_conversation_content").get()).toEqual({ n: 0 });
  expect(collector.attribution.rankings(filter, "all")).toEqual(before);
  expect(collector.attribution.contextSummary(filter)).toEqual(summary);
  expect(collector.detailRetention.status()).toMatchObject({ enabled: true, retiredSessions: 1 });
});

it("combines archived days with live unprojected contexts without losing first-use, coverage or unknown counts", async () => {
  const { db, seed, collector, session } = await setup();
  const live = seed.session(), binding = collector.binding(live.id);
  await collector.attribution.upsertContext(binding, context("live", "2026-10-10T11:00:00.000Z"));
  db.prepare("UPDATE agent_usage_contexts SET ranking_inputs_ready=0 WHERE session_id=?").run(String(live.id));
  const filters = [{ namespace: collector.namespace }, { namespace: collector.namespace, runtimeKind: "codex" },
    { namespace: collector.namespace, from: "2026-10-10T00:00:00.000Z", to: "2026-10-11T00:00:00.000Z" },
    { namespace: collector.namespace, sessionId: String(session.id) }];
  const before = filters.map(filter => collector.attribution.rankings(filter,"all"));
  for (let i = 0; i < 20; i++) collector.detailRetention.step(now);
  expect(db.prepare("SELECT COUNT(*) AS n FROM agent_usage_exposures").get()).toEqual({ n: 1 });
  filters.forEach((filter,index) => expect(collector.attribution.rankings(filter,"all")).toEqual(before[index]));
  // A restarted discovery must not hide already archived history.
  db.exec("UPDATE agent_usage_ranking_discovery SET context_complete=0,content_complete=0");
  filters.forEach((filter,index) => expect(collector.attribution.rankings(filter,"all")).toEqual(before[index]));
});

it("keeps first/repeated-result pagination stable across raw, daily, mixed and archived data", async () => {
  const { db,seed,collector,binding }=await setup();
  collector.attribution.deleteSession(binding.namespace,binding.sessionId);
  const estimate=(await collector.attribution.measureContent("fixture","result"))!;
  const blocks: ModelContextInput["blocks"]=[
    ["a-definition","definition",12],["b-positive","result",7],["c-zero","result",0],["d-unknown","result",null]
  ].map(([id,kind,tokens],position)=>({position,kind:kind as "definition"|"result",toolInvocationId:String(id),
    content:{identity:String(id),modality:"text",text:"fixture"},
    capabilities:[{capability:{kind:"builtin_tool",id:String(id),name:String(id)},evidence:"direct"}],
    measured:{...estimate,tokens:tokens as number|null}}));
  for(const [index,day] of ["09","10"].entries()) await collector.attribution.upsertContext(binding,{
    ...context("result-"+index,"2026-10-"+day+"T10:00:00.000Z"),blocks});
  await collector.attribution.upsertContext(binding,{
    ...context("unknown-history","2026-10-09T11:00:00.000Z"),historyComplete:false,
    blocks:[{...blocks[1]!,toolInvocationId:"unknown-history",content:{identity:"unknown-history",modality:"text",text:"fixture"},
      capabilities:[{capability:{kind:"builtin_tool",id:"e-unknown-history",name:"Unknown history"},evidence:"direct"}]}]});
  collector.attribution.observeInvocation(binding,{invocationId:"call-only",providerEpochId:"epoch",sourceId:"fixture",revision:1,
    executionId:null,origin:"execution",status:"succeeded",runtimeKind:"codex",startedAt:"2026-10-10T12:00:00.000Z",
    endedAt:"2026-10-10T12:00:00.001Z",rawResultBytes:0,capability:{kind:"builtin_tool",id:"f-call-only",name:"Call only"}});
  const live=seed.session(), liveBinding=collector.binding(live.id);
  await collector.attribution.upsertContext(liveBinding,{...context("live","2026-10-10T13:00:00.000Z"),blocks:[blocks[0]!]});
  const filters=[{namespace:binding.namespace},{namespace:binding.namespace,agentId:binding.agentId,runtimeKind:"codex",
    from:"2026-10-09T00:00:00.000Z",to:"2026-10-11T00:00:00.000Z"}];
  const ranks=filters.map(filter=>collector.attribution.rankings(filter,"builtin_tool"));
  const expectedIds=["b-positive","a-definition","c-zero","e-unknown-history","d-unknown","f-call-only"];
  const expectedValues=[7,0,0,0,null,null];
  const check=()=>{
    for(const [index,filter] of filters.entries()) {
      expect(collector.attribution.rankings(filter,"builtin_tool")).toEqual(ranks[index]);
      for(const sort of ["firstResultInputTokens","repeatedResultInputTokens"] as const) {
        const items=[];
        for(const offset of [0,2,4,6]) {
          const page=collector.attribution.rankingsPage(filter,"builtin_tool",{sort,limit:2,offset});
          expect(page.total).toBe(6); items.push(...page.items);
        }
        expect(items.map(row=>row.capability.id)).toEqual(expectedIds);
        expect(items.map(row=>row[sort])).toEqual(expectedValues);
      }
    }
  };
  // Force the original raw path while discovery and request projections are pending.
  db.exec("UPDATE agent_usage_contexts SET ranking_inputs_ready=0; UPDATE agent_usage_ranking_discovery SET context_complete=0,content_complete=0");
  check();
  collector.attribution.backfillRankingInputs(1000);
  check();
  const daily=collector.attribution.dailyRankings;
  while(daily.discover()) { /* Discover all partitions. */ }
  let job; while((job=daily.nextJob())) expect(daily.commit(daily.project(job))).toBe(true);
  check();
  // A newer live context can be pending while closed Sessions archive and expire.
  db.prepare("UPDATE agent_usage_contexts SET ranking_inputs_ready=0 WHERE session_id=?").run(String(live.id));
  check();
  expect(collector.detailRetention.step(now)).toBe("archived");
  check();
  for(let i=0;i<10;i++) { collector.detailRetention.step(now); check(); }
  expect(collector.detailRetention.status().retiredSessions).toBe(1);
  db.exec("UPDATE agent_usage_ranking_discovery SET context_complete=0,content_complete=0");
  check();
});

it("preserves accounting, exact percentiles, cross-day call deduplication and every ranking sort in mixed scopes", async () => {
  const { db, seed, session, collector, binding }=await setup();
  const capability={ kind: "builtin_tool" as const,id: "read",name: "Read" };
  const call: InvocationInput={ invocationId: "call",providerEpochId: "epoch",executionId: null,capability,
    startedAt: null,endedAt: null,status: "succeeded",runtimeKind: "codex",origin: "context",sourceId: "fixture",revision: 1,rawResultBytes: null };
  collector.attribution.observeInvocation(binding,call);
  for (const [i,duration] of [1,3,50,1000].entries()) {
    const startedAt=`2026-10-${i<2 ? "09" : "10"}T11:00:00.000Z`;
    collector.attribution.observeInvocation(binding,{ ...call,invocationId: `execution-${i}`,origin: "execution",startedAt,
      endedAt:new Date(Date.parse(startedAt)+duration).toISOString(),rawResultBytes: [0,10,100,1000][i]!,
      status:i===3 ? "tool_error" : "succeeded",argumentEstimate: await collector.attribution.measureContent("", "arguments"),
      resultEstimate: await collector.attribution.measureContent(i===2 ? [{type:"image",data:"fixture",mimeType:"image/png"}] : "a result","result") });
  }
  for (const observation of accountingRequests()) collector.store.observe(binding,observation);
  for (const [index,tokens] of [0,null,4].entries()) {
    const sample=context(`measure-${index}`,"2026-10-10T11:00:00.000Z");
    sample.runtimeKind=index===2 ? "claude_code" : "codex";
    sample.coverage=index===1 ? "opaque" : "partial"; sample.historyComplete=false;
    sample.blocks[0]!.capabilities[0]!.capability={ kind: "skill",id:`measure-${index}`,name:`Measure ${index}` };
    const measured=(await collector.attribution.measureContent("fixture","result"))!;
    sample.blocks[0]!.measured={ ...measured,tokens };
    await collector.attribution.upsertContext(binding,sample);
  }
  const untimed=context("untimed","2026-10-10T00:00:00.000Z"); untimed.occurredAt=null;
  await collector.attribution.upsertContext(binding,untimed);
  let job; while ((job=collector.attribution.dailyRankings.nextJob()))
    expect(collector.attribution.dailyRankings.commit(collector.attribution.dailyRankings.project(job))).toBe(true);
  const live=seed.session(), liveBinding=collector.binding(live.id);
  await collector.attribution.upsertContext(liveBinding,context("live","2026-10-10T11:00:00.000Z"));
  collector.attribution.observeInvocation(liveBinding,call);
  db.prepare("UPDATE agent_usage_contexts SET ranking_inputs_ready=0 WHERE session_id=?").run(String(live.id));
  const filters: UsageFilter[]=[{namespace:collector.namespace},{namespace:collector.namespace,sessionId:String(session.id)},
    {namespace:collector.namespace,agentId:binding.agentId},{namespace:collector.namespace,runtimeKind:"codex"},
    {namespace:collector.namespace,runtimeKind:"claude_code"},
    {namespace:collector.namespace,from:"2026-10-10T00:00:00Z",to:"2026-10-11T00:00:00Z"}];
  const sorts=["observedTotalTokens","observedArgumentTokens","observedResultTokens","totalInputTokens","inputBytes","calls",
    "definitionInputTokens","argumentInputTokens","firstResultInputTokens","repeatedResultInputTokens","failures","latencyMsP95"] as const;
  const rankings=filters.map(filter=>sorts.map(sort=>collector.attribution.rankingsPage(filter,"all",{sort,limit:2,offset:1})));
  const before=collector.attribution.rankings(filters[1]!,"all");
  expect(before.find(row=>row.capability.id==="read")).toMatchObject({calls:4,contextOnlyCalls:1,latencyMsP50:3,latencyMsP95:1000,rawResultBytesP50:10,rawResultBytesP95:1000});
  expect(before.find(row=>row.capability.id==="measure-0")).toMatchObject({totalInputTokens:0,missingExposureCount:0});
  expect(before.find(row=>row.capability.id==="measure-1")).toMatchObject({totalInputTokens:null,missingExposureCount:1});
  const accounting=collector.store.overview({});
  for(let i=0;i<20;i++) collector.detailRetention.step(now);
  expect(collector.detailRetention.status().retiredSessions).toBe(1);
  filters.forEach((filter,i)=>sorts.forEach((sort,j)=>
    expect(collector.attribution.rankingsPage(filter,"all",{sort,limit:2,offset:1})).toEqual(rankings[i]![j])));
  expect(collector.attribution.rankings(filters[1]!,"all")).toEqual(before);
  expect(collector.store.overview({})).toEqual({...accounting,summary:{...accounting.summary,asOf:expect.any(String)}});
  expect(collector.attribution.rankings(filters.at(-1)!,"builtin_tool")[0]!.contextOnlyCalls).toBe(2);
});
