import { afterEach, describe, expect, it, vi } from "vitest";
import { HostUsageCollector } from "../src/agent-usage/host-collector.js";
import { createTestDatabase } from "./helpers.js";
import { accountingRequests } from "./fixtures/agent-usage/accounting.js";

const databases: Array<ReturnType<typeof createTestDatabase>["db"]> = [];
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const db of databases.splice(0)) db.close(); });
const setup = () => {
  const { db, seed } = createTestDatabase(); databases.push(db);
  const session = seed.session(); seed.run(session.id, "running");
  const runId = (db.prepare("SELECT id FROM runs WHERE session_id = ?").get(session.id) as { id: number }).id;
  const host = new HostUsageCollector(db);
  return { db, seed, session, runId, host };
};

describe("host usage integration", () => {
  it("leaves idle time between background batches proportional to their work", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { host } = setup();
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const step = vi.spyOn(host.contentBackfill, "step").mockImplementation(async () => { elapsed += 30; return true; });
    host.startRecovery();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(step).toHaveBeenCalledTimes(1);
      expect(host.recoveryStatus()).toMatchObject({ phase: "idle", lastBackfillMs: 30,
        lastBackfillAt: expect.any(String) });
      await vi.advanceTimersByTimeAsync(89);
      expect(step).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(step).toHaveBeenCalledTimes(2);
    } finally { await host.stopRecovery(); }
    expect(host.recoveryStatus().phase).toBe("stopped");
  });

  it("does not rescan completed backfill on every retention check", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { host } = setup();
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const backfill = vi.spyOn(host.contentBackfill, "step").mockResolvedValue(false);
    const retention = vi.spyOn(host.eventRetention, "step").mockReturnValue("scanned");
    host.startRecovery();
    try {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(150);
      expect(retention).toHaveBeenCalledTimes(4);
      expect(backfill).toHaveBeenCalledTimes(1);
      elapsed = 5_000;
      await vi.advanceTimersByTimeAsync(50);
      expect(backfill).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(backfill).toHaveBeenCalledTimes(2);
    } finally { await host.stopRecovery(); }
  });

  it("continues retention while content backfill is blocked", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { host } = setup();
    vi.spyOn(host.contentBackfill, "step").mockImplementation(signal => new Promise(resolve => {
      signal!.addEventListener("abort", () => resolve(false), { once: true });
    }));
    const retention = vi.spyOn(host.eventRetention, "step").mockReturnValue("scanned");
    host.startRecovery();
    try {
      await vi.advanceTimersByTimeAsync(200);
      expect(retention.mock.calls.length).toBeGreaterThan(1);
    } finally { await host.stopRecovery(); }
  });

  it("settles failed cleanup discovery once and preserves the error after deleting storage", async () => {
    const { db, session } = setup();
    const discover = vi.fn(async () => { throw new Error("private path"); });
    const host = new HostUsageCollector(db, {}, discover);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await host.prepareMaintenance(session.id, "cleanup");
    await host.prepareMaintenance(session.id, "cleanup");
    expect(discover).toHaveBeenCalledOnce();
    host.finishMaintenance(session.id);
    db.prepare("UPDATE sessions SET storage_cleaned_at=? WHERE id=?").run(new Date().toISOString(), session.id);
    await host.collectSession(session.id);
    expect(discover).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT status,error_code FROM agent_usage_harvests WHERE session_id=?").get(String(session.id)))
      .toEqual({ status: "failed", error_code: "usage_discovery_failed" });
    expect(host.collectionFailures()).toEqual([
      { sessionId: String(session.id), status: "failed", errorCode: "usage_discovery_failed", retryable: false }
    ]);
    expect(host.collectionFailureCount({ sessionId: String(session.id) })).toBe(1);
  });

  it("does not block cleanup when importing legacy statistics fails", async () => {
    const { host, session } = setup();
    vi.spyOn(host, "importLegacy").mockImplementation(() => { throw new Error("invalid legacy counter"); });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(host.prepareMaintenance(session.id, "cleanup")).resolves.toBeUndefined();
    expect(() => host.finishMaintenance(session.id)).not.toThrow();
  });

  it.each([false, true])("preserves a cleanup gap when an earlier discovery settles late (reject=%s)", async reject => {
    const { db, session } = setup();
    let resume!: () => void;
    const delayed = new Promise<void>(resolve => { resume = resolve; });
    const discover = vi.fn().mockImplementationOnce(async () => {
      await delayed;
      if (reject) throw new Error("late discovery failure");
    }).mockRejectedValue(new Error("cleanup discovery failure"));
    const host = new HostUsageCollector(db, {}, discover);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stale = host.collectSession(session.id).catch(() => undefined);
    db.prepare("UPDATE sessions SET pending_operation='cleanup' WHERE id=?").run(session.id);
    await host.prepareMaintenance(session.id, "cleanup");
    host.finishMaintenance(session.id);
    db.prepare("UPDATE sessions SET pending_operation=NULL,storage_cleaned_at=? WHERE id=?").run(new Date().toISOString(), session.id);
    const gap = () => db.prepare("SELECT status,error_code FROM agent_usage_harvests WHERE session_id=?").get(String(session.id));
    expect(gap()).toEqual({ status: "failed", error_code: "usage_discovery_failed" });
    resume();
    await stale;
    expect(gap()).toEqual({ status: "failed", error_code: "usage_discovery_failed" });
  });

  it("times out cleanup discovery and ignores its late result", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { db, session } = setup();
    let resume!: () => void;
    const discover = vi.fn(() => new Promise<void>(resolve => { resume = resolve; }));
    const host = new HostUsageCollector(db, {}, discover);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let settled = false;
    const maintenance = host.prepareMaintenance(session.id, "cleanup").then(() => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(settled).toBe(true);
      host.finishMaintenance(session.id);
      db.prepare("UPDATE sessions SET storage_cleaned_at=? WHERE id=?").run(new Date().toISOString(), session.id);
      resume();
      await vi.advanceTimersByTimeAsync(0);
      expect(host.collectionFailures()).toEqual([expect.objectContaining({ status: "failed", errorCode: "usage_collection_failed" })]);
    } finally { resume(); await maintenance; }
  });

  it("advances context totals while content backfill and source collection remain active", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { host } = setup();
    vi.spyOn(host.contentBackfill, "step").mockResolvedValue(true);
    vi.spyOn(host.sources, "sourceStatusCounts").mockReturnValue({ collecting: 1 });
    const totals = vi.spyOn(host.attribution, "backfillContextTotals").mockReturnValue(true);
    host.startRecovery();
    try {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(100);
      expect(totals.mock.calls.length).toBeGreaterThan(1);
      expect(totals).toHaveBeenCalledWith(20);
    } finally { await host.stopRecovery(); }
  });

  it("stops in-flight content measurement without committing it and can resume", async () => {
    const { host, db, runId } = setup();
    db.prepare("UPDATE runs SET status='succeeded' WHERE id=?").run(runId);
    db.prepare("INSERT INTO events (run_id,seq,type,content_json,created_at) VALUES (?,1,'tool','{}',?)")
      .run(runId, "2026-09-22T01:00:00.000Z");
    let signal: AbortSignal | undefined;
    const commit = vi.fn();
    const prepare = vi.spyOn(host.runtimeCapabilities, "prepareTool").mockImplementation(async (_id, _content, _event, currentSignal) => {
      signal = currentSignal;
      await new Promise<void>(resolve => currentSignal!.addEventListener("abort", () => resolve(), { once: true }));
      return { commit };
    });
    host.startRecovery();
    try {
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
      await host.stopRecovery();
      expect(signal?.aborted).toBe(true);
      expect(commit).not.toHaveBeenCalled();
      expect(host.contentBackfill.status()).toMatchObject({ status: "pending", processedEvents: 0 });
      prepare.mockResolvedValue({ commit });
      host.startRecovery();
      await vi.waitFor(() => expect(host.contentBackfill.status()).toMatchObject({ status: "completed", processedEvents: 1 }));
      expect(commit).toHaveBeenCalledTimes(1);
    } finally { await host.stopRecovery(); }
  });

  it("starts bounded content replay automatically without native-log or HTTP capture configuration", async () => {
    const { host, db, runId, session } = setup();
    db.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(runId);
    db.prepare("INSERT INTO events (run_id, seq, type, content_json, created_at) VALUES (?, 1, 'tool', ?, ?)")
      .run(runId, JSON.stringify({ toolCallId: "retained", kind: "read", status: "completed", rawOutput: "hello world" }), "2026-09-21T12:00:00.000Z");
    expect(host.contentBackfill.status().status).toBe("pending");
    host.startRecovery();
    try {
      await vi.waitFor(() => expect(host.contentBackfill.status().status).toBe("completed"));
      expect(host.attribution.rankings({ namespace: host.namespace }, "builtin_tool")).toEqual([
        expect.objectContaining({ calls: 1, observedResultTokens: 3, totalInputTokens: null })
      ]);
    } finally { await host.stopRecovery(); }
    const restarted = new HostUsageCollector(db);
    expect(restarted.contentBackfill.status()).toMatchObject({ status: "completed", processedEvents: 1 });
    restarted.deleteSession(session.id);
    expect(restarted.contentBackfill.status()).toMatchObject({ status: "completed", processedEvents: 0 });
  });

  it("reuses a ready maintenance barrier without rediscovering potentially purged files", async () => {
    const { db, session } = setup();
    const discover = vi.fn(async () => undefined);
    const host = new HostUsageCollector(db, {}, discover);
    await host.prepareMaintenance(session.id, "reset");
    discover.mockRejectedValue(new Error("files already purged"));
    await host.prepareMaintenance(session.id, "reset");
    expect(discover).toHaveBeenCalledTimes(1);
    await expect(host.prepareMaintenance(session.id, "cleanup")).rejects.toThrow("usage_maintenance_conflict");
    host.finishMaintenance(session.id);
    expect(host.collectionFailures()).toEqual([]);
  });

  it("imports only the maintained Session and its Runs when a Session is supplied", () => {
    const { db, host, seed, session } = setup();
    const other = seed.session();
    seed.run(other.id, "succeeded");
    db.prepare("UPDATE sessions SET total_tokens=100").run();
    db.prepare("UPDATE runs SET total_tokens=50").run();
    host.importLegacy(session.id);
    expect(host.store.records().map((row) => row.sessionId)).toEqual([String(session.id), String(session.id)]);
    host.importLegacy();
    expect(host.store.records()).toHaveLength(4);
  });

  it("continues recovery beyond one batch in the same process", async () => {
    const { db, seed } = setup();
    for (let index = 0; index < 101; index++) seed.session();
    db.prepare("UPDATE sessions SET provider_session_id = 'native'").run();
    const host = new HostUsageCollector(db, {}, async (id) => {
      host.store.observe(host.binding(id), { ...accountingRequests()[0]!, eventId: String(id), coverageId: String(id) });
    });
    host.startRecovery();
    try {
      await vi.waitFor(() => expect(host.store.records()).toHaveLength(102));
      expect(host.collectionFailures()).toEqual([]);
    } finally { await host.stopRecovery(); }
  });

  it("background registered-source retries do not block readiness or monopolize sessions", async () => {
    const { db, seed } = setup();
    const session = seed.session();
    db.prepare("UPDATE sessions SET provider_session_id = 'native' WHERE id = ?").run(session.id);
    const host = new HostUsageCollector(db, { blocked: {
      describe: () => ({ usage: "none", context: "none", identity: "explicit", version: "1" }),
      freeze: async () => "boundary",
      async *collect(_input, _checkpoint, _boundary, signal) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      }
    } }, async (id) => {
      host.store.observe(host.binding(id), { ...accountingRequests()[0]!, eventId: String(id), coverageId: String(id) });
    });
    const registered = host.sources.registerSource({ namespace: host.namespace, sourceKey: "blocked", kind: "blocked", inputRef: {},
      mappings: [{ sourceSessionKey: "blocked", agentId: "1", sessionId: "1", providerEpochId: host.epoch(1) }] });
    db.prepare("UPDATE agent_usage_sources SET status = 'failed' WHERE id = ?").run(registered.id);
    expect(host.startRecovery()).toBeUndefined();
    try { await vi.waitFor(() => expect(host.store.records({ sessionId: String(session.id) })).toHaveLength(1)); }
    finally { await host.stopRecovery(); }
  });

  it("final harvest drains recently producing sessions beyond historical recovery batches", async () => {
    const { db, seed } = setup();
    for (let index = 0; index < 101; index++) seed.session();
    db.prepare("UPDATE sessions SET provider_session_id = 'native'").run();
    let total = 100;
    const host = new HostUsageCollector(db, {}, async (id) => {
      host.store.observe(host.binding(id), { ...accountingRequests()[0]!, eventId: `${id}:${total}`, coverageId: String(id),
        semantics: "snapshot", revision: total, metrics: { totalTokens: total } });
    });
    host.startRecovery();
    await vi.waitFor(() => expect(host.store.records()).toHaveLength(102));
    await host.stopRecovery();
    await host.collectSession(102);
    total = 190;
    await host.harvestFinalSessions();
    expect(host.store.summary({ sessionId: "102" }).usage.totalTokens).toBe(190);
    expect(host.collectionFailures()).toEqual([]);
  });

  it("skips deleted and storage-retired sessions during recovery", async () => {
    const { host, db, seed, session } = setup();
    const retired = seed.session();
    db.prepare("UPDATE sessions SET provider_session_id = 'native' WHERE id IN (?, ?)").run(session.id, retired.id);
    host.deleteSession(session.id);
    db.prepare("UPDATE sessions SET storage_cleaned_at = '2026-09-21T00:00:00Z' WHERE id = ?").run(retired.id);
    host.startRecovery();
    await host.stopRecovery();
    expect(host.collectionFailures()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_usage_harvests").get()).toEqual({ n: 0 });
  });

  it("clears pending harvest state when the maintenance barrier completes", async () => {
    const { host, session } = setup();
    await host.prepareMaintenance(session.id, "reset");
    host.finishMaintenance(session.id);
    expect(host.collectionFailures()).toEqual([]);
  });

  it("persists live usage evidence before the Run reaches a terminal state", () => {
    const { host, db, runId } = setup();
    host.recordRunUsage(runId, { inputTokens: 1000, outputTokens: 100 }, accountingRequests()[0]!);
    const restarted = new HostUsageCollector(db);
    expect(restarted.store.summary({ namespace: restarted.namespace }).usage.totalTokens).toBe(1100);
    expect(db.prepare("SELECT status FROM runs WHERE id = ?").get(runId)).toEqual({ status: "running" });
  });

  it("keeps unverified Runtime counters out of additive totals", () => {
    const { host, runId } = setup();
    host.recordRunUsage(runId, { inputTokens: 1000, outputTokens: 100, contextUsedTokens: 20000 });
    const result = host.store.summary({ namespace: host.namespace });
    expect(result.usage.totalTokens).toBeNull();
    expect(result.unverifiedObservations).toBe(1);
  });

  it("imports legacy history idempotently with uncertain semantics and no fabricated date", () => {
    const { host, db, session } = setup();
    db.prepare("UPDATE sessions SET total_tokens = 1234 WHERE id = ?").run(session.id);
    host.importLegacy(); host.importLegacy();
    expect(host.store.records({ namespace: host.namespace })).toHaveLength(1);
    expect(host.store.records({ namespace: host.namespace })[0]).toMatchObject({
      occurredAt: null, normalizationProfile: null, metrics: { totalTokens: 1234 }
    });
    expect(host.store.summary({ namespace: host.namespace }).usage.totalTokens).toBeNull();
  });

  it("does not reprocess imported snapshots on restart and still imports late zero counters", () => {
    const { host, db, session, seed } = setup();
    const later = seed.session();
    seed.run(later.id, "succeeded");
    db.prepare("UPDATE sessions SET total_tokens=123 WHERE id=?").run(session.id);
    db.prepare("UPDATE runs SET total_tokens=50 WHERE session_id=?").run(session.id);
    host.importLegacy();
    const before = host.store.records();

    const restarted = new HostUsageCollector(db);
    const observe = vi.spyOn(restarted.store, "observe");
    restarted.importLegacy();
    restarted.importLegacy(session.id);
    expect(observe).not.toHaveBeenCalled();
    expect(restarted.store.records()).toEqual(before);

    db.prepare("UPDATE sessions SET cached_read_tokens=0 WHERE id=?").run(later.id);
    db.prepare("UPDATE runs SET thought_tokens=0 WHERE session_id=?").run(later.id);
    restarted.importLegacy();
    expect(observe).toHaveBeenCalledTimes(2);
    const imported = restarted.store.records().filter(row => row.sessionId === String(later.id));
    expect(imported).toHaveLength(2);
    expect(imported.find(row => row.sourceId === "legacy_session_snapshot")?.metrics.cacheReadTokens).toBe(0);
    expect(imported.find(row => row.sourceId === "legacy_run_snapshot")?.metrics.reasoningOutputTokens).toBe(0);
  });

  it("reads legacy counters without materializing historical prompts or results", () => {
    const { host, db, session } = setup();
    db.prepare("UPDATE sessions SET total_tokens=123, instructions_snapshot=? WHERE id=?").run("large instructions", session.id);
    db.prepare("UPDATE runs SET total_tokens=50, input=?, result=? WHERE session_id=?")
      .run("large input", "large result", session.id);
    const prepare = db.prepare.bind(db);
    const returned: Record<string, unknown>[] = [];
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      const statement = prepare(sql);
      if (/SELECT[\s\S]*FROM (sessions s|runs r)/.test(sql)) {
        const all = statement.all.bind(statement);
        statement.all = (...params: unknown[]) => {
          const rows = all(...params) as Record<string, unknown>[];
          returned.push(...rows);
          return rows;
        };
      }
      return statement;
    });
    try { host.importLegacy(); } finally { spy.mockRestore(); }
    expect(returned).toHaveLength(2);
    for (const row of returned) {
      expect(row).not.toHaveProperty("input");
      expect(row).not.toHaveProperty("result");
      expect(row).not.toHaveProperty("instructions_snapshot");
    }
  });

  it("retains legacy Run evidence independently of overlapping Session snapshots", () => {
    const { host, db, session, runId } = setup();
    db.prepare("UPDATE sessions SET total_tokens = 1234 WHERE id = ?").run(session.id);
    db.prepare("UPDATE runs SET total_tokens = 200, started_at = '2026-09-20T01:00:00Z' WHERE id = ?").run(runId);
    host.importLegacy(); host.importLegacy();
    const rows = host.store.records({ namespace: host.namespace });
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.sourceId === "legacy_run_snapshot")).toMatchObject({
      scope: "turn", semantics: "unknown", executionId: String(runId), occurredAt: "2026-09-20T01:00:00.000Z",
      normalizationProfile: null, metrics: { totalTokens: 200 }
    });
    expect(host.store.summary({ namespace: host.namespace })).toMatchObject({
      usage: { totalTokens: null }, unverifiedObservations: 2
    });
  });

  it("keeps old epochs after reset and fences explicitly deleted subjects", async () => {
    const { host, session, runId } = setup();
    host.recordRunUsage(runId, {}, accountingRequests()[0]!);
    const before = host.epoch(session.id);
    await host.prepareMaintenance(session.id, "reset");
    host.finishMaintenance(session.id);
    expect(host.epoch(session.id)).not.toBe(before);
    expect(host.store.summary({ namespace: host.namespace }).usage.totalTokens).toBe(1100);
    host.deleteSession(session.id);
    expect(() => host.binding(session.id)).toThrow("usage_subject_deleted");
    expect(host.store.summary({ namespace: host.namespace }).usage.totalTokens).toBeNull();
  });
});
