import { afterEach, expect, it } from "vitest";
import { createTestDatabase } from "./helpers.js";
import { RuntimeContentBackfill } from "../src/agent-usage/runtime-backfill.js";
import { HostUsageCollector } from "../src/agent-usage/host-collector.js";

const databases: Array<ReturnType<typeof createTestDatabase>["db"]> = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
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
  const legacy = new RuntimeContentBackfill(db, initial.namespace, (runId, content, event) => initial.runtimeCapabilities.recordTool(runId, content, event));
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
  restarted.attribution.upsertContext(binding, { invocationId: "model", providerEpochId: restarted.epoch(session.id), sourceId: "fixture", revision: 1,
    occurredAt: "2026-09-22T01:00:00.000Z", runtimeKind: "codex", model: null, coverage: "full", historyComplete: true,
    blocks: [{ position: 0, kind: "user_message", content: { identity: "message", modality: "text", text: "prompt" }, capabilities: [{ capability: { kind: "user_prompt", id: "user_prompt", name: "User prompts" }, evidence: "direct" }] }] });
  expect(restarted.attribution.rankings(filter, "user_prompt")).toMatchObject([{ exposureCount: 1, contentObservations: 1 }]);
  expect(restarted.attribution.rankings({ ...filter, from: "2026-09-22T00:00:00Z", to: "2026-09-22T01:00:00Z" }, "user_prompt")).toEqual([]);
});
