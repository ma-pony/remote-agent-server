import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { ManagedUsageSources } from "../src/agent-usage/managed-sources.js";
import type { UsageObservation } from "../src/agent-usage/core/types.js";
import { createFakeRuntime, createTestDatabase } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
const headers = { authorization: "Bearer test-token" };
const range = "from=2026-10-10T00:00:00Z&to=2026-10-13T00:00:00Z";

const setup = async (fileBacked = false) => {
  const root = await mkdtemp(join(tmpdir(), "usage-dashboard-"));
  const databasePath = fileBacked ? join(root, "test.sqlite") : ":memory:";
  const { db, seed } = createTestDatabase(databasePath);
  const config = loadConfig({ API_TOKEN: "test-token", DATA_DIR: root, DATABASE_PATH: databasePath,
    PROJECT_ENVIRONMENTS_ROOT: join(root, "environments"), SESSIONS_ROOT: join(root, "sessions"), SESSION_RETENTION_HOURS: "0" });
  const sources = new ManagedUsageSources(db, config);
  const app = buildApp({ db, config, usageSources: sources, runtime: createFakeRuntime(),
    sessionCleanupScheduler: { start() {}, stop() {}, async runCleanup() {} } });
  cleanups.push(async () => { await app.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  await app.ready();
  await sources.collector.stopRecovery();
  const otherAgent = Number(db.prepare(`INSERT INTO agents(name,provider,project_environment_id,created_at,updated_at)
    VALUES('Other agent','codex',?,'2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z')`)
    .run(seed.projectEnvironment.id).lastInsertRowid);
  const session = (createdAt: string, agentId = seed.agent.id) => {
    const { id } = seed.session();
    db.prepare("UPDATE sessions SET created_at=?, agent_id=? WHERE id=?").run(createdAt, agentId, id);
    return id;
  };
  const run = (sessionId: number, startedAt: string | null, status = "succeeded") => db.prepare(`INSERT INTO runs
    (session_id,status,input,created_at,started_at) VALUES(?,?,'private prompt','2026-10-09T00:00:00.000Z',?)`)
    .run(sessionId, status, startedAt);
  const observe = (sessionId: number, id: string, at: string | null, total: number | null, extra: Partial<UsageObservation> = {}) =>
    sources.collector.store.observe(sources.collector.binding(sessionId), {
      eventId: id, sourceId: "fixture", sourceVersion: "1", scope: "model_request", semantics: "delta", coverageId: id,
      invocationId: id, executionId: id, providerEpochId: `session-${sessionId}`, occurredAt: at, finality: "final",
      revision: 1, measurement: "reported", normalizationProfile: "fixture", metrics: { totalTokens: total }, ...extra
    });
  const get = (endpoint = "dashboard", query = range) => app.inject({ url: `/api/usage/${endpoint}?${query}`, headers });
  return { app, db, sources, seed, otherAgent, session, run, observe, get };
};

it("counts new and active Sessions independently, deduplicates Runs, and fills UTC calendar gaps", async () => {
  const { session, run, observe, get, seed, otherAgent } = await setup();
  const old = session("2026-10-09T23:59:59.999Z"), first = session("2026-10-10T00:00:00.000Z");
  const other = session("2026-10-11T00:00:00.000Z", otherAgent);
  session("2026-10-13T00:00:00.000Z");
  run(old, "2026-10-10T01:00:00.000Z"); run(first, "2026-10-10T02:00:00.000Z");
  run(first, "2026-10-10T03:00:00.000Z", "failed"); run(first, "2026-10-11T04:00:00.000Z", "cancelled");
  run(other, "2026-10-11T01:00:00.000Z"); run(first, null, "queued");
  run(old, "2026-10-13T00:00:00.000Z");
  observe(old, "old", "2026-10-10T23:30:00Z", 10);
  observe(first, "midnight", "2026-10-11T08:00:00+08:00", 20);
  observe(other, "other", "2026-10-11T01:00:00Z", 70);
  observe(first, "outside", "2026-10-13T00:00:00Z", 900);
  const result = (await get()).json();
  expect(result).toMatchObject({ timeZone: "UTC", from: "2026-10-10T00:00:00.000Z", to: "2026-10-13T00:00:00.000Z",
    counts: { newSessions: 2, activeSessions: 3, runs: 5 }, summary: { usage: { totalTokens: 100 } } });
  expect(result.daily).toMatchObject([
    { day: "2026-10-10", newSessions: 1, activeSessions: 2, runs: 3, usage: { totalTokens: 10 } },
    { day: "2026-10-11", newSessions: 1, activeSessions: 2, runs: 2, usage: { totalTokens: 90 } },
    { day: "2026-10-12", newSessions: 0, activeSessions: 0, runs: 0, usage: { totalTokens: null } }
  ]);
  expect((await get("dashboard", `${range}&agentId=${seed.agent.id}`)).json()).toMatchObject({
    counts: { newSessions: 1, activeSessions: 2, runs: 4 }, summary: { usage: { totalTokens: 30 } }
  });
});

it("retains unknown versus measured zero and does not place undated or cross-day totals on a day", async () => {
  const { session, observe, get } = await setup();
  const id = session("2026-10-10T00:00:00.000Z");
  observe(id, "unknown", "2026-10-10T01:00:00Z", null);
  observe(id, "zero", "2026-10-11T01:00:00Z", 0);
  observe(id, "undated", null, 17, { providerEpochId: "undated" });
  observe(id, "interval", "2026-10-12T01:00:00Z", 30, { scope: "interval", intervalStart: "2026-10-11T23:00:00.000Z", providerEpochId: "interval" });
  const result = (await get()).json();
  expect(result.daily.map((row: { usage: { totalTokens: number | null } }) => row.usage.totalTokens)).toEqual([null, 0, null]);
  expect(result.unplacedUsage.totalTokens).toBe(47);
  expect(result.summary.usage.totalTokens).toBe(30);
});

it("paginates a creation-date cohort chronologically while retaining each Session's lifetime total", async () => {
  const { session, observe, get, seed, otherAgent } = await setup();
  session("2026-10-09T23:59:59.999Z");
  const first = session("2026-10-10T00:00:00.000Z"), second = session("2026-10-10T00:00:00.000Z");
  const other = session("2026-10-11T00:00:00.000Z", otherAgent);
  session("2026-10-13T00:00:00.000Z");
  observe(first, "inside", "2026-10-10T03:00:00Z", 10);
  observe(first, "later", "2026-10-14T03:00:00Z", 20);
  observe(other, "other", "2026-10-11T03:00:00Z", 100);
  const response = await get("session-trend", `${range}&agentId=${seed.agent.id}&limit=1`);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ total: 2, items: [{ sessionId: first, agentId: seed.agent.id, summary: { usage: { totalTokens: 30 } } }] });
  expect((await get("session-trend", `${range}&agentId=${seed.agent.id}&limit=1&offset=1`)).json())
    .toMatchObject({ total: 2, items: [{ sessionId: second, summary: { usage: { totalTokens: null } } }] });
  expect((await get("session-trend", `${range}&limit=1&offset=10`)).json()).toMatchObject({ total: 3, items: [] });
  expect(response.body).not.toMatch(/private prompt|workspacePath|providerSessionId/);
});

it("returns fresh Session and Run metadata even when the ledger revision has not changed", async () => {
  const { session, run, get, db } = await setup();
  const before = (await get()).json();
  const id = session("2026-10-10T00:00:00.000Z");
  run(id, "2026-10-10T01:00:00.000Z");
  expect((await get()).json().counts).toEqual({ newSessions: 1, activeSessions: 1, runs: 1 });
  expect(before.counts).toEqual({ newSessions: 0, activeSessions: 0, runs: 0 });
  await get("session-trend");
  db.prepare("UPDATE sessions SET title='Renamed' WHERE id=?").run(id);
  expect((await get("session-trend")).json().items[0].title).toBe("Renamed");
  db.prepare("DELETE FROM runs WHERE session_id=?").run(id);
  db.prepare("DELETE FROM sessions WHERE id=?").run(id);
  expect((await get("session-trend")).json()).toMatchObject({ total: 0, items: [] });
});

it("uses the existing reconciliation and dirty-epoch fallback in a read-only file-backed worker", async () => {
  const { session, observe, get, sources, db } = await setup(true);
  const id = session("2026-10-10T00:00:00.000Z");
  observe(id, "request", "2026-10-10T01:00:00Z", 10);
  observe(id, "parent", null, 30, { scope: "provider_session", semantics: "cumulative", invocationId: null, executionId: null });
  const store = sources.collector.store;
  let job;
  while ((job = store.nextAccountingProjection())) store.commitAccountingProjection(store.projectEpoch(job));
  observe(id, "late", "2026-10-11T01:00:00Z", 20);
  const schema = db.pragma("schema_version", { simple: true });
  vi.spyOn(store, "overviewWithSessionCounts").mockImplementation(() => { throw new Error("Main thread aggregation"); });
  vi.spyOn(store, "summariesBySession").mockImplementation(() => { throw new Error("Main thread aggregation"); });
  expect((await get()).json().summary.usage.totalTokens).toBe(30);
  expect((await get("session-trend")).json().items[0].summary.usage.totalTokens).toBe(30);
  expect(db.pragma("schema_version", { simple: true })).toBe(schema);
});

it("requires authentication and validates bounded dates, Agent IDs and pagination", async () => {
  const { app, get } = await setup();
  for (const endpoint of ["dashboard", "session-trend"]) {
    expect((await app.inject({ url: `/api/usage/${endpoint}?${range}` })).statusCode).toBe(401);
    for (const query of ["", `${range}&agentId=0`, `${range}&limit=101`, `${range}&offset=-1`, `${range}&timezone=Asia/Singapore`,
      "from=2026-10-12T12:00:00Z&to=2026-10-12T10:00:00Z", "from=2025-01-01T00:00:00Z&to=2026-10-13T00:00:00Z"]) {
      expect((await get(endpoint, query)).statusCode).toBe(400);
    }
    expect((await get(endpoint, "from=2026-10-10T03:00:00%2B08:00&to=2026-10-11T04:00:00%2B08:00")).json())
      .toMatchObject({ from: "2026-10-09T00:00:00.000Z", to: "2026-10-11T00:00:00.000Z" });
  }
  expect((await get("dashboard", `${range}&agentId=99999`)).json().counts).toEqual({ newSessions: 0, activeSessions: 0, runs: 0 });
});

it.each([false, true])("averages known Session totals per day, not Runs or epochs, with projection=%s", async projected => {
  const { session, observe, get, sources, seed, otherAgent } = await setup();
  const first = session("2026-10-10T00:00:00.000Z"), second = session("2026-10-10T00:00:00.000Z");
  const unknown = session("2026-10-10T00:00:00.000Z"), zero = session("2026-10-10T00:00:00.000Z");
  const other = session("2026-10-10T00:00:00.000Z", otherAgent);
  observe(first, "one", "2026-10-10T01:00:00Z", 10);
  observe(first, "two", "2026-10-10T02:00:00Z", 30);
  observe(first, "reset", "2026-10-10T03:00:00Z", 60, { providerEpochId: "reset" });
  observe(second, "second", "2026-10-10T01:00:00Z", 300);
  observe(unknown, "unknown", "2026-10-10T01:00:00Z", null);
  observe(zero, "zero", "2026-10-10T01:00:00Z", 0);
  observe(other, "other", "2026-10-10T01:00:00Z", 50);
  if (projected) {
    const store = sources.collector.store;
    let job;
    while ((job = store.nextAccountingProjection())) store.commitAccountingProjection(store.projectEpoch(job));
  }
  // Late data exercises the dirty-epoch fallback alongside already projected Sessions.
  observe(first, "next-day", "2026-10-11T01:00:00Z", 80);
  observe(unknown, "now-known", "2026-10-11T01:00:00Z", 20);
  const result = (await get("dashboard", `${range}&agentId=${seed.agent.id}`)).json();
  expect(result.daily).toMatchObject([
    { reportedSessions: 3, averageTokensPerSession: 400 / 3, usage: { totalTokens: 400 } },
    { reportedSessions: 2, averageTokensPerSession: 50, usage: { totalTokens: 100 } },
    { reportedSessions: 0, averageTokensPerSession: null, usage: { totalTokens: null } }
  ]);
  expect((await get()).json().daily[0]).toMatchObject({ reportedSessions: 4, averageTokensPerSession: 112.5 });
});
