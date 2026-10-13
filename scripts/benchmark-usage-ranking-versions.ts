import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { UsageStore } from "../src/agent-usage/storage/usage-store.js";
import { AttributionStore } from "../src/agent-usage/storage/attribution-store.js";
import { RuntimeConversationCollector } from "../src/agent-usage/runtime-conversation.js";
import type { Capability, TokenEstimate } from "../src/agent-usage/core/context-types.js";

// Pass a frozen AttributionStore module with its relative imports resolved to the source tree.
// Both versions read the same synthetic file. No Provider, network or application data is used.
const baselineModule = process.argv[2], contexts = Number(process.argv[3] ?? 1000);
if (!baselineModule || !Number.isInteger(contexts) || contexts < 1 || contexts > 5000)
  throw new Error("Usage: tsx scripts/benchmark-usage-ranking-versions.ts <baseline-module> [1-5000 contexts]");
const { AttributionStore: Baseline } = await import(pathToFileURL(resolve(baselineModule)).href) as { AttributionStore: typeof AttributionStore };
const root = mkdtempSync(join(tmpdir(), "usage-ranking-versions-"));
const db = new Database(join(root, "usage.sqlite"));
db.pragma("journal_mode=WAL"); db.pragma("cache_size=-8192");
const store = new UsageStore(db), attribution = new AttributionStore(store);
new RuntimeConversationCollector(store, attribution, "benchmark");
const readers: Array<{ db: Database.Database; attribution: AttributionStore }> = [];
const estimate: TokenEstimate = { measurement: "estimated", method: "text_heuristic", model: null, modelProvider: null,
  tokenizer: null, tokenizerVersion: null, encoding: null, tokenizerId: null, tokenizerRevision: null, reason: "model_missing" };
const profiles = [estimate, { ...estimate, reason: "unsupported_content" as const }, { ...estimate, tokenizerId: "fixture" }]
  .map(profile => attribution.tokenEstimateId(profile));
const capabilities = Array.from({ length: 20 }, (_, index) => {
  const capability: Capability = { kind: ["builtin_tool", "mcp_tool", "cli"][index % 3] as Capability["kind"],
    id: `tool-${index}`, name: `Tool ${index}` };
  return { key: JSON.stringify([capability.kind, null, capability.id]), json: JSON.stringify(capability) };
});
try {
  const started = performance.now();
  const context = db.prepare(`INSERT INTO agent_usage_contexts(context_id,namespace,agent_id,session_id,generation,
    invocation_id,provider_epoch_id,source_id,revision,occurred_at,runtime_kind,model,coverage,history_complete,ranking_inputs_ready)
    VALUES(?,'benchmark','agent',?,1,?,'epoch','fixture',1,?,'codex',NULL,?,1,1)`);
  const input = db.prepare(`INSERT INTO agent_usage_context_inputs(context_id,capability_key,block_kind,evidence,estimate_id,
    first_use,runtime_first_use,byte_length,token_count,exposure_count,known_count,position,capability_json)
    VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?)`);
  const invocation = db.prepare(`INSERT INTO agent_usage_invocations(public_id,namespace,agent_id,session_id,generation,
    invocation_id,provider_epoch_id,execution_id,capability_key,capability_json,started_at,ended_at,status,runtime_kind,origin,source_id,revision,raw_result_bytes)
    VALUES(?,'benchmark','agent',?,1,?,'epoch',NULL,?,?,?,?,'succeeded','codex',?,'fixture',1,?)`);
  const reference = db.prepare("INSERT INTO agent_usage_context_calls VALUES(?,?,?)");
  const payload = db.prepare("INSERT INTO agent_usage_invocation_payloads VALUES(?,'result',40,?,?,0)");
  const content = db.prepare(`INSERT INTO agent_usage_conversation_content(namespace,session_id,agent_id,run_id,event_key,category,
    occurred_at,runtime_kind,tokens,bytes,partial,estimate_json,estimate_id) VALUES('benchmark',?,'agent',?,?,?,?,'codex',?,7,0,'',?)`);
  // Bulk seed the existing compact projection to make its read cost independently measurable.
  // Public-write/projection parity is covered by agent-usage-projections.test.ts.
  db.transaction(() => {
    for (let index = 0; index < contexts; index++) {
      const id = index.toString(16).padStart(64, "0"), session = String(Math.floor(index / 100));
      const time = new Date(Date.UTC(2026, 9, 6 + index % 7, 0, 0, index % 60)).toISOString();
      context.run(id, session, `request-${index}`, time, ["full", "partial", "opaque", "none"][index % 4]);
      for (const [tool, capability] of capabilities.entries()) {
        const call = `call-${index}-${tool}`;
        invocation.run(call, session, call, capability.key, capability.json, time, time, tool % 2 ? "context" : "execution", tool * 5);
        reference.run(id, capability.key, call);
        payload.run(call, tool % 7 ? tool : null, profiles[tool % 3]);
        for (let group = 0; group < 9; group++) {
          const kind = ["definition", "arguments", "result"][group % 3];
          const first = kind === "result" ? ["first", "repeat", "unknown"][Math.floor(group / 3)] : "";
          const tokens = tool % 7 === 0 || group === 1 ? null : (tool + group) % 5;
          input.run(id, capability.key, kind, ["direct", "matched", "inferred"][Math.floor(group / 3)],
            profiles[(tool + group) % 3], first, first, 7, tokens, tokens === null ? 0 : 1, group * 20 + tool, capability.json);
        }
        content.run(session, index + 1, String(tool), ["configured_instructions", "user_prompt", "assistant_output", "assistant_thought"][tool % 4],
          time, tool % 7 ? tool : null, profiles[tool % 3]);
      }
    }
  })();
  const rollupStarted = performance.now();
  const pagesBefore = Number(db.pragma("page_count", { simple: true }));
  while (attribution.dailyRankings.discover(2000)) {}
  let projectedDays = 0, dailyJob;
  while ((dailyJob = attribution.dailyRankings.nextJob())) {
    assert.equal(attribution.dailyRankings.commit(attribution.dailyRankings.project(dailyJob)), true);
    projectedDays++;
  }
  console.log(JSON.stringify({ phase: "daily-projection", projectedDays, ms: Math.round(performance.now() - rollupStarted),
    storedBytes: (Number(db.pragma("page_count", { simple: true })) - pagesBefore) * Number(db.pragma("page_size", { simple: true })) }));
  const partial = db.prepare("SELECT context_id FROM agent_usage_contexts ORDER BY rowid LIMIT 1").get() as { context_id: string };
  const incrementalStarted = performance.now();
  db.prepare("UPDATE agent_usage_contexts SET coverage='partial' WHERE context_id=?").run(partial.context_id);
  let rebuilt = 0;
  while ((dailyJob = attribution.dailyRankings.nextJob())) {
    assert.equal(attribution.dailyRankings.commit(attribution.dailyRankings.project(dailyJob)), true); rebuilt++;
  }
  console.log(JSON.stringify({ phase: "incremental-rebuild", rebuilt, totalPartitions: projectedDays,
    ms: Math.round(performance.now() - incrementalStarted) }));
  // Compare invalidation overhead inside rolled-back synthetic transactions. No fixture counts change.
  const writeSamples: number[][] = [[], []], rollback = new Error("rollback benchmark");
  const contextIds = (db.prepare("SELECT context_id FROM agent_usage_contexts ORDER BY rowid LIMIT 500").all() as Array<{ context_id: string }>);
  const contentIds = (db.prepare("SELECT rowid FROM agent_usage_conversation_content ORDER BY rowid LIMIT 500").all() as Array<{ rowid: number }>);
  for (let round = 0; round < 5; round++) for (const tracked of round % 2 ? [1, 0] : [0, 1]) {
    try { db.transaction(() => {
      if (!tracked) for (const table of ["agent_usage_contexts", "agent_usage_conversation_content"])
        db.exec(`DROP TRIGGER ${table}_daily_update`);
      const changeContext = db.prepare("UPDATE agent_usage_contexts SET coverage='opaque' WHERE context_id=?");
      const changeContent = db.prepare("UPDATE agent_usage_conversation_content SET tokens=tokens+1 WHERE rowid=?");
      const started = performance.now();
      for (const row of contextIds) changeContext.run(row.context_id);
      for (const row of contentIds) changeContent.run(row.rowid);
      writeSamples[tracked]!.push(Number((performance.now() - started).toFixed(2)));
      throw rollback;
    })(); } catch (error) { if (error !== rollback) throw error; }
  }
  console.log(JSON.stringify({ phase: "invalidation-writes", rows: contextIds.length + contentIds.length,
    baselineMs: [...writeSamples[0]!].sort((a,b)=>a-b)[2], trackedMs: [...writeSamples[1]!].sort((a,b)=>a-b)[2],
    samples: writeSamples, measurement: "Synthetic transaction body; excludes commit/fsync" }));
  db.pragma("wal_checkpoint(TRUNCATE)");
  console.log(JSON.stringify({ phase: "fixture", node: process.version, contexts, compactInputRows: contexts * 180,
    invocations: contexts * 20, contentFragments: contexts * 20, setupMs: Math.round(performance.now() - started) }));
  for (const Store of [Baseline, AttributionStore]) {
    const connection = new Database(db.name, { readonly: true, timeout: 1000 });
    connection.pragma("query_only=ON"); connection.pragma("cache_size=-8192");
    readers.push({ db: connection, attribution: new Store(new UsageStore(connection)) });
  }
  const filter = { namespace: "benchmark", from: "2026-10-06T00:00:00.000Z", to: "2026-10-13T00:00:00.000Z" };
  for (const [name, scope, sort] of [
    ["week-input", filter, "totalInputTokens"],
    ["day-input", { ...filter, from: "2026-10-12T00:00:00.000Z" }, "totalInputTokens"],
    ["week-observed", filter, "observedTotalTokens"]
  ] as const) {
    const read = (version: number) => readers[version]!.attribution.rankingsPage(scope, "all", { sort, limit: 50, offset: 0 });
    // Warm each connection before measuring; alternate order to reduce cache/order bias.
    const expected = read(0); assert.deepEqual(read(1), expected);
    const samples: number[][] = [[], []];
    for (let round = 0; round < 5; round++) for (const version of round % 2 ? [1, 0] : [0, 1]) {
      const started = performance.now(), result = read(version);
      const ms = Number((performance.now() - started).toFixed(2));
      assert.deepEqual(result, expected);
      samples[version]!.push(ms);
      console.log(JSON.stringify({ name, version: version ? "optimized" : "baseline", round, ms, equal: true }));
    }
    const medians = samples.map(values => [...values].sort((a, b) => a - b)[2]!);
    console.log(JSON.stringify({ name, baselineMs: medians[0], optimizedMs: medians[1],
      reductionPercent: Number(((1 - medians[1]! / medians[0]!) * 100).toFixed(1)),
      samples, measurement: "Median of five warm reads on one synthetic file; not production p95" }));
  }
} finally {
  for (const reader of readers) { await reader.attribution.close(); reader.db.close(); }
  await attribution.close(); db.close(); rmSync(root, { recursive: true, force: true });
}
