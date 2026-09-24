import { fixtureTokenizers } from "./fixtures/agent-usage/tokenizers/helpers.js";
import { afterEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { createTestDatabase } from "./helpers.js";
import { HostUsageCollector } from "../src/agent-usage/host-collector.js";
import { HostUsageCapture } from "../src/agent-usage/capture/host-capture.js";
import { ModelTokenizers } from "../src/agent-usage/core/tokenizers.js";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
async function setup() {
  const { db, seed } = createTestDatabase(); cleanup.push(() => db.close());
  const session = seed.session(); seed.run(session.id, "running");
  const run = (db.prepare("SELECT id FROM runs WHERE session_id=?").get(session.id) as { id: number }).id;
  const host = new HostUsageCollector(db, {}, undefined, fixtureTokenizers());
  let responseId = 0; let holding = false; let release: (() => void) | undefined;
  const upstream: Server = createServer((req, res) => { req.resume(); req.on("end", () => { const send = () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id: `r${++responseId}`, output: [{ type: "function_call", call_id: "call1", name: "mcp__docs__search", arguments: "{}" }], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } })); }; if (holding) release = send; else send(); }); });
  await new Promise<void>((resolve, reject) => { upstream.once("error", reject); upstream.listen(0, "127.0.0.1", resolve); });
  cleanup.push(() => new Promise<void>((resolve) => { upstream.closeAllConnections(); upstream.close(() => resolve()); }));
  const capture = new HostUsageCapture(host, { codex: { baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`, protocol: "responses", apiKeyEnv: "CAPTURE_KEY" } }, new Map([["codex", "secret-sentinel"]]));
  cleanup.push(() => capture.close());
  const route = await capture.prepare({ sessionId: session.id, provider: "codex", providerSessionId: null, workspacePath: "/workspace", mcpServers: [{ name: "docs", type: "stdio", command: "fake", args: [], env: [], usageIdentity: { serverId: "7", tools: ["search"] } }] });
  return { db, host, capture, route: route!, session, run, seed, hold: () => { holding = true; }, resume: () => { holding = false; release?.(); } };
}
it("automatically reports totals and MCP definition/repeated-result exposure with no snapshot import", async () => {
  const { db, host, capture, route, session, run } = await setup();
  expect(capture.health({})).toEqual([expect.objectContaining({ status: "waiting", sessionId: String(session.id) })]);
  capture.startRun(session.id, run);
  const replay = [{ type: "function_call", call_id: "call1", name: "mcp__docs__search", arguments: "{}" },
    { type: "function_call_output", call_id: "call1", output: "SYNTHETIC_PAYLOAD_SENTINEL" }];
  const snapshots = [];
  for (const input of [[], replay, replay]) {
    await (await fetch(route.baseUrl + "/responses", { method: "POST", body: JSON.stringify({ model: "fixture-model", input, tools: [{ type: "function", name: "mcp__docs__search", parameters: { type: "object" } }] }) })).text(); await capture.drain();
    snapshots.push(host.attribution.rankings({}, "mcp_tool")[0]!);
  }
  expect(host.store.summary().usage.totalTokens).toBe(36);
  const [first, second, cumulative] = snapshots;
  expect(cumulative).toMatchObject({ capability: { id: "mcp:7:search", serverId: "7" }, calls: 0,
    exposureCount: 7, contextCoverage: { full: 3, partial: 0, opaque: 0, none: 0 } });
  expect(cumulative!.definitionInputTokens).toBe(first!.definitionInputTokens! * 3);
  expect(cumulative!.argumentInputTokens).toBe(second!.argumentInputTokens! * 2);
  expect(cumulative!.firstResultInputTokens).toBe(second!.firstResultInputTokens);
  expect(cumulative!.repeatedResultInputTokens).toBe(second!.firstResultInputTokens);
  expect(cumulative!.totalInputTokens).toBe(cumulative!.definitionInputTokens! + cumulative!.argumentInputTokens!
    + cumulative!.firstResultInputTokens! + cumulative!.repeatedResultInputTokens!);
  expect(db.serialize().includes(Buffer.from("SYNTHETIC_PAYLOAD_SENTINEL"))).toBe(false);
  expect(db.serialize().includes(Buffer.from("secret-sentinel"))).toBe(false);
  expect(capture.health({})[0]).toMatchObject({ status: "observed", observed: 3 });
});
it("marks server-side conversation history as partial even after a complete HTTP exchange", async () => {
  const { host, capture, route, session, run } = await setup(); capture.startRun(session.id, run);
  await (await fetch(route.baseUrl + "/responses", { method: "POST", body: JSON.stringify({
    previous_response_id: "earlier-response", input: [],
    tools: [{ type: "function", name: "mcp__docs__search", parameters: {} }]
  }) })).text();
  await capture.drain();
  expect(host.attribution.rankings({}, "mcp_tool")[0]?.contextCoverage)
    .toEqual({ full: 0, partial: 1, opaque: 0, none: 0 });
});
it.each(["ready", "close"])("keeps reported usage while vocabulary is pending and handles %s without persisting fallback counts", async outcome => {
  const { db, host, capture, route, session, run } = await setup(); capture.startRun(session.id, run);
  let ready = false;
  const count = ModelTokenizers.prototype.countAsync;
  vi.spyOn(ModelTokenizers.prototype, "countAsync").mockImplementation(async function (text, model, provider) {
    return ready ? count.call(this, text, model, provider) : { ...this.describe(model, provider), tokens: null, method: "unavailable", reason: "tokenizer_pending" };
  });
  await (await fetch(route.baseUrl + "/responses", { method: "POST", body: JSON.stringify({ model: "fixture-model",
    tools: [{ type: "function", name: "mcp__docs__search", parameters: {} }], input: [] }) })).text();
  await vi.waitFor(() => expect(host.store.summary().usage.totalTokens).toBe(12));
  expect(capture.health({})[0].status).toBe("pending");
  expect(db.prepare("SELECT * FROM agent_usage_exposures").all()).toEqual([]);
  if (outcome === "ready") {
    ready = true;
    await capture.drain();
    expect(capture.health({})[0].status).toBe("observed");
    expect(host.attribution.rankings({}, "mcp_tool")[0].tokenEstimates[0]).toMatchObject({ method: "model_tokenizer", reason: null });
  } else {
    await capture.close();
    expect(capture.health({})[0].status).toBe("incomplete");
    expect(db.prepare("SELECT * FROM agent_usage_exposures").all()).toEqual([]);
  }
  expect(host.store.summary().usage.totalTokens).toBe(12);
});
it("does not rewrite unchanged tool call cache rows on subsequent requests", async () => {
  const { db, capture, route, session, run } = await setup(); capture.startRun(session.id, run);
  const send = async () => { await (await fetch(route.baseUrl + "/responses", { method: "POST", body: '{"input":[]}' })).text(); await capture.drain(); };
  await send();
  db.exec(`CREATE TABLE cache_writes (operation TEXT);
    CREATE TRIGGER cache_insert AFTER INSERT ON agent_usage_capture_calls BEGIN INSERT INTO cache_writes VALUES ('insert'); END;
    CREATE TRIGGER cache_delete AFTER DELETE ON agent_usage_capture_calls BEGIN INSERT INTO cache_writes VALUES ('delete'); END;
    CREATE TRIGGER cache_update AFTER UPDATE ON agent_usage_capture_calls BEGIN INSERT INTO cache_writes VALUES ('update'); END;`);
  await send();
  expect(db.prepare("SELECT * FROM cache_writes").all()).toEqual([]);
  expect(db.prepare("SELECT * FROM agent_usage_capture_calls").all()).toHaveLength(1);
});
it("deduplicates MCP aliases and excludes every identity for ambiguous runtime names", async () => {
  const { capture, host, session, run } = await setup();
  const server = (serverId: string) => ({ name: "docs", type: "stdio" as const, command: "fake", args: [], env: [],
    usageIdentity: { serverId, tools: ["search", "search"] } });
  const route = await capture.prepare({ sessionId: session.id, provider: "codex", workspacePath: "/workspace",
    mcpServers: [server("7"), server("8"), server("7")] });
  capture.startRun(session.id, run);
  await (await fetch(route!.baseUrl + "/responses", { method: "POST", body: JSON.stringify({
    input: [], tools: [{ type: "function", name: "mcp__docs__search", parameters: {} }]
  }) })).text();
  await capture.drain();
  expect(host.attribution.rankings({}, "mcp_tool")).toEqual([]);
  expect(host.attribution.rankings({}, "unknown")[0]?.capability.name).toBe("mcp__docs__search");
});
it("retries call identity persistence after a transaction rolls back", async () => {
  const { db, host, capture, route, session, run } = await setup(); capture.startRun(session.id, run);
  const callId = `${host.epoch(session.id)}:retry-call`;
  const send = async () => {
    await (await fetch(route.baseUrl + "/responses", { method: "POST", body: JSON.stringify({ input: [
      { type: "function_call", call_id: "retry-call", name: "mcp__docs__search", arguments: "{}" }
    ] }) })).text(); await capture.drain();
  };
  db.exec(`CREATE TRIGGER fail_capture_commit BEFORE UPDATE ON agent_usage_capture_sessions
    BEGIN SELECT RAISE(ABORT, 'synthetic_commit_failure'); END;`);
  await send();
  expect(db.prepare("SELECT call_id FROM agent_usage_capture_calls WHERE call_id=?").get(callId)).toBeUndefined();
  expect(db.prepare("SELECT error_code FROM agent_usage_captures").get()).toEqual({ error_code: "capture_processing_failed" });
  db.exec("DROP TRIGGER fail_capture_commit");
  await send();
  expect(db.prepare("SELECT call_id FROM agent_usage_capture_calls WHERE call_id=?").get(callId)).toEqual({ call_id: callId });
});
it("freezes Run identity across reused sessions and fences reset/delete", async () => {
  const { db, host, capture, route, session, run, seed } = await setup(); capture.startRun(session.id, run);
  await (await fetch(route.baseUrl + "/responses", { method: "POST", body: '{"input":"one"}' })).text(); await capture.drain();
  capture.endRun(session.id, run); db.prepare("UPDATE runs SET status='succeeded' WHERE id=?").run(run); seed.run(session.id, "running"); const second = db.prepare("SELECT MAX(id) AS id FROM runs").get() as { id: number }; capture.startRun(session.id, second.id);
  await (await fetch(route.baseUrl + "/responses", { method: "POST", body: '{"input":"two"}' })).text(); await capture.drain();
  expect(host.store.records().map((row) => row.executionId)).toEqual([String(run), String(second.id)]);
  await host.prepareMaintenance(session.id, "reset"); host.finishMaintenance(session.id);
  await (await fetch(route.baseUrl + "/responses", { method: "POST", body: '{}' })).text(); await capture.drain();
  expect(host.store.records()).toHaveLength(2);
  host.deleteSession(session.id); await capture.drain(); expect(host.store.records()).toHaveLength(0);
});
it("reports failed capture health through the management summary without persisting payloads", async () => {
  const { host, capture, route, session, run } = await setup(); capture.startRun(session.id, run);
  await (await fetch(route.baseUrl + "/responses", { method: "POST", headers: { "content-encoding": "unknown" }, body: 'SYNTHETIC_PRIVATE_BODY' })).text(); await capture.drain();
  const { default: Fastify } = await import("fastify"); const { registerUsageQueryRoutes } = await import("../src/agent-usage/query-routes.js");
  const app = Fastify(); registerUsageQueryRoutes(app, host); cleanup.push(() => app.close());
  const result = (await app.inject({ url: "/usage/summary" })).json();
  expect(result.captureHealth).toEqual([expect.objectContaining({ status: "incomplete", errorCode: "unsupported_encoding", incomplete: 1 })]);
  expect(result.analysisStatus).toBe("partial"); expect(result.completeness).toBe("partial");
});
it.each([
  ["Skill", { skill: "Review" }],
  ["Skill", { skill: "Review plugin:Review" }],
  ["Read", { path: "/workspace/skills/review/SKILL.md" }],
  ["exec_command", { command: "rtk proxy cat SKILL.md", workdir: "/workspace/skills/review" }],
  ["exec_command", { command: "python /workspace/skills/review/scripts/check.py" }]
])("associates confirmed Skill and plugin ownership per %s call, never the definition or unrelated Read", async (toolName, args) => {
  const { host, capture, route, session, run } = await setup(); capture.startRun(session.id, run);
  host.runtimeCapabilities.recordProjection(run, [{ id: "skill1", name: "Review", revision: "1", skillMdPath: "/workspace/skills/review/SKILL.md", directoryAliases: ["/workspace/skills/review"], source: "local", pluginId: "plugin1", pluginName: "Review plugin" }]);
  const body = { model: "fixture-model", tools: [{ type: "function", name: "Read", parameters: {} }], input: [
    { type: "function_call", call_id: "skill-call", name: toolName, arguments: JSON.stringify(args) },
    { type: "function_call_output", call_id: "skill-call", output: "skill content" },
    { type: "function_call", call_id: "plain-call", name: "Read", arguments: '{"path":"/workspace/README.md"}' },
    { type: "function_call_output", call_id: "plain-call", output: "plain content" }
  ] };
  await (await fetch(route.baseUrl + "/responses", { method: "POST", body: JSON.stringify(body) })).text(); await capture.drain();
  const skill = host.attribution.rankings({}, "skill")[0]!; const plugin = host.attribution.rankings({}, "plugin")[0]!;
  expect(skill.capability.id).toBe("skill1"); expect(plugin.capability.id).toBe("plugin1");
  expect(skill.definitionInputTokens).toBe(0); expect(skill.firstResultInputTokens).toBeGreaterThan(0);
  expect(skill.exposureCount).toBe(2);
});
it.each(["removed", "replaced"])("preserves historical Skill and plugin ownership after the projection is %s", async (change) => {
  const { db, host, capture, route, session, run, seed } = await setup();
  capture.startRun(session.id, run);
  const skill = { id: "original", name: "Original", revision: "1", source: "local" as const,
    skillMdPath: "/workspace/skills/review/SKILL.md", directoryAliases: ["/workspace/skills/review"],
    pluginId: "original-plugin", pluginName: "Original plugin" };
  host.runtimeCapabilities.recordProjection(run, [skill]);
  const body = JSON.stringify({ model: "fixture-model", input: [
    { type: "function_call", call_id: "historical-read", name: "Read", arguments: JSON.stringify({ path: skill.skillMdPath }) },
    { type: "function_call_output", call_id: "historical-read", output: "original skill content" }
  ] });
  const send = async () => {
    await (await fetch(route.baseUrl + "/responses", { method: "POST", body })).text();
    await capture.drain();
  };
  await send();
  capture.endRun(session.id, run);
  db.prepare("UPDATE runs SET status='succeeded' WHERE id=?").run(run);
  seed.run(session.id, "running");
  const next = (db.prepare("SELECT MAX(id) AS id FROM runs").get() as { id: number }).id;
  host.runtimeCapabilities.recordProjection(next, change === "removed" ? [] : [
    { ...skill, id: "replacement", revision: "2", pluginId: "replacement-plugin" }
  ]);
  capture.startRun(session.id, next);
  await send();
  for (const dimension of ["skill", "plugin"] as const) {
    const rows = host.attribution.rankings({}, dimension);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ capability: { id: dimension === "skill" ? "original" : "original-plugin" }, exposureCount: 4 });
    expect(rows[0]!.repeatedResultInputTokens).toBeGreaterThan(0);
  }
});

it("attributes built-in and structured CLI input to the same capabilities as Runtime execution", async () => {
  const { host, capture, route, session, run } = await setup();
  capture.startRun(session.id, run);
  for (const [id, kind, rawInput] of [
    ["read-call", "read", { path: "/workspace/README.md" }],
    ["git-call", "execute", { argv: ["git", "status"] }]
  ] as const) {
    await host.runtimeCapabilities.recordTool(run, { toolCallId: id, kind, rawInput, status: "in_progress" });
    await host.runtimeCapabilities.recordTool(run, { toolCallId: id, kind, rawInput, status: "completed", rawOutput: "result" });
  }
  const body = JSON.stringify({ model: "fixture-model", tools: [
    { type: "function", name: "Read", parameters: {} }, { type: "function", name: "exec_command", parameters: {} }
  ], input: [
    { type: "function_call", call_id: "read-call", name: "Read", arguments: '{"path":"/workspace/README.md"}' },
    { type: "function_call_output", call_id: "read-call", output: "read result" },
    { type: "function_call", call_id: "git-call", name: "exec_command", arguments: '{"argv":["git","status"]}' },
    { type: "function_call_output", call_id: "git-call", output: "git result" }
  ] });
  for (let index = 0; index < 2; index++) {
    await (await fetch(route.baseUrl + "/responses", { method: "POST", body })).text();
    await capture.drain();
  }
  expect(host.attribution.rankings({}, "builtin_tool")).toEqual([
    expect.objectContaining({ capability: expect.objectContaining({ id: "runtime:codex:builtin:read" }), calls: 1, exposureCount: 6 })
  ]);
  const cli = host.attribution.rankings({}, "cli");
  expect(cli.find((row) => row.capability.name === "git")).toMatchObject({ calls: 1, exposureCount: 4 });
  expect(cli.find((row) => row.capability.name === "git")!.repeatedResultInputTokens).toBeGreaterThan(0);
  // A generic shell definition does not belong to every executable invoked through it.
  expect(cli.find((row) => row.capability.name === "Shell command")).toMatchObject({ calls: 0, exposureCount: 2 });
  expect(host.attribution.rankings({}, "unknown")).toEqual([]);
});
it.each(["capture-first", "native-first"])("reconciles Claude native message identity in %s order, keeping terminal native evidence over partial capture", async (order) => {
  const { host, session } = await setup(); const { parseProviderLog } = await import("../src/agent-usage/adapters/provider-logs.js");
  const binding = host.binding(session.id); const epoch = host.epoch(session.id);
  const native = parseProviderLog("claude_log", [JSON.stringify({ type: "assistant", sessionId: "provider-1", requestId: "req", uuid: "uuid", timestamp: "2026-09-21T00:00:00Z", message: { role: "assistant", id: "msg1", stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })])[0]!.observation;
  const observed = { ...native, sourceId: "http_capture", sourcePriority: 10, eventId: "capture", finality: "interim" as const, metrics: { inputTotalTokens: 10, outputTotalTokens: 1, totalTokens: 11 } };
  for (const row of order === "capture-first" ? [observed, native] : [native, observed]) host.store.observe(binding, { ...row, providerEpochId: epoch });
  expect(host.store.summary().usage.totalTokens).toBe(14); expect(host.store.summary().observedModelRequests).toBe(1);
});
it.each([false, true])("selects capture request date basis without adding native intervals (full capture=%s)", async (full) => {
  const { host, session } = await setup(); const binding = host.binding(session.id); const epoch = host.epoch(session.id);
  const common = { sourceVersion: "1", providerEpochId: epoch, semantics: "snapshot" as const, occurredAt: "2026-09-21T01:00:00Z", revision: 1, finality: "final" as const, measurement: "reported" as const, normalizationProfile: "test", executionId: null, invocationId: null };
  for (const row of [{ ...common, sourceId: "native", eventId: "parent", coverageId: "parent", scope: "provider_session" as const, metrics: { totalTokens: 190 } },
    { ...common, sourceId: "native", eventId: "interval", coverageId: "interval", scope: "interval" as const, intervalStart: "2026-09-21T00:00:00Z", metrics: { totalTokens: 70 } },
    ...[...(full ? [120] : []), 70].map((total, i) => ({ ...common, sourceId: "http_capture", sourcePriority: 10, eventId: `req${i}`, coverageId: `req${i}`, invocationId: `req${i}`, scope: "model_request" as const, metrics: { totalTokens: total } }))]) host.store.observe(binding, row);
  expect(host.store.summary({ from: "2026-09-21T00:00:00Z", to: "2026-09-22T00:00:00Z" }).usage.totalTokens).toBe(full ? 190 : 70);
  expect(host.store.summary().unplacedUsage.totalTokens).toBe(full ? 0 : 120);
});

it("late response remains attached to its admitted Run; reset interrupts work without repopulating the new epoch", async () => {
  const { db, host, capture, route, session, run, seed, hold, resume } = await setup(); capture.startRun(session.id, run); hold();
  const pending = fetch(route.baseUrl + "/responses", { method: "POST", body: '{}' }).then((res) => res.text());
  await vi.waitFor(() => expect(capture.health({})[0]?.status).toBe("pending"));
  db.prepare("UPDATE runs SET status='succeeded' WHERE id=?").run(run); seed.run(session.id, "running"); capture.startRun(session.id, 2);
  resume(); await pending; await capture.drain(); expect(host.store.records()[0]?.executionId).toBe(String(run));
  hold(); const stale = fetch(route.baseUrl + "/responses", { method: "POST", body: '{}' }).then((res) => res.text()).catch(() => "aborted");
  await vi.waitFor(() => expect(capture.health({})[0]?.status).toBe("pending"));
  await host.prepareMaintenance(session.id, "reset"); host.finishMaintenance(session.id); resume(); await stale; await capture.drain();
  expect(host.store.records()).toHaveLength(2); expect(capture.health({})[0]?.incomplete).toBe(1);
  expect(host.store.records()[1]).toMatchObject({ finality: "interim", executionId: "2", issues: ["interrupted"] });
  expect(host.store.records().every((row) => row.providerEpochId !== host.epoch(session.id))).toBe(true);
});
it("concurrent Sessions have independent route bindings and delete prevents late resurrection", async () => {
  const { host, capture, route, session, run, seed, hold, resume } = await setup(); capture.startRun(session.id, run);
  const other = seed.session(); seed.run(other.id, "running");
  const route2 = await capture.prepare({ sessionId: other.id, provider: "codex", workspacePath: "/workspace", mcpServers: [] }); capture.startRun(other.id, 2);
  await Promise.all([route, route2!].map(async (item) => (await fetch(item.baseUrl + "/responses", { method: "POST", body: '{}' })).text())); await capture.drain();
  expect(host.store.records().map((row) => row.sessionId).sort()).toEqual([String(session.id), String(other.id)]);
  hold(); const stale = fetch(route.baseUrl + "/responses", { method: "POST", body: '{}' }).then((res) => res.text()).catch(() => "aborted");
  await vi.waitFor(() => expect(capture.health({ sessionId: String(session.id) })[0]?.status).toBe("pending"));
  host.deleteSession(session.id); resume(); await stale; await capture.drain();
  expect(host.store.records().map((row) => row.sessionId)).toEqual([String(other.id)]);
  expect(capture.health({ sessionId: String(session.id) })).toEqual([]);
});
it("combines one actual MCP execution with repeated input evidence and keeps same-named servers distinct", async () => {
  const { host, capture, route, session, run } = await setup(); const { McpUsageObserver } = await import("../src/agent-usage/mcp-observer.js"); const { randomUUID } = await import("node:crypto");
  const observer = new McpUsageObserver(host); cleanup.push(() => observer.close()); const ticket = observer.issueTicket(session.id, 7); const invocationId = randomUUID();
  observer.record(ticket, { invocationId, phase: "start", toolName: "search", occurredAt: "2026-09-21T00:00:00Z" });
  observer.record(ticket, { invocationId, phase: "end", toolName: "search", occurredAt: "2026-09-21T00:00:01Z", status: "succeeded", resultBytes: 16 });
  await capture.prepare({ sessionId: session.id, provider: "codex", workspacePath: "/workspace", mcpServers: [
    { name: "docs", type: "stdio", command: "fake", args: [], env: [], usageIdentity: { serverId: "7", tools: ["search"] } },
    { name: "other", type: "stdio", command: "fake", args: [], env: [], usageIdentity: { serverId: "8", tools: ["search"] } }
  ] }); capture.startRun(session.id, run);
  for (let index = 0; index < 3; index++) {
    await (await fetch(route.baseUrl + "/responses", { method: "POST", body: JSON.stringify({ model: "fixture-model", tools: [{ type: "function", name: "mcp__docs__search" }, { type: "function", name: "mcp__other__search" }], input: index === 0 ? [] : [{ type: "function_call_output", call_id: "call1", output: "result" }] }) })).text(); await capture.drain();
  }
  const ranks = host.attribution.rankings({}, "mcp_tool"); expect(ranks).toHaveLength(2);
  expect(ranks.find((row) => row.capability.serverId === "7")).toMatchObject({ capability: { id: "mcp:7:search" }, calls: 1, exposureCount: 5 });
  expect(ranks.find((row) => row.capability.serverId === "7")!.repeatedResultInputTokens).toBeGreaterThan(0);
  expect(ranks.find((row) => row.capability.serverId === "8")).toMatchObject({ calls: 0, exposureCount: 3 });
});
it("restart exposes interrupted pending intents and restores body-free call identity", async () => {
  const { db, host, capture, route, session, run } = await setup(); capture.startRun(session.id, run);
  await (await fetch(route.baseUrl + "/responses", { method: "POST", body: '{}' })).text(); await capture.drain();
  db.prepare("UPDATE agent_usage_captures SET status='pending'").run(); await capture.close();
  const restarted = new HostUsageCapture(host, {}, new Map()); cleanup.push(() => restarted.close());
  expect(restarted.health({})[0]).toMatchObject({ status: "incomplete", incomplete: 1, errorCode: "interrupted" });
  const call = db.prepare("SELECT metadata_json FROM agent_usage_capture_calls").get() as { metadata_json: string };
  expect(JSON.parse(call.metadata_json)).toEqual({ name: "mcp__docs__search", capability: { id: "mcp:7:search", kind: "mcp_tool", name: "search", serverId: "7" }, tags: [] });
  expect(db.serialize().includes(Buffer.from("secret-sentinel"))).toBe(false);
});
it("late Run-A attribution uses its admitted MCP projection even when Run-B replaces an alias", async () => {
  const { host, capture, route, session, run, hold, resume } = await setup(); capture.startRun(session.id, run); hold();
  const pending = fetch(route.baseUrl + "/responses", { method: "POST", body: JSON.stringify({ model: "fixture-model", tools: [{ type: "function", name: "mcp__docs__search" }], input: [] }) }).then((res) => res.text());
  await vi.waitFor(() => expect(capture.health({})[0]?.status).toBe("pending"));
  await capture.prepare({ sessionId: session.id, provider: "codex", workspacePath: "/workspace", mcpServers: [{ name: "docs", type: "stdio", command: "fake", args: [], env: [], usageIdentity: { serverId: "8", tools: ["search"] } }] });
  capture.startRun(session.id, 2); resume(); await pending; await capture.drain();
  expect(host.attribution.rankings({}, "mcp_tool")[0]?.capability.id).toBe("mcp:7:search");
});
it("a later result retains the server identity from its original call across alias replacement", async () => {
  const { host, capture, route, session, run } = await setup(); capture.startRun(session.id, run);
  await (await fetch(route.baseUrl + "/responses", { method: "POST", body: '{"input":[]}' })).text(); await capture.drain();
  await capture.prepare({ sessionId: session.id, provider: "codex", workspacePath: "/workspace", mcpServers: [{ name: "docs", type: "stdio", command: "fake", args: [], env: [], usageIdentity: { serverId: "8", tools: ["search"] } }] });
  await (await fetch(route.baseUrl + "/responses", { method: "POST", body: JSON.stringify({ model: "fixture-model", tools: [{ type: "function", name: "mcp__docs__search" }], input: [{ type: "function_call_output", call_id: "call1", output: "old server result" }] }) })).text(); await capture.drain();
  const ranks = host.attribution.rankings({}, "mcp_tool");
  expect(ranks.find((row) => row.capability.id === "mcp:7:search")?.exposureCount).toBe(1);
  expect(ranks.find((row) => row.capability.id === "mcp:8:search")?.exposureCount).toBe(1);
});
it("real aborted Claude transport persists retained usage and identity as interim with incomplete health", async () => {
  const { request } = await import("node:http"); const { db, seed } = createTestDatabase(); cleanup.push(() => db.close());
  const session = seed.session(); seed.run(session.id, "running"); const host = new HostUsageCollector(db, {}, undefined, fixtureTokenizers());
  const upstream = createServer((req, res) => { req.resume(); req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"type":"message_start","message":{"id":"msg-aborted","content":[],"usage":{"input_tokens":20,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":3}}\n\n');
  }); });
  await new Promise<void>((resolve, reject) => { upstream.once("error", reject); upstream.listen(0, "127.0.0.1", resolve); });
  cleanup.push(() => new Promise<void>((resolve) => { upstream.closeAllConnections(); upstream.close(() => resolve()); }));
  const capture = new HostUsageCapture(host, { claude_code: { baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`, protocol: "anthropic_messages", apiKeyEnv: "SYNTHETIC_KEY" } }, new Map([["claude_code", "synthetic"]])); cleanup.push(() => capture.close());
  const route = await capture.prepare({ sessionId: session.id, provider: "claude_code", providerSessionId: null, workspacePath: "/workspace", mcpServers: [] }); capture.startRun(session.id, 1);
  const client = request(route!.baseUrl + "/v1/messages", { method: "POST" }); client.on("error", () => {});
  const aborted = new Promise<void>((resolve) => client.on("response", (response) => { response.on("error", () => {}); response.once("data", () => { response.destroy(); resolve(); }); }));
  client.end('{"system":"PRIVATE_ABORTED_SYSTEM","messages":[{"role":"user","content":"PRIVATE_ABORTED_REQUEST"}]}'); await aborted;
  await vi.waitFor(() => expect(capture.health({})[0]?.status).toBe("incomplete")); await capture.drain();
  expect(host.store.records()).toEqual([expect.objectContaining({ invocationId: "claude-message:msg-aborted", finality: "interim", metrics: expect.objectContaining({ inputTotalTokens: 20, outputTotalTokens: 3, totalTokens: 23 }), issues: ["downstream_aborted"] })]);
  expect(host.attribution.rankings({}, "system_prompt")).toMatchObject([{ capability: { kind: "system_prompt" }, exposureCount: 1 }]);
  expect(host.attribution.rankings({}, "user_prompt")).toMatchObject([{ capability: { kind: "user_prompt" }, exposureCount: 1 }]);
  expect(host.attribution.rankings({}, "unknown")).toEqual([]);
  expect(capture.health({})[0]).toMatchObject({ status: "incomplete", incomplete: 1, errorCode: "downstream_aborted" });
  expect(db.serialize().includes(Buffer.from("PRIVATE_ABORTED_REQUEST"))).toBe(false);
  expect(db.serialize().includes(Buffer.from("PRIVATE_ABORTED_SYSTEM"))).toBe(false);
});
