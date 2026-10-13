import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { AttributionStore } from "../src/agent-usage/storage/attribution-store.js";
import { UsageStore } from "../src/agent-usage/storage/usage-store.js";
import { RuntimeConversationCollector } from "../src/agent-usage/runtime-conversation.js";
import { DailyRankingStore } from "../src/agent-usage/storage/daily-rankings.js";
import { dailyBounds, dayStart } from "../src/agent-usage/core/daily-time.js";
import type { ModelContextInput } from "../src/agent-usage/core/context-types.js";

const options = { sort: "totalInputTokens" as const, limit: 50, offset: 0 };
const databases: Database.Database[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); });
const setup = () => {
  const db = new Database(":memory:"); databases.push(db);
  const store = new UsageStore(db), attribution = new AttributionStore(store), daily = new DailyRankingStore(db);
  return { db, store, attribution, daily, binding: store.bindSession("test", "agent", "session") };
};
const context = (id: string, occurredAt: string | null, revision = 1): ModelContextInput => ({
  invocationId: id, occurredAt, revision, providerEpochId: "epoch", sourceId: "fixture", model: null,
  runtimeKind: "codex", historyComplete: true, coverage: "full",
  blocks: Array.from({ length: 20 }, (_, position) => ({ position, kind: "result",
    content: { modality: "text", identity: `result-${position}`, text: "fixture" },
    measured: { tokens: position % 3 === 0 ? null : position % 3, byteLength: 7, partial: false,
      estimate: { measurement: "estimated", method: "text_heuristic", model: null, modelProvider: null, tokenizer: null,
        tokenizerVersion: null, encoding: null, tokenizerId: "fixture", tokenizerRevision: "1", reason: "model_missing" } },
    capabilities: [{ capability: { kind: "builtin_tool", id: "read", name: `Read ${id}` }, evidence: "direct" }]
  }))
});
const warm = (daily: DailyRankingStore) => {
  while (daily.discover(5)) { /* Resume discovery from its persisted cursor. */ }
  let job;
  while ((job = daily.nextJob())) expect(daily.commit(daily.project(job))).toBe(true);
};

it("reads a completed day's input totals without evaluating source token rows", async () => {
  const { db, attribution, binding, daily } = setup();
  for (let index = 0; index < 8; index++) await attribution.upsertContext(binding, context(String(index), "2026-10-10T12:00:00Z"));
  const filter = { namespace: "test", from: "2026-10-10T00:00:00.000Z", to: "2026-10-11T00:00:00.000Z" };
  const options = { sort: "totalInputTokens" as const, limit: 50, offset: 0 };
  const expected = attribution.rankingsPage(filter, "all", options);
  warm(daily);
  let reads = 0;
  db.function("input_row_read", (value: number | null) => { reads++; return value; });
  const columns = (db.prepare("PRAGMA table_info(agent_usage_context_inputs)").all() as Array<{ name: string }>).map(row => row.name);
  db.exec(`ALTER TABLE agent_usage_context_inputs RENAME TO source_inputs;
    CREATE VIEW agent_usage_context_inputs AS SELECT ${columns.map(name => name === "token_count"
      ? "input_row_read(token_count) AS token_count" : name).join(",")} FROM source_inputs`);
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation(sql => prepare(sql.replace("INDEXED BY sqlite_autoindex_agent_usage_context_inputs_1", "")));
  expect(attribution.rankingsPage(filter, "all", options)).toEqual(expected);
  expect(reads).toBe(0);
});

it("rounds management ranges to local days and preserves 23/25-hour DST days", () => {
  expect(dailyBounds("2026-10-10T03:00:00Z", "2026-10-11T04:00:00Z", "Asia/Singapore"))
    .toEqual({ from: "2026-10-09T16:00:00.000Z", to: "2026-10-11T16:00:00.000Z" });
  expect(dailyBounds("2026-10-09T16:00:00Z", "2026-10-10T16:00:00Z", "Asia/Singapore"))
    .toEqual({ from: "2026-10-09T16:00:00.000Z", to: "2026-10-10T16:00:00.000Z" });
  const duration = (from: string, to: string) => (Date.parse(dayStart(to, "America/New_York")) - Date.parse(dayStart(from, "America/New_York"))) / 3_600_000;
  expect(duration("2026-03-08", "2026-03-09")).toBe(23);
  expect(duration("2026-11-01", "2026-11-02")).toBe(25);
  expect(dayStart("2018-11-04", "America/Sao_Paulo")).toBe("2018-11-04T03:00:00.000Z");
  expect(dayStart("2011-12-30", "Pacific/Apia")).toBe("2011-12-30T10:00:00.000Z");
});

it("merges clean days with live dirty days, rejects stale commits and rebuilds only affected Sessions", async () => {
  const { db, attribution, binding, daily, store } = setup();
  const other = store.bindSession("test", "agent", "other");
  await attribution.upsertContext(binding, context("later", "2026-10-11T12:00:00.000Z"));
  await attribution.upsertContext(binding, { ...context("runtime", "2026-10-12T12:00:00.000Z"), runtimeKind: "claude_code" });
  await attribution.upsertContext(other, context("unaffected", "2026-10-12T12:00:00.000Z"));
  warm(daily);
  const untouched = db.prepare("SELECT * FROM agent_usage_ranking_days WHERE session_id='other'").all();
  const check = () => {
    for (const runtimeKind of [undefined, "codex", "claude_code"]) {
      const filter = { namespace: "test", runtimeKind, from: "2026-10-11T00:00:00.000Z" };
      expect(attribution.rankingsPage(filter, "all", options))
        .toEqual(attribution.rankingsPage({ ...filter, timezone: "Etc/UTC" }, "all", options));
    }
  };
  check();
  // Earlier evidence changes first/repeat classification in already aggregated days.
  await attribution.upsertContext(binding, context("late", "2026-10-10T12:00:00.000Z"));
  expect(db.prepare("SELECT COUNT(*) AS n FROM agent_usage_ranking_days WHERE session_id='session' AND ready=0").get())
    .toEqual({ n: 2 });
  check();
  const job = daily.nextJob()!, stale = daily.project(job);
  await attribution.upsertContext(binding, { ...context("late", "2026-10-10T12:00:00.000Z", 2),
    blocks: context("late", null).blocks.slice(1) });
  expect(daily.commit(stale)).toBe(false);
  check(); warm(daily); check();
  expect(db.prepare("SELECT * FROM agent_usage_ranking_days WHERE session_id='other'").all()).toEqual(untouched);
  attribution.deleteSession("test", "session");
  check(); warm(daily); check();
  expect(db.prepare("SELECT 1 FROM agent_usage_ranking_days WHERE session_id='session'").get()).toBeUndefined();
});

it("keeps null, zero, content-only, legacy estimate and missing-timestamp semantics through updates and deletion", async () => {
  const { db, attribution, binding, daily, store } = setup();
  const content = new RuntimeConversationCollector(store, attribution, "test");
  await attribution.upsertContext(binding, context("missing-time", null));
  const estimate = context("fixture", null).blocks[0]!.measured!.estimate;
  const insert = db.prepare(`INSERT INTO agent_usage_conversation_content
    (namespace,agent_id,session_id,run_id,event_key,category,occurred_at,runtime_kind,tokens,bytes,partial,estimate_json,estimate_id)
    VALUES('test','agent','content-only',?,'event','assistant_output',?,'codex',?,7,0,?,?)`);
  insert.run(1, "2026-10-10T23:00:00.000Z", null, JSON.stringify(estimate), null);
  insert.run(2, "2026-10-11T00:00:00.000Z", 0, "", attribution.tokenEstimateId(estimate));
  const filters = [{ namespace: "test" }, { namespace: "test", from: "2026-10-10T00:00:00.000Z", to: "2026-10-12T00:00:00.000Z" }];
  const check = () => {
    for (const filter of filters) expect(attribution.rankingsPage(filter, "all", options))
      .toEqual(attribution.rankingsPage({ ...filter, timezone: "Etc/UTC" }, "all", options));
  };
  warm(daily); check();
  content.compactEstimates(1, ["event"]);
  db.prepare("UPDATE agent_usage_conversation_content SET tokens=9,runtime_kind='claude_code' WHERE run_id=1").run();
  check(); warm(daily); check();
  expect(attribution.rankings({ namespace: "test" }, "assistant_output")[0])
    .toMatchObject({ observedResultTokens: 9, contentObservations: 2 });
  content.deleteSession("content-only");
  check(); warm(daily); check();
  expect(attribution.rankings({ namespace: "test" }, "assistant_output")).toEqual([]);
});

it("resumes bounded historical discovery after restart and safely registers a new timezone", async () => {
  const { db, attribution, binding, daily } = setup();
  for (let index = 0; index < 5; index++) await attribution.upsertContext(binding,
    context(String(index), `2026-10-${10 + index}T23:00:00.000Z`));
  // Upgrade an existing database that has never tracked daily partitions.
  for (const suffix of ["insert", "update", "delete"]) db.exec(`DROP TRIGGER agent_usage_contexts_daily_${suffix}`);
  db.exec("DROP TABLE agent_usage_ranking_days; DROP TABLE agent_usage_ranking_timezones");
  const upgraded = new DailyRankingStore(db);
  expect(upgraded.discover(1)).toBe(true);
  const cursor = db.prepare("SELECT context_cursor FROM agent_usage_ranking_timezones").get();
  const reopened = new DailyRankingStore(db);
  expect(db.prepare("SELECT context_cursor FROM agent_usage_ranking_timezones").get()).toEqual(cursor);
  warm(reopened);
  expect(reopened.ensureTimezone("Asia/Kathmandu")).toBe(true);
  expect(reopened.ensureTimezone("Asia/Kathmandu")).toBe(false);
  expect(reopened.discover(1)).toBe(true);
  const filter = { namespace: "test", timezone: "Asia/Kathmandu", from: "2026-10-10T18:15:00.000Z", to: "2026-10-12T18:15:00.000Z" };
  const expected = attribution.rankingsPage(filter, "all", options);
  await attribution.upsertContext(binding, context("new", "2026-10-11T12:00:00.000Z"));
  const live = attribution.rankingsPage(filter, "all", options);
  expect(live).not.toEqual(expected);
  warm(daily);
  expect(attribution.rankingsPage(filter, "all", options)).toEqual(live);
});

it("preserves fallback semantics for internal partial-day and noncanonical timestamp filters", async () => {
  const { attribution, binding, daily } = setup();
  await attribution.upsertContext(binding, context("midnight", "2026-10-10T00:00:00.000Z"));
  const filters = [{ from: "2026-10-10T00:00:00Z" }, { from: "2026-10-10T00:00:01.000Z" },
    { to: "2026-10-10T00:00:00Z" }];
  const before = filters.map(filter => attribution.rankingsPage(filter, "all", options));
  warm(daily);
  for (const [index, filter] of filters.entries()) expect(attribution.rankingsPage(filter, "all", options)).toEqual(before[index]);
});

it("does not read numeric detail or display metadata for capabilities outside the selected page", async () => {
  const { db, attribution, binding, daily } = setup();
  const input = context("page", "2026-10-10T12:00:00.000Z");
  input.blocks = input.blocks.map((block, index) => ({ ...block,
    measured: { ...block.measured!, tokens: index < 10 ? 10 : 1 }, capabilities: [{ evidence: "direct",
      capability: { kind: "builtin_tool", id: index < 10 ? "read" : "other", name: index < 10 ? "Read" : "Other" } }] }));
  await attribution.upsertContext(binding, input);
  warm(daily);
  const filter = { namespace: "test", from: "2026-10-10T00:00:00.000Z", to: "2026-10-11T00:00:00.000Z" };
  const expected = attribution.rankingsPage(filter, "all", { ...options, limit: 1 });
  expect(expected.items[0]?.capability.id).toBe("read");
  db.function("required_bytes", (key: string, bytes: number | null) => {
    if (JSON.parse(key)[2] === "other") throw new Error("Loaded off-page numeric details");
    return bytes;
  });
  db.function("required_metadata", (value: string) => {
    if (JSON.parse(value).id === "other") throw new Error("Loaded off-page display metadata");
    return value;
  });
  for (const kind of ["inputs", "latest"]) {
    const table = `agent_usage_ranking_${kind}`;
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name);
    db.exec(`ALTER TABLE ${table} RENAME TO stored_${kind}; CREATE VIEW ${table} AS SELECT ${columns.map(name =>
      name === "byte_length" ? "required_bytes(capability_key,byte_length) AS byte_length"
        : name === "capability_json" ? "required_metadata(capability_json) AS capability_json" : name).join(",")} FROM stored_${kind}`);
  }
  expect(attribution.rankingsPage(filter, "all", { ...options, limit: 1 })).toEqual(expected);
});

it("uses capability keys and timestamp ranges in daily query access paths", async () => {
  const { db, attribution, binding, daily } = setup();
  await attribution.upsertContext(binding, context("plan", "2026-10-10T12:00:00.000Z"));
  warm(daily);
  const source = daily.inputs({ namespace: "test", from: "2026-10-10T00:00:00.000Z", to: "2026-10-11T00:00:00.000Z" })!;
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT token_count FROM (${source.sql}) WHERE capability_key=?`)
    .all(...source.params, '["builtin_tool",null,"read"]') as Array<{ detail: string }>;
  expect(plan.some(row => /SEARCH v USING PRIMARY KEY \(partition_id=\? AND capability_key=\?\)/.test(row.detail))).toBe(true);
  expect(plan.some(row => /agent_usage_contexts_subject.*occurred_at>\? AND occurred_at<\?/.test(row.detail))).toBe(true);
  const coverage = daily.coverage({ namespace: "test", from: "2026-10-10T00:00:00.000Z", to: "2026-10-11T00:00:00.000Z" },
    ['["builtin_tool",null,"read"]']);
  const coveragePlan = db.prepare(`EXPLAIN QUERY PLAN ${coverage.sql}`).all(...coverage.params) as Array<{ detail: string }>;
  expect(coveragePlan.some(row => /SEARCH e USING COVERING INDEX.*context_id=\? AND capability_key=\?/.test(row.detail))).toBe(true);
  expect(coveragePlan.some(row => /SEARCH v USING PRIMARY KEY \(partition_id=\? AND capability_key=\?\)/.test(row.detail))).toBe(true);
});

it("rolls back all projection tables when a partition commit is interrupted", async () => {
  const { db, attribution, binding, daily } = setup();
  await attribution.upsertContext(binding, context("atomic", "2026-10-10T12:00:00.000Z"));
  warm(daily);
  await attribution.upsertContext(binding, { ...context("atomic", "2026-10-10T12:00:00.000Z", 2), blocks: [] });
  const batch = daily.project(daily.nextJob()!)!;
  const expected = attribution.rankingsPage({ namespace: "test" }, "all", options);
  const prepare = db.prepare.bind(db);
  const interrupted = vi.spyOn(db, "prepare").mockImplementation(sql => {
    if (sql.startsWith("DELETE FROM agent_usage_ranking_coverage")) throw new Error("interrupted commit");
    return prepare(sql);
  });
  expect(() => daily.commit(batch)).toThrow("interrupted commit");
  interrupted.mockRestore();
  expect(daily.nextJob()).toBeDefined();
  expect(attribution.rankingsPage({ namespace: "test" }, "all", options)).toEqual(expected);
  expect(daily.commit(batch)).toBe(true);
  expect(daily.nextJob()).toBeUndefined();
  expect(db.prepare("SELECT COUNT(*) AS n FROM agent_usage_ranking_inputs").get()).toEqual({ n: 0 });
});

it("keeps both occurrences of a repeated midnight in the same daily partition", async () => {
  const { db, store, attribution, binding, daily } = setup();
  new RuntimeConversationCollector(store, attribution, "test");
  const timezone = "Asia/Amman";
  daily.ensureTimezone(timezone);
  // This is the first 00:30 on a day whose 00:00-00:59 occurs twice.
  await attribution.upsertContext(binding, context("first-midnight", "2021-10-28T21:30:00.000Z"));
  const estimate = context("fixture", null).blocks[0]!.measured!.estimate;
  db.prepare(`INSERT INTO agent_usage_conversation_content
    (namespace,agent_id,session_id,run_id,event_key,category,occurred_at,runtime_kind,tokens,bytes,partial,estimate_json,estimate_id)
    VALUES('test','agent','session',1,'event','assistant_output','2021-10-28T21:30:00.000Z','codex',7,7,0,'',?)`)
    .run(attribution.tokenEstimateId(estimate));
  const filters = [{ namespace: "test", timezone }, { namespace: "test", timezone,
    from: "2021-10-28T21:00:00.000Z", to: "2021-10-29T22:00:00.000Z" }];
  const expected = filters.map(filter => attribution.rankingsPage(filter, "all", options));
  expect(expected[0].total).toBe(2);
  warm(daily);
  for (const [index, filter] of filters.entries()) expect(attribution.rankingsPage(filter, "all", options)).toEqual(expected[index]);
  expect(dayStart("2021-10-29", timezone)).toBe("2021-10-28T21:00:00.000Z");
  expect(dailyBounds("2021-10-28T22:30:00.000Z", "2021-10-29T22:00:00.000Z", timezone))
    .toEqual({ from: "2021-10-28T21:00:00.000Z", to: "2021-10-29T22:00:00.000Z" });
  expect(dayStart("2026-11-01", "America/Havana")).toBe("2026-11-01T04:00:00.000Z");
  await attribution.upsertContext(binding, context("second-midnight", "2021-10-28T22:30:00.000Z"));
  const revised = filters.map(filter => attribution.rankingsPage({ ...filter, timezone: "Etc/UTC" }, "all", options));
  for (const [index, filter] of filters.entries()) expect(attribution.rankingsPage(filter, "all", options)).toEqual(revised[index]);
  warm(daily);
  for (const [index, filter] of filters.entries()) expect(attribution.rankingsPage(filter, "all", options)).toEqual(revised[index]);
});

it.each(["dated", "missing-time"])("does not read off-page coverage from dirty %s partitions", async time => {
  const { db, attribution, binding, daily } = setup();
  const occurredAt = time === "dated" ? "2026-10-10T12:00:00.000Z" : null;
  const selected = context("selected", occurredAt);
  selected.blocks = selected.blocks.map(block => ({ ...block, measured: { ...block.measured!, tokens: 10 } }));
  const other = context("other", occurredAt);
  other.blocks = other.blocks.map(block => ({ ...block, capabilities: [{ evidence: "direct",
    capability: { kind: "builtin_tool", id: "other", name: "Other" } }] }));
  await attribution.upsertContext(binding, selected);
  await attribution.upsertContext(binding, other);
  warm(daily);
  await attribution.upsertContext(binding, { ...selected, revision: 2, coverage: "partial" });
  const filter = { namespace: "test", ...(time === "dated"
    ? { from: "2026-10-10T00:00:00.000Z", to: "2026-10-11T00:00:00.000Z" } : {}) };
  const pageOptions = { ...options, limit: 1 };
  const expected = attribution.rankingsPage({ ...filter, timezone: "Etc/UTC" }, "all", pageOptions);
  expect(expected.items[0]).toMatchObject({ capability: { id: "read" }, contextCoverage: { partial: 1 } });
  let reads = 0;
  db.function("required_coverage", (id: string, coverage: string) => {
    if (id === "other") throw new Error("Loaded off-page coverage");
    reads++; return coverage;
  });
  const columns = (db.prepare("PRAGMA table_info(agent_usage_contexts)").all() as Array<{ name: string }>).map(row => row.name);
  db.exec(`ALTER TABLE agent_usage_contexts RENAME TO source_contexts;
    CREATE VIEW agent_usage_contexts AS SELECT ${columns.map(name => name === "coverage"
      ? "required_coverage(invocation_id,coverage) AS coverage" : name).join(",")} FROM source_contexts`);
  expect(attribution.rankingsPage(filter, "all", pageOptions)).toEqual(expected);
  expect(reads).toBeGreaterThan(0);
});

it.each(["fallback", "ready", "dirty"] as const)("only reads the selected observed token side in %s content", async state => {
  const { db, attribution, daily, store } = setup();
  new RuntimeConversationCollector(store, attribution, "test");
  const estimate = context("fixture", null).blocks[0]!.measured!.estimate;
  const insert = db.prepare(`INSERT INTO agent_usage_conversation_content
    (namespace,agent_id,session_id,run_id,event_key,category,occurred_at,runtime_kind,tokens,bytes,partial,estimate_json,estimate_id)
    VALUES('test','agent','session',?,'event',?,'2026-10-10T12:00:00.000Z','codex',?,7,0,'',?)`);
  for (const [index, category] of ["configured_instructions", "user_prompt", "assistant_output", "assistant_thought"].entries())
    insert.run(index + 1, category, [10, 80, 1000, 20][index], attribution.tokenEstimateId(estimate));
  if (state !== "fallback") warm(daily);
  if (state === "dirty") db.prepare("UPDATE agent_usage_conversation_content SET tokens=tokens").run();
  const filter = { namespace: "test", from: "2026-10-10T00:00:00.000Z", to: "2026-10-11T00:00:00.000Z" };
  const sorts = ["observedArgumentTokens", "observedResultTokens"] as const;
  const expected = sorts.map(sort => attribution.rankingsPage(filter, "all", { ...options, sort, limit: 1 }));
  expect(expected.map(page => page.items[0]?.capability.id)).toEqual(["user_prompt", "assistant_output"]);
  expect(expected.map(page => page.total)).toEqual([4, 4]);
  let argumentsOnly = true, reads = 0;
  db.function("required_content_tokens", (category: string, tokens: number | null) => {
    if (["configured_instructions", "user_prompt"].includes(category) !== argumentsOnly)
      throw new Error("Loaded tokens from the other observed content side");
    reads++; return tokens;
  });
  const sources = [["agent_usage_conversation_content", "c"], ["agent_usage_ranking_content", "v"]].map(([table, alias]) => {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name);
    return { table, alias, sql: `(SELECT ${columns.map(name => name === "tokens"
      ? "required_content_tokens(category,tokens) AS tokens" : name).join(",")} FROM ${table}) ${alias}` };
  });
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation(sql => {
    for (const source of sources) sql = sql.replaceAll(`${source.table} ${source.alias} `, `${source.sql} `);
    return prepare(sql);
  });
  for (const [index, sort] of sorts.entries()) {
    argumentsOnly = sort === "observedArgumentTokens"; reads = 0;
    expect(attribution.rankingsPage(filter, "all", { ...options, sort, limit: 1 })).toEqual(expected[index]);
    expect(reads).toBeGreaterThan(0);
  }
});
