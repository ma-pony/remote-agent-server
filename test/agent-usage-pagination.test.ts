import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { UsageStore } from "../src/agent-usage/storage/usage-store.js";
import { AttributionStore } from "../src/agent-usage/storage/attribution-store.js";
import { UsageSourceCoordinator } from "../src/agent-usage/source-coordinator.js";
import { measureToolContent } from "../src/agent-usage/core/tool-content.js";
import { fixtureTokenizers } from "./fixtures/agent-usage/tokenizers/helpers.js";
import type { InvocationInput } from "../src/agent-usage/core/context-types.js";

const dbs: Database.Database[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of dbs.splice(0)) db.close(); });
const setup = () => {
  const db = new Database(":memory:"); dbs.push(db);
  const usage = new UsageStore(db), attribution = new AttributionStore(usage, fixtureTokenizers());
  return { db, usage, attribution, binding: usage.bindSession("test", "agent", "session") };
};
const call = (index: number, overrides: Partial<InvocationInput> = {}): InvocationInput => ({
  invocationId: `call-${index}`, providerEpochId: "epoch", executionId: "run", capability: { kind: "mcp_tool", id: "tool", name: "Tool" },
  startedAt: "2026-09-20T10:00:00Z", endedAt: "2026-09-20T10:00:01Z", status: "succeeded", runtimeKind: "codex",
  sourceId: "runtime", revision: 1, rawResultBytes: index, ...overrides
});

it("limits SQL source rows and loads complete mappings only for the requested page", () => {
  const { usage, db } = setup();
  const sources = new UsageSourceCoordinator(usage, { fixture: { describe: () => ({ usage: "model_request", context: "none", identity: "explicit", version: "1" }), freeze: async () => "0", async *collect() {} } });
  for (let index = 0; index < 42; index++) sources.registerSource({ namespace: "test", sourceKey: `source-${String(index).padStart(2, "0")}`, kind: "fixture", inputRef: {},
    mappings: [{ sourceSessionKey: "one", sessionId: "session", agentId: "agent", providerEpochId: "epoch" }, { sourceSessionKey: "two", sessionId: "other", agentId: "other", providerEpochId: "epoch" }] });
  const original = db.prepare.bind(db); let largest = 0;
  vi.spyOn(db, "prepare").mockImplementation((sql: string) => { const statement = original(sql), all = statement.all.bind(statement); statement.all = (...params: unknown[]) => { const rows = all(...params); largest = Math.max(largest, rows.length); return rows; }; return statement; });
  const page = sources.listSourcesPage("test", { sessionId: "session" }, { page: 3, pageSize: 20 });
  expect(page).toMatchObject({ page: 3, pageSize: 20, total: 42, totalPages: 3 });
  expect(page.items.map((item) => item.sourceKey)).toEqual(["source-40", "source-41"]);
  expect(page.items.every((item) => item.mappings.length === 2)).toBe(true);
  expect(sources.sourceStatusCounts("test", { sessionId: "session" })).toEqual({ idle: 42 });
  expect(largest).toBeLessThanOrEqual(4);
});

it("sorts and pages mixed capability rankings in SQL without materializing invocation histories", () => {
  const { db, attribution, binding } = setup();
  for (let index = 0; index < 500; index++) attribution.observeInvocation(binding, call(index));
  attribution.observeInvocation(binding, call(501, { capability: { kind: "cli", id: "build", name: "Build" }, rawResultBytes: 999 }));
  const original = db.prepare.bind(db); let largest = 0;
  vi.spyOn(db, "prepare").mockImplementation((sql: string) => { const statement = original(sql), all = statement.all.bind(statement); statement.all = (...params: unknown[]) => { const rows = all(...params); largest = Math.max(largest, rows.length); return rows; }; return statement; });
  expect(attribution.rankingsPage({ namespace: "test" }, "all", { sort: "calls", limit: 1, offset: 0 })).toMatchObject({ total: 2, items: [{ calls: 500, rawResultBytesP50: 249, rawResultBytesP95: 474, latencyMsP95: 1000, capability: { id: "tool" } }] });
  expect(attribution.rankingsPage({ namespace: "test" }, "all", { sort: "calls", limit: 1, offset: 1 })).toMatchObject({ total: 2, items: [{ calls: 1, capability: { id: "build" } }] });
  expect(largest).toBeLessThanOrEqual(2);
});

it.each(["compact", "detailed"])("looks up dated context calls by invocation before visiting contexts (%s)", async (path) => {
  const { db, attribution, binding } = setup();
  for (let index = 0; index < 64; index++) {
    attribution.observeInvocation(binding, call(index, { origin: "context", startedAt: null }));
    await attribution.upsertContext(binding, {
      invocationId: `model-${index}`, providerEpochId: "epoch", sourceId: "snapshot", revision: 1,
      occurredAt: "2026-09-21T10:00:00Z", runtimeKind: "codex", model: "gpt-test", coverage: "full", historyComplete: true,
      blocks: [0, 1].map(position => ({ position, kind: "result", toolInvocationId: `call-${index}`,
        content: { identity: `result-${index}-${position}`, modality: "text", text: "visible result" },
        capabilities: [{ capability: call(index).capability, evidence: "direct" }] }))
    });
  }
  if (path === "detailed") db.exec("UPDATE agent_usage_contexts SET ranking_inputs_ready=0");
  type PlanRow = { id: number; parent: number; detail: string };
  const prepare = db.prepare.bind(db), plans: PlanRow[][] = [];
  vi.spyOn(db, "prepare").mockImplementation(sql => {
    const statement = prepare(sql);
    if (sql.includes("e.tool_invocation_id=i.invocation_id")) {
      const all = statement.all.bind(statement);
      statement.all = (...params: unknown[]) => {
        plans.push(prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as PlanRow[]);
        return all(...params);
      };
    }
    return statement;
  });
  const filter = { namespace: "test", from: "2026-09-21T00:00:00Z", to: "2026-09-22T00:00:00Z" };
  expect(attribution.rankingsPage(filter, "all", { sort: "totalInputTokens", limit: 50, offset: 0 }))
    .toMatchObject({ total: 1, items: [{ calls: 0, contextOnlyCalls: 64, exposureCount: 128, totalInputTokens: 256 }] });
  expect(attribution.invocations(filter, "context", { limit: 10 })).toHaveLength(10);
  // Inspect the actual ranking and list statements, without a machine-dependent timing threshold.
  const lookups = plans.flatMap(plan => plan.filter(row => row.detail.startsWith("CORRELATED SCALAR SUBQUERY"))
    .map(subquery => plan.filter(row => row.parent === subquery.id).map(row => row.detail)));
  expect(lookups.length).toBeGreaterThanOrEqual(3);
  for (const lookup of lookups) {
    expect(lookup[0]).toMatch(/^SEARCH e .*\(tool_invocation_id=\?/);
    expect(lookup[1]).toMatch(/^SEARCH c .*\(context_id=\?\)/);
  }
});

it.each(["compact", "detailed"])("preserves dated context-call membership, boundaries and deduplication (%s)", async (path) => {
  const { db, usage, attribution, binding } = setup();
  for (let index = 0; index < 9; index++) attribution.observeInvocation(binding, call(index, {
    origin: "context", startedAt: index === 0 ? null : "2026-09-01T00:00:00Z"
  }));
  attribution.observeInvocation(binding, call(9, {
    startedAt: "2026-09-21T10:00:00Z", endedAt: "2026-09-21T10:00:01Z"
  }));
  const save = (subject: typeof binding, id: string, occurredAt: string | null, calls: number[],
    providerEpochId = "epoch", capability = call(0).capability) => attribution.upsertContext(subject, {
    invocationId: id, providerEpochId, sourceId: "snapshot", revision: 1, occurredAt,
    runtimeKind: "codex", model: "gpt-test", coverage: "full", historyComplete: true,
    blocks: calls.map((index, position) => ({ position, kind: "result", toolInvocationId: `call-${index}`,
      content: { identity: `result-${index}`, modality: "text", text: "visible result" },
      capabilities: [{ capability, evidence: "direct" }] }))
  });
  await save(binding, "before", "2026-09-20T23:59:59.999Z", [2]);
  await save(binding, "from", "2026-09-21T00:00:00Z", [0, 0]);
  await save(binding, "inside", "2026-09-21T12:00:00Z", [0, 1]);
  await save(binding, "to", "2026-09-22T00:00:00Z", [3]);
  await save(binding, "undated", null, [4]);
  await save(usage.bindSession("test", "other-agent", "other-session"), "other-session", "2026-09-21T12:00:00Z", [5]);
  await save(usage.bindSession("other", "agent", "session"), "other-namespace", "2026-09-21T12:00:00Z", [6]);
  await save(binding, "other-epoch", "2026-09-21T12:00:00Z", [7], "other-epoch");
  await save(binding, "other-capability", "2026-09-21T12:00:00Z", [8], "epoch", { kind: "cli", id: "build", name: "Build" });
  if (path === "detailed") db.exec("UPDATE agent_usage_contexts SET ranking_inputs_ready=0");
  const scope = { namespace: "test", agentId: "agent", sessionId: "session", runtimeKind: "codex" };
  const filter = { ...scope, from: "2026-09-21T00:00:00Z", to: "2026-09-22T00:00:00Z" };
  const ids = (range: { from?: string; to?: string }) => attribution.invocations({ ...scope, ...range }, "context")
    .map(row => row.invocationId).sort();
  expect(ids(filter)).toEqual(["call-0", "call-1"]);
  expect(ids({ from: filter.from })).toEqual(["call-0", "call-1", "call-3"]);
  expect(ids({ to: filter.to })).toEqual(["call-0", "call-1", "call-2"]);
  expect(ids({})).toHaveLength(9);
  const ranked = attribution.rankingsPage(filter, "all", { sort: "totalInputTokens", limit: 1, offset: 0 });
  expect(ranked).toMatchObject({ total: 2, items: [{ capability: { id: "tool" }, calls: 1, contextOnlyCalls: 2,
    totalInputTokens: 10, exposureCount: 5, contextCoverage: { full: 3, partial: 0, opaque: 0, none: 0 },
    rawResultBytes: 9, rawResultBytesP95: 9, latencyMsP95: 1000 }] });
  expect(attribution.rankingsPage(filter, "all", { sort: "totalInputTokens", limit: 1, offset: 1 }))
    .toMatchObject({ total: 2, items: [{ capability: { id: "build" }, calls: 0, contextOnlyCalls: 0, totalInputTokens: 2 }] });
  expect(attribution.rankingsPage(filter, "mcp_tool", { sort: "calls", limit: 1, offset: 0 }).items).toEqual(ranked.items);
});


it("paginates invocation and context detail exposures while keeping accurate totals", async () => {
  const { attribution, binding } = setup();
  attribution.observeInvocation(binding, call(1));
  for (let index = 0; index < 24; index++) await attribution.upsertContext(binding, {
    invocationId: `model-${String(index).padStart(2, "0")}`, providerEpochId: "epoch", sourceId: "snapshot", revision: 1,
    occurredAt: new Date(Date.UTC(2026, 8, 20, 11, index)).toISOString(), runtimeKind: "codex", model: "gpt-test", coverage: "full", historyComplete: true,
    blocks: [0, 1, 2].map((position) => ({ position, kind: "result", toolInvocationId: "call-1", content: { identity: `result-${position}`, modality: "text", text: "visible result" }, capabilities: [{ capability: call(1).capability, evidence: "direct" }] }))
  });
  const invocation = attribution.invocations({ namespace: "test" })[0]!;
  const detail = attribution.detail("test", invocation.id, { limit: 20, offset: 20 })!;
  expect(detail.exposureTotal).toBe(72);
  expect(detail.exposures).toHaveLength(20);
  expect(detail.exposures[0]).toMatchObject({ modelInvocationId: "model-06", position: 2 });
  const evidence = attribution.contextEvidence({ namespace: "test" }, { limit: 1 })[0]!;
  expect(attribution.contextEvidenceDetail("test", evidence.id, { limit: 2, offset: 2 })).toMatchObject({ exposureTotal: 3, context: { exposureCount: 3 }, exposures: [{ position: 2 }] });
  expect(attribution.contextEvidenceDetail("test", evidence.id, { limit: 2, offset: 10 })).toMatchObject({ exposureTotal: 3, context: { exposureCount: 3 }, exposures: [] });
});


it("preserves ranking metrics and sort order for every page with mixed execution and context evidence", async () => {
  const { attribution, binding } = setup();
  for (let index = 0; index < 8; index++) {
    const capability = { kind: index % 2 ? "cli" as const : "mcp_tool" as const, id: `cap-${index}`, name: `Capability ${index}` };
    for (let count = 0; count <= index; count++) attribution.observeInvocation(binding, call(index * 10 + count, {
      capability, status: count % 2 ? "tool_error" : "succeeded", endedAt: `2026-09-20T10:00:0${index}Z`,
      argumentEstimate: await measureToolContent("argument ".repeat(index + 1), "arguments"),
      resultEstimate: await measureToolContent("result ".repeat(8 - index), "result")
    }));
    for (let repeat = 0; repeat < 3; repeat++) await attribution.upsertContext(binding, {
      invocationId: `model-${index}-${repeat}`, providerEpochId: "epoch", sourceId: "snapshot", revision: 1,
      occurredAt: new Date(Date.UTC(2026, 8, 20, 11, repeat)).toISOString(), runtimeKind: "codex", model: "gpt-test", coverage: "full", historyComplete: true,
      blocks: [{ position: 0, kind: "definition", content: { identity: `definition-${index}`, modality: "text", text: "tool definition ".repeat(index + 1) }, capabilities: [{ capability, evidence: "direct" }] },
        { position: 1, kind: "result", toolInvocationId: `call-${index * 10}`, content: { identity: `result-${index}`, modality: "text", text: "visible result ".repeat(8 - index) }, capabilities: [{ capability, evidence: "direct" }] },
        { position: 2, kind: "user_message", content: { identity: "message", modality: "text", text: "user message context" }, capabilities: [{ capability: { kind: "unknown", id: "message", name: "Message" }, evidence: "direct" }] }]
    });
  }
  for (const filter of [{ namespace: "test" }, { namespace: "test", from: "2026-09-20T11:01:00Z", runtimeKind: "codex" }]) {
    const all = attribution.rankings(filter, "all");
    expect(all.map((row) => row.capability.id)).toContain("message");
    for (const sort of ["observedTotalTokens", "observedArgumentTokens", "observedResultTokens", "totalInputTokens", "inputBytes", "calls", "definitionInputTokens", "firstResultInputTokens", "repeatedResultInputTokens", "failures", "latencyMsP95"] as const) {
      const expected = [...all].sort((a, b) => (b[sort] ?? -1) - (a[sort] ?? -1) || a.capability.id.localeCompare(b.capability.id));
      const result = attribution.rankingsPage(filter, "all", { sort, limit: 3, offset: 3 });
      expect(result.total).toBe(9);
      expect(result.items).toEqual(expected.slice(3, 6));
    }
  }
});
