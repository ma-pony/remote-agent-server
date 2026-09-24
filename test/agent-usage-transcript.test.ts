import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { createTranscriptParser, type TranscriptOptions } from "../src/agent-usage/adapters/transcript-context.js";
import type { IncrementalUsageParser } from "../src/agent-usage/adapters/file-source.js";
import type { ProviderLogKind } from "../src/agent-usage/adapters/provider-logs.js";
import { ModelTokenizers } from "../src/agent-usage/core/tokenizers.js";
import { AttributionStore } from "../src/agent-usage/storage/attribution-store.js";
import { UsageStore } from "../src/agent-usage/storage/usage-store.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const capability = { kind: "mcp_tool" as const, id: "mcp:1:lookup", name: "lookup", serverId: "1" };
const options = (): TranscriptOptions => ({
  measure: vi.fn(async text => ({ tokens: text.length, byteLength: Buffer.byteLength(text), partial: false,
    estimate: new ModelTokenizers().describe("test-model") })),
  profile: () => ({ tools: [{ runtimeName: "mcp__server__lookup", capability, definition: { name: "lookup" } }] }),
  tags: () => []
});
const setup = (kind: ProviderLogKind = "codex_log", config = options()) => {
  const db = new Database(":memory:"); databases.push(db);
  const store = new UsageStore(db), attribution = new AttributionStore(store);
  const binding = store.bindSession("test", "agent", "session");
  let parser: IncrementalUsageParser = createTranscriptParser(kind, config), line = 0;
  const feed = async (value: Record<string, unknown>) => {
    const entries = await parser.parseLine(JSON.stringify({ timestamp: "2026-09-24T01:00:00Z", ...value }), ++line);
    for (const entry of entries) {
      store.observe(binding, entry.observation);
      if (entry.context) await attribution.upsertContext(binding, entry.context);
    }
    return entries;
  };
  return { db, store, attribution, binding, feed, config, state: () => parser.snapshot(),
    resume: () => { parser = createTranscriptParser(kind, config, parser.snapshot()); },
    tool: () => attribution.rankings({ namespace: "test" }, "mcp_tool")[0]! };
};
const item = (payload: object) => ({ type: "response_item", payload });
const message = (role: string, text: string) => item({ type: "message", role, content: [{ type: "input_text", text }] });
const count = (total: number) => ({ type: "event_msg", payload: { type: "token_count", info: {
  total_token_usage: { input_tokens: total, output_tokens: total / 10, total_tokens: total + total / 10 },
  last_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 }
} } });
const call = (id: string) => item({ type: "function_call", call_id: id, name: "mcp__server__lookup", arguments: "{}" });
const result = (id: string, output: string) => item({ type: "function_call_output", call_id: id, output });
const meta = { type: "session_meta", payload: { id: "native" } };

it("counts tool definitions on every request and arguments/results only on subsequent requests", async () => {
  const test = setup();
  await test.feed(meta); await test.feed(message("user", "prompt"));
  await test.feed(call("call-1")); await test.feed(count(100));
  expect(test.tool()).toMatchObject({ argumentInputTokens: 0, firstResultInputTokens: 0, definitionInputTokens: 17 });
  await test.feed(result("call-1", "secret-result"));
  await test.feed(message("assistant", "reply")); await test.feed(count(200));
  expect(test.tool()).toMatchObject({ argumentInputTokens: 2, firstResultInputTokens: 13, repeatedResultInputTokens: 0 });
  await test.feed(message("user", "follow up")); await test.feed(call("call-2")); await test.feed(count(300));
  expect(test.tool()).toMatchObject({ argumentInputTokens: 4, firstResultInputTokens: 13, repeatedResultInputTokens: 13, definitionInputTokens: 51 });
  await test.feed(result("call-2", "new")); await test.feed(count(400));
  expect(test.tool()).toMatchObject({ argumentInputTokens: 8, firstResultInputTokens: 16, repeatedResultInputTokens: 26 });
  expect(JSON.stringify(test.state())).not.toContain("secret-result");
  expect(test.attribution.contextSummary({ namespace: "test" })).toMatchObject({ requests: 4, reconstructedRequests: 4, reportedInputTokens: 400 });
});

it("reconstructs namespaced Codex tools and dynamically loaded definitions from native logs", async () => {
  const test = setup(); await test.feed(meta); await test.feed(message("user", "lookup"));
  await test.feed(item({ type: "tool_search_call", call_id: "search", arguments: { query: "lookup" } }));
  await test.feed(item({ type: "tool_search_output", call_id: "search", tools: [
    { type: "namespace", name: "mcp__server", tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }] }
  ] }));
  await test.feed(count(100));
  expect(test.tool()).toBeUndefined();
  await test.feed(item({ type: "function_call", call_id: "call", namespace: "mcp__server", name: "lookup", arguments: "{}" }));
  // Codex can persist a fast tool result before the usage of the request that called it.
  await test.feed(result("call", "data")); await test.feed(count(200));
  expect(test.tool()).toMatchObject({ capability, firstResultInputTokens: 0, argumentInputTokens: 0 });
  const definition = test.tool().definitionInputTokens;
  await test.feed(message("assistant", "data")); await test.feed(count(300));
  await test.feed(message("user", "repeat")); await test.feed(message("assistant", "data")); await test.feed(count(400));
  expect(test.tool()).toMatchObject({ definitionInputTokens: definition! * 3, firstResultInputTokens: 4, repeatedResultInputTokens: 4 });
});

it("resumes body-free state and ignores repeated Codex rate-limit counters", async () => {
  const test = setup();
  await test.feed(meta); await test.feed({ type: "turn_context", payload: { turn_id: "turn" } });
  await test.feed(call("call-1")); await test.feed(count(100));
  await test.feed(result("call-1", "data")); await test.feed(count(200));
  test.resume(); await test.feed(count(200)); await test.feed(count(300));
  expect(test.tool()).toMatchObject({ firstResultInputTokens: 4, repeatedResultInputTokens: 4 });
  expect(test.attribution.contextSummary({ namespace: "test" }).requests).toBe(3);
  expect(test.config.measure).toHaveBeenCalledWith("data", null);
  expect(vi.mocked(test.config.measure).mock.calls.filter(([value]) => value === "data")).toHaveLength(1);
  const terminal = await test.feed({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn" } });
  expect(terminal).toHaveLength(1);
  expect(terminal[0]?.context).toBeUndefined();
});

it("replaces compacted history and stops charging retired tool content", async () => {
  const test = setup();
  await test.feed(meta); await test.feed(call("call")); await test.feed(count(100));
  await test.feed(result("call", "old")); await test.feed(count(200));
  await test.feed({ type: "compacted", payload: { replacement_history: [{ type: "message", role: "user", content: [{ type: "input_text", text: "summary" }] }] } });
  await test.feed(count(300));
  expect(test.tool()).toMatchObject({ firstResultInputTokens: 3, repeatedResultInputTokens: 0, definitionInputTokens: 51 });
});

it("counts Claude requests once across partial usage updates and excludes each request's own output", async () => {
  const test = setup("claude_log");
  const assistant = (id: string, content: object[], stop: string | null = "end_turn") => ({ type: "assistant", sessionId: "claude", uuid: `${id}:${stop}`,
    message: { id, role: "assistant", model: "model", content, stop_reason: stop,
      usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 } } });
  await test.feed({ type: "user", uuid: "u1", sessionId: "claude", message: { role: "user", content: "hello" } });
  await test.feed(assistant("m1", [{ type: "tool_use", id: "tool1", name: "mcp__server__lookup", input: {} }], null));
  await test.feed(assistant("m1", [{ type: "tool_use", id: "tool1", name: "mcp__server__lookup", input: {} }]));
  await test.feed({ type: "user", uuid: "u2", sessionId: "claude", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool1", content: "data" }] } });
  await test.feed(assistant("m2", [{ type: "text", text: "answer" }]));
  await test.feed(assistant("m3", [{ type: "text", text: "more" }]));
  expect(test.tool()).toMatchObject({ firstResultInputTokens: 4, repeatedResultInputTokens: 4, argumentInputTokens: 4, definitionInputTokens: 51 });
  expect(test.attribution.contextSummary({ namespace: "test" }).requests).toBe(3);
  expect(test.store.summary().usage.totalTokens).toBe(330);
  await test.feed({ type: "system", subtype: "compact_boundary" });
  await test.feed(assistant("m4", [{ type: "text", text: "after compact" }]));
  expect(test.tool().repeatedResultInputTokens).toBe(4);
});

it("keeps configured instructions separate and counts skill/plugin tags without inflating the input comparison", async () => {
  const config = options();
  config.profile = () => ({ instructions: "rules", tools: [] });
  config.tags = () => [{ id: "skill", kind: "skill", name: "Skill" }, { id: "plugin", kind: "plugin", name: "Plugin" }];
  const test = setup("codex_log", config);
  await test.feed(meta); await test.feed(message("user", "rulesprompt"));
  await test.feed(item({ type: "function_call", call_id: "read", name: "read_file", arguments: "{}" }));
  await test.feed(count(100)); await test.feed(result("read", "body")); await test.feed(count(200));
  expect(test.attribution.rankings({ namespace: "test" }, "configured_instructions")[0]?.totalInputTokens).toBe(10);
  expect(test.attribution.rankings({ namespace: "test" }, "skill")[0]?.totalInputTokens).toBe(6);
  const summary = test.attribution.contextSummary({ namespace: "test" });
  expect(summary).toMatchObject({ estimatedInputTokens: 28, differenceTokens: 172 });
});

it("attributes Claude's injected Skill messages across checkpoints and subsequent requests", async () => {
  const config = options();
  config.profile = () => ({ tools: [] });
  config.tags = name => name === "Skill"
    ? [{ id: "review", kind: "skill", name: "Review" }, { id: "plugin", kind: "plugin", name: "Plugin" }] : [];
  const test = setup("claude_log", config);
  const assistant = (id: string, content: object[]) => ({ type: "assistant", sessionId: "claude", uuid: id,
    message: { id, role: "assistant", model: "model", content, stop_reason: "end_turn",
      usage: { input_tokens: 3000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 } } });
  const user = (uuid: string, content: string | object[], sourceToolUseID?: string) => ({ type: "user", uuid, sessionId: "claude",
    ...(sourceToolUseID ? { isMeta: true, sourceToolUseID } : {}), message: { role: "user", content } });
  const input = { skill: "Review" }, result = "Launching skill: Review", body = "x".repeat(1000);
  await test.feed(user("u1", "hello"));
  await test.feed(assistant("m1", [{ type: "tool_use", id: "load", name: "Skill", input }]));
  await test.feed(user("u2", [{ type: "tool_result", tool_use_id: "load", content: result }]));
  test.resume();
  await test.feed(user("u3", body, "load"));
  await test.feed(user("u4", [{ type: "text", text: "rules" }], "load"));
  await test.feed(assistant("m2", [{ type: "text", text: "done" }]));
  await test.feed(user("u5", "again"));
  await test.feed(assistant("m3", [{ type: "text", text: "done" }]));
  const expected = 2 * (JSON.stringify(input).length + result.length + body.length + "rules".length);
  for (const dimension of ["skill", "plugin"] as const) {
    expect(test.attribution.rankings({ namespace: "test" }, dimension)[0]?.totalInputTokens).toBe(expected);
  }
  expect(test.attribution.rankings({ namespace: "test" }, "user_prompt")[0]?.totalInputTokens).toBe(20);
  expect(test.attribution.contextSummary({ namespace: "test" }).estimatedInputTokens).toBe(expected + 24);
  expect(JSON.stringify(test.state())).not.toContain(body);
  expect(test.state()).toMatchObject({ transcript: { calls: {} } });
});

it("stores a bounded number of groups per request instead of repeating every historical message", async () => {
  const test = setup(); await test.feed(meta);
  for (let index = 1; index <= 100; index++) {
    await test.feed(message("user", "one")); await test.feed(message("assistant", "two")); await test.feed(count(index * 100));
  }
  const row = test.db.prepare("SELECT COUNT(*) AS count FROM agent_usage_exposures").get() as { count: number };
  expect(row.count).toBeLessThanOrEqual(300);
  expect(JSON.stringify(test.state()).length).toBeLessThan(10_000);
});

it("locates a validated first increment and midnight crossing in Agent and Session date totals", async () => {
  const test = setup(); await test.feed(meta); await test.feed(message("user", "hello"));
  await test.feed({ ...count(100), timestamp: "2026-09-23T23:59:59Z" });
  await test.feed({ ...count(200), timestamp: "2026-09-24T00:00:01Z" });
  expect(test.store.summary({ namespace: "test", agentId: "agent" }).usage.totalTokens).toBe(220);
  const filter = { namespace: "test", sessionId: "session", from: "2026-09-24T00:00:00Z", to: "2026-09-25T00:00:00Z" };
  expect(test.store.summary(filter)).toMatchObject({ usage: { totalTokens: 110 }, unplacedUsage: { totalTokens: 0 } });
  expect(test.attribution.contextSummary(filter).requests).toBe(1);
});
