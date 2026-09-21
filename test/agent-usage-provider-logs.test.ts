import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseProviderLog,
  ProviderLogFormatError
} from "../src/agent-usage/adapters/provider-logs.js";
import { UsageStore } from "../src/agent-usage/storage/usage-store.js";

const fixture = (name: string): string[] => readFileSync(
  fileURLToPath(new URL(`./fixtures/agent-usage/provider-logs/${name}`, import.meta.url)),
  "utf8"
).trimEnd().split("\n");

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const summarize = (kind: "codex_log" | "claude_log", name: string) => {
  const db = new Database(":memory:");
  databases.push(db);
  const store = new UsageStore(db);
  const binding = store.bindSession("test", "agent-1", "session-1");
  const parsed = parseProviderLog(kind, fixture(name));
  for (const { observation } of parsed) store.observe(binding, observation);
  return { parsed, summary: store.summary({ namespace: "test" }) };
};

describe("provider usage log adapters", () => {
  it("keeps Codex cumulative totals and dated increments without inventing requests", () => {
    const { parsed, summary } = summarize("codex_log", "codex-token-count.jsonl");

    expect(parsed).toHaveLength(4);
    expect(new Set(parsed.map((row) => row.sourceSessionKey))).toEqual(new Set(["codex-session-1"]));
    expect(parsed.filter((row) => row.observation.scope === "provider_session")).toHaveLength(3);
    expect(parsed.filter((row) => row.observation.scope === "model_request")).toHaveLength(0);
    expect(parsed.filter((row) => row.observation.scope === "unknown")).toHaveLength(0);
    expect(parsed[0]!.observation).toMatchObject({
      semantics: "cumulative",
      coverageId: "codex-session:codex-session-1",
      finality: "interim",
      metrics: {
        inputTotalTokens: 100,
        inputUncachedTokens: 50,
        cacheReadTokens: 40,
        cacheWriteTokens: 10,
        outputTotalTokens: 20,
        reasoningOutputTokens: 5,
        totalTokens: 120
      }
    });
    expect(parsed[3]!.observation).toMatchObject({ scope: "interval", invocationId: null, metrics: { totalTokens: 70 } });
    expect(summary).toMatchObject({
      accountingBasis: "range_totals",
      observedModelRequests: 0,
      usage: {
        inputTotalTokens: 160,
        inputUncachedTokens: 80,
        cacheReadTokens: 60,
        cacheWriteTokens: 20,
        outputTotalTokens: 30,
        reasoningOutputTokens: 7,
        totalTokens: 190
      }
    });
  });

  it("dates only proven same-day cumulative increments without inventing model requests", () => {
    const db = new Database(":memory:"); databases.push(db);
    const store = new UsageStore(db);
    const binding = store.bindSession("test", "a", "s");
    const event = (timestamp: string, input: number, output: number) => JSON.stringify({
      timestamp, type: "event_msg", payload: { type: "token_count", info: {
        total_token_usage: { input_tokens: input, output_tokens: output, total_tokens: input + output }
      } }
    });
    const lines = [JSON.stringify({ type: "session_meta", payload: { id: "native" } }),
      event("2026-09-20T23:59:00Z", 100, 20),
      event("2026-09-21T00:01:00Z", 150, 30),
      event("2026-09-21T00:02:00Z", 180, 40),
      event("2026-09-21T00:02:00Z", 180, 40),
      JSON.stringify({ timestamp: "2026-09-21T00:03:00Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn" } })];
    for (let replay = 0; replay < 2; replay++) for (const row of parseProviderLog("codex_log", lines)) store.observe(binding, row.observation);
    expect(store.summary()).toMatchObject({ usage: { totalTokens: 220 }, observedModelRequests: 0 });
    expect(store.summary({ from: "2026-09-21T00:00:00Z", to: "2026-09-22T00:00:00Z" })).toMatchObject({
      usage: { totalTokens: 40 }, unplacedUsage: { totalTokens: 180 }, observedModelRequests: 0
    });
    expect(store.summary({ from: "2026-09-21T00:01:30Z", to: "2026-09-22T00:00:00Z" }).usage.totalTokens).toBeNull();
  });

  it("only seals Codex totals with a matching terminal turn after the latest usage", () => {
    const lines = fixture("codex-token-count.jsonl");
    const terminal = JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "codex-turn-2" } });
    const rows = parseProviderLog("codex_log", [...lines, terminal]);
    expect(rows.filter((row) => row.observation.scope === "provider_session").at(-1)?.observation.finality).toBe("final");
    expect(parseProviderLog("codex_log", lines).filter((row) => row.observation.scope === "provider_session").at(-1)?.observation.finality).toBe("interim");
  });

  it("does not double count captured requests inside native intervals or reset a decreasing baseline", () => {
    const db = new Database(":memory:"); databases.push(db);
    const store = new UsageStore(db); const binding = store.bindSession("test", "a", "s");
    const lines = fixture("codex-token-count.jsonl");
    const parsed = parseProviderLog("codex_log", lines);
    for (const row of parsed) store.observe(binding, row.observation);
    const base = parsed.at(-1)!.observation;
    store.observe(binding, { ...base, eventId: "captured", sourceId: "http", scope: "model_request",
      intervalStart: undefined, coverageId: "request", invocationId: "request", occurredAt: "2026-09-21T01:00:03Z",
      metrics: { inputTotalTokens: 60, outputTotalTokens: 10, totalTokens: 70 } });
    store.observe(binding, { ...base, eventId: "unknown-time", sourceId: "http", scope: "model_request",
      intervalStart: undefined, coverageId: "unknown-time", invocationId: "unknown-time", occurredAt: null,
      metrics: { totalTokens: 70 } });
    expect(store.summary()).toMatchObject({ usage: { totalTokens: 190 }, locatedUsage: { totalTokens: 70 } });
    const decrease = JSON.stringify({ timestamp: "2026-09-21T01:00:05Z", type: "event_msg", payload: { type: "token_count",
      info: { total_token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } } });
    expect(parseProviderLog("codex_log", [...lines, decrease]).filter((row) => row.observation.scope === "interval")).toHaveLength(1);
  });

  it("does not seal a previous turn when a later turn terminates without usage", () => {
    const rows = parseProviderLog("codex_log", [...fixture("codex-token-count.jsonl"),
      JSON.stringify({ type: "turn_context", payload: { turn_id: "later" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "later" } })]);
    expect(rows.filter((row) => row.observation.scope === "provider_session").at(-1)?.observation.finality).toBe("interim");
  });

  it("advances a terminal cumulative total when a later turn produces new usage", () => {
    const db = new Database(":memory:"); databases.push(db);
    const store = new UsageStore(db); const binding = store.bindSession("test", "a", "s");
    const lines = [...fixture("codex-token-count.jsonl"),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "codex-turn-2" } })];
    for (const row of parseProviderLog("codex_log", lines)) store.observe(binding, row.observation);
    expect(store.summary().completeness).toBe("complete");
    const next = [...lines, JSON.stringify({ type: "turn_context", payload: { turn_id: "codex-turn-3" } }),
      JSON.stringify({ timestamp: "2026-09-21T01:00:06Z", type: "event_msg", payload: { type: "token_count",
        info: { total_token_usage: { input_tokens: 200, cached_input_tokens: 80, cache_write_input_tokens: 20,
          output_tokens: 40, reasoning_output_tokens: 10, total_tokens: 240 } } } })];
    for (const row of parseProviderLog("codex_log", next)) store.observe(binding, row.observation);
    expect(store.summary()).toMatchObject({ usage: { totalTokens: 240 }, completeness: "partial" });
  });

  it("does not add a captured request that started before a repeated native notification", () => {
    const db = new Database(":memory:"); databases.push(db); const store = new UsageStore(db);
    const binding = store.bindSession("test", "a", "s");
    const parsed = parseProviderLog("codex_log", fixture("codex-token-count.jsonl"));
    for (const row of parsed) store.observe(binding, row.observation);
    store.observe(binding, { ...parsed.at(-1)!.observation, sourceId: "capture", eventId: "request", scope: "model_request",
      intervalStart: undefined, occurredAt: "2026-09-21T01:00:02.100Z", coverageId: "request", invocationId: "request",
      metrics: { inputTotalTokens: 60, outputTotalTokens: 10, totalTokens: 70 } });
    expect(store.summary({ from: "2026-09-21T00:00:00Z" })).toMatchObject({
      usage: { totalTokens: 70 }, unplacedUsage: { totalTokens: 120 }, completeness: "conflict"
    });
  });

  it("accepts Codex rate-limit/context events whose token info is null", () => {
    expect(parseProviderLog("codex_log", fixture("codex-empty-info.jsonl"))).toEqual([]);
  });

  it("uses Claude request/message identities, replaces replayed snapshots, and adds cache input once", () => {
    const { parsed, summary } = summarize("claude_log", "claude-assistant-usage.jsonl");

    expect(parsed).toHaveLength(3);
    expect(parsed[0]!.observation).toMatchObject({
      invocationId: "claude-message:msg-1",
      coverageId: "claude-message:msg-1",
      runtimeKind: "claude_code",
      semantics: "snapshot",
      finality: "interim",
      metrics: {
        inputTotalTokens: 175,
        inputUncachedTokens: 5,
        cacheReadTokens: 120,
        cacheWriteTokens: 50,
        outputTotalTokens: 6,
        reasoningOutputTokens: null,
        totalTokens: 181
      }
    });
    expect(parsed[1]!.observation).toMatchObject({
      invocationId: "claude-message:msg-1",
      coverageId: "claude-message:msg-1",
      finality: "final",
      metrics: { outputTotalTokens: 9, totalTokens: 184 }
    });
    expect(parsed[2]!.observation).toMatchObject({
      invocationId: "claude-message:msg-2",
      coverageId: "claude-message:msg-2",
      metrics: { outputTotalTokens: 9, totalTokens: 184 }
    });
    expect(summary).toMatchObject({
      accountingBasis: "model_requests",
      observedModelRequests: 2,
      usage: {
        inputTotalTokens: 350,
        cacheReadTokens: 240,
        cacheWriteTokens: 100,
        outputTotalTokens: 18,
        totalTokens: 368
      }
    });
  });

  it("leaves absent Claude cache fields and derived totals unknown", () => {
    const [row] = parseProviderLog("claude_log", fixture("claude-usage-without-cache.jsonl"));
    expect(row!.observation.metrics).toEqual({
      inputTotalTokens: null,
      inputUncachedTokens: 7,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      outputTotalTokens: 3,
      reasoningOutputTokens: null,
      totalTokens: null
    });
  });

  it("uses canonical Claude message identity with native epoch separation", () => {
    const parsed = parseProviderLog("claude_log", fixture("claude-message-id-only.jsonl"));
    expect(parsed.map((row) => row.observation.invocationId)).toEqual([
      "claude-message:shared-message",
      "claude-message:shared-message"
    ]);
  });

  it("produces stable source-local event IDs when the same complete input is replayed", () => {
    const lines = fixture("codex-token-count.jsonl");
    expect(parseProviderLog("codex_log", lines)).toEqual(parseProviderLog("codex_log", lines));
    const claude = parseProviderLog("claude_log", fixture("claude-assistant-usage.jsonl"));
    expect(new Set(claude.map((row) => row.observation.eventId)).size).toBe(3);
  });

  it.each([
    ["malformed JSON", "codex_log" as const, "malformed.jsonl", "provider_log_malformed"],
    ["unsupported content", "claude_log" as const, "claude-no-usage.jsonl", "provider_log_unsupported"],
    ["invalid metrics", "claude_log" as const, "claude-invalid-usage.jsonl", "provider_log_invalid_metric"]
  ])("throws a typed stable format error for %s", (_label, kind, name, code) => {
    try {
      parseProviderLog(kind, fixture(name));
      throw new Error("expected parser failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderLogFormatError);
      expect(error).toMatchObject({ code });
    }
  });
});
