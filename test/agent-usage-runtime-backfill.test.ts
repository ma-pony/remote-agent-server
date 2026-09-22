import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeContentBackfill } from "../src/agent-usage/runtime-backfill.js";
import { UsageStore } from "../src/agent-usage/storage/usage-store.js";
import { createTestDatabase } from "./helpers.js";

const databases: Array<ReturnType<typeof createTestDatabase>["db"]> = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const setup = () => {
  const { db, seed } = createTestDatabase(); databases.push(db);
  const store = new UsageStore(db);
  const run = (status: "queued" | "running" | "succeeded" = "succeeded") => {
    const sessionId = seed.session().id; seed.run(sessionId, status);
    const runId = (db.prepare("SELECT id FROM runs WHERE session_id = ?").get(sessionId) as { id: number }).id;
    return { runId, sessionId };
  };
  const event = (runId: number, sequence: number, content = '{"type":"tool_call","name":"read_file"}', type = "tool") => {
    return Number(db.prepare("INSERT INTO events (run_id, seq, type, content_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(runId, sequence, type, content, "2026-09-22T01:00:00.000Z").lastInsertRowid);
  };
  return { db, seed, store, run, event };
};

describe("historical runtime content backfill", () => {
  it("advances message-only batches without one progress write per message", async () => {
    const { db, run, event } = setup(), history = run();
    for (let sequence = 1; sequence <= 100; sequence++) event(history.runId, sequence, "{}", "message");
    event(history.runId, 101);
    const consume = vi.fn();
    const backfill = new RuntimeContentBackfill(db, "test", consume);
    db.exec(`CREATE TABLE progress_writes (value INTEGER);
      CREATE TRIGGER count_progress_writes AFTER UPDATE OF last_seq ON agent_usage_runtime_backfills
      BEGIN INSERT INTO progress_writes VALUES (1); END;`);
    expect(await backfill.step()).toBe(true);
    expect(consume).not.toHaveBeenCalled();
    expect((db.prepare("SELECT COUNT(*) AS n FROM progress_writes").get() as { n: number }).n).toBeLessThanOrEqual(1);
    const resumed = new RuntimeContentBackfill(db, "test", consume);
    expect(await resumed.step()).toBe(false);
    expect(consume).toHaveBeenCalledTimes(1);
  });
  it("keeps pending work visible after another Run fails, retaining its sanitized error", async () => {
    const { db, run, event } = setup(), pending = run(), failed = run();
    event(pending.runId, 1); event(failed.runId, 1, "{bad-json");
    const backfill = new RuntimeContentBackfill(db, "test", () => undefined);
    expect(await backfill.step()).toBe(true);
    expect(backfill.status()).toEqual({ status: "pending", processedEvents: 0, errorCode: "usage_runtime_event_malformed" });
    expect(await backfill.step()).toBe(false);
    expect(backfill.status()).toEqual({ status: "failed", processedEvents: 1, errorCode: "usage_runtime_event_malformed" });
  });
  it("keeps a partially processed Run running even when an earlier event failed", async () => {
    const { db, run, event } = setup(), history = run();
    event(history.runId, 1, "{bad-json");
    for (let sequence = 2; sequence <= 101; sequence++) event(history.runId, sequence);
    const backfill = new RuntimeContentBackfill(db, "test", () => undefined);
    expect(await backfill.step()).toBe(true);
    expect(backfill.status()).toEqual({ status: "running", processedEvents: 99, errorCode: "usage_runtime_event_malformed" });
    expect(await backfill.step()).toBe(false);
    expect(backfill.status()).toEqual({ status: "failed", processedEvents: 100, errorCode: "usage_runtime_event_malformed" });
  });
  it("measures event bytes from SQLite metadata before admitting payloads to a batch", async () => {
    const { db, run, event } = setup(), history = run(); event(history.runId, 1);
    const backfill = new RuntimeContentBackfill(db, "test", () => undefined);
    const prepare = vi.spyOn(db, "prepare");
    try {
      await backfill.step();
      const metadataQuery = prepare.mock.results.flatMap(result => result.type === "return" ? [result.value] : [])
        .find(statement => statement.reader && statement.columns().some(column => column.name === "bytes"));
      expect(metadataQuery).toBeDefined();
      const plan = db.prepare(`EXPLAIN ${metadataQuery!.source}`).all(history.runId, 0) as Array<{ opcode: string; p2: number; p5: number }>;
      const columnId = (db.prepare("PRAGMA table_info(events)").all() as Array<{ cid: number; name: string }>).find(column => column.name === "content_json")!.cid;
      const contentRead = plan.filter(instruction => instruction.opcode === "Column" && instruction.p2 === columnId);
      expect(contentRead.length).toBeGreaterThan(0);
      // OPFLAG_LENGTHARG (0x40) makes SQLite use column length metadata instead
      // of loading each large event body before the replay byte budget applies.
      expect(contentRead.every(instruction => (instruction.p5 & 0x40) !== 0)).toBe(true);
    } finally { prepare.mockRestore(); }
  });
  it("leaves active Runs eligible for replay after they finish", async () => {
    const { db, run, event } = setup(), active = run("running"), queued = run("queued"), seen: number[] = [];
    event(active.runId, 1); event(queued.runId, 1);
    const backfill = new RuntimeContentBackfill(db, "test", (id) => { seen.push(id); });
    expect(await backfill.step()).toBe(false); expect(seen).toEqual([]);
    db.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(active.runId);
    expect(await backfill.step()).toBe(false); expect(seen).toEqual([active.runId]);
    db.prepare("UPDATE runs SET status = 'cancelled' WHERE id = ?").run(queued.runId);
    expect(await backfill.step()).toBe(false); expect(seen).toEqual([active.runId, queued.runId]);
  });
  it("bounds traversal even when most historical events are not tools", async () => {
    const { db, run, event } = setup(), history = run(), seen: number[] = [];
    for (let sequence = 1; sequence <= 100; sequence++) event(history.runId, sequence, "{}", "message");
    event(history.runId, 101);
    const backfill = new RuntimeContentBackfill(db, "test", (id) => { seen.push(id); });
    expect(await backfill.step()).toBe(true); expect(seen).toEqual([]);
    expect(backfill.status({ sessionId: String(history.sessionId) }).status).toBe("running");
    expect(await backfill.step()).toBe(false); expect(seen).toEqual([history.runId]);
  });
  it("bounds total payload bytes per batch while allowing one larger record", async () => {
    const { db, run, event } = setup(), history = run(), seen: number[] = [];
    const content = JSON.stringify({ payload: "x".repeat(1_500_000) });
    for (let sequence = 1; sequence <= 3; sequence++) event(history.runId, sequence, content);
    event(history.runId, 4, JSON.stringify({ payload: "x".repeat(5 * 1024 * 1024) }));
    const backfill = new RuntimeContentBackfill(db, "test", (_id, value) => { seen.push((value.payload as string).length); });
    expect(await backfill.step()).toBe(true); expect(seen).toEqual([1_500_000, 1_500_000]);
    expect(await backfill.step()).toBe(true); expect(seen).toEqual([1_500_000, 1_500_000, 1_500_000]);
    expect(await backfill.step()).toBe(false); expect(seen.at(-1)).toBe(5 * 1024 * 1024);
  });
  it("records sanitized failures for malformed or oversized events and continues other records and Runs", async () => {
    const { db, run, event } = setup(), other = run(), malformed = run(), oversized = run(), seen: number[] = [];
    event(other.runId, 1); event(malformed.runId, 1, "{secret-invalid-json"); event(malformed.runId, 2);
    event(oversized.runId, 1, JSON.stringify({ secret: "x".repeat(17 * 1024 * 1024) })); event(oversized.runId, 2);
    const backfill = new RuntimeContentBackfill(db, "test", (id) => { seen.push(id); });
    while (await backfill.step()) { /* process all jobs */ }
    expect(seen).toEqual([oversized.runId, malformed.runId, other.runId]);
    expect(backfill.status({ sessionId: String(malformed.sessionId) })).toEqual({ status: "failed", processedEvents: 1, errorCode: "usage_runtime_event_malformed" });
    expect(backfill.status({ sessionId: String(oversized.sessionId) }).errorCode).toBe("usage_runtime_event_too_large");
    expect(backfill.status({ sessionId: String(other.sessionId) })).toEqual({ status: "completed", processedEvents: 1, errorCode: null });
    const persisted = JSON.stringify(db.prepare("SELECT * FROM agent_usage_runtime_backfills").all());
    expect(persisted).not.toContain("secret");
    expect(await backfill.step()).toBe(false);
  });
  it("rolls back failed consume writes with their checkpoint and preserves other successful records", async () => {
    const { db, run, event } = setup(), history = run();
    event(history.runId, 1); event(history.runId, 2);
    db.exec("CREATE TABLE consumed_events (sequence INTEGER PRIMARY KEY)");
    const backfill = new RuntimeContentBackfill(db, "test", (_id, _value, detail) => {
      db.prepare("INSERT INTO consumed_events VALUES (?)").run(detail.sequence);
      if (detail.sequence === 1) throw new Error("secret-provider-output");
    });
    expect(await backfill.step()).toBe(false);
    expect(db.prepare("SELECT * FROM consumed_events").all()).toEqual([{ sequence: 2 }]);
    expect(backfill.status()).toEqual({ status: "failed", processedEvents: 1, errorCode: "usage_runtime_backfill_failed" });
  });
  it("never resurrects deleted Sessions or Agents, including after restart", async () => {
    const { db, seed, store, run, event } = setup(), removed = run(), remaining = run(), seen: number[] = [];
    event(removed.runId, 1); event(remaining.runId, 1);
    const consume = (id: number) => { seen.push(id); };
    const backfill = new RuntimeContentBackfill(db, "test", consume);
    backfill.deleteSession(String(removed.sessionId));
    const resumed = new RuntimeContentBackfill(db, "test", consume);
    while (await resumed.step()) { /* skip deleted session */ }
    expect(seen).toEqual([remaining.runId]);
    expect(resumed.status({ sessionId: String(removed.sessionId) }).processedEvents).toBe(0);
    const later = run(); event(later.runId, 1);
    store.bindSession("test", String(seed.agent.id), String(later.sessionId));
    db.prepare("UPDATE agent_usage_subjects SET state = 'deleted' WHERE namespace = 'test' AND kind = 'agent'").run();
    expect(await resumed.step()).toBe(false);
    expect(seen).toEqual([remaining.runId]);
  });
  it("deletes one Session's pending progress without resetting unrelated completed jobs", async () => {
    const { db, store, seed, run, event } = setup(), complete = run(), deleted = run();
    event(complete.runId, 1);
    for (let sequence = 1; sequence <= 101; sequence++) event(deleted.runId, sequence);
    const seen: number[] = [], backfill = new RuntimeContentBackfill(db, "test", (id) => { seen.push(id); });
    expect(await backfill.step()).toBe(true);
    backfill.deleteSession(String(deleted.sessionId));
    store.deleteSession("test", String(deleted.sessionId));
    expect(await backfill.step()).toBe(false);
    const restarted = new RuntimeContentBackfill(db, "test", (id) => { seen.push(id); });
    expect(await restarted.step()).toBe(false);
    expect(restarted.status({ agentId: String(seed.agent.id) })).toEqual({ status: "completed", processedEvents: 1, errorCode: null });
    expect(seen.filter((id) => id === complete.runId)).toEqual([complete.runId]);
    expect(seen.filter((id) => id === deleted.runId)).toHaveLength(100);
    const otherNamespace = new RuntimeContentBackfill(db, "other", () => undefined);
    expect(otherNamespace.status({ sessionId: String(complete.sessionId) })).toEqual({ status: "pending", processedEvents: 0, errorCode: null });
    expect(restarted.status({ namespace: "other" })).toEqual({ status: "completed", processedEvents: 0, errorCode: null });
  });
  it("starts with newest Runs, checkpoints bounded batches, and resumes without duplicate work", async () => {
    const { db, run, event } = setup(), older = run(), newest = run();
    event(older.runId, 1);
    for (let sequence = 1; sequence <= 205; sequence++) event(newest.runId, sequence);
    db.exec("CREATE TABLE consumed_events (id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL)");
    const consume = (runId: number, _content: Record<string, unknown>, detail: { eventId: number; sequence: number; occurredAt: string }) => {
      expect(detail.occurredAt).toBe("2026-09-22T01:00:00.000Z");
      db.prepare("INSERT INTO consumed_events VALUES (?, ?)").run(detail.eventId, runId);
    };
    const backfill = new RuntimeContentBackfill(db, "test", consume);
    expect(backfill.status()).toEqual({ status: "pending", processedEvents: 0, errorCode: null });
    expect(await backfill.step()).toBe(true);
    expect(backfill.status({ sessionId: String(newest.sessionId) })).toEqual({ status: "running", processedEvents: 100, errorCode: null });
    expect(db.prepare("SELECT DISTINCT run_id FROM consumed_events").all()).toEqual([{ run_id: newest.runId }]);
    const resumed = new RuntimeContentBackfill(db, "test", consume);
    while (await resumed.step()) { /* bounded batches */ }
    expect(resumed.status()).toEqual({ status: "completed", processedEvents: 206, errorCode: null });
    expect(resumed.status({ sessionId: String(older.sessionId) }).processedEvents).toBe(1);
    expect(await resumed.step()).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS count FROM consumed_events").get()).toEqual({ count: 206 });
  });
});
