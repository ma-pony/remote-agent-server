import { afterEach, expect, it } from "vitest";
import { HostUsageCollector } from "../src/agent-usage/host-collector.js";
import { EventStore } from "../src/events/event-store.js";
import { createTestDatabase } from "./helpers.js";
import { fixtureTokenizers } from "./fixtures/agent-usage/tokenizers/helpers.js";
import { accountingRequests } from "./fixtures/agent-usage/accounting.js";

const databases: Array<ReturnType<typeof createTestDatabase>["db"]> = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const now = Date.parse("2026-09-23T00:00:00.000Z");
const setup = async (count = 1, retentionMs?: number) => {
  const { db, seed } = createTestDatabase(); databases.push(db);
  const session = seed.session(); seed.run(session.id, "succeeded");
  const { id } = db.prepare("SELECT id FROM runs WHERE session_id=?").get(session.id) as { id: number };
  db.prepare("UPDATE runs SET finished_at=?,result='Final reply' WHERE id=?").run("2026-09-01T00:00:00.000Z", id);
  const events = new EventStore({ db });
  events.append(id, "status", { text: "Started" });
  for (let i = 0; i < count; i++) events.append(id, "message", { stream: "output", text: "private message body" });
  events.append(id, "tool", { toolCallId: "read", kind: "read", status: "completed", rawInput: { path: "example" }, rawOutput: "private tool body" });
  const collector = new HostUsageCollector(db, {}, undefined, undefined, retentionMs);
  while (await collector.contentBackfill.step()) { /* complete bounded replay */ }
  for (const observation of accountingRequests()) collector.store.observe(collector.binding(session.id), observation);
  return { db, seed, session, id, events, collector };
};

it("retires bounded raw batches, preserves counts and final replies, and never reuses event sequences", async () => {
  const { db, id, events, collector } = await setup(105);
  // Simulate the prior on-disk representation: compaction must preserve its exact provenance.
  db.exec(`UPDATE agent_usage_conversation_content SET estimate_json=(SELECT estimate_json
    FROM agent_usage_token_estimates WHERE id=estimate_id),estimate_id=NULL`);
  const before = collector.attribution.rankings({}, "all");
  const totalBefore = collector.store.overview({});
  const cursor = events.latestSeq(id);
  expect(collector.eventRetention.step(now)).toBe(true);
  expect(events.list(id, 0, 200)).toHaveLength(7);
  const restarted = new HostUsageCollector(db);
  expect(restarted.eventRetention.step(now)).toBe(true);
  expect(restarted.eventRetention.step(now)).toBe(false);
  expect(events.list(id, 0)).toMatchObject([{ type: "status", seq: 1 }]);
  expect(db.prepare("SELECT input,result,events_pruned_through_seq FROM runs WHERE id=?").get(id))
    .toEqual({ input: "test input", result: "Final reply", events_pruned_through_seq: cursor });
  expect(restarted.attribution.rankings({}, "all")).toEqual(before);
  expect(restarted.store.overview({})).toEqual({ ...totalBefore, summary: { ...totalBefore.summary, asOf: expect.any(String) } });
  expect(db.prepare("SELECT COUNT(*) AS n FROM agent_usage_conversation_content WHERE estimate_id IS NULL OR estimate_json!=''").get()).toEqual({ n: 0 });
  expect(events.latestSeq(id)).toBe(cursor);
  expect(events.append(id, "status", { text: "Audit" }).seq).toBe(cursor + 1);
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM agent_usage_conversation_content WHERE namespace=? AND run_id=? AND tokens IS NULL")
    .all(collector.namespace, id) as Array<{ detail: string }>;
  expect(plan.some(row => row.detail.includes("agent_usage_conversation_uncounted"))).toBe(true);
});

it.each(["pending", "failed", "error", "queued", "running", "maintenance", "recent", "unfinished", "uncounted message", "uncounted tool"])(
  "preserves raw evidence when %s work makes it unsafe to retire", async state => {
    const { db, seed, session, id, events, collector } = await setup();
    if (state === "pending" || state === "failed") db.prepare("UPDATE agent_usage_runtime_backfills SET status=?").run(state);
    if (state === "error") db.prepare("UPDATE agent_usage_runtime_backfills SET error_code='usage_runtime_event_malformed'").run();
    if (state === "queued" || state === "running") seed.run(session.id, state);
    if (state === "maintenance") db.prepare("UPDATE sessions SET pending_operation='reset'").run();
    if (state === "recent") db.prepare("UPDATE runs SET finished_at=? WHERE id=?").run(new Date(now - 60_000).toISOString(), id);
    if (state === "unfinished") db.prepare("UPDATE runs SET finished_at=NULL WHERE id=?").run(id);
    if (state === "uncounted message") db.prepare("UPDATE agent_usage_conversation_content SET tokens=NULL").run();
    if (state === "uncounted tool") db.prepare("UPDATE agent_usage_invocation_payloads SET token_count=NULL").run();
    expect(collector.eventRetention.step(now)).toBe(false);
    expect(events.list(id, 0)).toHaveLength(3);
  }
);

it("disables retirement at zero retention", async () => {
  const { id, events, collector } = await setup(1, 0);
  expect(collector.eventRetention.step(now)).toBe(false);
  expect(events.list(id, 0)).toHaveLength(3);
});

it("rolls compaction, deletion and the expiry marker back together on failure", async () => {
  const { db, id, events, collector } = await setup();
  db.exec(`UPDATE agent_usage_conversation_content SET estimate_json=(SELECT estimate_json
    FROM agent_usage_token_estimates WHERE id=estimate_id),estimate_id=NULL;
    CREATE TRIGGER fail_retirement BEFORE UPDATE OF events_pruned_at ON runs
    BEGIN SELECT RAISE(ABORT, 'retirement failed'); END;`);
  expect(() => collector.eventRetention.step(now)).toThrow("retirement failed");
  expect(events.list(id, 0)).toHaveLength(3);
  expect(db.prepare("SELECT events_pruned_at FROM runs WHERE id=?").get(id)).toEqual({ events_pruned_at: null });
  expect(db.prepare("SELECT COUNT(*) AS n FROM agent_usage_conversation_content WHERE estimate_id IS NOT NULL").get()).toEqual({ n: 0 });
  db.exec("DROP TRIGGER fail_retirement");
  expect(collector.eventRetention.step(now)).toBe(true);
});

it("does not schedule a vocabulary replay when its raw evidence has expired", async () => {
  const { db, id, collector } = await setup();
  db.prepare("UPDATE runs SET resolved_model='fixture-model' WHERE id=?").run(id);
  expect(collector.eventRetention.step(now)).toBe(true);
  const before = db.prepare("SELECT * FROM agent_usage_runtime_backfills").all();
  const upgraded = new HostUsageCollector(db, {}, undefined, fixtureTokenizers());
  expect(await upgraded.contentBackfill.step()).toBe(false);
  expect(db.prepare("SELECT * FROM agent_usage_runtime_backfills").all()).toEqual(before);
});

it("bounds retired payload bytes even when fewer than 100 events remain", async () => {
  const { db, id, collector } = await setup(3);
  // Counts were already committed; emulate large source bodies without tokenizing fixture megabytes.
  db.prepare("UPDATE events SET content_json=? WHERE type='message'").run(JSON.stringify({ text: "x".repeat(1_500_000) }));
  expect(collector.eventRetention.step(now)).toBe(true);
  expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE run_id=? AND type='message'").get(id)).toEqual({ n: 1 });
});
