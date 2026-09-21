import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureTokenizers } from "./fixtures/agent-usage/tokenizers/helpers.js";
import type { Capability, ModelContextInput } from "../src/agent-usage/core/context-types.js";
import { AttributionStore } from "../src/agent-usage/storage/attribution-store.js";
import { UsageStore } from "../src/agent-usage/storage/usage-store.js";

const databases: Database.Database[] = [];
const setup = () => {
  const db = new Database(":memory:"); databases.push(db);
  const usage = new UsageStore(db);
  const attribution = new AttributionStore(usage, fixtureTokenizers());
  const binding = usage.bindSession("test", "agent-1", "session-1");
  return { db, usage, attribution, binding };
};
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const tool = (id: string, name = id): Capability => ({ id, kind: "mcp_tool", name, serverId: "server-1" });
const context = (invocationId: string, occurredAt: string, blocks: ModelContextInput["blocks"],
  overrides: Partial<ModelContextInput> = {}): ModelContextInput => ({
  invocationId, providerEpochId: "epoch-1", sourceId: "context-snapshot", revision: 1,
  occurredAt, runtimeKind: "codex", model: "gpt-test", coverage: "full", historyComplete: true,
  blocks, ...overrides
});
const textBlock = (position: number, kind: ModelContextInput["blocks"][number]["kind"], capability: Capability,
  identity: string, text: string, toolInvocationId?: string): ModelContextInput["blocks"][number] => ({
  position, kind, ...(toolInvocationId === undefined ? {} : { toolInvocationId }),
  content: { identity, modality: "text", text }, capabilities: [{ capability, evidence: "direct" }]
});

describe("agent usage context attribution", () => {
  it("keeps unknown models rankable using an explicit fallback while retaining input bytes", () => {
    const { attribution, binding } = setup();
    attribution.upsertContext(binding, context("unknown-model", "2026-09-20T10:00:00Z", [
      textBlock(0, "result", tool("read"), "body", "hello world", "call-unknown")
    ], { model: "unmapped-model" }));
    expect(attribution.rankings({ namespace: "test" }, "mcp_tool")[0]).toMatchObject({
      totalInputTokens: 3, inputBytes: 11, exposureCount: 1, missingExposureCount: 0,
      tokenEstimates: [expect.objectContaining({ method: "text_heuristic", reason: "model_unmapped" })],
      contextCoverage: { full: 1, partial: 0 }
    });
  });
  it("uses the real reference tokenizer per block and counts repeated occurrences", () => {
    const { attribution, binding } = setup();
    const capability = tool("weather");
    const definition = "Get current weather";
    const args = "{\"city\":\"Paris\"}";
    const result = "Sunny and warm";
    attribution.upsertContext(binding, context("model-1", "2026-09-20T10:00:00Z", [
      textBlock(0, "definition", capability, "definition-v1", definition),
      textBlock(1, "arguments", capability, "args-1", args, "call-1"),
      textBlock(2, "result", capability, "result-1", result, "call-1"),
      textBlock(3, "result", capability, "result-1", result, "call-1")
    ]));

    const row = attribution.rankings({ namespace: "test" }, "mcp_tool")[0]!;
    expect(row).toMatchObject({
      measurement: "estimated", tokenizationStatus: "single",
      tokenEstimates: [expect.objectContaining({ tokenizer: "@huggingface/tokenizers", model: "gpt-test" })],
      exposureCount: 4, contextCoverage: { full: 1, partial: 0, opaque: 0, none: 0 },
      definitionInputTokens: 3,
      argumentInputTokens: 5,
      firstResultInputTokens: 3,
      repeatedResultInputTokens: 3
    });
    expect(row.totalInputTokens).toBe(14);
  });

  it("atomically replaces context revisions and ignores duplicate or stale revisions", () => {
    const { attribution, binding, db } = setup();
    const capability = tool("search");
    attribution.upsertContext(binding, context("model-1", "2026-09-20T10:00:00Z", [
      textBlock(0, "result", capability, "old", "obsolete", "call-1")
    ]));
    attribution.upsertContext(binding, context("model-1", "2026-09-20T10:00:00Z", [
      textBlock(0, "result", capability, "new", "replacement", "call-1")
    ], { revision: 2 }));
    attribution.upsertContext(binding, context("model-1", "2026-09-20T10:00:00Z", [
      textBlock(0, "result", capability, "late", "must be ignored", "call-1")
    ], { revision: 1 }));

    expect(attribution.rankings({ namespace: "test" }, "mcp_tool")[0]).toMatchObject({ exposureCount: 1 });
    const persisted = db.prepare("SELECT capability_json, content_identity_hash, token_count FROM agent_usage_exposures").all();
    expect(persisted).toHaveLength(1);
    expect(JSON.stringify(persisted)).not.toContain("replacement");
    expect(JSON.stringify(persisted)).not.toContain("obsolete");
    expect(JSON.stringify(persisted)).not.toContain("must be ignored");
  });

  it("tokenizes literal special markers as ordinary tool content", () => {
    const { attribution, binding } = setup();
    const capability = tool("source-reader");
    const literal = "literal <|endoftext|> in tool result";
    expect(fixtureTokenizers().count(literal, "gpt-test").tokens).toBe(7);
    attribution.upsertContext(binding, context("model-special", "2026-09-20T11:00:00Z", [
      textBlock(0, "result", capability, "literal-v1", literal, "call-special"),
      textBlock(1, "other", capability, "tail-v1", "tail", "call-special")
    ]));
    expect(attribution.rankings({ namespace: "test" }, "mcp_tool")[0]).toMatchObject({
      exposureCount: 2, firstResultInputTokens: 7, missingExposureCount: 0, estimateCompleteness: "complete"
    });
  });

  it("classifies first use across lifetime before applying the date filter", () => {
    const { attribution, binding } = setup();
    const capability = tool("read");
    attribution.upsertContext(binding, context("model-1", "2026-09-19T23:00:00Z", [
      textBlock(0, "result", capability, "file-v1", "same body", "call-1")
    ]));
    attribution.upsertContext(binding, context("model-2", "2026-09-20T12:00:00Z", [
      textBlock(0, "result", capability, "file-v1", "same body", "call-1")
    ]));

    expect(attribution.rankings({ namespace: "test", from: "2026-09-20T00:00:00Z", to: "2026-09-21T00:00:00Z" }, "mcp_tool")[0])
      .toMatchObject({ firstResultInputTokens: 0, repeatedResultInputTokens: 2, exposureCount: 1 });
  });

  it("keeps unknown first use and identical text from different calls distinct", () => {
    const { attribution, binding } = setup();
    const first = tool("first");
    const second = tool("second");
    attribution.upsertContext(binding, context("model-1", "2026-09-20T12:00:00Z", [
      textBlock(0, "result", first, "result", "identical", "call-1"),
      textBlock(1, "result", second, "result", "identical", "call-2")
    ], { historyComplete: false, coverage: "partial" }));

    const rows = attribution.rankings({ namespace: "test" }, "mcp_tool");
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.firstResultInputTokens === 0 && row.unknownFirstResultInputTokens === 2)).toBe(true);
  });

  it("keeps reused local result IDs independent across sessions and provider epochs", () => {
    const { attribution, usage, binding } = setup();
    const capability = tool("read");
    const second = usage.bindSession("test", "agent-1", "session-2");
    const block = () => textBlock(0, "result", capability, "result", "same body", "call-1");
    attribution.upsertContext(binding, context("model-1", "2026-09-20T10:00:00Z", [block()]));
    attribution.upsertContext(second, context("model-2", "2026-09-20T11:00:00Z", [block()]));
    attribution.upsertContext(second, context("model-3", "2026-09-20T12:00:00Z", [block()], { providerEpochId: "epoch-2" }));

    expect(attribution.rankings({ namespace: "test" }, "mcp_tool")[0]).toMatchObject({
      firstResultInputTokens: 6, repeatedResultInputTokens: 0, exposureCount: 3
    });
    expect(attribution.rankings({ namespace: "test", sessionId: "session-2" }, "mcp_tool")[0]).toMatchObject({
      firstResultInputTokens: 4, repeatedResultInputTokens: 0, exposureCount: 2
    });
  });

  it("returns null estimates for unsupported modalities and deduplicates repeated tags per exposure", () => {
    const { attribution, binding } = setup();
    const skill: Capability = { id: "summarize", kind: "skill", name: "Summarize" };
    attribution.upsertContext(binding, context("model-1", "2026-09-20T12:00:00Z", [{
      position: 0, kind: "skill", content: { identity: "image-1", modality: "unsupported", mediaType: "image/png", byteLength: 42 },
      capabilities: [{ capability: skill, evidence: "inferred" }, { capability: skill, evidence: "direct" }]
    }]));
    expect(attribution.rankings({ namespace: "test" }, "skill")[0]).toMatchObject({
      exposureCount: 1, totalInputTokens: null, missingExposureCount: 1, estimateCompleteness: "none",
      contextCoverage: { full: 1 }
    });
  });

  it("preserves a known subtotal while reporting unsupported exposures", () => {
    const { attribution, binding } = setup();
    const capability = tool("vision");
    attribution.upsertContext(binding, context("model-mixed", "2026-09-20T12:00:00Z", [
      textBlock(0, "result", capability, "text-v1", "known text", "call-mixed"),
      {
        position: 1, kind: "result", toolInvocationId: "call-mixed",
        content: { identity: "image-v1", modality: "unsupported", mediaType: "image/png", byteLength: 42 },
        capabilities: [{ capability, evidence: "direct" }]
      }
    ]));
    expect(attribution.rankings({ namespace: "test" }, "mcp_tool")[0]).toMatchObject({
      exposureCount: 2, totalInputTokens: 2, firstResultInputTokens: 2,
      missingExposureCount: 1, estimateCompleteness: "partial", contextCoverage: { full: 1 }
    });
  });

  it("marks oversized text partial without passing it through the tokenizer", () => {
    const { attribution, binding } = setup();
    const capability = tool("large-result");
    attribution.upsertContext(binding, context("model-large", "2026-09-20T12:00:00Z", [
      textBlock(0, "result", capability, "small-v1", "known", "call-large"),
      textBlock(1, "result", capability, "large-v1", "x".repeat(256 * 1024 + 1), "call-large")
    ]));
    expect(attribution.rankings({ namespace: "test" }, "mcp_tool")[0]).toMatchObject({
      exposureCount: 2, totalInputTokens: 1, firstResultInputTokens: 1,
      missingExposureCount: 1, estimateCompleteness: "partial",
      contextCoverage: { full: 0, partial: 1 }
    });
  });
});
