import { fixtureTokenizerConfig } from "./fixtures/agent-usage/tokenizers/helpers.js";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { ManagedUsageSources } from "../src/agent-usage/managed-sources.js";
import { createFakeRuntime, createTestDatabase } from "./helpers.js";
import { snapshotFixture } from "./fixtures/agent-usage/context-snapshot.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const headers = { authorization: "Bearer test-token" };
const setup = async (usageTokenizers = [fixtureTokenizerConfig()]) => {
  const root = await mkdtemp(join(tmpdir(), "usage-api-"));
  const { db, seed } = createTestDatabase(); const session = seed.session();
  const config = loadConfig({ USAGE_TOKENIZERS: JSON.stringify(usageTokenizers), API_TOKEN: "test-token", DATA_DIR: root, DATABASE_PATH: ":memory:",
    PROJECT_ENVIRONMENTS_ROOT: join(root, "environments"), SESSIONS_ROOT: join(root, "sessions"),
    SESSION_RETENTION_HOURS: "0", USAGE_IMPORT_ROOTS: JSON.stringify({ fixtures: root }) });
  await copyFile("test/fixtures/agent-usage/provider-logs/codex-token-count.jsonl", join(root, "codex.jsonl"));
  const manager = new ManagedUsageSources(db, config);
  const app = buildApp({ db, config, runtime: createFakeRuntime(), usageSources: manager,
    sessionCleanupScheduler: { start() {}, stop() {}, async runCleanup() {} } });
  cleanups.push(async () => { await app.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  await app.ready();
  const registration = { sourceKey: "fixture-codex", kind: "codex_log", inputRef: { importRootId: "fixtures", relativePath: "codex.jsonl" },
    mappings: [{ sourceSessionKey: "codex-session-1", sessionId: String(session.id), providerEpochId: manager.collector.epoch(session.id) }] };
  return { app, db, root, manager, registration, session };
};
const register = (app: FastifyInstance, payload: unknown) => app.inject({ method: "POST", url: "/api/usage/sources", headers, payload });

describe("usage source management API", () => {
  it("filters source listings by Agent and Session at the API boundary", async () => {
    const { app, manager, registration, session } = await setup();
    const registered = await register(app, registration);
    const agentId = manager.collector.binding(session.id).agentId;
    const list = (query: string) => app.inject({ url: `/api/usage/sources?${query}`, headers });
    expect((await list(`agentId=${agentId}&sessionId=${session.id}`)).json()).toEqual([registered.json()]);
    expect((await list("agentId=999999")).json()).toEqual([]);
    expect((await list("sessionId=999999")).json()).toEqual([]);
    expect((await list("sessionId=invalid")).statusCode).toBe(400);
  });

  it.each(["database unavailable", "usage_source_conflict"])("does not classify an untyped internal error as client input: %s", async (message) => {
    const { app, manager, registration } = await setup();
    vi.spyOn(manager, "register").mockRejectedValueOnce(new Error(message));
    const response = await register(app, registration);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: { code: "usage_source_failed", message: "Usage source operation could not be completed" } });
    expect(response.body).not.toContain(message);
  });
  it("returns ranked fallback estimates through the import API with no tokenizer profiles configured", async () => {
    const { app, root, manager, registration } = await setup([]);
    await writeFile(join(root, "fallback.json"), JSON.stringify(snapshotFixture()));
    const registered = await register(app, { ...registration, sourceKey: "fallback", kind: "context_snapshot",
      inputRef: { importRootId: "fixtures", relativePath: "fallback.json" },
      mappings: [{ ...registration.mappings[0], sourceSessionKey: "capture-session" }] });
    expect(registered.statusCode).toBe(201);
    const collection = await app.inject({ method: "POST", url: `/api/usage/sources/${registered.json().id}/collect`, headers });
    expect(collection.statusCode).toBe(202);
    await vi.waitFor(() => expect(manager.collector.sources.listSources(manager.collector.namespace)[0]?.status).toBe("completed"));
    const response = await app.inject({ method: "GET", url: "/api/usage/capabilities?dimension=mcp_tool&sort=totalInputTokens", headers });
    expect(response.statusCode).toBe(200);
    const row = response.json().items[0];
    expect(row).toMatchObject({ firstResultInputTokens: 3, missingExposureCount: 0,
      tokenEstimates: [expect.objectContaining({ method: "text_heuristic", heuristicVersion: "unicode-weighted-v1", reason: "model_unmapped" })] });
    expect(row.totalInputTokens).toBeGreaterThan(3);
    const summary = await app.inject({ method: "GET", url: "/api/usage/summary", headers });
    expect(summary.json().usage.totalTokens).toBe(280);
    expect(response.body).not.toContain("hello world");
  });
  it("recovers an unregistered completed log on startup and harvests shutdown-flushed usage", async () => {
    const root = await mkdtemp(join(tmpdir(), "usage-recovery-"));
    const { db, seed } = createTestDatabase();
    for (let index = 0; index < 101; index++) {
      const historical = seed.session();
      db.prepare("UPDATE sessions SET provider_session_id = 'historical' WHERE id = ?").run(historical.id);
    }
    const session = seed.session(); seed.run(session.id, "succeeded");
    db.prepare("UPDATE sessions SET provider_session_id = 'codex-session-1' WHERE id = ?").run(session.id);
    const home = join(root, "agents", String(seed.agent.id), "provider-home", "codex", "sessions", String(session.id), "sessions");
    await mkdir(home, { recursive: true });
    const log = join(home, "rollout-codex-session-1.jsonl");
    await copyFile("test/fixtures/agent-usage/provider-logs/codex-token-count.jsonl", log);
    const config = loadConfig({ USAGE_TOKENIZERS: JSON.stringify([fixtureTokenizerConfig()]), API_TOKEN: "test-token", DATA_DIR: root, DATABASE_PATH: ":memory:",
      PROJECT_ENVIRONMENTS_ROOT: join(root, "envs"), SESSIONS_ROOT: join(root, "sessions"), SESSION_RETENTION_HOURS: "0" });
    const manager = new ManagedUsageSources(db, config);
    const runtime = createFakeRuntime();
    runtime.shutdown = async () => {
      const { appendFile } = await import("node:fs/promises");
      await appendFile(log, JSON.stringify({ timestamp: "2026-09-21T01:00:06Z", type: "event_msg", payload: {
        type: "token_count", info: { total_token_usage: { input_tokens: 200, output_tokens: 40, total_tokens: 240 } }
      } }) + "\n");
    };
    const app = buildApp({ db, config, runtime, usageSources: manager,
      sessionCleanupScheduler: { start() {}, stop() {}, async runCleanup() {} } });
    cleanups.push(async () => { await app.close(); db.close(); await rm(root, { recursive: true, force: true }); });
    await app.ready();
    await vi.waitFor(() => expect(manager.collector.store.summary().usage.totalTokens).toBe(190));
    // This Session runs in this service lifetime and therefore owns a producer shutdown barrier.
    await manager.collector.collectSession(session.id);
    await app.close();
    expect(manager.collector.store.summary().usage.totalTokens).toBe(240);
  });

  it("persists discovery failure before registration and retries it after the path is repaired", async () => {
    const { app, db, manager, root, session } = await setup();
    db.prepare("UPDATE sessions SET provider_session_id = 'codex-session-1' WHERE id = ?").run(session.id);
    const home = join(root, "agents", "1", "provider-home", "codex", "sessions", String(session.id), "sessions");
    await mkdir(home, { recursive: true });
    await rm(home, { recursive: true });
    await writeFile(home, "not a directory");
    await expect(manager.collector.collectSession(session.id)).rejects.toThrow();
    const failed = await app.inject({ method: "GET", url: "/api/usage/summary", headers });
    expect(failed.json()).toMatchObject({ analysisStatus: "partial", collectionFailures: [
      expect.objectContaining({ sessionId: String(session.id), errorCode: "usage_discovery_failed" })
    ] });
    await rm(home); await mkdir(home);
    await copyFile("test/fixtures/agent-usage/provider-logs/codex-token-count.jsonl", join(home, "rollout-codex-session-1.jsonl"));
    await manager.collector.collectSession(session.id);
    expect(manager.collector.store.summary().usage.totalTokens).toBe(190);
    expect((await app.inject({ method: "GET", url: "/api/usage/summary", headers })).json().collectionFailures).toEqual([]);
  });

  it("imports a context snapshot then drills from tool ranking to subsequent model inputs", async () => {
    const { app, root, manager, registration } = await setup();
    await writeFile(join(root, "snapshot.json"), JSON.stringify(snapshotFixture()));
    const response = await register(app, { ...registration, sourceKey: "capture", kind: "context_snapshot",
      inputRef: { importRootId: "fixtures", relativePath: "snapshot.json" },
      mappings: [{ ...registration.mappings[0], sourceSessionKey: "capture-session" }] });
    expect(response.statusCode).toBe(201);
    const id = response.json<{ id: string }>().id;
    await app.inject({ method: "POST", url: `/api/usage/sources/${id}/collect`, headers });
    await vi.waitFor(() => expect(manager.collector.sources.listSources(manager.collector.namespace)[0]?.status).toBe("completed"));
    const summary = await app.inject({ method: "GET", url: "/api/usage/summary", headers });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().usage.totalTokens).toBe(280);
    const ranking = await app.inject({ method: "GET", url: "/api/usage/capabilities?dimension=mcp_tool", headers });
    expect(ranking.statusCode).toBe(200);
    expect(ranking.json().items[0]).toMatchObject({ capability: { id: "mcp:server-1:search" }, calls: 0, contextOnlyCalls: 1, measurement: "estimated" });
    expect(ranking.json().items[0].firstResultInputTokens).toBe(2);
    const calls = await app.inject({ method: "GET", url: "/api/usage/invocations?origin=context&capabilityId=mcp%3Aserver-1%3Asearch", headers });
    const detail = await app.inject({ method: "GET", url: `/api/usage/invocations/${calls.json().items[0].id}`, headers });
    expect(detail.json().subsequentModelInvocationIds).toEqual(["context-snapshot:capture-session:capture-2"]);
    expect(detail.body).not.toContain("hello world");
    const updated = snapshotFixture(2); updated.requests[1]!.canonical_request_body = JSON.stringify({ model: "gpt-4.1", input: [
      { type: "function_call_output", call_id: "call-1", output: "hello world" },
      { type: "function_call_output", call_id: "call-1", output: "hello world" }
    ] });
    await writeFile(join(root, "snapshot.json"), JSON.stringify(updated));
    await app.inject({ method: "POST", url: `/api/usage/sources/${id}/collect`, headers });
    await vi.waitFor(() => expect(manager.collector.sources.listSources(manager.collector.namespace)[0]?.status).toBe("completed"));
    const revised = await app.inject({ method: "GET", url: "/api/usage/capabilities?dimension=mcp_tool", headers });
    expect(revised.json().items[0]).toMatchObject({ calls: 0, contextOnlyCalls: 1, firstResultInputTokens: 2, repeatedResultInputTokens: 2 });
    expect(manager.collector.store.summary().usage.totalTokens).toBe(280);
  });
  it("requires management authentication and validates the source contract", async () => {
    const { app, registration } = await setup();
    expect((await app.inject({ method: "GET", url: "/api/usage/sources" })).statusCode).toBe(401);
    expect((await register(app, { ...registration, inputRef: { relativePath: "/etc/passwd" } })).statusCode).toBe(400);
  });
  it("registers idempotently, imports through the real boundary and preserves replay totals", async () => {
    const { app, manager, registration } = await setup();
    const first = await register(app, registration); expect(first.statusCode).toBe(201);
    const id = first.json<{ id: string }>().id;
    expect((await register(app, registration)).statusCode).toBe(200);
    expect((await register(app, { ...registration, mappings: [{ ...registration.mappings[0], sourceSessionKey: "different" }] })).statusCode).toBe(409);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await app.inject({ method: "POST", url: `/api/usage/sources/${id}/collect`, headers });
      expect(response.statusCode).toBe(202);
      await vi.waitFor(() => expect(manager.collector.sources.listSources(manager.collector.namespace)[0]?.status).toBe("completed"));
    }
    expect(manager.collector.store.summary().usage.totalTokens).toBeGreaterThan(0);
    const sources = await app.inject({ method: "GET", url: "/api/usage/sources", headers });
    expect(sources.json()[0].rejectedRecords).toBe(0);
    expect(sources.body).not.toContain("codex.jsonl");
    expect(manager.collector.store.records()).not.toHaveLength(0);
  });
  it("rejects unauthorized roots, symlink escapes, wrong epochs and deleted subjects", async () => {
    const { app, root, registration, manager, session } = await setup();
    expect((await register(app, { ...registration, inputRef: { importRootId: "missing", relativePath: "codex.jsonl" } })).statusCode).toBe(400);
    const outside = await mkdtemp(join(tmpdir(), "usage-outside-"));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await writeFile(join(outside, "secret.jsonl"), "synthetic private body");
    await symlink(join(outside, "secret.jsonl"), join(root, "escape.jsonl"));
    const denied = await register(app, { ...registration, inputRef: { importRootId: "fixtures", relativePath: "escape.jsonl" } });
    expect(denied.statusCode).toBe(400); expect(denied.body).not.toContain(outside);
    expect((await register(app, { ...registration, mappings: [{ ...registration.mappings[0], providerEpochId: "not-known" }] })).statusCode).toBe(400);
    manager.collector.deleteSession(session.id);
    expect((await register(app, registration)).statusCode).toBe(409);
  });
});
