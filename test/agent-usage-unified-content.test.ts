import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { UsageStore } from "../src/agent-usage/storage/usage-store.js";
import { AttributionStore } from "../src/agent-usage/storage/attribution-store.js";
import { RuntimeConversationCollector } from "../src/agent-usage/runtime-conversation.js";
import { measureToolContent } from "../src/agent-usage/core/tool-content.js";
import { contentCapability } from "../src/agent-usage/core/context-types.js";

const dbs: Database.Database[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of dbs.splice(0)) db.close(); });
const setup = () => {
  const db = new Database(":memory:"); dbs.push(db);
  const usage = new UsageStore(db), attribution = new AttributionStore(usage);
  new RuntimeConversationCollector(usage, attribution, "test");
  const binding = usage.bindSession("test", "agent", "session");
  const content = async (category: string, tokens: number | null, event = "1", namespace = "test") => db.prepare(`INSERT INTO agent_usage_conversation_content (namespace,session_id,agent_id,run_id,event_key,category,occurred_at,runtime_kind,tokens,bytes,partial,estimate_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(namespace, "session", "agent", 1, event, category, "2026-09-22T01:00:00.000Z", "codex", tokens, 100, Number(tokens === null), JSON.stringify((await measureToolContent("sample", "result"))!.estimate));
  return { db, usage, attribution, binding, content };
};

it("ranks prompts, conversations and tools together without inventing tool calls", async () => {
  const { db, attribution, binding, content } = setup();
  await content("configured_instructions", 30); await content("user_prompt", 60);
  await content("assistant_output", 90); await content("assistant_output", null, "2"); await content("assistant_thought", 10);
  await content("user_prompt", 999, "other", "other");
  attribution.observeInvocation(binding, { invocationId: "tool", providerEpochId: "epoch", executionId: "run", capability: { kind: "cli", id: "build", name: "Build" }, startedAt: "2026-09-22T01:00:00.000Z", endedAt: null, status: "running", sourceId: "runtime", revision: 1, rawResultBytes: null, argumentEstimate: { ...await measureToolContent("args", "arguments")!, tokens: 20 } });
  const filter = { namespace: "test", sessionId: "session", agentId: "agent", runtimeKind: undefined };
  const prepare = vi.spyOn(db, "prepare");
  const page = attribution.rankingsPage(filter, "all", { sort: "observedTotalTokens", limit: 2, offset: 0 });
  expect(prepare.mock.calls.filter(([sql]) => sql.includes("FROM agent_usage_conversation_content"))).toHaveLength(1);
  expect(page).toMatchObject({ total: 5, items: [
    { capability: { kind: "assistant_output", id: "assistant_output" }, observedResultTokens: 90, observedArgumentTokens: null, calls: 0, contentObservations: 2, observedResultCalls: 0, totalInputTokens: null },
    { capability: { kind: "user_prompt", id: "user_prompt" }, observedArgumentTokens: 60, calls: 0, contentObservations: 1, observedArgumentCalls: 0 }
  ] });
  expect(attribution.rankingsPage(filter, "all", { sort: "observedTotalTokens", limit: 2, offset: 2 }).items.map((row) => row.capability.id)).toEqual(["configured_instructions", "build"]);
  expect(attribution.rankings(filter, "cli")[0]).toMatchObject({ calls: 1, contentObservations: 0 });
  expect(attribution.rankingsPage({ ...filter, sessionId: "missing" }, "all", { sort: "observedTotalTokens", limit: 20, offset: 0 })).toEqual({ total: 0, items: [] });
  expect(attribution.rankings({ ...filter, from: "2026-09-22T01:00:01Z" }, "user_prompt")).toEqual([]);
  expect(attribution.rankings({ ...filter, from: "2026-09-22T01:00:00Z", to: "2026-09-22T01:00:01Z" }, "user_prompt")).toHaveLength(1);
});

it("combines model-input exposure evidence under the same content capability while keeping the two measurements distinct", async () => {
  const { attribution, binding, content } = setup();
  await content("user_prompt", 60);
  await attribution.upsertContext(binding, { invocationId: "request", providerEpochId: "epoch", sourceId: "snapshot", revision: 1, occurredAt: "2026-09-22T01:00:00Z", runtimeKind: "codex", model: null, coverage: "full", historyComplete: true,
    blocks: [{ position: 0, kind: "user_message", content: { identity: "prompt", modality: "text", text: "snapshot prompt" }, capabilities: [{ capability: contentCapability("user_prompt")!, evidence: "direct" }] }] });
  const page = attribution.rankingsPage({ namespace: "test" }, "user_prompt", { sort: "totalInputTokens", limit: 20, offset: 0 });
  expect(page.total).toBe(1);
  expect(page.items[0]).toMatchObject({ capability: { kind: "user_prompt", id: "user_prompt" }, observedArgumentTokens: 60, contentObservations: 1, exposureCount: 1, calls: 0 });
  expect(page.items[0]!.totalInputTokens).toBeGreaterThan(0);
});

it("aggregates compacted and legacy content before resolving estimate profiles", async () => {
  const { db, attribution, content } = setup();
  await content("user_prompt", 30);
  await content("user_prompt", 40, "2");
  const { estimate_json: estimateJson } = db.prepare(`SELECT estimate_json FROM agent_usage_conversation_content
    WHERE namespace='test' AND event_key='1'`).get() as { estimate_json: string };
  db.prepare("INSERT OR IGNORE INTO agent_usage_token_estimates(estimate_json) VALUES(?)").run(estimateJson);
  db.prepare(`UPDATE agent_usage_conversation_content SET estimate_id=(SELECT id FROM agent_usage_token_estimates WHERE estimate_json=?),estimate_json=''
    WHERE namespace='test' AND event_key='1'`).run(estimateJson);

  const page = attribution.rankingsPage({ namespace: "test" }, "user_prompt",
    { sort: "observedTotalTokens", limit: 20, offset: 0 });
  expect(page.items[0]).toMatchObject({ observedArgumentTokens: 70, contentObservations: 2 });
  expect(page.items[0]?.payloadEstimates).toHaveLength(1);
});

it("marks content-only Runs ready while retaining namespace, session, agent, runtime and date scope", async () => {
  const { attribution, content } = setup();
  await content("user_prompt", 60);
  expect(attribution.hasEvidence({ namespace: "test", sessionId: "session", agentId: "agent", runtimeKind: "codex", from: "2026-09-22T01:00:00Z" })).toBe(true);
  for (const filter of [{ namespace: "other" }, { namespace: "test", sessionId: "missing" },
    { namespace: "test", agentId: "missing" }, { namespace: "test", runtimeKind: "claude" },
    { namespace: "test", from: "2026-09-22T01:00:01Z" }]) expect(attribution.hasEvidence(filter)).toBe(false);
});
