import { afterEach, expect, it, vi } from "vitest";
import { fixtureTokenizers } from "./fixtures/agent-usage/tokenizers/helpers.js";
import { createTestDatabase } from "./helpers.js";
import { RuntimeContentBackfill } from "../src/agent-usage/runtime-backfill.js";
import { HostUsageCollector } from "../src/agent-usage/host-collector.js";

const databases: Array<ReturnType<typeof createTestDatabase>["db"]> = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
it("replaces historical fallback with pending but never downgrades a completed vocabulary count", async () => {
  const { db, seed } = createTestDatabase(); databases.push(db);
  const session = seed.session(); seed.run(session.id, "succeeded");
  const { id } = db.prepare("SELECT id FROM runs WHERE session_id=?").get(session.id) as { id: number };
  db.prepare("UPDATE runs SET resolved_model='fixture-model' WHERE id=?").run(id);
  const old = new HostUsageCollector(db);
  await old.runtimeCapabilities.recordTool(id, { toolCallId: "read", kind: "read", status: "completed", rawOutput: "hello world" });
  const tokenizers = fixtureTokenizers();
  const upgraded = new HostUsageCollector(db, {}, undefined, tokenizers);
  const event = { eventId: 1, sequence: 1, occurredAt: "2026-09-22T01:00:00Z" };
  const progress = { toolCallId: "read", kind: "read", status: "in_progress", rawOutput: "hello world" };
  for (const tokens of [null, 2]) {
    const count = vi.spyOn(tokenizers, "countAsync").mockResolvedValueOnce({ ...tokenizers.describe("fixture-model"),
      tokens: null, method: "unavailable", reason: "tokenizer_pending" });
    await expect(upgraded.runtimeCapabilities.recordTool(id, progress, event)).rejects.toThrow("usage_tokenizer_pending");
    count.mockRestore();
    expect(upgraded.attribution.rankings({}, "builtin_tool")).toMatchObject([{ calls: 1, observedResultTokens: tokens }]);
    await upgraded.runtimeCapabilities.recordTool(id, progress, event);
    await upgraded.runtimeCapabilities.recordTool(id, { toolCallId: "read", status: "completed" }, { ...event, eventId: 2, sequence: 2 });
    expect(upgraded.attribution.rankings({}, "builtin_tool")).toMatchObject([{ calls: 1, observedResultTokens: 2 }]);
  }
});
it("upgrades retained historical fallback content without adding calls and resumes pending vocabulary work", async () => {
  const { db, seed } = createTestDatabase(); databases.push(db);
  const session = seed.session(); seed.run(session.id, "succeeded");
  const { id } = db.prepare("SELECT id FROM runs WHERE session_id=?").get(session.id) as { id: number };
  db.prepare("UPDATE runs SET input='hello world',resolved_model='fixture-model' WHERE id=?").run(id);
  db.prepare("UPDATE sessions SET instructions_snapshot='hello' WHERE id=?").run(session.id);
  db.prepare("INSERT INTO events(run_id,seq,type,content_json,created_at) VALUES(?,1,'tool',?,?)")
    .run(id, JSON.stringify({ toolCallId: "read", kind: "read", status: "in_progress", rawOutput: "hello" }), "2026-09-22T01:00:00Z");
  db.prepare("INSERT INTO events(run_id,seq,type,content_json,created_at) VALUES(?,2,'tool',?,?)")
    .run(id, JSON.stringify({ toolCallId: "read", kind: "read", status: "in_progress", rawOutput: "hello world" }), "2026-09-22T01:00:01Z");
  db.prepare("INSERT INTO events(run_id,seq,type,content_json,created_at) VALUES(?,3,'tool',?,?)")
    .run(id, JSON.stringify({ toolCallId: "read", status: "completed" }), "2026-09-22T01:00:02Z");
  const old = new HostUsageCollector(db);
  await old.contentBackfill.step();
  expect(old.attribution.rankings({}, "user_prompt")[0].observedTotalTokens).toBe(3);
  db.prepare("UPDATE agent_usage_runtime_backfills SET content_version=2").run();
  const tokenizers = fixtureTokenizers();
  vi.spyOn(tokenizers, "countAsync").mockResolvedValueOnce({ ...tokenizers.describe("fixture-model"),
    tokens: null, method: "unavailable", reason: "tokenizer_pending" });
  const upgraded = new HostUsageCollector(db, {}, undefined, tokenizers);
  expect(await upgraded.contentBackfill.step()).toBe(true);
  expect(upgraded.contentBackfill.status()).toMatchObject({ status: "pending", errorCode: "usage_tokenizer_pending", processedEvents: 0 });
  expect(upgraded.attribution.rankings({}, "user_prompt")[0].observedTotalTokens).toBeNull();
  expect(await upgraded.contentBackfill.step()).toBe(false); // Cooldown is not a busy loop.
  db.prepare("UPDATE agent_usage_runtime_backfills SET retry_after=0").run();
  const resumed = new HostUsageCollector(db, {}, undefined, fixtureTokenizers());
  await resumed.contentBackfill.step();
  expect(resumed.contentBackfill.status()).toMatchObject({ status: "completed", processedEvents: 3, errorCode: null });
  expect(resumed.attribution.rankings({}, "user_prompt")[0]).toMatchObject({ observedTotalTokens: 2, contentObservations: 1 });
  expect(resumed.attribution.rankings({}, "configured_instructions")[0]).toMatchObject({ observedTotalTokens: 1, contentObservations: 1 });
  expect(resumed.attribution.rankings({}, "builtin_tool")[0]).toMatchObject({ calls: 1, observedResultTokens: 2 });
  expect(await new HostUsageCollector(db, {}, undefined, fixtureTokenizers()).contentBackfill.step()).toBe(false);
});
it("backfills prompts and output once, keeps scope and never stores their bodies in usage tables", async () => {
  const { db, seed } = createTestDatabase(); databases.push(db);
  const session = seed.session(); seed.run(session.id, "succeeded");
  const run = db.prepare("SELECT id FROM runs WHERE session_id=?").get(session.id) as { id: number };
  db.prepare("UPDATE runs SET input=?,started_at=? WHERE id=?").run("PRIVATE_USER_PROMPT", "2026-09-22T01:00:00.000Z", run.id);
  db.prepare("UPDATE sessions SET instructions_snapshot=? WHERE id=?").run("PRIVATE_INSTRUCTIONS", session.id);
  db.prepare("INSERT INTO events(run_id,seq,type,content_json,created_at) VALUES(?,1,'message',?,?)")
    .run(run.id, JSON.stringify({ stream: "output", text: "PRIVATE_ASSISTANT_OUTPUT" }), "2026-09-22T01:00:01.000Z");
  const collector = new HostUsageCollector(db);
  await collector.contentBackfill.step();
  await collector.contentBackfill.step();
  const rows = collector.attribution.rankings({ sessionId: String(session.id) }, "all");
  expect(rows.map((row) => row.capability.kind).sort()).toEqual(["assistant_output", "configured_instructions", "user_prompt"]);
  expect(rows.every((row) => row.observedTotalTokens! > 0 && row.contentObservations === 1)).toBe(true);
  expect(collector.attribution.rankings({ sessionId: "9999" }, "all")).toEqual([]);
  expect(collector.attribution.rankings({ from: "2026-09-23T00:00:00.000Z" }, "all")).toEqual([]);
  expect(JSON.stringify(db.prepare("SELECT * FROM agent_usage_conversation_content").all())).not.toContain("PRIVATE_");
  collector.deleteSession(session.id);
  expect(collector.attribution.rankings({}, "all")).toEqual([]);
});


it("upgrades completed tool-only replay once and normalizes equivalent date boundaries", async () => {
  const { db, seed } = createTestDatabase(); databases.push(db);
  const session = seed.session(); seed.run(session.id, "succeeded");
  const run = db.prepare("SELECT id FROM runs WHERE session_id=?").get(session.id) as { id: number };
  db.prepare("UPDATE runs SET input=?,started_at=?,finished_at=? WHERE id=?").run("prompt", "2026-09-22T01:00:00.000Z", "2026-09-22T01:01:00.000Z", run.id);
  db.prepare("INSERT INTO events(run_id,seq,type,content_json,created_at) VALUES(?,1,'message',?,?)")
    .run(run.id, JSON.stringify({ stream: "output", text: "reply" }), "2026-09-22T01:00:00.000Z");
  const initial = new HostUsageCollector(db);
  db.prepare("INSERT INTO events(run_id,seq,type,content_json,created_at) VALUES(?,2,'tool',?,?)")
    .run(run.id, JSON.stringify({ toolCallId: "read-1", kind: "read", status: "completed", rawOutput: "file contents" }), "2026-09-22T01:00:00.000Z");
  const legacy = new RuntimeContentBackfill(db, initial.namespace, async (runId, content, event) => await initial.runtimeCapabilities.recordTool(runId, content, event));
  await legacy.step();
  expect(legacy.status().status).toBe("completed");
  expect(initial.attribution.rankings({ namespace: initial.namespace }, "all").reduce((total, row) => total + row.calls, 0)).toBe(1);
  const upgraded = new HostUsageCollector(db);
  await upgraded.contentBackfill.step();
  const filter = { namespace: upgraded.namespace, from: "2026-09-22T01:00:00Z", to: "2026-09-22T01:00:01Z" };
  expect(upgraded.attribution.rankings(filter, "all").filter((row) => row.contentObservations > 0).map((row) => row.capability.kind).sort()).toEqual(["assistant_output", "user_prompt"]);
  const restarted = new HostUsageCollector(db);
  expect(await restarted.contentBackfill.step()).toBe(false);
  expect(restarted.attribution.rankings(filter, "all").filter((row) => row.contentObservations > 0).every((row) => row.contentObservations === 1)).toBe(true);
  expect(restarted.attribution.rankings({ namespace: restarted.namespace }, "all").reduce((total, row) => total + row.calls, 0)).toBe(1);
  const binding = restarted.binding(session.id);
  await restarted.attribution.upsertContext(binding, { invocationId: "model", providerEpochId: restarted.epoch(session.id), sourceId: "fixture", revision: 1,
    occurredAt: "2026-09-22T01:00:00.000Z", runtimeKind: "codex", model: null, coverage: "full", historyComplete: true,
    blocks: [{ position: 0, kind: "user_message", content: { identity: "message", modality: "text", text: "prompt" }, capabilities: [{ capability: { kind: "user_prompt", id: "user_prompt", name: "User prompts" }, evidence: "direct" }] }] });
  expect(restarted.attribution.rankings(filter, "user_prompt")).toMatchObject([{ exposureCount: 1, contentObservations: 1 }]);
  expect(restarted.attribution.rankings({ ...filter, from: "2026-09-22T00:00:00Z", to: "2026-09-22T01:00:00Z" }, "user_prompt")).toEqual([]);
});
