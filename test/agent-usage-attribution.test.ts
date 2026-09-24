import { fixtureTokenizers } from "./fixtures/agent-usage/tokenizers/helpers.js";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Capability, InvocationInput, ModelContextInput } from "../src/agent-usage/core/context-types.js";
import { AttributionStore } from "../src/agent-usage/storage/attribution-store.js";
import { UsageStore } from "../src/agent-usage/storage/usage-store.js";
import { stableHash } from "../src/agent-usage/core/context.js";

const databases: Database.Database[] = [];
const setup = () => {
  const db = new Database(":memory:"); databases.push(db);
  const usage = new UsageStore(db);
  const attribution = new AttributionStore(usage, fixtureTokenizers());
  const binding = usage.bindSession("test", "agent-1", "session-1");
  return { db, usage, attribution, binding };
};
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const capability: Capability = { id: "fetch", kind: "mcp_tool", name: "Fetch", serverId: "web" };
const invocation = (overrides: Partial<InvocationInput> = {}): InvocationInput => ({
  invocationId: "call-1", providerEpochId: "epoch-1", executionId: "run-1", capability,
  startedAt: "2026-09-20T10:00:00Z", endedAt: null, status: "running", runtimeKind: "codex", sourceId: "runtime",
  revision: 1, rawResultBytes: null, ...overrides
});
const context = (): ModelContextInput => ({
  invocationId: "model-2", providerEpochId: "epoch-1", sourceId: "context-snapshot", revision: 1,
  occurredAt: "2026-09-21T10:00:00Z", runtimeKind: "codex", model: "gpt-test", coverage: "full",
  historyComplete: true, blocks: [{
    position: 0, kind: "result", toolInvocationId: "call-1",
    content: { identity: "result-1", modality: "text", text: "visible result" },
    capabilities: [{ capability, evidence: "direct" }]
  }]
});

describe("agent usage invocation attribution", () => {
  it("adds each request exposure once and filters cumulative occupation by Agent, Session and date", async () => {
    const { usage, attribution, binding } = setup();
    const sameAgent = usage.bindSession("test", "agent-1", "session-2");
    const otherAgent = usage.bindSession("test", "agent-2", "session-3");
    const blocks: ModelContextInput["blocks"] = [
      { position: 0, kind: "definition", content: { identity: "definition", modality: "text", text: "search definition" },
        capabilities: [{ capability, evidence: "direct" }] },
      { position: 1, kind: "arguments", toolInvocationId: "call-1",
        content: { identity: "arguments", modality: "text", text: "search arguments" },
        capabilities: [{ capability, evidence: "direct" }] },
      { ...context().blocks[0]!, position: 2 }
    ];
    const save = (subject: typeof binding, id: string, date: string) => attribution.upsertContext(subject,
      { ...context(), invocationId: id, occurredAt: date, blocks });
    await save(binding, "first", "2026-09-20T10:00:00Z");
    const one = attribution.rankings({ namespace: "test", sessionId: binding.sessionId }, "mcp_tool")[0]!;
    await save(binding, "second", "2026-09-21T10:00:00Z");
    await save(sameAgent, "third", "2026-09-21T11:00:00Z");
    await save(otherAgent, "fourth", "2026-09-21T12:00:00Z");
    expect(attribution.rankings({ namespace: "test", sessionId: binding.sessionId }, "mcp_tool")[0])
      .toMatchObject({ totalInputTokens: one.totalInputTokens! * 2, argumentInputTokens: one.argumentInputTokens! * 2,
        exposureCount: 6 });
    expect(attribution.rankings({ namespace: "test", agentId: binding.agentId }, "mcp_tool")[0])
      .toMatchObject({ totalInputTokens: one.totalInputTokens! * 3, exposureCount: 9 });
    expect(attribution.rankings({ namespace: "test", agentId: binding.agentId,
      from: "2026-09-21T00:00:00Z", to: "2026-09-22T00:00:00Z" }, "mcp_tool")[0])
      .toMatchObject({ totalInputTokens: one.totalInputTokens! * 2, exposureCount: 6 });
    expect(attribution.rankingsPage({ namespace: "test" }, "mcp_tool",
      { sort: "argumentInputTokens", limit: 10, offset: 0 }).items[0]?.argumentInputTokens)
      .toBe(one.argumentInputTokens! * 4);
  });

  it("selects bounded indexed context candidates before building evidence page IDs", async () => {
    const { db, attribution, binding } = setup();
    for (let index = 0; index < 200; index++) await attribution.upsertContext(binding, {
      ...context(), invocationId: `page-${index}`, occurredAt: new Date(Date.UTC(2026, 8, 20, 0, index)).toISOString()
    });
    let ids = 0;
    db.function("usage_evidence_id", { deterministic: true }, (contextId: string, key: string) => {
      ids++; return `${Buffer.from(contextId, "hex").toString("base64url")}.${Buffer.from(stableHash(key), "hex").toString("base64url")}`;
    });
    const first = attribution.contextEvidence({ namespace: "test" }, { limit: 5 });
    expect(first.map((row) => row.modelInvocationId)).toEqual(["page-199", "page-198", "page-197", "page-196", "page-195"]);
    expect(ids).toBeLessThanOrEqual(10);
    ids = 0;
    const next = attribution.contextEvidence({ namespace: "test" }, { limit: 5, cursor: { id: first[4]!.id, t: first[4]!.occurredAt! } });
    expect(next.map((row) => row.modelInvocationId)).toEqual(["page-194", "page-193", "page-192", "page-191", "page-190"]);
    expect(ids).toBeLessThanOrEqual(20);
  });
  it("materializes aggregate rows instead of the exposure history for rankings", async () => {
    const { db, attribution, binding } = setup();
    for (let index = 0; index < 200; index++) await attribution.upsertContext(binding, {
      ...context(), invocationId: `request-${index}`, occurredAt: new Date(Date.UTC(2026, 8, 20, 0, index)).toISOString()
    });
    const prepare = db.prepare.bind(db); let largest = 0;
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      const statement = prepare(sql);
      if (/agent_usage_exposures/.test(sql)) {
        const all = statement.all.bind(statement);
        statement.all = (...args: unknown[]) => { const rows = all(...args); largest = Math.max(largest, rows.length); return rows; };
      }
      return statement;
    });
    try {
      expect(attribution.rankings({ namespace: "test" }, "mcp_tool")[0])
        .toMatchObject({ firstResultInputTokens: 2, repeatedResultInputTokens: 398, exposureCount: 200 });
      expect(attribution.rankings({ namespace: "test", from: "2026-09-20T03:19:00Z" }, "mcp_tool")[0])
        .toMatchObject({ firstResultInputTokens: 0, repeatedResultInputTokens: 2, exposureCount: 1 });
      expect(largest).toBeLessThanOrEqual(10);
    } finally { spy.mockRestore(); }
  });
  it("repairs first-use indexes for late contexts, timestamp revisions, removed blocks and restart", async () => {
    const { usage, attribution, binding } = setup();
    const input = context();
    await attribution.upsertContext(binding, input);
    await attribution.upsertContext(binding, { ...input, invocationId: "older", occurredAt: "2026-09-20T10:00:00Z", historyComplete: false });
    const latest = { namespace: "test", from: "2026-09-21T00:00:00Z" };
    expect(attribution.rankings(latest, "mcp_tool")[0]).toMatchObject({ firstResultInputTokens: 0, repeatedResultInputTokens: 2 });
    await attribution.upsertContext(binding, { ...input, invocationId: "older", revision: 2, occurredAt: "2026-09-22T10:00:00Z" });
    expect(attribution.rankings(latest, "mcp_tool")[0]).toMatchObject({ firstResultInputTokens: 2, repeatedResultInputTokens: 2 });
    await attribution.upsertContext(binding, { ...input, revision: 2, blocks: [] });
    const restarted = new AttributionStore(usage, fixtureTokenizers());
    expect(restarted.rankings(latest, "mcp_tool")[0]).toMatchObject({ firstResultInputTokens: 2, repeatedResultInputTokens: 0 });
  });
  it("keeps lifetime repeat classification beyond SQLite's historical context variable limit", async () => {
    const { db, attribution, binding } = setup();
    const old = context(); old.invocationId = "old-model"; old.occurredAt = "2026-01-01T10:00:00Z";
    await attribution.upsertContext(binding, old);
    await attribution.upsertContext(binding, context());
    db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 32767)
      INSERT INTO agent_usage_contexts (context_id,namespace,agent_id,session_id,generation,invocation_id,
        provider_epoch_id,source_id,revision,occurred_at,runtime_kind,model,coverage,history_complete,evidence_sort_key)
      SELECT 'historical-' || x, namespace, agent_id, session_id, generation, 'historical-' || x,
        provider_epoch_id, source_id, revision, '2026-01-01T00:00:00.000Z', runtime_kind, model, coverage, history_complete, NULL
      FROM n CROSS JOIN (SELECT * FROM agent_usage_contexts LIMIT 1)`);
    expect(attribution.rankings({ namespace: "test", from: "2026-09-21T00:00:00Z" }, "mcp_tool")[0])
      .toMatchObject({ calls: 0, firstResultInputTokens: 0, repeatedResultInputTokens: 2, exposureCount: 1 });
  });

  it("separates context-only tool evidence from execution counts with and without dates", async () => {
    const { attribution, binding } = setup();
    attribution.observeInvocation(binding, invocation({ origin: "context", startedAt: null, status: "succeeded" }));
    await attribution.upsertContext(binding, context());
    for (const filter of [{ namespace: "test" }, { namespace: "test", from: "2026-09-21T00:00:00Z", to: "2026-09-22T00:00:00Z" }]) {
      expect(attribution.rankings(filter, "mcp_tool")[0]).toMatchObject({ calls: 0, contextOnlyCalls: 1 });
      expect(attribution.invocations(filter)).toEqual([]);
      expect(attribution.invocations(filter, "context")).toHaveLength(1);
    }
  });

  it("treats multiple observations as one call and never regresses a final state", () => {
    const { attribution, binding } = setup();
    attribution.observeInvocation(binding, invocation());
    attribution.observeInvocation(binding, invocation({
      revision: 2, endedAt: "2026-09-20T10:00:02Z", status: "succeeded", rawResultBytes: 120
    }));
    attribution.observeInvocation(binding, invocation({ revision: 1, status: "transport_error" }));
    attribution.observeInvocation(binding, invocation({ revision: 3, status: "running" }));

    expect(attribution.invocations({ namespace: "test" })).toHaveLength(1);
    expect(attribution.rankings({ namespace: "test" }, "mcp_tool")[0]).toMatchObject({
      calls: 1, successes: 1, failures: 0, unfinished: 0,
      rawResultBytes: 120, rawResultBytesP50: 120, rawResultBytesP95: 120, rawResultBytesSampleCount: 1,
      latencyMsP50: 2000, latencyMsP95: 2000, latencySampleCount: 1,
      totalInputTokens: null
    });
  });

  it("uses invocation time for calls and context time for input contribution", async () => {
    const { attribution, binding } = setup();
    attribution.observeInvocation(binding, invocation({
      revision: 2, endedAt: "2026-09-20T10:00:01Z", status: "succeeded", rawResultBytes: 10
    }));
    await attribution.upsertContext(binding, context());

    const dayOne = attribution.rankings({ namespace: "test", from: "2026-09-20T00:00:00Z", to: "2026-09-21T00:00:00Z" }, "mcp_tool")[0]!;
    expect(dayOne).toMatchObject({ calls: 1, exposureCount: 0, totalInputTokens: null });
    const dayTwo = attribution.rankings({ namespace: "test", from: "2026-09-21T00:00:00Z", to: "2026-09-22T00:00:00Z" }, "mcp_tool")[0]!;
    expect(dayTwo).toMatchObject({ calls: 0, exposureCount: 1, firstResultInputTokens: 2 });
  });

  it("returns stable collision-safe public IDs and body-free detail", async () => {
    const { attribution, usage, binding } = setup();
    attribution.observeInvocation(binding, invocation({
      revision: 2, endedAt: "2026-09-20T10:00:01Z", status: "succeeded", rawResultBytes: 10
    }));
    await attribution.upsertContext(binding, context());
    const first = attribution.invocations({ namespace: "test" })[0]!;
    const detail = attribution.detail("test", first.id)!;
    expect(detail).toMatchObject({
      invocation: { id: first.id, invocationId: "call-1", runtimeKind: "codex", executionEvidence: "unknown", origin: "execution" },
      subsequentModelInvocationIds: ["model-2"],
      exposures: [{ modelInvocationId: "model-2", contentIdentityHash: expect.stringMatching(/^[a-f0-9]{64}$/), tokens: 2 }]
    });
    expect(JSON.stringify(detail)).not.toContain("visible result");
    expect(attribution.detail("other", first.id)).toBeNull();

    const other = usage.bindSession("test", "agent-1", "session-2");
    attribution.observeInvocation(other, invocation());
    expect(attribution.invocations({ namespace: "test", sessionId: "session-2" })[0]!.id).not.toBe(first.id);
  });

  it("deletes only the selected session and rejects late or stale writes", async () => {
    const { attribution, usage, binding } = setup();
    attribution.observeInvocation(binding, invocation());
    await attribution.upsertContext(binding, context());
    const other = usage.bindSession("test", "agent-1", "session-2");
    attribution.observeInvocation(other, invocation());

    usage.deleteSession("test", "session-1");
    attribution.deleteSession("test", "session-1");
    attribution.deleteSession("test", "session-1");
    expect(attribution.invocations({ namespace: "test", sessionId: "session-1" })).toEqual([]);
    expect(attribution.invocations({ namespace: "test", sessionId: "session-2" })).toHaveLength(1);
    expect(() => attribution.observeInvocation(binding, invocation({ revision: 2 }))).toThrow("usage_subject_deleted");
    await expect(attribution.upsertContext(binding, { ...context(), revision: 2 })).rejects.toThrow("usage_subject_deleted");
  });

  it("keeps unknown capabilities queryable", () => {
    const { attribution, binding } = setup();
    attribution.observeInvocation(binding, invocation({ capability: { id: "unmapped", kind: "unknown", name: "Unmapped" } }));
    expect(attribution.rankings({ namespace: "test" }, "unknown")[0]).toMatchObject({ calls: 1, capability: { id: "unmapped" } });
  });

  it("filters invocation-only evidence by its persisted runtime and preserves unknown runtime", () => {
    const { attribution, binding } = setup();
    attribution.observeInvocation(binding, invocation({
      invocationId: "codex-only", executionEvidence: "inferred", status: "tool_error", endedAt: "2026-09-20T10:00:01Z"
    }));
    attribution.observeInvocation(binding, invocation({ invocationId: "unknown-runtime", runtimeKind: null }));

    expect(attribution.invocations({ namespace: "test", runtimeKind: "codex" })).toEqual([
      expect.objectContaining({ invocationId: "codex-only", runtimeKind: "codex", executionEvidence: "inferred" })
    ]);
    expect(attribution.invocations({ namespace: "test", runtimeKind: "claude" })).toEqual([]);
    expect(attribution.rankings({ namespace: "test", runtimeKind: "codex" }, "mcp_tool")[0]).toMatchObject({
      calls: 1, failures: 1, exposureCount: 0
    });
    expect(attribution.invocations({ namespace: "test" })).toEqual(expect.arrayContaining([
      expect.objectContaining({ invocationId: "unknown-runtime", runtimeKind: null })
    ]));
  });

  it("uses execution observations as the call-counting source while retaining context evidence for detail", async () => {
    const { attribution, binding } = setup();
    attribution.observeInvocation(binding, invocation({
      invocationId: "context-call", startedAt: null, origin: "context", sourceId: "context-snapshot"
    }));
    const contextOnly = attribution.invocations({ namespace: "test" }, "context")[0]!;
    attribution.observeInvocation(binding, invocation({ invocationId: "wrapper-call", origin: "execution" }));
    await attribution.upsertContext(binding, {
      ...context(),
      blocks: [{ ...context().blocks[0]!, toolInvocationId: "context-call" }]
    });

    expect(attribution.invocations({ namespace: "test" })).toEqual([
      expect.objectContaining({ invocationId: "wrapper-call", origin: "execution" })
    ]);
    expect(attribution.rankings({ namespace: "test" }, "mcp_tool")[0]).toMatchObject({ calls: 1 });
    expect(attribution.invocations({
      namespace: "test", from: "2026-09-21T00:00:00Z", to: "2026-09-22T00:00:00Z"
    }, "context")).toEqual([
      expect.objectContaining({ invocationId: "context-call", origin: "context", startedAt: null })
    ]);
    expect(attribution.invocations({
      namespace: "test", from: "2026-09-20T00:00:00Z", to: "2026-09-21T00:00:00Z"
    }, "context")).toEqual([]);
    expect(attribution.detail("test", contextOnly.id)).toMatchObject({
      invocation: { invocationId: "context-call", origin: "context" },
      subsequentModelInvocationIds: ["model-2"]
    });
  });

  it.each(["execution-first", "context-first"] as const)(
    "keeps execution authoritative for the same canonical call when %s",
    async (order) => {
      const { attribution, binding } = setup();
      const execution = invocation({
        invocationId: "canonical-call", revision: 1, origin: "execution", executionEvidence: "direct",
        startedAt: "2026-09-20T10:00:00Z", endedAt: "2026-09-20T10:00:01Z",
        status: "succeeded", rawResultBytes: 321
      });
      const imported = invocation({
        invocationId: "canonical-call", revision: 20, origin: "context", executionEvidence: "unknown",
        startedAt: null, endedAt: null, status: "succeeded", runtimeKind: null, rawResultBytes: null,
        sourceId: "context-snapshot"
      });
      if (order === "execution-first") {
        attribution.observeInvocation(binding, execution);
        attribution.observeInvocation(binding, imported);
      } else {
        attribution.observeInvocation(binding, imported);
        attribution.observeInvocation(binding, execution);
      }
      await attribution.upsertContext(binding, {
        ...context(),
        blocks: [{
          ...context().blocks[0]!, toolInvocationId: "canonical-call"
        }]
      });

      expect(attribution.invocations({ namespace: "test" })).toEqual([
        expect.objectContaining({
          invocationId: "canonical-call", origin: "execution", revision: 1, executionEvidence: "direct",
          startedAt: "2026-09-20T10:00:00.000Z", endedAt: "2026-09-20T10:00:01.000Z", rawResultBytes: 321
        })
      ]);
      expect(attribution.rankings({
        namespace: "test", from: "2026-09-20T00:00:00Z", to: "2026-09-21T00:00:00Z"
      }, "mcp_tool")[0]).toMatchObject({ calls: 1, successes: 1, rawResultBytes: 321 });
      expect(attribution.rankings({ namespace: "test" }, "mcp_tool")[0]).toMatchObject({ exposureCount: 1 });
    }
  );
});
