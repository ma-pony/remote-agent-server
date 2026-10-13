import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { AttributionStore } from "../src/agent-usage/storage/attribution-store.js";
import { DailyRankingStore } from "../src/agent-usage/storage/daily-rankings.js";
import { UsageStore } from "../src/agent-usage/storage/usage-store.js";
import { RuntimeConversationCollector } from "../src/agent-usage/runtime-conversation.js";

const databases: Database.Database[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); });
const tables = ["inputs", "coverage", "latest", "content"];

const legacy = () => {
  const db = new Database(":memory:"); databases.push(db);
  const store = new UsageStore(db), attribution = new AttributionStore(store);
  new RuntimeConversationCollector(store, attribution, "test");
  for (const table of ["agent_usage_contexts", "agent_usage_conversation_content"]) {
    for (const event of ["insert", "update", "delete"]) db.exec(`DROP TRIGGER IF EXISTS ${table}_daily_${event}`);
  }
  db.exec(`DROP TABLE agent_usage_ranking_days;
    DROP TABLE IF EXISTS agent_usage_ranking_discovery;
    DROP TABLE IF EXISTS agent_usage_ranking_timezones;
    CREATE TABLE agent_usage_ranking_timezones (
      timezone TEXT PRIMARY KEY, context_cursor INTEGER NOT NULL DEFAULT 0, content_cursor INTEGER NOT NULL DEFAULT 0,
      context_complete INTEGER NOT NULL DEFAULT 0, content_complete INTEGER NOT NULL DEFAULT 0);
    INSERT INTO agent_usage_ranking_timezones VALUES ('UTC',123,456,1,1),('Asia/Singapore',123,50,1,0);
    CREATE TABLE agent_usage_ranking_days (
      id INTEGER PRIMARY KEY AUTOINCREMENT, timezone TEXT NOT NULL, namespace TEXT NOT NULL, agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL, day TEXT NOT NULL, from_at TEXT, to_at TEXT, revision INTEGER NOT NULL DEFAULT 1,
      ready INTEGER NOT NULL DEFAULT 0, UNIQUE(timezone,namespace,agent_id,session_id,day));
    INSERT INTO agent_usage_ranking_days VALUES
      (7,'UTC','test','agent','session','2026-10-10','2026-10-10T00:00:00.000Z','2026-10-11T00:00:00.000Z',3,1),
      (8,'Asia/Singapore','test','agent','session','2026-10-10','2026-10-09T16:00:00.000Z','2026-10-10T16:00:00.000Z',5,1);
    INSERT INTO agent_usage_ranking_inputs(partition_id,capability_key,ordinal,token_count) VALUES(7,'read',0,42),(8,'read',0,99);
    INSERT INTO agent_usage_ranking_coverage(partition_id,capability_key,ordinal,full) VALUES(7,'read',0,2),(8,'read',0,3);
    INSERT INTO agent_usage_ranking_latest(partition_id,capability_key,ordinal,capability_json) VALUES(7,'read',0,'{}'),(8,'read',0,'{}');
    INSERT INTO agent_usage_ranking_content(partition_id,category,ordinal,tokens) VALUES(7,'user_prompt',0,12),(8,'user_prompt',0,33);`);
  for (const table of ["agent_usage_contexts", "agent_usage_conversation_content"]) {
    const invalidate = (row: string) => `INSERT INTO agent_usage_ranking_days(timezone,namespace,agent_id,session_id,day,from_at,to_at)
      SELECT timezone,${row}.namespace,${row}.agent_id,${row}.session_id,usage_local_day(${row}.occurred_at,timezone),
        usage_day_start(usage_local_day(${row}.occurred_at,timezone),timezone),
        usage_day_end(usage_local_day(${row}.occurred_at,timezone),timezone)
      FROM agent_usage_ranking_timezones WHERE 1
      ON CONFLICT(timezone,namespace,agent_id,session_id,day) DO UPDATE SET revision=revision+1,ready=0;`;
    for (const [event, rows] of [["INSERT", ["NEW"]], ["UPDATE", ["OLD", "NEW"]], ["DELETE", ["OLD"]]] as const)
      db.exec(`CREATE TRIGGER ${table}_daily_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN ${rows.map(invalidate).join("\n")} END`);
  }
  return db;
};

it("keeps existing UTC summaries and discovery progress while removing duplicate calendars", () => {
  const db = legacy();
  const before = tables.map(table => db.prepare(`SELECT * FROM agent_usage_ranking_${table} WHERE partition_id=7`).all());
  const daily = new DailyRankingStore(db);
  expect(db.prepare("PRAGMA table_info(agent_usage_ranking_days)").all()).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "timezone" })]));
  expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='agent_usage_ranking_timezones'").get()).toBeUndefined();
  expect(db.prepare("SELECT * FROM agent_usage_ranking_discovery").all()).toEqual([
    { id: 1, context_cursor: 123, content_cursor: 456, context_complete: 1, content_complete: 1 }
  ]);
  expect(db.prepare("SELECT id,revision,ready FROM agent_usage_ranking_days").all()).toEqual([{ id: 7, revision: 3, ready: 1 }]);
  tables.forEach((table, index) => expect(db.prepare(`SELECT * FROM agent_usage_ranking_${table}`).all()).toEqual(before[index]));
  expect(daily.discover()).toBe(false);
  expect(daily.pending()).toBe(false);
  expect(daily.commit({ id: 8, revision: 5, data: null })).toBe(false);
  new DailyRankingStore(db);
  expect(db.prepare("SELECT context_cursor,content_cursor FROM agent_usage_ranking_discovery").get()).toEqual({ context_cursor: 123, content_cursor: 456 });
});

it("replaces legacy source triggers and never reuses a removed partition's identity", () => {
  const db = legacy(), daily = new DailyRankingStore(db);
  db.exec(`INSERT INTO agent_usage_conversation_content
    (namespace,agent_id,session_id,run_id,event_key,category,occurred_at,runtime_kind,tokens,bytes,partial,estimate_json)
    VALUES('test','agent','session',1,'event','user_prompt','2026-10-11T00:30:00.000Z','codex',11,20,0,'{}')`);
  expect(db.prepare("SELECT id,day,from_at,to_at,ready FROM agent_usage_ranking_days WHERE id>7").all()).toEqual([
    { id: 9, day: "2026-10-11", from_at: "2026-10-11T00:00:00.000Z", to_at: "2026-10-12T00:00:00.000Z", ready: 0 }
  ]);
  expect(daily.commit({ id: 8, revision: 1, data: null })).toBe(false);
  expect(daily.commit(daily.project(daily.nextJob()!))).toBe(true);
  expect(db.prepare("SELECT tokens FROM agent_usage_ranking_content WHERE partition_id=9").get()).toEqual({ tokens: 11 });
  db.exec("UPDATE agent_usage_conversation_content SET tokens=0");
  expect(daily.commit(daily.project(daily.nextJob()!))).toBe(true);
  expect(db.prepare("SELECT tokens FROM agent_usage_ranking_content WHERE partition_id=9").get()).toEqual({ tokens: 0 });
  db.exec("DELETE FROM agent_usage_conversation_content");
  expect(daily.commit(daily.project(daily.nextJob()!))).toBe(true);
  expect(db.prepare("SELECT id FROM agent_usage_ranking_days WHERE id=9").get()).toBeUndefined();
  expect(db.prepare("SELECT id,revision,ready FROM agent_usage_ranking_days").all()).toEqual([{ id: 7, revision: 3, ready: 1 }]);
});

it("rolls back an interrupted calendar migration and can retry it without losing UTC summaries", () => {
  const db = legacy(), exec = db.exec.bind(db);
  const before = tables.map(table => db.prepare(`SELECT * FROM agent_usage_ranking_${table}`).all());
  const interrupted = vi.spyOn(db, "exec").mockImplementation(sql => {
    if (sql.includes("DROP TABLE agent_usage_ranking_timezones")) throw new Error("interrupted migration");
    return exec(sql);
  });
  expect(() => new DailyRankingStore(db)).toThrow("interrupted migration");
  interrupted.mockRestore();
  expect(db.prepare("SELECT COUNT(*) AS n FROM agent_usage_ranking_days").get()).toEqual({ n: 2 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE '%_daily_%' AND sql LIKE '%ranking_timezones%'").get()).toEqual({ n: 6 });
  tables.forEach((table, index) => expect(db.prepare(`SELECT * FROM agent_usage_ranking_${table}`).all()).toEqual(before[index]));
  new DailyRankingStore(db);
  expect(db.prepare("SELECT id FROM agent_usage_ranking_days").all()).toEqual([{ id: 7 }]);
});
