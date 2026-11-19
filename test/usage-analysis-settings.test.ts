import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { migrate, openDatabase } from "../src/db.js";
import { HostUsageCollector } from "../src/agent-usage/host-collector.js";
import { McpUsageObserver } from "../src/agent-usage/mcp-observer.js";
import { McpManager } from "../src/mcp/mcp-manager.js";
import { RunMcpPreparer } from "../src/mcp/run-mcp-preparer.js";
import { SecretStore } from "../src/mcp/secret-store.js";
import { RunRepository } from "../src/runs/run-repository.js";
import { UsageAnalysisSettingsStore } from "../src/settings/usage-analysis-settings-store.js";
import { createFakeRuntime, createTestDatabase } from "./helpers.js";

const apiToken = "test-token";
const headers = { authorization: `Bearer ${apiToken}` };
const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(resources.splice(0).map(async (close) => close()));
});

const createApp = async () => {
  const { db, seed } = createTestDatabase();
  const root = mkdtempSync(join(tmpdir(), "remote-agent-usage-analysis-"));
  const app = buildApp({
    config: {
      host: "127.0.0.1", port: 3000, apiToken, dataDir: root, databasePath: ":memory:",
      projectEnvironmentsRoot: "/unused/environments", sessionsRoot: "/unused/sessions",
      maxConcurrentRuns: 4, maxConcurrentWebhookDeliveries: 4, maxConcurrentEnvironmentBuilds: 1,
      projectEnvironmentCheckIntervalMs: 3 * 60 * 60 * 1000, projectPrepareTimeoutMs: 30 * 60 * 1000, sessionRetentionMs: 0
    },
    db,
    runtime: createFakeRuntime(),
    sessionCleanupScheduler: { start() {}, stop() {}, async runCleanup() {} }
  });
  await app.ready();
  resources.push(async () => { await app.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  return { app, db, seed };
};

describe("Usage analysis settings API", () => {
  it("is disabled on a freshly migrated database", () => {
    const db = openDatabase(":memory:");
    try {
      migrate(db);
      expect(new UsageAnalysisSettingsStore(db).get()).toEqual({ enabled: false });
    } finally { db.close(); }
  });

  it("validates updates and requires authentication", async () => {
    const { app } = await createApp();
    expect((await app.inject({ method: "GET", url: "/api/system-settings/usage-analysis" })).statusCode).toBe(401);
    expect((await app.inject({ method: "PUT", url: "/api/system-settings/usage-analysis", headers, payload: { enabled: false } })).json())
      .toEqual({ enabled: false });
    expect((await app.inject({ method: "GET", url: "/api/system-settings/usage-analysis", headers })).json()).toEqual({ enabled: false });

    const invalid = await app.inject({ method: "PUT", url: "/api/system-settings/usage-analysis", headers, payload: { enabled: "no" } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: "invalid_request" } });

    const enabled = await app.inject({ method: "PUT", url: "/api/system-settings/usage-analysis", headers, payload: { enabled: true } });
    expect(enabled.json()).toEqual({ enabled: true });
    expect((await app.inject({ method: "GET", url: "/api/system-settings/usage-analysis", headers })).json()).toEqual({ enabled: true });
  });

  it("rejects manual usage-source import and collection while disabled", async () => {
    const { app, db } = await createApp();
    new UsageAnalysisSettingsStore(db).update({ enabled: false });
    const registered = await app.inject({ method: "POST", url: "/api/usage/sources", headers, payload: {
      sourceKey: "manual", kind: "codex_log", inputRef: { importRootId: "imports", relativePath: "session.jsonl" },
      mappings: [{ sourceSessionKey: "source-session", sessionId: "1", providerEpochId: "epoch" }]
    } });
    expect(registered.statusCode).toBe(409);
    expect(registered.json()).toMatchObject({ error: { code: "usage_analysis_disabled" } });
    const collected = await app.inject({ method: "POST", url: "/api/usage/sources/1/collect", headers, payload: {} });
    expect(collected.statusCode).toBe(409);
    expect(collected.json()).toMatchObject({ error: { code: "usage_analysis_disabled" } });
  });
});

describe("Usage analysis switch", () => {
  it("is frozen on each Run when it starts", () => {
    const { db, seed } = createTestDatabase();
    try {
      const session = seed.session();
      const settings = new UsageAnalysisSettingsStore(db), runs = new RunRepository({ db }), collector = new HostUsageCollector(db);
      const first = runs.create({ sessionId: session.id, input: "first" });
      settings.update({ enabled: false });
      // A queued Run follows the current switch; the value is fixed only by the start transition.
      expect(collector.runAnalysisEnabled(first.id)).toBe(false);
      runs.markRunning(first.id);
      settings.update({ enabled: true });
      expect(collector.runAnalysisEnabled(first.id)).toBe(false);
      runs.finish(first.id, { status: "succeeded", result: "done" });
      const second = runs.create({ sessionId: session.id, input: "second" });
      runs.markRunning(second.id);
      settings.update({ enabled: false });
      expect(collector.runAnalysisEnabled(second.id)).toBe(true);
    } finally { db.close(); }
  });

  it("starts MCP servers without the usage observer and revokes its tickets for a disabled Run", async () => {
    const { db, seed } = createTestDatabase();
    const dataDir = mkdtempSync(join(tmpdir(), "remote-agent-usage-analysis-mcp-"));
    const collector = new HostUsageCollector(db), observer = new McpUsageObserver(collector);
    resources.push(async () => { await observer.close(); db.close(); rmSync(dataDir, { recursive: true, force: true }); });
    const manager = new McpManager({ db, secrets: SecretStore.open({ dataDir }) });
    const check = vi.fn(async () => ({ status: "passed" as const, toolCount: 1, message: "ready", tools: [{ name: "search", description: "search" }] }));
    const preparer = new RunMcpPreparer({ manager, checker: { check }, observer });
    const session = seed.session();
    manager.createServer(seed.agent.id, { name: "project-tools", transport: "http", enabled: true, url: "https://example.test/mcp", checkTimeoutSeconds: 5, headers: [] });
    const runs = new RunRepository({ db });
    const context = (runId: number) => ({ agentId: seed.agent.id, sessionId: session.id, runId, workspacePath: "/workspace", browserProfilePath: "/browser" });

    const enabledRun = runs.create({ sessionId: session.id, input: "enabled" });
    runs.markRunning(enabledRun.id);
    const [observed] = await preparer.prepare(context(enabledRun.id));
    expect(observed).toMatchObject({ type: "stdio" });
    const ticket = observer.issueTicket(session.id, Number(observed!.usageIdentity!.serverId));
    runs.finish(enabledRun.id, { status: "succeeded", result: "done" });

    new UsageAnalysisSettingsStore(db).update({ enabled: false });
    const disabledRun = runs.create({ sessionId: session.id, input: "disabled" });
    runs.markRunning(disabledRun.id);
    const [plain] = await preparer.prepare(context(disabledRun.id));
    expect(plain).toMatchObject({ type: "http", url: "https://example.test/mcp" });
    // A still-running wrapper from the earlier Run can no longer record observations.
    expect(() => observer.record(ticket, { invocationId: crypto.randomUUID(), toolName: "search", phase: "start", occurredAt: new Date().toISOString() }))
      .toThrow("usage_observer_unauthorized");
    expect(collector.attribution.invocations()).toEqual([]);
  });
});
