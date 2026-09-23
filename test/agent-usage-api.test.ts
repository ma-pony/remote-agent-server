import { fixtureTokenizerConfig } from "./fixtures/agent-usage/tokenizers/helpers.js";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ManagedUsageSources } from "../src/agent-usage/managed-sources.js";
import { parseProviderLog } from "../src/agent-usage/adapters/provider-logs.js";
import type { Capability, InvocationInput, ModelContextInput } from "../src/agent-usage/core/context-types.js";
import type { UsageBinding, UsageObservation } from "../src/agent-usage/core/types.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { SessionCleanupSchedulerLike } from "../src/sessions/session-cleanup-scheduler.js";
import { createFakeRuntime, createTestDatabase } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

const headers = { authorization: "Bearer test-token" };
const providerFixture = (name: string): string[] => readFileSync(
  fileURLToPath(new URL(`./fixtures/agent-usage/provider-logs/${name}`, import.meta.url)),
  "utf8"
).trimEnd().split("\n");
const setup = async (sessionCleanupScheduler: SessionCleanupSchedulerLike = {
  start() {}, stop() {}, async runCleanup() {}
}, fileBacked = false) => {
  const root = await mkdtemp(join(tmpdir(), "usage-query-api-"));
  const databasePath = fileBacked ? join(root, "usage.sqlite") : ":memory:";
  const { db, seed } = createTestDatabase(databasePath);
  const first = seed.session();
  const second = seed.session();
  const unbound = seed.session();
  const now = "2026-08-12T00:00:00.000Z";
  const otherAgentId = Number(db.prepare(`INSERT INTO agents
    (name, provider, project_environment_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run("Other agent", "claude_code", seed.projectEnvironment.id, now, now).lastInsertRowid);
  const otherSessionId = Number(db.prepare(`INSERT INTO sessions
    (agent_id, title, status, workspace_path, created_at, updated_at) VALUES (?, ?, 'idle', ?, ?, ?)`)
    .run(otherAgentId, "Other session", join(root, "other-session"), now, now).lastInsertRowid);
  const config = loadConfig({
    API_TOKEN: "test-token",
    DATA_DIR: root,
    DATABASE_PATH: databasePath,
    PROJECT_ENVIRONMENTS_ROOT: join(root, "environments"),
    SESSIONS_ROOT: join(root, "sessions"),
    SESSION_RETENTION_HOURS: "0"
  });
  const manager = new ManagedUsageSources(db, config);
  const app = buildApp({
    db,
    config,
    runtime: createFakeRuntime(),
    usageSources: manager,
    sessionCleanupScheduler
  });
  cleanups.push(async () => { await app.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  await app.ready();
  return {
    app,
    db,
    manager,
    ids: {
      unboundSession: String(unbound.id),
      firstAgent: String(seed.agent.id),
      otherAgent: String(otherAgentId)
    },
    bindings: {
      first: manager.collector.binding(first.id),
      second: manager.collector.binding(second.id),
      other: manager.collector.binding(otherSessionId)
    }
  };
};

const get = (app: FastifyInstance, path: string) => app.inject({ method: "GET", url: `/api/usage${path}`, headers });

it("serves status while a file-backed ranking runs in the query worker", async () => {
  const { app, manager } = await setup(undefined, true);
  await manager.collector.stopRecovery();
  const mainQuery = vi.spyOn(manager.collector.attribution, "rankingsPage")
    .mockImplementation(() => { throw new Error("Query ran on the HTTP thread"); });
  try {
    let completed = false;
    const ranking = get(app, "/capabilities").then(response => { completed = true; return response; });
    const status = await get(app, "/status");
    expect(status.statusCode).toBe(200);
    expect(completed).toBe(false);
    expect((await ranking).statusCode).toBe(200);
    expect(mainQuery).not.toHaveBeenCalled();
  } finally { mainQuery.mockRestore(); }
});

it("shares summary and trend accounting and polls status without rerunning historical queries", async () => {
  const { app, manager, bindings } = await setup();
  await manager.collector.stopRecovery();
  observe(manager, bindings.first, { id: "one", at: "2026-09-20T00:00:00Z", total: 30 });
  const records = vi.spyOn(manager.collector.store, "records");
  const rankings = vi.spyOn(manager.collector.attribution, "rankingsPage");
  const first = (await get(app, "/summary")).json();
  expect(first.usage.totalTokens).toBe(30);
  expect((await get(app, "/timeseries")).json().items[0].usage.totalTokens).toBe(30);
  expect(records).toHaveBeenCalledTimes(1);
  await get(app, "/capabilities"); await get(app, "/capabilities");
  expect(rankings).toHaveBeenCalledTimes(1);
  for (let count = 0; count < 3; count++) {
    const status = (await get(app, "/status")).json();
    expect(status.revision).toBe(first.revision);
    expect(status).not.toHaveProperty("usage");
    expect(status.recovery).toMatchObject({ phase: "stopped", pendingSources: 0 });
    expect(status.eventRetention).toMatchObject({ enabled: true, checkedRuns: 0, retiredEvents: 0 });
  }
  manager.collector.eventRetention.step();
  expect((await get(app, "/status")).json().eventRetention).toMatchObject({ lastAction: "idle",
    lastStepAt: expect.any(String), nextSweepAt: expect.any(String) });
  expect(records).toHaveBeenCalledTimes(1); expect(rankings).toHaveBeenCalledTimes(1);
  observe(manager, bindings.first, { id: "two", at: "2026-09-20T01:00:00Z", total: 40 });
  expect((await get(app, "/status")).json().revision).not.toBe(first.revision);
  expect((await get(app, "/summary")).json().usage.totalTokens).toBe(70);
  expect((await get(app, "/timeseries")).json().items[0].usage.totalTokens).toBe(70);
  expect(records).toHaveBeenCalledTimes(2);
  expect((await app.inject({ url: "/api/usage/status" })).statusCode).toBe(401);
  expect((await get(app, "/status?sessionId=0")).statusCode).toBe(400);
  records.mockRestore(); rankings.mockRestore();
});

const observe = (
  manager: ManagedUsageSources,
  binding: UsageBinding,
  input: { id: string; at: string | null; total: number; scope?: UsageObservation["scope"]; runtime?: string; epoch?: string }
) => manager.collector.store.observe(binding, {
  eventId: input.id,
  sourceId: "synthetic",
  sourceVersion: "1",
  scope: input.scope ?? "model_request",
  semantics: input.scope === "provider_session" ? "cumulative" : "delta",
  coverageId: input.id,
  invocationId: input.scope === "provider_session" ? null : input.id,
  executionId: input.scope === "provider_session" ? null : input.id,
  providerEpochId: input.epoch ?? "epoch-1",
  occurredAt: input.at,
  finality: "final",
  revision: 1,
  measurement: "reported",
  normalizationProfile: "synthetic-v1",
  runtimeKind: input.runtime ?? "codex",
  metrics: { inputTotalTokens: input.total - 10, outputTotalTokens: 10, totalTokens: input.total }
});

it("batches paged Session totals from the same ledger as Agent and Session summaries", async () => {
  const { app, manager, bindings, ids } = await setup(undefined, true);
  await manager.collector.stopRecovery();
  observe(manager, bindings.first, { id: "one", at: "2026-09-20T00:00:00Z", total: 30 });
  observe(manager, bindings.second, { id: "two", at: "2026-09-20T00:01:00Z", total: 50 });
  observe(manager, bindings.other, { id: "other", at: "2026-09-20T00:02:00Z", total: 70 });
  const requested = [bindings.first.sessionId, bindings.second.sessionId, ids.unboundSession];
  const response = await get(app, `/session-summaries?ids=${requested.join(",")}`);
  expect(response.statusCode).toBe(200);
  const rows = response.json().items as Array<{ sessionId: string; summary: { usage: { totalTokens: number | null } } }>;
  expect(rows.map((row) => [row.sessionId, row.summary.usage.totalTokens])).toEqual([
    [bindings.first.sessionId, 30], [bindings.second.sessionId, 50], [ids.unboundSession, null]
  ]);
  expect((await get(app, `/summary?agentId=${ids.firstAgent}`)).json().usage.totalTokens).toBe(80);
  expect((await get(app, `/summary?sessionId=${bindings.first.sessionId}`)).json().usage.totalTokens).toBe(30);
  expect((await get(app, "/session-summaries?ids=0")).statusCode).toBe(400);
});

const invocation = (
  id: string,
  capability: Capability,
  startedAt: string,
  runtimeKind = "codex"
): InvocationInput => ({
  invocationId: id,
  providerEpochId: "epoch-1",
  executionId: `run-${id}`,
  capability,
  startedAt,
  endedAt: new Date(Date.parse(startedAt) + 50).toISOString(),
  status: "succeeded",
  runtimeKind,
  executionEvidence: "direct",
  origin: "execution",
  sourceId: "synthetic-runtime",
  revision: 1,
  rawResultBytes: 64
});

describe("usage query API", () => {
  it.each(["2026-09-21T10:00:00Z", null])("paginates every same-timestamp model input exactly once with opaque evidence IDs (%s)", async (occurredAt) => {
    const { app, manager, bindings } = await setup();
    const capability: Capability = { id: "review", name: "Review", kind: "skill" };
    for (let index = 0; index < 32; index += 1) {
      await manager.collector.attribution.upsertContext(bindings.first, {
        invocationId: `r${index}`, occurredAt, providerEpochId: "epoch-1", sourceId: "fixture", revision: 1,
        runtimeKind: "claude_code", model: "fixture", coverage: "full", historyComplete: true,
        blocks: [{ position: 0, kind: "skill", toolInvocationId: null,
          content: { identity: `content-${index}`, modality: "text", text: "fixture" },
          capabilities: [{ capability, evidence: "direct" }] }]
      });
    }
    const base = "/context-evidence?capabilityId=review&capabilityKind=skill";
    const all = (await get(app, base)).json().items as Array<{ id: string; modelInvocationId: string }>;
    const expected = all.map((item) => item.id).sort();
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await get(app, `${base}&limit=1${cursor === null ? "" : `&cursor=${cursor}`}`);
      expect(response.statusCode).toBe(200);
      const page = response.json();
      seen.push(...page.items.map((item: { id: string }) => item.id));
      cursor = page.nextCursor;
      expect(seen.length).toBeLessThanOrEqual(32);
    } while (cursor !== null);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(32);
  });

  it("exposes tagged, unused-definition and unattributed model input without inventing calls", async () => {
    const { app, manager, bindings } = await setup();
    const capabilities: Capability[] = [
      { id: "review", name: "Review", kind: "skill" },
      { id: "review", name: "Review plugin", kind: "plugin" },
      { id: "unused", name: "Unused", kind: "mcp_tool", serverId: "7" },
      { id: "unattributed", name: "Unattributed", kind: "unknown" }
    ];
    for (const [invocationId, occurredAt] of [["old-request", "2026-09-20T10:00:00Z"], ["new-request", "2026-09-21T10:00:00Z"]]) {
      await manager.collector.attribution.upsertContext(bindings.first, {
        invocationId: invocationId!, occurredAt: occurredAt!, providerEpochId: "epoch-1", sourceId: "fixture", revision: 1,
        runtimeKind: "claude_code", model: "fixture", coverage: "full", historyComplete: true,
        blocks: capabilities.map((capability, position) => ({ position,
          kind: position === 2 ? "definition" : position === 3 ? "other" : "result",
          toolInvocationId: position < 2 ? "original-tool-call" : null,
          content: { identity: `content-${position}`, modality: "text", text: "private fixture body" },
          capabilities: [{ capability, evidence: "direct" }] }))
      });
    }
    for (const capability of capabilities) {
      const query = `capabilityId=${capability.id}&capabilityKind=${capability.kind}&from=2026-09-21T00:00:00Z`;
      const response = await get(app, `/context-evidence?${query}`);
      expect(response.statusCode).toBe(200);
      const items = response.json().items;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ modelInvocationId: "new-request", capability, exposureCount: 1 });
      const detail = await get(app, `/context-evidence/${items[0].id}`);
      expect(detail.statusCode).toBe(200);
      expect(detail.json().exposures[0]).toMatchObject({ modelInvocationId: "new-request",
        toolInvocationId: ["skill", "plugin"].includes(capability.kind) ? "original-tool-call" : null,
        resultFirstUse: ["skill", "plugin"].includes(capability.kind) ? "repeat" : null });
      expect(detail.body).not.toContain("private fixture body");
      const rankings = (await get(app, `/capabilities?dimension=${capability.kind}`)).json();
      expect(rankings.items[0]).toMatchObject({ calls: 0, contextOnlyCalls: 0 });
      expect((await get(app, `/invocations?origin=context&capabilityId=${capability.id}`)).json().items).toEqual([]);
      expect((await get(app, `/context-evidence?${query}`)).json().items[0].id).toBe(items[0].id);
      const firstPage = (await get(app, `/context-evidence?capabilityId=${capability.id}&capabilityKind=${capability.kind}&limit=1`)).json();
      expect(firstPage.items[0].modelInvocationId).toBe("new-request");
      expect(firstPage.nextCursor).toEqual(expect.any(String));
      const nextPage = (await get(app, `/context-evidence?capabilityId=${capability.id}&capabilityKind=${capability.kind}&limit=1&cursor=${firstPage.nextCursor}`)).json();
      expect(nextPage.items.map((item: { modelInvocationId: string }) => item.modelInvocationId)).toEqual(["old-request"]);
      expect(nextPage.nextCursor).toBeNull();
      expect((await get(app, `/context-evidence?${query}&sessionId=${bindings.second.sessionId}`)).json().items).toEqual([]);
      expect((await get(app, `/context-evidence?${query}&runtimeKind=codex`)).json().items).toEqual([]);

    }
    expect((await get(app, "/context-evidence/invalid")).statusCode).toBe(404);
    expect((await get(app, "/context-evidence?cursor=invalid")).statusCode).toBe(400);
    expect((await get(app, "/context-evidence?capabilityKind=invalid")).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/usage/context-evidence" })).statusCode).toBe(401);
  });

  it("does not assign cumulative intervals across a requested boundary or local calendar day", async () => {
    const { app, manager, bindings } = await setup();
    const parsed = parseProviderLog("codex_log", providerFixture("codex-token-count.jsonl"));
    const base = parsed.at(-1)!.observation;
    manager.collector.store.observe(bindings.first, { ...base, eventId: "interval", scope: "interval",
      occurredAt: "2026-09-21T16:01:00Z", intervalStart: "2026-09-21T15:59:00Z" });
    const series = (await get(app, "/timeseries?timezone=Asia%2FSingapore")).json();
    expect(series.items).toEqual([]);
    const partial = (await get(app, "/timeseries?from=2026-09-21T16%3A00%3A00Z")).json();
    expect(partial.items).toEqual([]);
    expect(partial.unplacedUsage.totalTokens).toBe(70);
    const summary = (await get(app, "/summary?from=2026-09-21T16%3A00%3A00Z&to=2026-09-22T16%3A00%3A00Z")).json();
    expect(summary).toMatchObject({ usage: { totalTokens: null }, unplacedUsage: { totalTokens: 70 }, completeness: "partial" });
    manager.collector.store.observe(bindings.first, { ...base, eventId: "parent", scope: "provider_session", intervalStart: undefined,
      coverageId: "parent", occurredAt: null, semantics: "cumulative", metrics: { totalTokens: 190 } });
    const crossing = "/summary?from=2026-09-21T16%3A00%3A00Z&to=2026-09-22T16%3A00%3A00Z";
    expect((await get(app, crossing)).json().unplacedUsage.totalTokens).toBe(190);
    expect((await get(app, crossing.replace("summary", "timeseries"))).json().unplacedUsage.totalTokens).toBe(190);
    expect((await get(app, "/summary?from=2026-09-23T00%3A00%3A00Z")).json().unplacedUsage.totalTokens).toBe(120);
  });

  it("requires management authentication and rejects invalid filters", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "GET", url: "/api/usage/summary" })).statusCode).toBe(401);
    for (const path of [
      "/summary?unknown=value",
      "/summary?agentId=0",
      "/summary?timezone=Mars%2FOlympus",
      "/summary?from=2026-03-01T00%3A00%3A00Z&to=2026-03-01T00%3A00%3A00Z",
      "/capabilities?limit=0",
      "/invocations?origin=unknown",
      "/invocations?cursor=not-a-cursor"
    ]) {
      const response = await get(app, path);
      expect(response.statusCode, path).toBe(400);
      expect(response.json()).toEqual({ error: { code: "invalid_request", message: expect.any(String) } });
    }
  });

  it("returns a read-only provider epoch for a valid empty Session", async () => {
    const { app, db, ids } = await setup();
    const subjectCount = () => (db.prepare(`SELECT COUNT(*) AS count FROM agent_usage_subjects
      WHERE namespace = 'remote-agent-server' AND kind = 'session' AND subject_id = ?`)
      .get(ids.unboundSession) as { count: number }).count;
    expect(subjectCount()).toBe(0);

    const valid = await get(app, `/summary?sessionId=${ids.unboundSession}`);
    expect(valid.json()).toMatchObject({
      providerEpochId: `session:${ids.unboundSession}:epoch:1`,
      completeness: "none",
      analysisStatus: "empty",
      usage: { totalTokens: null }
    });
    expect(subjectCount()).toBe(0);

    expect((await get(app,
      `/summary?sessionId=${ids.unboundSession}&agentId=${ids.otherAgent}`)).json().providerEpochId).toBeNull();
    expect((await get(app, "/summary?sessionId=999999999")).json()).toMatchObject({
      providerEpochId: null,
      completeness: "none",
      analysisStatus: "empty"
    });
  });

  it("waits for cleanup shutdown before closing usage sources", async () => {
    let release!: () => void;
    let stopStarted!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const stopping = new Promise<void>((resolve) => { stopStarted = resolve; });
    let cleanupStopped = false;
    const { app, manager } = await setup({
      start() {},
      async runCleanup() {},
      async stop() {
        stopStarted();
        await blocked;
        cleanupStopped = true;
      }
    });
    const closeSources = vi.spyOn(manager.collector.sources, "close");

    const closing = app.close();
    await stopping;
    expect(closeSources).not.toHaveBeenCalled();
    release();
    await closing;

    expect(cleanupStopped).toBe(true);
    expect(closeSources).toHaveBeenCalledTimes(1);
  });

  it("uses a half-open date range and keeps unplaced provider totals separate from located requests", async () => {
    const { app, manager, bindings } = await setup();
    observe(manager, bindings.first, { id: "range", at: null, total: 500, scope: "provider_session" });
    observe(manager, bindings.first, { id: "before-dst", at: "2026-03-08T06:59:00Z", total: 100 });
    observe(manager, bindings.first, { id: "after-dst", at: "2026-03-08T07:01:00Z", total: 150 });
    observe(manager, bindings.first, { id: "at-to", at: "2026-03-09T04:00:00Z", total: 50 });
    const query = `?sessionId=${bindings.first.sessionId}&from=2026-03-08T05%3A00%3A00Z&to=2026-03-09T04%3A00%3A00Z&timezone=America%2FNew_York`;

    const summary = await get(app, `/summary${query}`);
    expect(summary.statusCode).toBe(200);
    expect(summary.json()).toMatchObject({
      timezone: "America/New_York",
      bodyStatus: "not_retained",
      usage: { totalTokens: 250 },
      locatedUsage: { totalTokens: 250 },
      unplacedUsage: { totalTokens: 200 },
      observedModelRequests: 2
    });

    const series = await get(app, `/timeseries${query}&bucket=day`);
    expect(series.json()).toMatchObject({
      bucket: "day",
      items: [{ period: "2026-03-08", usage: { totalTokens: 250 }, observedRanges: 2 }],
      unplacedUsage: { totalTokens: 200 }
    });
    const all = await get(app, `/summary?sessionId=${bindings.first.sessionId}`);
    expect(all.json()).toMatchObject({
      usage: { totalTokens: 500 },
      locatedUsage: { totalTokens: 300 },
      unplacedUsage: { totalTokens: 200 }
    });
    expect(summary.body).not.toContain("canonical_request_body");
  });

  it("buckets IANA-local days, Monday weeks and months across calendar boundaries", async () => {
    const { app, manager, bindings } = await setup();
    observe(manager, bindings.first, { id: "feb-local", at: "2026-03-01T04:30:00Z", total: 10 });
    observe(manager, bindings.first, { id: "march-local", at: "2026-03-01T05:30:00Z", total: 20 });
    observe(manager, bindings.first, { id: "dst-before", at: "2026-03-08T06:59:00Z", total: 30 });
    observe(manager, bindings.first, { id: "dst-after", at: "2026-03-08T07:01:00Z", total: 40 });
    const base = `?sessionId=${bindings.first.sessionId}&timezone=America%2FNew_York`;

    expect((await get(app, `/timeseries${base}&bucket=day`)).json().items.map((item: { period: string; usage: { totalTokens: number } }) =>
      [item.period, item.usage.totalTokens])).toEqual([
      ["2026-02-28", 10], ["2026-03-01", 20], ["2026-03-08", 70]
    ]);
    expect((await get(app, `/timeseries${base}&bucket=week`)).json().items.map((item: { period: string; usage: { totalTokens: number } }) =>
      [item.period, item.usage.totalTokens])).toEqual([
      ["2026-02-23", 30], ["2026-03-02", 70]
    ]);
    expect((await get(app, `/timeseries${base}&bucket=month`)).json().items.map((item: { period: string; usage: { totalTokens: number } }) =>
      [item.period, item.usage.totalTokens])).toEqual([
      ["2026-02", 10], ["2026-03", 90]
    ]);
  });

  it("scopes summary queries by Agent, Session and Runtime", async () => {
    const { app, manager, bindings } = await setup();
    observe(manager, bindings.first, { id: "first", at: "2026-09-21T01:00:00Z", total: 100, runtime: "codex" });
    observe(manager, bindings.second, { id: "second", at: "2026-09-21T02:00:00Z", total: 70, runtime: "claude_code" });
    observe(manager, bindings.other, { id: "other", at: "2026-09-21T03:00:00Z", total: 900, runtime: "claude_code" });

    expect((await get(app, `/summary?agentId=${bindings.first.agentId}`)).json().usage.totalTokens).toBe(170);
    expect((await get(app, `/summary?sessionId=${bindings.second.sessionId}`)).json().usage.totalTokens).toBe(70);
    expect((await get(app, `/summary?agentId=${bindings.first.agentId}&runtimeKind=claude_code`)).json().usage.totalTokens).toBe(70);
    expect((await get(app, `/summary?agentId=${bindings.other.agentId}&runtimeKind=codex`)).json().usage.totalTokens).toBeNull();
  });

  it("joins Claude log usage and host capability calls under the canonical Runtime filter", async () => {
    const { app, db, manager, bindings } = await setup();
    for (const { observation } of parseProviderLog("claude_log", providerFixture("claude-assistant-usage.jsonl"))) {
      manager.collector.store.observe(bindings.other, observation);
    }
    const runId = Number(db.prepare(
      "INSERT INTO runs (session_id, status, input, created_at) VALUES (?, 'running', ?, ?)"
    ).run(Number(bindings.other.sessionId), "test", "2026-09-21T00:00:00.000Z").lastInsertRowid);
    await manager.collector.runtimeCapabilities.recordTool(runId, {
      toolCallId: "claude-read", kind: "read", status: "completed", rawInput: { path: "README.md" }
    });
    const filter = `sessionId=${bindings.other.sessionId}&runtimeKind=claude_code`;

    expect((await get(app, `/summary?${filter}`)).json()).toMatchObject({
      observedModelRequests: 2,
      usage: { totalTokens: 368 }
    });
    expect((await get(app, `/capabilities?${filter}&dimension=builtin_tool&sort=calls`)).json()).toMatchObject({
      total: 1,
      items: [{ capability: { id: "runtime:claude_code:builtin:read" }, calls: 1 }]
    });
  });

  it("keeps same-named MCP tools distinct, preserves null estimates and paginates ranked calls and invocations", async () => {
    const { app, manager, bindings } = await setup();
    const serverOne: Capability = { id: "search", kind: "mcp_tool", name: "search", serverId: "server-1" };
    const serverTwo: Capability = { id: "search", kind: "mcp_tool", name: "search", serverId: "server-2" };
    const unused: Capability = { id: "mcp:server-3:unused", kind: "mcp_tool", name: "unused", serverId: "server-3" };
    const rows = [
      invocation("one-1", serverOne, "2026-09-21T03:00:00Z"),
      invocation("one-2", serverOne, "2026-09-21T02:00:00Z"),
      invocation("one-3", serverOne, "2026-09-21T01:00:00Z"),
      invocation("two-1", serverTwo, "2026-09-21T02:30:00Z"),
      invocation("two-2", serverTwo, "2026-09-21T01:30:00Z"),
      invocation("unused-1", unused, "2026-09-21T00:30:00Z")
    ];
    for (const row of rows) manager.collector.attribution.observeInvocation(bindings.first, row);
    manager.collector.attribution.observeInvocation(bindings.second,
      invocation("other-runtime", serverTwo, "2026-09-21T04:00:00Z", "claude_code"));
    manager.collector.attribution.observeInvocation(bindings.first, {
      ...invocation("snapshot-call", serverOne, "2026-09-21T03:00:30Z"),
      startedAt: null,
      endedAt: null,
      executionId: null,
      origin: "context",
      executionEvidence: "unknown",
      sourceId: "context-snapshot"
    });
    const context: ModelContextInput = {
      invocationId: "model-1",
      providerEpochId: "epoch-1",
      sourceId: "context-snapshot",
      revision: 1,
      occurredAt: "2026-09-21T03:01:00Z",
      runtimeKind: "codex",
      model: "synthetic-model",
      coverage: "full",
      historyComplete: true,
      blocks: [{
        position: 0,
        kind: "result",
        toolInvocationId: "snapshot-call",
        content: { identity: "result-1", modality: "text", text: "synthetic private body must stay hidden" },
        capabilities: [{ capability: serverOne, evidence: "direct" }]
      }]
    };
    await manager.collector.attribution.upsertContext(bindings.first, context);

    const ranking = await get(app, `/capabilities?sessionId=${bindings.first.sessionId}&dimension=mcp_tool&sort=calls`);
    expect(ranking.json().items.map((item: { capability: Capability; calls: number }) =>
      [item.capability.id, item.capability.serverId, item.capability.name, item.calls])).toEqual([
      [serverOne.id, "server-1", "search", 3], [serverTwo.id, "server-2", "search", 2], [unused.id, "server-3", "unused", 1]
    ]);
    expect(ranking.json().items.find((item: { capability: Capability }) => item.capability.id === unused.id)).toMatchObject({
      definitionInputTokens: null,
      firstResultInputTokens: null,
      totalInputTokens: null,
      estimateCompleteness: "none"
    });
    expect(ranking.body).not.toContain("synthetic private body");
    const argumentSort = await get(app,
      `/capabilities?sessionId=${bindings.first.sessionId}&dimension=mcp_tool&sort=argumentInputTokens`);
    expect(argumentSort.statusCode).toBe(200);
    expect(argumentSort.json()).toMatchObject({ sort: "argumentInputTokens", total: 3 });

    const offset = await get(app,
      `/capabilities?sessionId=${bindings.first.sessionId}&dimension=mcp_tool&sort=calls&offset=1&limit=1`);
    expect(offset.json()).toMatchObject({ total: 3, items: [{ capability: { id: serverTwo.id }, calls: 2 }] });
    const runtime = await get(app, `/capabilities?sessionId=${bindings.second.sessionId}&runtimeKind=claude_code&sort=calls`);
    expect(runtime.json().items).toEqual([expect.objectContaining({ capability: expect.objectContaining({ id: serverTwo.id }), calls: 1 })]);

    const bounded = "from=2026-09-21T03%3A00%3A00Z&to=2026-09-21T03%3A02%3A00Z";
    const boundedRanking = await get(app,
      `/capabilities?sessionId=${bindings.first.sessionId}&dimension=mcp_tool&sort=calls&${bounded}`);
    expect(boundedRanking.json().items.find((item: { capability: Capability }) =>
      item.capability.serverId === serverOne.serverId)).toMatchObject({ calls: 1, exposureCount: 1 });

    const firstPage = await get(app, `/invocations?sessionId=${bindings.first.sessionId}&limit=2`);
    expect(firstPage.json().origin).toBe("counted");
    expect(firstPage.json().items).toHaveLength(2);
    expect(firstPage.json().nextCursor).toEqual(expect.any(String));
    const secondPage = await get(app,
      `/invocations?sessionId=${bindings.first.sessionId}&limit=2&cursor=${encodeURIComponent(firstPage.json().nextCursor)}`);
    const firstIds = firstPage.json().items.map((item: { id: string }) => item.id);
    const secondIds = secondPage.json().items.map((item: { id: string }) => item.id);
    expect(secondIds).toHaveLength(2);
    expect(secondIds).not.toEqual(expect.arrayContaining(firstIds));
    const filtered = await get(app,
      `/invocations?sessionId=${bindings.first.sessionId}&capabilityId=${encodeURIComponent(serverTwo.id)}&capabilityServerId=server-2`);
    expect(filtered.json().items).toHaveLength(2);
    expect(filtered.json().items.every((item: { capability: Capability }) =>
      item.capability.id === serverTwo.id && item.capability.serverId === serverTwo.serverId)).toBe(true);
    const executions = await get(app, `/invocations?sessionId=${bindings.first.sessionId}&origin=execution`);
    expect(executions.json().origin).toBe("execution");
    expect(executions.json().items).toHaveLength(6);
    expect(executions.json().items.every((item: { origin: string }) => item.origin === "execution")).toBe(true);

    const contextCalls = await get(app,
      `/invocations?sessionId=${bindings.first.sessionId}&origin=context&capabilityId=search&capabilityServerId=server-1&${bounded}`);
    expect(contextCalls.json()).toMatchObject({
      origin: "context",
      items: [{ invocationId: "snapshot-call", origin: "context", startedAt: null }]
    });
    const contextDetail = await get(app, `/invocations/${contextCalls.json().items[0].id}`);
    expect(contextDetail.json()).toMatchObject({
      invocation: { invocationId: "snapshot-call", origin: "context" },
      subsequentModelInvocationIds: ["model-1"]
    });
    expect(contextDetail.body).not.toContain("synthetic private body");

    const detail = await get(app, `/invocations/${firstPage.json().items[0].id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ bodyStatus: "not_retained" });
    expect(detail.body).not.toContain("synthetic private body");
    expect((await get(app, "/invocations/missing")).statusCode).toBe(404);
  });

  it("returns Runtime Skill stages as evidence without turning visibility into calls", async () => {
    const { app, db, bindings } = await setup();
    const skill: Capability = { id: "review", kind: "skill", name: "Review", version: "1" };
    db.prepare(`INSERT INTO agent_usage_runtime_activity
      (namespace, agent_id, session_id, generation, provider_epoch_id, execution_id, runtime_kind,
       event_id, capability_json, stage, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("remote-agent-server", bindings.first.agentId, bindings.first.sessionId, bindings.first.generation,
        "epoch-1", "run-1", "codex", "projection:review", JSON.stringify(skill), "catalog_visible", "2026-09-21T00:00:00Z");

    const response = await get(app, `/capabilities?sessionId=${bindings.first.sessionId}&dimension=skill`);

    expect(response.json()).toMatchObject({
      dimension: "skill",
      total: 0,
      items: [],
      stages: [{ capability: skill, stage: "catalog_visible", count: 1 }]
    });
  });
});
