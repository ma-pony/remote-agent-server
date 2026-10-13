import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { UsageStore } from "../src/agent-usage/storage/usage-store.js";
import { AttributionStore } from "../src/agent-usage/storage/attribution-store.js";
import { accountingRequests } from "./fixtures/agent-usage/accounting.js";
import type { ContextBlock, ModelContextInput } from "../src/agent-usage/core/context-types.js";
import { usageQueryVersion } from "../src/agent-usage/storage/query-version.js";

const databases: Database.Database[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); });
const setup = () => {
  const db = new Database(":memory:"); databases.push(db);
  const store = new UsageStore(db), attribution = new AttributionStore(store);
  const binding = store.bindSession("test", "1", "1");
  return { db, store, attribution, binding };
};
const context = (id: string, occurredAt: string): ModelContextInput => ({
  invocationId: id, occurredAt, providerEpochId: "epoch", sourceId: "fixture", revision: 1,
  runtimeKind: "codex", model: null, coverage: "full", historyComplete: true,
  blocks: Array.from({ length: 20 }, (_, position) => ({ position, kind: "result",
    content: { identity: `content-${position}`, modality: "text", text: "fixture" },
    measured: { tokens: position === 0 ? null : 2, byteLength: 7, partial: false,
      estimate: { measurement: "estimated", method: "text_heuristic", model: null, modelProvider: null,
        tokenizer: null, tokenizerVersion: null, encoding: null, tokenizerId: "fixture",
        tokenizerRevision: "1", reason: "model_missing" } },
    capabilities: [{ capability: { kind: "builtin_tool", id: "read", name: "Read" }, evidence: "direct" }]
  }))
});

it("serves rankings from compact inputs without reading exposures after projection", async () => {
  const { db, attribution, binding } = setup();
  await attribution.upsertContext(binding, context("first", "2026-10-10T00:00:00Z"));
  await attribution.upsertContext(binding, context("second", "2026-10-11T00:00:00Z"));
  const filter = { namespace: "test", from: "2026-10-11T00:00:00Z" };
  const expected = attribution.rankingsPage(filter, "all", { sort: "totalInputTokens", limit: 20, offset: 0 });
  while (attribution.backfillRankingInputs(5)) { /* Complete the bounded migration. */ }
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation(sql => {
    if (sql.includes("agent_usage_exposures")) throw new Error("Ranking scanned detailed exposures");
    return prepare(sql);
  });
  expect(attribution.rankingsPage(filter, "all", { sort: "totalInputTokens", limit: 20, offset: 0 })).toEqual(expected);
});

it("preserves accounting across projection, date filters, cumulative parents and Runtime filters", () => {
  const { db, store, binding } = setup();
  for (const observation of accountingRequests()) store.observe(binding, observation);
  const filters = [{ namespace: "test" }, { namespace: "test", runtimeKind: "codex" },
    { namespace: "test", from: "2026-09-20T00:00:00Z", to: "2026-09-21T00:00:00Z" }];
  const expected = filters.map(filter => store.overview(filter, "day"));
  let job = store.nextAccountingProjection();
  while (job) { store.commitAccountingProjection(store.projectEpoch(job)); job = store.nextAccountingProjection(); }
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation(sql => {
    if (sql.includes("FROM agent_usage_ledger")) throw new Error("Overview reloaded the ledger");
    return prepare(sql);
  });
  for (const [index, filter] of filters.entries()) expect(store.overview(filter, "day"))
    .toEqual({ ...expected[index], summary: { ...expected[index]!.summary, asOf: expect.any(String) } });
});

it("clears unused historical event payloads in bounded batches and preserves replay deduplication", () => {
  const { db, store, binding } = setup();
  const observation = accountingRequests()[0]!;
  store.observe(binding, observation);
  expect((db.prepare("SELECT payload_json FROM agent_usage_events").get() as { payload_json: string }).payload_json).toBe("{}");
  db.prepare("UPDATE agent_usage_events SET payload_json=?").run(JSON.stringify(observation));
  db.exec("DELETE FROM agent_usage_storage_limits WHERE name='event-payload'");
  new UsageStore(db); // Simulate the first upgraded open of historical rows.
  expect(store.compactEventPayloads(1)).toBe(1);
  store.observe(binding, observation);
  expect(store.summary({ namespace: "test" }).usage.totalTokens).toBe(1100);
  expect(db.prepare("SELECT COUNT(*) AS n FROM agent_usage_events").get()).toEqual({ n: 1 });
});

it("reclaims only estimate profiles without a retained reference", async () => {
  const { db, attribution, binding } = setup();
  await attribution.upsertContext(binding,context("first","2026-10-10T00:00:00Z"));
  db.prepare("INSERT INTO agent_usage_token_estimates(estimate_json) VALUES(?)").run('{"method":"unused-fixture"}');
  const before = db.prepare("SELECT COUNT(*) AS n FROM agent_usage_token_estimates").get();
  expect(attribution.cleanupUnusedEstimates(100)).toBe(1);
  expect(db.prepare("SELECT 1 FROM agent_usage_token_estimates WHERE estimate_json=?").get('{"method":"unused-fixture"}')).toBeUndefined();
  expect(db.prepare("SELECT COUNT(*) AS n FROM agent_usage_token_estimates").get()).not.toEqual(before);
  expect(attribution.rankingsPage({ namespace: "test" },"all",{ sort: "totalInputTokens",limit:20,offset:0 }).items[0])
    .toMatchObject({ totalInputTokens: 38, missingExposureCount: 1 });
});

it("rejects stale accounting commits and reloads only the changed epoch", () => {
  const { db,store,binding } = setup();
  const sample = accountingRequests()[0]!;
  store.observe(binding,{ ...sample, eventId: "old",invocationId:"old",providerEpochId:"closed",coverageId:"old" });
  let job = store.nextAccountingProjection()!;
  store.commitAccountingProjection(store.projectEpoch(job));
  store.observe(binding,{ ...sample,eventId:"live",invocationId:"live",providerEpochId:"live",coverageId:"live" });
  job = store.nextAccountingProjection()!;
  const stale = store.projectEpoch(job);
  store.observe(binding,{ ...sample,eventId:"live-2",invocationId:"live-2",providerEpochId:"live",coverageId:"live-2" });
  expect(store.commitAccountingProjection(stale)).toBe(false);
  expect(store.summary({ namespace:"test" }).usage.totalTokens).toBe(3300);
  job = store.nextAccountingProjection()!;
  expect(store.commitAccountingProjection(store.projectEpoch(job))).toBe(true);
  expect(store.summary({ namespace:"test" }).usage.totalTokens).toBe(3300);
  store.deleteSession("test","1");
  expect(db.prepare("SELECT COUNT(*) AS n FROM agent_usage_accounting_projections").get()).toEqual({n:0});
  expect(store.nextAccountingProjection()).toBeUndefined();
});

it("retries historical accounting initialization after an interrupted upgrade", () => {
  const { db,store,binding } = setup();
  const sample = accountingRequests()[0]!;
  store.observe(binding,{ ...sample,providerEpochId:"historical" });
  // Restore the pre-projection schema, then fail between table creation and seeding.
  db.exec(`DROP TRIGGER agent_usage_ledger_accounting_insert;
    DROP TRIGGER agent_usage_ledger_accounting_update;
    DROP TRIGGER agent_usage_ledger_accounting_delete;
    DROP TABLE agent_usage_accounting_jobs;
    DROP TABLE agent_usage_accounting_projections`);
  const exec = db.exec.bind(db);
  const interrupted = vi.spyOn(db,"exec").mockImplementation(sql => {
    if (sql.includes("INSERT OR IGNORE INTO agent_usage_accounting_jobs")) throw new Error("interrupted upgrade");
    return exec(sql);
  });
  expect(() => new UsageStore(db)).toThrow("interrupted upgrade");
  interrupted.mockRestore();
  const reopened = new UsageStore(db);
  reopened.observe(binding,{ ...sample,eventId:"new",providerEpochId:"new" });
  let job = reopened.nextAccountingProjection();
  while (job) { reopened.commitAccountingProjection(reopened.projectEpoch(job)); job = reopened.nextAccountingProjection(); }
  expect(reopened.summary({namespace:"test"}).usage.totalTokens).toBe(2200);
});

it("keeps compact and detailed ranking results equal after late arrivals, revisions and Runtime filtering", async () => {
  const { db,attribution,binding } = setup();
  await attribution.upsertContext(binding,context("later","2026-10-11T00:00:00Z"));
  await attribution.upsertContext(binding,{ ...context("other-runtime","2026-10-12T00:00:00Z"),runtimeKind:"claude_code" });
  await attribution.upsertContext(binding,context("earlier","2026-10-10T00:00:00Z"));
  await attribution.upsertContext(binding,{ ...context("earlier","2026-10-10T00:00:00Z"),revision:2,blocks:context("unused","2026-10-10T00:00:00Z").blocks.slice(1) });
  const sorts = ["observedTotalTokens","observedArgumentTokens","observedResultTokens","totalInputTokens","inputBytes","calls",
    "definitionInputTokens","argumentInputTokens","firstResultInputTokens","repeatedResultInputTokens","failures","latencyMsP95"] as const;
  const filters = [{ namespace:"test" },{ namespace:"test",runtimeKind:"codex" },{ namespace:"test",runtimeKind:"claude_code",from:"2026-10-11T00:00:00Z" }];
  const compact = filters.map(filter => sorts.map(sort => attribution.rankingsPage(filter,"all",{sort,limit:20,offset:0})));
  db.exec("UPDATE agent_usage_contexts SET ranking_inputs_ready=0");
  for (const [index,filter] of filters.entries()) for (const [sortIndex,sort] of sorts.entries())
    expect(attribution.rankingsPage(filter,"all",{sort,limit:20,offset:0})).toEqual(compact[index]![sortIndex]);
});

it("preserves nulls and distinct context coverage across estimate profiles and first-use groups", async () => {
  const { db, attribution, binding } = setup();
  const block = (position: number, kind: ContextBlock["kind"], tokens: number | null,
    profile: string, resultFirstUse?: ContextBlock["resultFirstUse"]): ContextBlock => {
    const template = context("unused", "2026-10-10T00:00:00Z").blocks[0]!;
    return { ...template, position, kind, resultFirstUse,
      measured: { ...template.measured!, tokens, estimate: { ...template.measured!.estimate, tokenizerId: profile } } };
  };
  const blocks = [block(0, "definition", null, "unknown"), block(1, "arguments", null, "unknown"),
    block(2, "result", null, "unknown", "first"), block(3, "result", 3, "known", "repeat"),
    block(4, "result", null, "unknown", "unknown"), block(5, "other", 0, "zero")];
  for (const [index, coverage] of (["full", "partial", "opaque", "none"] as const).entries()) {
    await attribution.upsertContext(binding, { ...context(`coverage-${index}`, `2026-10-1${index}T00:00:00Z`), coverage, blocks });
  }
  const filter = { namespace: "test", from: "2026-10-10T00:00:00Z", to: "2026-10-14T00:00:00Z" };
  const compact = attribution.rankingsPage(filter, "all", { sort: "totalInputTokens", limit: 10, offset: 0 });
  expect(compact.items).toHaveLength(1);
  expect(compact.items[0]).toMatchObject({
    definitionInputTokens: null, argumentInputTokens: null, firstResultInputTokens: null,
    unknownFirstResultInputTokens: null, repeatedResultInputTokens: 12, totalInputTokens: 12,
    inputBytes: 168, exposureCount: 24, missingExposureCount: 16,
    contextCoverage: { full: 1, partial: 1, opaque: 1, none: 1 },
    tokenEstimates: [
      { tokenizerId: "unknown", exposureCount: 16, knownExposureCount: 0, totalInputTokens: null },
      { tokenizerId: "known", exposureCount: 4, knownExposureCount: 4, totalInputTokens: 12 },
      { tokenizerId: "zero", exposureCount: 4, knownExposureCount: 4, totalInputTokens: 0 }
    ]
  });
  db.exec("UPDATE agent_usage_contexts SET ranking_inputs_ready=0");
  expect(attribution.rankingsPage(filter, "all", { sort: "totalInputTokens", limit: 10, offset: 0 })).toEqual(compact);
  // A window with only unknown results must stay unknown, while absent arguments remain zero.
  await attribution.upsertContext(binding, { ...context("only-unknown", "2026-10-14T00:00:00Z"), blocks: [blocks[2]!] });
  expect(attribution.rankings({ namespace: "test", from: "2026-10-14T00:00:00Z" }, "all")[0])
    .toMatchObject({ totalInputTokens: null, definitionInputTokens: 0, argumentInputTokens: 0,
      firstResultInputTokens: null, repeatedResultInputTokens: 0, unknownFirstResultInputTokens: 0 });
});

it("compacts redundant identity hashes without changing evidence or invalidating rankings", async () => {
  const { db,attribution,binding } = setup();
  await attribution.upsertContext(binding,context("first","2026-10-10T00:00:00Z"));
  db.exec("UPDATE agent_usage_exposures SET content_identity_hash=content_key");
  db.prepare("UPDATE agent_usage_exposures SET content_identity_hash=? WHERE position=0").run("d".repeat(64));
  db.exec("DELETE FROM agent_usage_storage_limits WHERE name='exposure-identities'");
  const reopened = new AttributionStore(new UsageStore(db));
  const filter = {namespace:"test"}, evidence = reopened.contextEvidence(filter,{limit:1})[0]!;
  const before = reopened.contextEvidenceDetail("test",evidence.id,{limit:50,offset:0});
  const version = usageQueryVersion(db).revision;
  let compacted = 0;
  while (reopened.exposureIdentityCompactionPending()) compacted += reopened.compactExposureIdentities(5);
  expect(compacted).toBe(19);
  expect(reopened.contextEvidenceDetail("test",evidence.id,{limit:50,offset:0})).toEqual(before);
  expect(usageQueryVersion(db).revision).toBe(version);
  expect(db.prepare("SELECT COUNT(*) AS n FROM agent_usage_exposures WHERE content_identity_hash!=''").get()).toEqual({n:1});
});
