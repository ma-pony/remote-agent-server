import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { UsageStore } from "../src/agent-usage/storage/usage-store.js";
import { AttributionStore } from "../src/agent-usage/storage/attribution-store.js";
import { RuntimeConversationCollector } from "../src/agent-usage/runtime-conversation.js";
import { measureToolContent } from "../src/agent-usage/core/tool-content.js";
import { listRuntimeContentEvidence, getRuntimeContentEvidence, runtimeContentScope } from "../src/agent-usage/runtime-content-evidence.js";

const dbs: Database.Database[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of dbs.splice(0)) db.close(); });
it("pages metadata-only runtime evidence with stable tied cursors, scoped details and no duplicate rows", async () => {
  const db = new Database(":memory:"); dbs.push(db);
  const usage = new UsageStore(db), attribution = new AttributionStore(usage);
  new RuntimeConversationCollector(usage, attribution, "test");
  const estimate = JSON.stringify((await measureToolContent("private content never belongs in evidence", "result"))!.estimate);
  const insert = db.prepare("INSERT INTO agent_usage_conversation_content VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
  for (let run = 1; run <= 50; run++) for (const category of ["user_prompt", "configured_instructions", "assistant_output", "assistant_thought"]) {
    insert.run("test", "session", "agent", run, "1", category, "2026-09-22T01:00:00.000Z", "codex", run, 10, 0, estimate);
  }
  insert.run("other", "session", "agent", 999, "1", "user_prompt", "2026-09-22T01:00:00.000Z", "codex", 999, 10, 0, estimate);
  const prepare = db.prepare.bind(db); let largest = 0;
  vi.spyOn(db, "prepare").mockImplementation((sql: string) => { const statement = prepare(sql), all = statement.all.bind(statement); statement.all = (...params: unknown[]) => { const rows = all(...params); largest = Math.max(largest, rows.length); return rows; }; return statement; });
  const scope = { namespace: "test", agentId: "agent", sessionId: "session", runtimeKind: "codex", from: "2026-09-22T01:00:00Z", to: "2026-09-22T01:00:01Z" };
  const scoped = runtimeContentScope(db, scope);
  const plan = prepare(`EXPLAIN QUERY PLAN WITH scoped AS (${scoped.sql}) SELECT * FROM scoped
    ORDER BY occurred_at DESC,run_id DESC,event_key,category LIMIT ?`).all(...scoped.params, 3) as Array<{ detail: string }>;
  expect(plan.map((row) => row.detail).join("\n")).not.toContain("USE TEMP B-TREE");
  const first = listRuntimeContentEvidence(db, scope, { limit: 3 });
  const last = first.at(-1)!;
  const next = listRuntimeContentEvidence(db, scope, { limit: 3, cursor: { t: last.occurredAt, id: last.id } });
  expect(first.map((row) => [row.runId,row.category])).toEqual([[50,"assistant_output"],[50,"assistant_thought"],[50,"configured_instructions"]]);
  expect(next.map((row) => [row.runId,row.category])).toEqual([[50,"user_prompt"],[49,"assistant_output"],[49,"assistant_thought"]]);
  expect(new Set([...first,...next].map((row) => row.id)).size).toBe(6);
  expect(largest).toBeLessThanOrEqual(3);
  expect(getRuntimeContentEvidence(db, "test", first[0]!.id)).toEqual(first[0]);
  expect(getRuntimeContentEvidence(db, "other", first[0]!.id)).toBeNull();
  expect(getRuntimeContentEvidence(db, "test", "not-an-id")).toBeNull();
  expect(listRuntimeContentEvidence(db, scope, { limit: 3, capabilityKind: "user_prompt", capabilityId: "user_prompt" }).every((row) => row.category === "user_prompt")).toBe(true);
  expect(listRuntimeContentEvidence(db, { ...scope, sessionId: "missing" }, { limit: 3 })).toEqual([]);
  expect(JSON.stringify(first)).not.toContain("private content");
  expect(JSON.stringify(first)).not.toContain("body");
});

it("returns empty evidence for a standalone attribution database without runtime content", () => {
  const db = new Database(":memory:"); dbs.push(db);
  new AttributionStore(new UsageStore(db));
  expect(listRuntimeContentEvidence(db, { namespace: "test" }, { limit: 20 })).toEqual([]);
  expect(getRuntimeContentEvidence(db, "test", "rc1.WzEsIjEiLCJ1c2VyX3Byb21wdCJd")).toBeNull();
});
