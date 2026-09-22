import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { ManagedUsageSources } from "../src/agent-usage/managed-sources.js";
import { measureToolContent } from "../src/agent-usage/core/tool-content.js";
import type { Capability } from "../src/agent-usage/core/context-types.js";
import { accountingRequests } from "./fixtures/agent-usage/accounting.js";
import { createFakeRuntime, createTestDatabase } from "./helpers.js";

it("keeps mixed capability, content and provider totals scoped while independently paging management evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-query-scope-"));
  const { db, seed } = createTestDatabase();
  const selected = seed.session(), sibling = seed.session(), foreign = seed.session();
  const otherAgent = Number(db.prepare(`INSERT INTO agents (name, provider, project_environment_id, created_at, updated_at)
    VALUES ('Other fixture', 'codex', ?, ?, ?)`).run(seed.projectEnvironment.id, "2026-09-20", "2026-09-20").lastInsertRowid);
  db.prepare("UPDATE sessions SET agent_id=? WHERE id=?").run(otherAgent, foreign.id);
  const config = loadConfig({ API_TOKEN: "scope-fixture", DATA_DIR: root, DATABASE_PATH: ":memory:",
    PROJECT_ENVIRONMENTS_ROOT: join(root, "environments"), SESSIONS_ROOT: join(root, "sessions"), SESSION_RETENTION_HOURS: "0" });
  const manager = new ManagedUsageSources(db, config), host = manager.collector;
  const app = buildApp({ db, config, runtime: createFakeRuntime(), usageSources: manager,
    sessionCleanupScheduler: { start() {}, stop() {}, async runCleanup() {} } });
  const get = async (path: string) => {
    const response = await app.inject({ url: `/api/usage${path}`, headers: { authorization: "Bearer scope-fixture" } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toContain("PRIVATE_SCOPE_FIXTURE");
    return response.json();
  };
  try {
    await app.ready(); await host.stopRecovery();
    const builtin: Capability = { kind: "builtin_tool", id: "read", name: "Read" };
    const cli: Capability = { kind: "cli", id: "build", name: "Build" };
    const populate = (sessionId: number, day: number, capability: Capability, tokens: number, runtimeKind = "codex") => {
      const binding = host.binding(sessionId), providerEpochId = host.epoch(sessionId);
      const id = `${sessionId}-${day}-${runtimeKind}`, occurredAt = `2026-09-${day}T01:00:00.000Z`;
      host.attribution.observeInvocation(binding, { invocationId: `call-${id}`, providerEpochId, executionId: null,
        capability, startedAt: occurredAt, endedAt: occurredAt, status: "succeeded", runtimeKind,
        sourceId: "fixture-runtime", revision: 1, rawResultBytes: 30,
        argumentEstimate: measureToolContent("PRIVATE_SCOPE_FIXTURE".repeat(tokens), "arguments"),
        resultEstimate: measureToolContent("PRIVATE_SCOPE_FIXTURE result", "result") });
      for (let repeat = 0; repeat < 3; repeat++) {
        const invocationId = `model-${id}-${repeat}`;
        host.store.observe(binding, { ...accountingRequests()[0]!, eventId: invocationId, coverageId: invocationId,
          invocationId, executionId: null, providerEpochId, occurredAt, runtimeKind,
          metrics: { inputTotalTokens: tokens, outputTotalTokens: 1 } });
        host.attribution.upsertContext(binding, { invocationId, providerEpochId, sourceId: "fixture-context", revision: 1,
          occurredAt, runtimeKind, model: "fixture-unmapped", coverage: "full", historyComplete: true,
          blocks: [
            { position: 0, kind: "result", toolInvocationId: `call-${id}`,
              content: { identity: `result-${id}`, modality: "text", text: "PRIVATE_SCOPE_FIXTURE result" },
              capabilities: [{ capability, evidence: "direct" }] },
            { position: 1, kind: "result", toolInvocationId: `call-${id}`,
              content: { identity: `second-result-${id}`, modality: "text", text: "PRIVATE_SCOPE_FIXTURE second result" },
              capabilities: [{ capability, evidence: "direct" }] },
            { position: 2, kind: "system_prompt", content: { identity: "system", modality: "text", text: "PRIVATE_SCOPE_FIXTURE system" },
              capabilities: [{ capability: { kind: "system_prompt", id: "system_prompt", name: "System prompts" }, evidence: "direct" }] }
          ] });
      }
    };
    populate(selected.id, 20, builtin, 10);
    populate(selected.id, 21, cli, 20);
    populate(selected.id, 22, builtin, 1000); // Exclusive upper bound.
    populate(selected.id, 19, builtin, 1000); // Before the lower bound.
    populate(selected.id, 20, builtin, 1000, "claude_code");
    populate(sibling.id, 20, builtin, 1000);
    populate(foreign.id, 20, builtin, 1000);
    for (const sessionId of [selected.id, sibling.id, foreign.id]) {
      const binding = host.binding(sessionId);
      for (let index = 0; index < 3; index++) host.sources.registerSource({ namespace: host.namespace,
        sourceKey: `session-${sessionId}-source-${index}`, kind: "codex_log", inputRef: { relativePath: "unused-fixture" },
        mappings: [{ sourceSessionKey: "provider", agentId: binding.agentId, sessionId: binding.sessionId, providerEpochId: host.epoch(sessionId) }] });
    }
    const scope = new URLSearchParams({ agentId: String(seed.agent.id), sessionId: String(selected.id),
      runtimeKind: "codex", from: "2026-09-20T08:00:00+08:00", to: "2026-09-22T08:00:00+08:00" });
    const summary = await get(`/summary?${scope}`);
    expect(summary).toMatchObject({ usage: { totalTokens: 96 }, sourceCounts: { idle: 3 }, hasCapabilityEvidence: true });
    const prompts = await get(`/capabilities?${scope}&dimension=system_prompt`);
    expect(prompts).toMatchObject({ total: 1, items: [{ capability: { kind: "system_prompt" }, exposureCount: 6, calls: 0 }] });
    const first = await get(`/capabilities?${scope}&limit=1`), second = await get(`/capabilities?${scope}&limit=1&offset=1`);
    expect(first).toMatchObject({ dimension: "all", total: 3, items: [{ capability: { kind: "cli", id: "build" }, calls: 1 }] });
    expect(second).toMatchObject({ total: 3, items: [{ capability: { kind: "builtin_tool", id: "read" }, calls: 1 }] });
    expect((await get(`/capabilities?${scope}&dimension=builtin_tool`)).items).toEqual(second.items);
    expect((await get(`/capabilities?${scope}&dimension=unknown`)).items).toEqual([]);
    const wrongAgent = new URLSearchParams(scope); wrongAgent.set("agentId", String(otherAgent));
    expect((await get(`/capabilities?${wrongAgent}`)).total).toBe(0);
    expect((await get(`/capabilities?${wrongAgent}&dimension=system_prompt`)).total).toBe(0);
    const sourceScope = `agentId=${seed.agent.id}&sessionId=${selected.id}`;
    const sourceFirst = await get(`/sources?${sourceScope}&page=1&pageSize=2`);
    const sourceLast = await get(`/sources?${sourceScope}&page=2&pageSize=2`);
    expect(sourceFirst).toMatchObject({ total: 3, totalPages: 2 });
    expect(sourceLast).toMatchObject({ total: 3, totalPages: 2 });
    expect([...sourceFirst.items, ...sourceLast.items].map((item) => item.sourceKey)).toEqual(
      [0, 1, 2].map((index) => `session-${selected.id}-source-${index}`));
    const trendFirst = await get(`/timeseries?${scope}&limit=1`), trendLast = await get(`/timeseries?${scope}&limit=1&offset=1`);
    expect(trendFirst.total).toBe(2); expect(trendLast.total).toBe(2);
    expect(trendFirst.items).toHaveLength(1); expect(trendLast.items).toHaveLength(1);
    expect(trendFirst.items[0]).not.toEqual(trendLast.items[0]);
    expect([...trendFirst.items, ...trendLast.items].reduce((sum, item) => sum + item.usage.totalTokens, 0)).toBe(96);
    expect((await get(`/summary?${scope}&offset=1&limit=1`)).usage).toEqual(summary.usage);
    const callsFirst = await get(`/invocations?${scope}&limit=1`);
    const callsLast = await get(`/invocations?${scope}&limit=1&cursor=${callsFirst.nextCursor}`);
    expect(callsFirst.items).toHaveLength(1); expect(callsLast.items).toHaveLength(1);
    expect(callsLast.nextCursor).toBeNull(); expect(callsLast.items[0].id).not.toBe(callsFirst.items[0].id);
    const detailFirst = await get(`/invocations/${callsFirst.items[0].id}?limit=4`);
    const detailLast = await get(`/invocations/${callsFirst.items[0].id}?limit=4&offset=4`);
    expect(detailFirst.exposureTotal).toBe(6); expect(detailLast.exposureTotal).toBe(6);
    expect(detailFirst.exposures).toHaveLength(4); expect(detailLast.exposures).toHaveLength(2);
    expect([...detailFirst.usageEvidence, ...detailLast.usageEvidence]).toHaveLength(3);
    const evidence = await get(`/context-evidence?${scope}&capabilityKind=builtin_tool&limit=1`);
    const nextEvidence = await get(`/context-evidence?${scope}&capabilityKind=builtin_tool&limit=1&cursor=${evidence.nextCursor}`);
    expect(nextEvidence.items[0].id).not.toBe(evidence.items[0].id);
    const contextFirst = await get(`/context-evidence/${evidence.items[0].id}?limit=1`);
    const contextLast = await get(`/context-evidence/${evidence.items[0].id}?limit=1&offset=1`);
    expect(contextFirst.exposureTotal).toBe(2); expect(contextLast.exposureTotal).toBe(2);
    expect(contextFirst.exposures[0].position).not.toBe(contextLast.exposures[0].position);

    db.prepare("UPDATE sessions SET instructions_snapshot=? WHERE id=?").run("PRIVATE_SCOPE_FIXTURE instructions", selected.id);
    for (const sessionId of [selected.id, sibling.id, foreign.id]) {
      for (let index = 0; index < 2; index++) {
        seed.run(sessionId, "succeeded");
        const run = db.prepare("SELECT MAX(id) AS id FROM runs WHERE session_id=?").get(sessionId) as { id: number };
        db.prepare("UPDATE runs SET input=?,started_at=? WHERE id=?")
          .run("PRIVATE_SCOPE_FIXTURE prompt", "2026-09-21T02:00:00.000Z", run.id);
        host.conversationContent.recordRun(run.id);
        host.conversationContent.recordMessage(run.id, { stream: "output", text: "PRIVATE_SCOPE_FIXTURE reply" },
          { sequence: 1, occurredAt: "2026-09-21T02:00:01.000Z" });
      }
    }
    expect(await get(`/capabilities?${scope}&dimension=user_prompt`)).toMatchObject({ total: 1,
      items: [{ capability: { kind: "user_prompt" }, calls: 0, contentObservations: 2 }] });
    expect(await get(`/capabilities?${scope}&dimension=configured_instructions`)).toMatchObject({ total: 1,
      items: [{ capability: { kind: "configured_instructions" }, calls: 0, contentObservations: 2 }] });
    const contentFirst = await get(`/content-evidence?${scope}&capabilityKind=user_prompt&limit=1`);
    const contentLast = await get(`/content-evidence?${scope}&capabilityKind=user_prompt&limit=1&cursor=${contentFirst.nextCursor}`);
    expect(contentFirst.items).toHaveLength(1); expect(contentLast.items).toHaveLength(1);
    expect(contentFirst.items[0].id).not.toBe(contentLast.items[0].id); expect(contentLast.nextCursor).toBeNull();
    expect(contentFirst.items[0]).toMatchObject({ sessionId: String(selected.id), category: "user_prompt", tokens: expect.any(Number) });
    expect(await get(`/content-evidence/${contentFirst.items[0].id}`)).toMatchObject({
      id: contentFirst.items[0].id, bodyStatus: "not_retained", estimate: { method: "text_heuristic" } });
    expect((await get(`/content-evidence?${wrongAgent}&capabilityKind=user_prompt`)).items).toEqual([]);
    expect((await get(`/summary?${scope}`)).usage).toEqual(summary.usage);
    const invalid = await app.inject({ url: "/api/usage/content-evidence?capabilityKind=prompt", headers: { authorization: "Bearer scope-fixture" } });
    expect(invalid.statusCode).toBe(400);
    const missing = await app.inject({ url: "/api/usage/content-evidence/invalid", headers: { authorization: "Bearer scope-fixture" } });
    expect(missing.statusCode).toBe(404);
  } finally { await app.close(); db.close(); await rm(root, { recursive: true, force: true }); }
});
