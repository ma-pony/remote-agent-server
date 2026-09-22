import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db.js";
import { EventStore } from "../src/events/event-store.js";
import { ManagedUsageSources } from "../src/agent-usage/managed-sources.js";
import { createFakeRuntime, createTestDatabase } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const headers = { authorization: "Bearer content-flow-token" };
const privateArgument = "PRIVATE_ARGUMENT_NEVER_IN_USAGE";
const privateResult = "PRIVATE_RESULT_NEVER_IN_USAGE";
const setup = async (withMcpMirror = false, legacyObserver = false) => {
  const root = await mkdtemp(join(tmpdir(), "usage-content-flow-")), databasePath = join(root, "app.sqlite");
  const seeded = createTestDatabase(databasePath), seed = seeded.seed;
  let db = seeded.db;
  const codexSessionId = seed.session().id;
  const at = "2026-09-22T01:00:00.000Z";
  const claudeAgentId = Number(db.prepare(`INSERT INTO agents
    (name, provider, project_environment_id, created_at, updated_at) VALUES ('Claude', 'claude_code', ?, ?, ?)`)
    .run(seed.projectEnvironment.id, at, at).lastInsertRowid);
  const claudeSessionId = Number(db.prepare(`INSERT INTO sessions
    (agent_id, title, status, workspace_path, created_at, updated_at) VALUES (?, 'Claude history', 'idle', ?, ?, ?)`)
    .run(claudeAgentId, join(root, "sessions", "claude"), at, at).lastInsertRowid);
  const config = loadConfig({ API_TOKEN: "content-flow-token", DATA_DIR: root, DATABASE_PATH: databasePath,
    PROJECT_ENVIRONMENTS_ROOT: join(root, "environments"), SESSIONS_ROOT: join(root, "sessions"), SESSION_RETENTION_HOURS: "0" });
  const retainedCall = (sessionId: number, day: string, id: string, kind: string, rawInput: unknown, rawOutput: unknown) => {
    const started = `${day}T01:00:00.000Z`, ended = `${day}T01:00:01.000Z`;
    const runId = Number(db.prepare(`INSERT INTO runs (session_id, status, input, created_at, started_at, finished_at)
      VALUES (?, 'succeeded', 'retained history', ?, ?, ?)`).run(sessionId, started, started, ended).lastInsertRowid);
    const events = new EventStore({ db });
    const first = events.append(runId, "tool", { toolCallId: id, kind, status: "in_progress", rawInput });
    const last = events.append(runId, "tool", { toolCallId: id, status: "completed", rawOutput });
    db.prepare("UPDATE events SET created_at = ? WHERE id = ?").run(started, first.id);
    db.prepare("UPDATE events SET created_at = ? WHERE id = ?").run(ended, last.id);
    return runId;
  };
  retainedCall(codexSessionId, "2026-09-20", "codex-read", "read", { path: `${privateArgument}.md` },
    { content: [{ type: "text", text: privateResult + "x".repeat(2048) }] });
  retainedCall(codexSessionId, "2026-09-21", "codex-edit", "edit", { path: "sample.md", newText: privateArgument + "x".repeat(4096) }, "ok");
  retainedCall(claudeSessionId, "2026-09-22", "claude-read", "read", { file_path: `${privateArgument}.md` },
    [{ type: "content", content: { type: "text", text: privateResult + "x".repeat(1024) } }]);
  let manager = new ManagedUsageSources(db, config);
  const createApp = () => buildApp({ db, config, runtime: createFakeRuntime(), usageSources: manager,
    sessionCleanupScheduler: { start() {}, stop() {}, async runCleanup() {} } });
  let app = createApp();
  let mcpSessionId: number | undefined;
  if (withMcpMirror) {
    db.prepare(`INSERT INTO agent_mcp_servers (id, agent_id, name, transport, enabled, command, created_at, updated_at)
      VALUES (7, ?, 'project-tools', 'stdio', 1, 'unused-fixture-command', ?, ?)`).run(seed.agent.id, at, at);
    mcpSessionId = seed.session().id;
    const runId = retainedCall(mcpSessionId, "2026-09-21", "native-search", "execute",
      { server: "project-tools", tool: "search", arguments: { query: privateArgument } },
      { content: [{ type: "text", text: privateResult }] });
    db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);
    const observer = manager.collector.observer!, ticket = observer.issueTicket(mcpSessionId, 7), invocationId = randomUUID();
    observer.record(ticket, { invocationId, toolName: "search", phase: "start", occurredAt: "2026-09-21T01:00:00.000Z",
      ...(legacyObserver ? {} : { argumentContent: { tokens: 3, byteLength: 12, partial: false } }) });
    observer.record(ticket, { invocationId, toolName: "search", phase: "end", occurredAt: "2026-09-21T01:00:01.000Z", status: "succeeded",
      resultBytes: 32, ...(legacyObserver ? {} : { resultContent: { tokens: 8, byteLength: 32, partial: false } }) });
    db.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(runId);
    if (legacyObserver) expect(manager.collector.attribution.rankings({ sessionId: String(mcpSessionId) }, "mcp_tool")[0])
      .toMatchObject({ calls: 1, observedTotalTokens: null });
  }
  cleanups.push(async () => { await app.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  const ready = async (processedEvents = withMcpMirror ? 8 : 6) => {
    await app.ready();
    await vi.waitFor(async () => {
      const response = await app.inject({ url: "/api/usage/summary", headers });
      expect(response.statusCode).toBe(200);
      expect(response.json().contentBackfill).toMatchObject({ status: "completed", processedEvents, errorCode: null });
    });
  };
  await ready();
  return {
    ids: { codexSessionId, codexAgentId: seed.agent.id, claudeSessionId, claudeAgentId, mcpSessionId },
    get: (path: string) => app.inject({ url: `/api/usage${path}`, headers }),
    inject: (options: Parameters<typeof app.inject>[0]) => app.inject(options),
    async restart(processedEvents?: number) {
      await app.close(); db.close(); db = openDatabase(databasePath);
      manager = new ManagedUsageSources(db, config); app = createApp(); await ready(processedEvents);
    }
  };
};

describe("default tool-content analysis through management API", () => {
  it("automatically backfills retained Codex and Claude events without capture or tokenizer configuration", async () => {
    const h = await setup();
    const ranking = await h.get("/capabilities?dimension=builtin_tool");
    expect(ranking.statusCode).toBe(200);
    expect(ranking.json()).toMatchObject({ sort: "observedTotalTokens", analysisStatus: "ready", captureHealth: [], total: 3 });
    expect(ranking.json().items.map((item: { capability: { id: string } }) => item.capability.id)).toEqual([
      "runtime:codex:builtin:edit", "runtime:codex:builtin:read", "runtime:claude_code:builtin:read"
    ]);
    for (const item of ranking.json().items) {
      expect(item).toMatchObject({ calls: 1, successes: 1, observedArgumentCalls: 1, observedResultCalls: 1, totalInputTokens: null });
      expect(item.observedArgumentTokens).toBeGreaterThan(0);
      expect(item.observedResultTokens).toBeGreaterThan(0);
      expect(item.observedTotalTokens).toBe(item.observedArgumentTokens + item.observedResultTokens);
      expect(item.payloadEstimates).toEqual([expect.objectContaining({ method: "text_heuristic", heuristicVersion: "unicode-weighted-v1", reason: "model_missing" })]);
    }
    const args = (await h.get("/capabilities?dimension=builtin_tool&sort=observedArgumentTokens")).json();
    expect(args.items[0].capability.id).toBe("runtime:codex:builtin:edit");
    const results = (await h.get("/capabilities?dimension=builtin_tool&sort=observedResultTokens")).json();
    expect(results.items.map((item: { capability: { id: string } }) => item.capability.id)).toEqual([
      "runtime:codex:builtin:read", "runtime:claude_code:builtin:read", "runtime:codex:builtin:edit"
    ]);
    expect((await h.get("/context-evidence")).json().items).toEqual([]);
    const calls = (await h.get("/invocations")).json().items;
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      const detail = await h.get(`/invocations/${call.id}`);
      expect(detail.json()).toMatchObject({ bodyStatus: "not_retained", subsequentModelInvocationIds: [] });
      expect(detail.body).not.toContain(privateArgument); expect(detail.body).not.toContain(privateResult);
    }
    expect(ranking.body).not.toContain(privateArgument); expect(ranking.body).not.toContain(privateResult);
    await h.restart();
    expect((await h.get("/capabilities?dimension=builtin_tool")).json().items).toEqual(ranking.json().items);
    expect((await h.get("/invocations")).json().items.map((call: { id: string }) => call.id)).toEqual(calls.map((call: { id: string }) => call.id));
  });

  it("applies original historical dates, Session and Agent scopes, management auth, and deletion", async () => {
    const h = await setup(), { ids } = h;
    expect((await h.get(`/capabilities?dimension=builtin_tool&sessionId=${ids.codexSessionId}`)).json().total).toBe(2);
    const claude = (await h.get(`/capabilities?dimension=builtin_tool&agentId=${ids.claudeAgentId}`)).json();
    expect(claude.items).toEqual([expect.objectContaining({ capability: expect.objectContaining({ id: "runtime:claude_code:builtin:read" }) })]);
    expect((await h.get(`/capabilities?dimension=builtin_tool&sessionId=${ids.codexSessionId}&agentId=${ids.claudeAgentId}`)).json().items).toEqual([]);
    const dates = new URLSearchParams({ dimension: "builtin_tool", from: "2026-09-21T00:00:00.000Z", to: "2026-09-22T00:00:00.000Z" });
    expect((await h.get(`/capabilities?${dates}`)).json().items).toEqual([
      expect.objectContaining({ capability: expect.objectContaining({ id: "runtime:codex:builtin:edit" }), calls: 1 })
    ]);
    for (const endpoint of ["capabilities", "invocations", "summary", "context-evidence"]) {
      expect((await h.inject({ url: `/api/usage/${endpoint}` })).statusCode).toBe(401);
      expect((await h.inject({ url: `/api/usage/${endpoint}`, headers: { authorization: "Bearer wrong-token" } })).statusCode).toBe(401);
    }
    expect((await h.get("/capabilities?sort=unsafe")).statusCode).toBe(400);
    const deletedCalls = (await h.get(`/invocations?sessionId=${ids.codexSessionId}`)).json().items;
    const deletion = await h.inject({ method: "DELETE", url: `/api/sessions/${ids.codexSessionId}`, headers });
    expect(deletion.statusCode).toBe(204);
    expect((await h.get(`/invocations?sessionId=${ids.codexSessionId}`)).json().items).toEqual([]);
    expect((await h.get(`/capabilities?dimension=builtin_tool&sessionId=${ids.codexSessionId}`)).json().items).toEqual([]);
    for (const call of deletedCalls) expect((await h.get(`/invocations/${call.id}`)).statusCode).toBe(404);
    expect((await h.get(`/capabilities?dimension=builtin_tool&agentId=${ids.claudeAgentId}`)).json().items).toEqual(claude.items);
    await h.restart(2);
    expect((await h.get(`/invocations?sessionId=${ids.codexSessionId}`)).json().items).toEqual([]);
    expect((await h.get("/capabilities?dimension=builtin_tool")).json().items).toEqual(claude.items);
  });

  it("keeps one MCP wrapper call when its retained Runtime mirror is replayed", async () => {
    const h = await setup(true), query = `sessionId=${h.ids.mcpSessionId}`;
    const response = await h.get(`/capabilities?${query}&dimension=mcp_tool`);
    expect(response.json()).toMatchObject({ dimension: "mcp_tool", sort: "observedTotalTokens", total: 1,
      items: [{ calls: 1, observedArgumentTokens: 3, observedResultTokens: 8, observedTotalTokens: 11, totalInputTokens: null }] });
    expect((await h.get(`/capabilities?${query}&dimension=cli`)).json().items).toEqual([]);
    expect((await h.get(`/capabilities?${query}&dimension=unknown`)).json().items).toEqual([]);
    expect((await h.get(`/invocations?${query}`)).json().items).toHaveLength(1);
    await h.restart();
    expect((await h.get(`/capabilities?${query}&dimension=mcp_tool`)).json().items).toEqual(response.json().items);
  });

  it("fills a legacy count-only MCP wrapper call from retained Runtime content without a second call", async () => {
    const h = await setup(true, true), query = `sessionId=${h.ids.mcpSessionId}`;
    const response = await h.get(`/capabilities?${query}&dimension=mcp_tool`), item = response.json().items[0];
    expect(response.json()).toMatchObject({ dimension: "mcp_tool", total: 1 });
    expect(item).toMatchObject({ calls: 1, observedArgumentCalls: 1, observedResultCalls: 1, totalInputTokens: null,
      capability: { id: "mcp:7:search", serverId: "7" } });
    expect(item.observedArgumentTokens).toBeGreaterThan(0);
    expect(item.observedResultTokens).toBeGreaterThan(0);
    expect(item.observedTotalTokens).toBe(item.observedArgumentTokens + item.observedResultTokens);
    const invocations = (await h.get(`/invocations?${query}`)).json().items;
    expect(invocations).toHaveLength(1);
    expect(invocations[0].sourceId).toBe("mcp-observer:7");
    const detail = await h.get(`/invocations/${invocations[0].id}`);
    expect(detail.body).not.toContain(privateArgument); expect(detail.body).not.toContain(privateResult);
    await h.restart();
    expect((await h.get(`/capabilities?${query}&dimension=mcp_tool`)).json().items).toEqual(response.json().items);
  });
});
