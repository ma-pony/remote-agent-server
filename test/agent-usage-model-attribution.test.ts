import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { AttributionStore } from "../src/agent-usage/storage/attribution-store.js";
import { UsageStore } from "../src/agent-usage/storage/usage-store.js";
import { ModelTokenizers } from "../src/agent-usage/core/tokenizers.js";
import { fixtureProfile, fixtureTokenizers } from "./fixtures/agent-usage/tokenizers/helpers.js";
import type { ModelContextInput } from "../src/agent-usage/core/context-types.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const setup = () => {
  const db = new Database(":memory:"); databases.push(db);
  const usage = new UsageStore(db); const binding = usage.bindSession("test", "a", "s");
  return { db, usage, binding, store: new AttributionStore(usage, fixtureTokenizers()) };
};
const context = (id: string, model = "fixture-model"): ModelContextInput => ({
  invocationId: id, model, sourceId: "test", revision: 1, providerEpochId: "e", occurredAt: "2026-09-21T01:00:00Z",
  runtimeKind: "custom", coverage: "full", historyComplete: true,
  blocks: [{ position: 0, kind: "result", toolInvocationId: "call", content: { identity: "body", modality: "text", text: "hello world" },
    capabilities: [{ capability: { id: "search", name: "search", kind: "mcp_tool", serverId: "docs" }, evidence: "direct" }] }]
});

describe("persisted tokenizer provenance", () => {
  it("preserves original measurements and their breakdown when a registry change creates a mixed estimate", () => {
    const { store, db, usage, binding } = setup();
    store.upsertContext(binding, context("old"));
    const modified = fixtureProfile(); delete modified.tokenizerJson.model.vocab.hello;
    Object.assign(modified.tokenizerJson.model.vocab, { he: 30, "##llo": 31 });
    const next = new AttributionStore(usage, new ModelTokenizers([modified]));
    expect(next.rankings({}, "mcp_tool")[0]!.totalInputTokens).toBe(2);
    next.upsertContext(binding, context("new"));
    const row = next.rankings({}, "mcp_tool")[0]!;
    expect(row).toMatchObject({ tokenizationStatus: "mixed", totalInputTokens: 5, inputBytes: 22 });
    expect(row.tokenEstimates.map((item) => item.totalInputTokens).sort()).toEqual([2, 3]);
    expect(new Set(row.tokenEstimates.map((item) => item.tokenizerRevision)).size).toBe(2);
    const persisted = db.prepare("SELECT estimate_json FROM agent_usage_exposures").all();
    expect(JSON.stringify(persisted)).not.toContain("hello world");
  });
  it("keeps a rankable mixed estimate and its fallback provenance when another model is unconfigured", () => {
    const { store, binding } = setup();
    store.upsertContext(binding, context("known")); store.upsertContext(binding, context("unknown", "closed-model"));
    const row = store.rankings({}, "mcp_tool")[0]!;
    expect(row).toMatchObject({ totalInputTokens: 5, tokenizationStatus: "mixed", estimateCompleteness: "complete", missingExposureCount: 0 });
    expect(row.tokenEstimates).toContainEqual(expect.objectContaining({ model: "closed-model", method: "text_heuristic", reason: "model_unmapped", totalInputTokens: 3 }));
    const evidence = store.contextEvidence().find((item) => item.modelInvocationId === "unknown")!;
    expect(store.contextEvidenceDetail("test", evidence.id)?.exposures[0]).toMatchObject({
      tokens: 3, byteLength: 11, model: "closed-model", method: "text_heuristic", reason: "model_unmapped", coverage: "full"
    });
  });
  it("migrates the old schema once without relabeling historical estimates as model-specific", () => {
    const { store, usage, db, binding } = setup();
    store.upsertContext(binding, context("old"));
    db.exec("ALTER TABLE agent_usage_exposures DROP COLUMN estimate_json");
    if ((db.prepare("PRAGMA table_info(agent_usage_exposures)").all() as Array<{ name: string }>).some((column) => column.name === "estimate_id")) {
      db.exec("ALTER TABLE agent_usage_exposures DROP COLUMN estimate_id");
    }
    const migrated = new AttributionStore(usage, fixtureTokenizers());
    expect(migrated.rankings({}, "mcp_tool")[0]).toMatchObject({ totalInputTokens: 2,
      tokenEstimates: [expect.objectContaining({ method: "legacy_reference", tokenizer: "js-tiktoken", encoding: "o200k_base" })] });
    const before = db.prepare("SELECT estimate_json FROM agent_usage_exposures").get();
    new AttributionStore(usage);
    expect(db.prepare("SELECT estimate_json FROM agent_usage_exposures").get()).toEqual(before);
    migrated.upsertContext(binding, context("new"));
    expect(migrated.rankings({}, "mcp_tool")[0]?.tokenizationStatus).toBe("mixed");
  });
});
