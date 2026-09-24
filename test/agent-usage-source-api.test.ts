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
import { ProviderExtensionManager } from "../src/provider-extensions/provider-extension-manager.js";
import { ProviderExtensionProjector } from "../src/runtime/provider-extension-projector.js";

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
  it("collects native Claude plugin instructions into cumulative Skill and plugin API rankings", async () => {
    const { app, db, root, manager, session } = await setup();
    await manager.collector.stopRecovery();
    const agentId = Number(manager.collector.binding(session.id).agentId);
    db.prepare("UPDATE agents SET provider='claude_code' WHERE id=?").run(agentId);
    db.prepare("UPDATE sessions SET provider_session_id='claude-native' WHERE id=?").run(session.id);
    const runId = Number(db.prepare(`INSERT INTO runs(session_id,status,input,created_at,started_at,resolved_model)
      VALUES (?,'succeeded','hello','2026-09-24T00:00:00Z','2026-09-24T00:00:00Z','gpt-4.1')`).run(session.id).lastInsertRowid);
    const host = join(root, "host-claude"), source = join(host, "plugins", "cache", "official", "review", "1", "skills", "inspect");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "---\nname: inspect\n---\nhello world");
    await writeFile(join(host, "settings.json"), JSON.stringify({ enabledPlugins: { "review@official": true } }));
    const extensions = new ProviderExtensionManager({ db, claudeHome: host });
    extensions.setEnabled(agentId, "plugin:review@official", true);
    const home = join(root, "agents", String(agentId), "provider-home", "claude");
    const skills = await new ProviderExtensionProjector(extensions, root).prepare({ agentId, provider: "claude_code", home });
    manager.collector.runtimeCapabilities.recordRun(runId);
    manager.collector.runtimeCapabilities.recordProjection(runId, skills);
    const args = { skill: "review:inspect" }, result = "Launching skill: review:inspect", body = "hello world";
    const assistant = (id: string, content: object[]) => ({ type: "assistant", uuid: id,
      message: { id, role: "assistant", model: "gpt-4.1", content, stop_reason: "end_turn",
        usage: { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 } } });
    const records = [
      { type: "user", uuid: "u1", message: { role: "user", content: "hello" } },
      assistant("m1", [{ type: "tool_use", id: "load", name: "Skill", input: args }]),
      { type: "user", uuid: "u2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "load", content: result }] } },
      { type: "user", uuid: "u3", isMeta: true, sourceToolUseID: "load", message: { role: "user", content: body } },
      assistant("m2", [{ type: "text", text: "hello" }]),
      { type: "user", uuid: "u4", message: { role: "user", content: "hello" } },
      assistant("m3", [{ type: "text", text: "hello" }])
    ];
    const logs = join(home, "projects", "workspace");
    await mkdir(logs, { recursive: true });
    await writeFile(join(logs, "claude-native.jsonl"), records.map((record, index) => JSON.stringify({ ...record, sessionId: "claude-native",
      timestamp: new Date(Date.parse("2026-09-24T01:00:00Z") + index * 1000).toISOString() })).join("\n") + "\n");
    await manager.collector.collectSession(session.id);
    await manager.collector.collectSession(session.id);
    const count = async (text: string) => (await manager.collector.attribution.measureContent(text, "result", "gpt-4.1"))!.tokens!;
    const expected = 2 * (await count(JSON.stringify(args)) + await count(result) + await count(body));
    const query = `sessionId=${session.id}&from=2026-09-24T00:00:00Z&to=2026-09-25T00:00:00Z`;
    for (const dimension of ["skill", "plugin"]) {
      const ranking = (await app.inject({ url: `/api/usage/capabilities?${query}&dimension=${dimension}`, headers })).json();
      expect(ranking.items).toHaveLength(1);
      expect(ranking.items[0].totalInputTokens).toBe(expected);
    }
    const prompts = (await app.inject({ url: `/api/usage/capabilities?${query}&dimension=user_prompt`, headers })).json();
    expect(prompts.items[0].totalInputTokens).toBe(4 * await count("hello"));
    const summary = (await app.inject({ url: `/api/usage/summary?${query}`, headers })).json();
    expect(summary).toMatchObject({ usage: { totalTokens: 3030 }, contextAnalysis: { requests: 3, estimatedInputTokens: expected + 5 * await count("hello") } });
  });

  it("stores MCP definitions only when configuration changes and resolves the snapshot for each Run", async () => {
    const { db, manager, session } = await setup();
    await manager.collector.stopRecovery();
    const run = db.prepare(`INSERT INTO runs(session_id,status,input,created_at,started_at)
      VALUES (?,'succeeded','prompt',?,?)`);
    const profiles = manager.collector.transcriptProfiles;
    const servers = [{ type: "stdio" as const, name: "server", command: "unused", args: [], env: [],
      usageIdentity: { serverId: "12", tools: ["lookup"], definitions: [{ name: "lookup", description: "Lookup" }] } }];
    for (const [time, tools] of [["2026-09-24T00:00:00Z", servers], ["2026-09-24T01:00:00Z", servers],
      ["2026-09-24T02:00:00Z", []]] as const) {
      const id = Number(run.run(session.id, time, time).lastInsertRowid);
      profiles.record(session.id, id, tools);
    }
    expect(db.prepare("SELECT run_id FROM agent_usage_context_profiles").all()).toHaveLength(2);
    expect(profiles.profile(String(session.id), "2026-09-24T01:30:00Z").tools[0]?.capability.id).toBe("mcp:12:lookup");
    expect(profiles.profile(String(session.id), "2026-09-24T02:30:00Z").tools).toEqual([]);
  });

  it("automatically turns managed transcripts and frozen MCP schemas into cumulative rankings and scoped totals", async () => {
    const { app, db, root, manager, session } = await setup();
    await manager.collector.stopRecovery();
    db.prepare("UPDATE sessions SET provider_session_id='transcript-session' WHERE id=?").run(session.id);
    const runId = Number(db.prepare(`INSERT INTO runs(session_id,status,input,created_at,started_at,resolved_model)
      VALUES (?,'succeeded','hello','2026-09-24T00:00:00Z','2026-09-24T00:00:00Z','gpt-4.1')`).run(session.id).lastInsertRowid);
    manager.collector.runtimeCapabilities.recordRun(runId);
    manager.collector.transcriptProfiles.record(session.id, runId, [{ type: "stdio", name: "server", command: "unused", args: [], env: [],
      usageIdentity: { serverId: "12", tools: ["lookup"], definitions: [{ name: "lookup", description: "Look up a record", inputSchema: { type: "object" } }] } }]);
    const home = join(root, "agents", manager.collector.binding(session.id).agentId, "provider-home", "codex", "sessions", String(session.id), "sessions");
    await mkdir(home, { recursive: true });
    const records = [
      { type: "session_meta", payload: { id: "transcript-session" } },
      { type: "turn_context", payload: { model: "gpt-4.1", turn_id: "turn" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } },
      { type: "response_item", payload: { type: "function_call", call_id: "call", name: "mcp__server__lookup", arguments: "{}" } },
      ...[1, 2, 3].flatMap(number => [
        ...(number === 2 ? [{ type: "response_item", payload: { type: "function_call_output", call_id: "call", output: "hello world" } }] : []),
        { type: "event_msg", payload: { type: "token_count", info: {
          total_token_usage: { input_tokens: number * 100, output_tokens: number * 10, total_tokens: number * 110 },
          last_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 }
        } } }
      ])
    ];
    await writeFile(join(home, "rollout-transcript-session.jsonl"), records.map((record, index) => JSON.stringify({ ...record,
      timestamp: new Date(Date.parse("2026-09-24T01:00:00Z") + index * 1000).toISOString() })).join("\n") + "\n");
    await manager.collector.collectSession(session.id);
    await manager.collector.collectSession(session.id);
    const query = `sessionId=${session.id}&from=2026-09-24T00:00:00Z&to=2026-09-25T00:00:00Z`;
    const ranking = (await app.inject({ url: `/api/usage/capabilities?${query}&dimension=mcp_tool`, headers })).json();
    expect(ranking.items).toHaveLength(1);
    expect(ranking.items[0]).toMatchObject({ capability: { id: "mcp:12:lookup" }, firstResultInputTokens: 2, repeatedResultInputTokens: 2 });
    expect(ranking.items[0].definitionInputTokens).toBeGreaterThan(0);
    const summary = (await app.inject({ url: `/api/usage/summary?${query}`, headers })).json();
    expect(summary).toMatchObject({ usage: { totalTokens: 330 }, contextAnalysis: { requests: 3, reconstructedRequests: 3, reportedInputTokens: 300 } });
    expect((await app.inject({ url: `/api/usage/session-summaries?ids=${session.id}`, headers })).json().items[0].summary.usage.totalTokens).toBe(330);
    expect((await app.inject({ url: `/api/usage/summary?agentId=${manager.collector.binding(session.id).agentId}`, headers })).json().usage.totalTokens).toBe(330);
    expect((await app.inject({ url: "/api/usage/capabilities?sessionId=99999", headers })).json().items).toEqual([]);
    const checkpoint = db.prepare("SELECT checkpoint FROM agent_usage_sources").get() as { checkpoint: string };
    expect(checkpoint.checkpoint).not.toContain("hello world");
    expect(ranking.items[0].attributionEvidence.inferred).toBeGreaterThan(0);
  });

  it("reads Skill projections once per Run during collection and refreshes them on the next collection", async () => {
    const { db, manager, session } = await setup();
    await manager.collector.stopRecovery();
    const runIds = ["2026-09-24T00:00:00Z", "2026-09-24T01:00:00Z"].map(time => Number(db.prepare(`
      INSERT INTO runs(session_id,status,input,created_at,started_at) VALUES (?,'succeeded','hello',?,?)`)
      .run(session.id, time, time).lastInsertRowid));
    const skills = runIds.map(id => ({ id: `skill-${id}`, name: `Skill ${id}`, revision: "1", source: "local" as const,
      skillMdPath: "/workspace/skills/review/SKILL.md", directoryAliases: ["/workspace/skills/review"] }));
    for (const [index, id] of runIds.entries()) manager.collector.runtimeCapabilities.recordProjection(id, [skills[index]!]);
    const prepare = vi.spyOn(db, "prepare");
    const tagger = manager.collector.transcriptProfiles.skillTagger(String(session.id));
    for (let index = 0; index < 100; index++) {
      expect(tagger("Read", { file_path: skills[0]!.skillMdPath }, "2026-09-24T00:30:00Z")[0]?.id).toBe(skills[0]!.id);
    }
    expect(prepare.mock.calls.filter(([sql]) => sql.includes("SELECT capability_json,plugin_json"))).toHaveLength(1);
    expect(tagger("Read", { file_path: skills[1]!.skillMdPath }, "2026-09-24T01:30:00Z")[0]?.id).toBe(skills[1]!.id);
    expect(prepare.mock.calls.filter(([sql]) => sql.includes("SELECT capability_json,plugin_json"))).toHaveLength(2);
    const runQuery = prepare.mock.calls.find(([sql]) => sql.includes("SELECT r.id,r.resolved_model"))![0];
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${runQuery}`).all(manager.collector.namespace, String(session.id),
      String(session.id), "2026-09-24T01:30:00Z") as Array<{ detail: string }>;
    expect(plan.map(row => row.detail).join(" ")).toContain("runs_session_started");
    expect(plan.map(row => row.detail).join(" ")).not.toContain("TEMP B-TREE");
    prepare.mockRestore();
    manager.collector.runtimeCapabilities.recordProjection(runIds[1]!, []);
    const refreshed = manager.collector.transcriptProfiles.skillTagger(String(session.id));
    expect(refreshed("Read", { file_path: skills[1]!.skillMdPath }, "2026-09-24T01:30:00Z")).toEqual([]);
  });

  it("does not treat scanned unsupported events as actual usage evidence", async () => {
    const { app, db, session, manager } = await setup([]);
    await manager.collector.stopRecovery();
    const runId = Number(db.prepare("INSERT INTO runs(session_id,status,input,created_at) VALUES (?,'succeeded','test',?)")
      .run(session.id, "2026-09-21T00:00:00.000Z").lastInsertRowid);
    db.prepare("INSERT INTO events(run_id,seq,type,content_json,created_at) VALUES (?,1,'tool','{}',?)")
      .run(runId, "2026-09-21T00:00:00.000Z");
    while (await manager.collector.contentBackfill.step()) { /* finish retained events */ }
    const response = await app.inject({ url: `/api/usage/summary?sessionId=${session.id}`, headers });
    expect(response.json()).toMatchObject({ analysisStatus: "ready", hasCapabilityEvidence: true,
      contentBackfill: { status: "completed", processedEvents: 1 },
      usage: { totalTokens: null } });
    await manager.collector.runtimeCapabilities.recordTool(runId, { toolCallId: "read", kind: "read", status: "completed", rawOutput: "result" });
    expect((await app.inject({ url: `/api/usage/summary?sessionId=${session.id}`, headers })).json())
      .toMatchObject({ analysisStatus: "ready", hasCapabilityEvidence: true });
  });
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
  it("rebuilds an unchanged Codex source on request without duplicating reported usage", async () => {
    const { app, db, root, manager, registration, session } = await setup([]);
    await manager.collector.stopRecovery();
    const line = (type: string, payload: object) => JSON.stringify({ timestamp: "2026-09-24T01:00:00Z", type, payload });
    const usage = (input: number) => line("event_msg", { type: "token_count", info: {
      total_token_usage: { input_tokens: input, output_tokens: input / 10, total_tokens: input + input / 10 },
      last_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 }
    } });
    await writeFile(join(root, "codex.jsonl"), [
      line("session_meta", { id: "codex-session-1" }),
      line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "prompt" }] }),
      line("response_item", { type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: "thought" }] }),
      usage(100), usage(200)
    ].join("\n") + "\n");
    const registered = await register(app, registration);
    const sourceId = registered.json().id as string;
    expect((await app.inject({ method: "POST", url: `/api/usage/sources/${sourceId}/collect`, headers })).statusCode).toBe(202);
    await vi.waitFor(() => expect(manager.collector.sources.listSources(manager.collector.namespace)[0]?.status).toBe("completed"));
    const filter = { namespace: manager.collector.namespace, sessionId: String(session.id) };
    const reported = manager.collector.attribution.contextSummary(filter).reportedInputTokens;
    const checkpoint = db.prepare("SELECT checkpoint FROM agent_usage_sources WHERE id=?").get(sourceId) as { checkpoint: string };
    db.prepare("UPDATE agent_usage_sources SET checkpoint=? WHERE id=?")
      .run(JSON.stringify({ ...JSON.parse(checkpoint.checkpoint) as object, version: 2 }), sourceId);
    db.prepare("UPDATE agent_usage_contexts SET revision=revision/2 WHERE session_id=?").run(String(session.id));
    db.prepare(`DELETE FROM agent_usage_exposures WHERE context_id IN
      (SELECT context_id FROM agent_usage_contexts WHERE session_id=?)
      AND json_extract(capability_key,'$[0]')='assistant_thought'`).run(String(session.id));
    const before = manager.collector.attribution.contextSummary(filter).estimatedInputTokens;
    expect(manager.collector.attribution.rankings(filter, "assistant_thought")).toHaveLength(0);
    expect((await app.inject({ method: "POST", url: `/api/usage/sources/${sourceId}/collect`, headers })).statusCode).toBe(202);
    await vi.waitFor(() => expect(manager.collector.sources.listSources(manager.collector.namespace)[0]?.status).toBe("completed"));
    expect(manager.collector.attribution.contextSummary(filter).estimatedInputTokens).toBe(before);
    const response = await app.inject({ method: "POST", url: `/api/usage/sources/${sourceId}/collect`, headers,
      payload: { rebuild: true } });
    expect(response.statusCode).toBe(202);
    await vi.waitFor(() => expect(manager.collector.attribution.rankings(filter, "assistant_thought")[0]?.totalInputTokens).toBeGreaterThan(0));
    expect(manager.collector.attribution.contextSummary(filter).reportedInputTokens).toBe(reported);
    expect(manager.collector.attribution.contextSummary(filter).estimatedInputTokens).toBeGreaterThan(before!);
  });
  it("imports and ranks a complete model-tokenized result beyond the old block and context limits", async () => {
    const { app, root, manager, registration } = await setup();
    const snapshot = snapshotFixture();
    const content = "hello world ".repeat(100000);
    snapshot.requests[1].canonical_request_body = JSON.stringify({ model: "gpt-4.1", input: [
      { type: "function_call_output", call_id: "call-1", output: content }
    ] });
    await writeFile(join(root, "large.json"), JSON.stringify(snapshot));
    const registered = await register(app, { ...registration, sourceKey: "large", kind: "context_snapshot",
      inputRef: { importRootId: "fixtures", relativePath: "large.json" },
      mappings: [{ ...registration.mappings[0], sourceSessionKey: "capture-session" }] });
    expect(registered.statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `/api/usage/sources/${registered.json().id}/collect`, headers })).statusCode).toBe(202);
    await vi.waitFor(() => expect(manager.collector.sources.listSources(manager.collector.namespace)[0]?.status).toBe("completed"), { timeout: 5000 });
    const response = await app.inject({ url: "/api/usage/capabilities?dimension=mcp_tool&sort=totalInputTokens", headers });
    expect(response.json().items[0]).toMatchObject({ firstResultInputTokens: 200000, missingExposureCount: 0,
      tokenEstimates: [expect.objectContaining({ method: "model_tokenizer", reason: null })] });
    expect(response.body).not.toContain(content.slice(0, 100));
    expect((await app.inject({ url: "/api/usage/summary", headers })).json().usage.totalTokens).toBe(280);
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
