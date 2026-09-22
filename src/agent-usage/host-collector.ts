import { pageResult, type PaginationQuery } from "../pagination.js";
import { UsageError } from "./core/errors.js";
import { ModelTokenizers } from "./core/tokenizers.js";
import type Database from "better-sqlite3";
import type { HostUsageCapture } from "./capture/host-capture.js";
import type { McpUsageObserver } from "./mcp-observer.js";
import type { TokenUsage } from "../domain.js";
import type { UsageBinding, UsageFilter, UsageMetrics, UsageObservation } from "./core/types.js";
import { UsageStore } from "./storage/usage-store.js";
import { UsageSourceCoordinator, type UsageSourceAdapter } from "./source-coordinator.js";
import { AttributionStore } from "./storage/attribution-store.js";
import { RuntimeCapabilityCollector } from "./runtime-capabilities.js";
import { RuntimeContentBackfill } from "./runtime-backfill.js";
import { RuntimeConversationCollector } from "./runtime-conversation.js";

/** The only layer that translates business-table IDs into the reusable usage module. */
export class HostUsageCollector {
  readonly namespace = "remote-agent-server";
  capture?: HostUsageCapture;
  observer?: McpUsageObserver;
  private readonly producers = new Set<number>();
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private recoveryWork?: Promise<void>;
  private recoveryStopped = true;
  private recoveryQueue: Array<() => Promise<void>> = [];
  readonly store: UsageStore;
  readonly sources: UsageSourceCoordinator;
  readonly attribution: AttributionStore;
  readonly runtimeCapabilities: RuntimeCapabilityCollector;
  readonly contentBackfill: RuntimeContentBackfill;
  readonly conversationContent: RuntimeConversationCollector;
  constructor(readonly db: Database.Database, adapters: Record<string, UsageSourceAdapter> = {},
    private readonly discoverManagedSources?: (sessionId: number) => Promise<void>, tokenizers = new ModelTokenizers()) {
    this.store = new UsageStore(db);
    db.exec(`CREATE TABLE IF NOT EXISTS agent_usage_harvests (
      namespace TEXT NOT NULL, session_id TEXT NOT NULL, status TEXT NOT NULL,
      error_code TEXT, attempted_at TEXT, PRIMARY KEY(namespace, session_id)
    )`);
    this.attribution = new AttributionStore(this.store, tokenizers);
    this.runtimeCapabilities = new RuntimeCapabilityCollector(this.store, this.attribution, this.namespace);
    this.conversationContent = new RuntimeConversationCollector(this.store, this.attribution, this.namespace);
    this.contentBackfill = new RuntimeContentBackfill(db, this.namespace,
      (runId, content, event) => this.runtimeCapabilities.recordTool(runId, content, event), this.conversationContent, tokenizers.knownModels());
    this.sources = new UsageSourceCoordinator(this.store, adapters, 30_000, this.attribution);
  }
  binding(sessionId: number): UsageBinding {
    const session = this.db.prepare("SELECT agent_id FROM sessions WHERE id = ?").get(sessionId) as { agent_id: number } | undefined;
    if (!session) throw new UsageError("usage_session_not_found");
    return this.store.bindSession(this.namespace, String(session.agent_id), String(sessionId));
  }

  epoch(sessionId: number): string {
    this.binding(sessionId);
    const row = this.db.prepare("SELECT epoch FROM agent_usage_subjects WHERE namespace = ? AND kind = 'session' AND subject_id = ?")
      .get(this.namespace, String(sessionId)) as { epoch: number };
    return `session:${sessionId}:epoch:${row.epoch}`;
  }

  recordRunUsage(runId: number, usage: Partial<TokenUsage>, observation?: UsageObservation): void {
    const run = this.db.prepare(`SELECT r.session_id, r.started_at, a.provider FROM runs r
      JOIN sessions s ON s.id = r.session_id JOIN agents a ON a.id = s.agent_id WHERE r.id = ?`)
      .get(runId) as { session_id: number; started_at: string | null; provider: string } | undefined;
    if (!run) throw new UsageError("usage_run_not_found");
    this.producers.add(run.session_id);
    const binding = this.binding(run.session_id);
    const epoch = this.epoch(run.session_id);
    const sourceId = observation?.sourceId ?? "runtime";
    const previous = this.db.prepare(`SELECT MAX(revision) AS revision FROM agent_usage_ledger
      WHERE namespace = ? AND source_id = ? AND session_id = ? AND epoch_id = ? AND coverage_id = ?`)
      .get(this.namespace, sourceId, binding.sessionId, epoch, `run:${runId}`) as { revision: number | null };
    const revision = (previous.revision ?? 0) + 1;
    this.store.observe(binding, {
      eventId: `${runId}:${revision}`, sourceId, sourceVersion: "1", scope: "turn", semantics: "unknown",
      coverageId: `run:${runId}`, invocationId: null, occurredAt: run.started_at, finality: "interim",
      revision, measurement: "reported", normalizationProfile: null, metrics: runtimeMetrics(usage),
      ...observation,
      executionId: String(runId), providerEpochId: epoch, runtimeKind: run.provider
    });
  }

  importLegacy(sessionId?: number): void {
    const params = sessionId === undefined ? [] : [sessionId];
    const rows = this.db.prepare(`SELECT s.*, a.provider FROM sessions s JOIN agents a ON a.id = s.agent_id
      WHERE ${sessionId === undefined ? "" : "s.id = ? AND "}(s.input_tokens IS NOT NULL OR s.output_tokens IS NOT NULL OR s.total_tokens IS NOT NULL
        OR s.cached_read_tokens IS NOT NULL OR s.cached_write_tokens IS NOT NULL OR s.thought_tokens IS NOT NULL)`)
      .all(...params) as Array<{ id: number; provider: string } & LegacyMetrics>;
    for (const row of rows) {
      try {
        this.store.observe(this.binding(row.id), {
          eventId: `session:${row.id}`, sourceId: "legacy_session_snapshot", sourceVersion: "1",
          scope: "provider_session", semantics: "unknown", coverageId: `legacy:${row.id}`,
          invocationId: null, executionId: null, providerEpochId: "legacy", occurredAt: null, finality: "unknown",
          revision: 1, measurement: "reported", normalizationProfile: null, runtimeKind: row.provider,
          metrics: legacyMetrics(row)
        });
      } catch (error) {
        if (!(error instanceof UsageError) || error.code !== "usage_subject_deleted") throw error;
      }
    }
    const runs = this.db.prepare(`SELECT r.*, a.provider FROM runs r
      JOIN sessions s ON s.id = r.session_id JOIN agents a ON a.id = s.agent_id
      WHERE ${sessionId === undefined ? "" : "r.session_id = ? AND "}(r.input_tokens IS NOT NULL OR r.output_tokens IS NOT NULL OR r.total_tokens IS NOT NULL
        OR r.cached_read_tokens IS NOT NULL OR r.cached_write_tokens IS NOT NULL OR r.thought_tokens IS NOT NULL)`)
      .all(...params) as Array<{ id: number; session_id: number; started_at: string | null; provider: string } & LegacyMetrics>;
    for (const row of runs) {
      try {
        this.store.observe(this.binding(row.session_id), {
          eventId: `run:${row.id}`, sourceId: "legacy_run_snapshot", sourceVersion: "1",
          scope: "turn", semantics: "unknown", coverageId: `legacy:run:${row.id}`,
          invocationId: null, executionId: String(row.id), providerEpochId: "legacy", occurredAt: row.started_at,
          finality: "unknown", revision: 1, measurement: "reported", normalizationProfile: null,
          runtimeKind: row.provider, metrics: legacyMetrics(row)
        });
      } catch (error) {
        if (!(error instanceof UsageError) || error.code !== "usage_subject_deleted") throw error;
      }
    }
  }

  async prepareMaintenance(sessionId: number, operation: "reset" | "cleanup"): Promise<void> {
    const binding = this.binding(sessionId);
    const pending = this.sources.maintenance(binding);
    if (pending && pending.operation !== operation) throw new UsageError("usage_maintenance_conflict");
    // A ready barrier already captured the stopped producer. Its files may now be partially purged.
    if (pending?.state === "ready") return;
    await this.capture?.release(sessionId);
    await this.discover(sessionId);
    await this.sources.prepareMaintenance(binding, operation, pending?.id ?? `${this.epoch(sessionId)}:${operation}`);
  }

  private async discover(sessionId: number): Promise<void> {
    this.binding(sessionId);
    this.db.prepare(`INSERT INTO agent_usage_harvests (namespace, session_id, status, attempted_at)
      VALUES (?, ?, 'pending', ?) ON CONFLICT(namespace, session_id) DO UPDATE SET
      status = 'pending', error_code = NULL, attempted_at = excluded.attempted_at`)
      .run(this.namespace, String(sessionId), new Date().toISOString());
    try { await this.discoverManagedSources?.(sessionId); }
    catch (error) {
      this.db.prepare("UPDATE agent_usage_harvests SET status = 'failed', error_code = 'usage_discovery_failed' WHERE namespace = ? AND session_id = ?")
        .run(this.namespace, String(sessionId));
      throw error;
    }
  }

  async collectSession(sessionId: number): Promise<void> {
    this.producers.add(sessionId);
    await this.harvestSession(sessionId);
  }

  private async harvestSession(sessionId: number): Promise<void> {
    await this.discover(sessionId);
    try {
      const sources = this.sources.listSources(this.namespace, { sessionId: String(sessionId), mappingState: "active" });
      for (const source of sources) await this.sources.collect(source.id);
      this.db.prepare("UPDATE agent_usage_harvests SET status = 'completed', error_code = NULL WHERE namespace = ? AND session_id = ?")
        .run(this.namespace, String(sessionId));
    } catch (error) {
      this.db.prepare("UPDATE agent_usage_harvests SET status = 'failed', error_code = 'usage_collection_failed' WHERE namespace = ? AND session_id = ?")
        .run(this.namespace, String(sessionId));
      throw error;
    }
  }

  private eligibleSessions(includeCompleted = true): Array<{ id: number }> {
    this.db.prepare(`INSERT INTO agent_usage_harvests (namespace, session_id, status)
      SELECT ?, CAST(s.id AS TEXT), 'pending' FROM sessions s JOIN agents a ON a.id = s.agent_id
      WHERE a.provider IN ('codex', 'claude_code') AND s.provider_session_id IS NOT NULL
        AND s.storage_cleaned_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM agent_usage_subjects u WHERE u.namespace = ?
          AND ((u.kind = 'session' AND u.subject_id = CAST(s.id AS TEXT))
            OR (u.kind = 'agent' AND u.subject_id = CAST(a.id AS TEXT))) AND u.state != 'active')
      ON CONFLICT(namespace, session_id) DO NOTHING`).run(this.namespace, this.namespace);
    return this.db.prepare(`SELECT s.id FROM sessions s JOIN agents a ON a.id = s.agent_id
      JOIN agent_usage_harvests h ON h.namespace = ? AND h.session_id = CAST(s.id AS TEXT)
      WHERE a.provider IN ('codex', 'claude_code') AND s.provider_session_id IS NOT NULL AND s.storage_cleaned_at IS NULL
        AND (? OR h.status != 'completed')
        AND NOT EXISTS (SELECT 1 FROM agent_usage_subjects u WHERE u.namespace = ?
          AND ((u.kind = 'session' AND u.subject_id = CAST(s.id AS TEXT))
            OR (u.kind = 'agent' AND u.subject_id = CAST(a.id AS TEXT))) AND u.state != 'active')
      ORDER BY h.attempted_at ASC, s.id ASC`).all(this.namespace, Number(includeCompleted), this.namespace) as Array<{ id: number }>;
  }

  /** A single owned continuation performs bounded batches; readiness never waits for source I/O. */
  startRecovery(): void {
    if (!this.recoveryStopped) return;
    this.recoveryStopped = false;
    this.queueRecovery(true);
    this.scheduleRecovery(0);
  }

  private queueRecovery(initial: boolean): void {
    const sessions = this.eligibleSessions(initial);
    const managedIds = new Set(sessions.map(({ id }) => String(id)));
    this.recoveryQueue.push(...sessions.map(({ id }) => () => this.harvestSession(id)));
    // Registered imports without managed discovery are owned by the same continuation.
    this.recoveryQueue.push(...this.sources.recoverySources().filter((source) => !source.sessionIds.some((id) => managedIds.has(id)))
      .map((source) => () => this.sources.collect(source.id)));
  }

  private scheduleRecovery(delay: number): void {
    if (this.recoveryStopped) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      this.recoveryWork = this.recoveryBatch().finally(() => { this.recoveryWork = undefined; });
    }, delay);
    this.recoveryTimer.unref();
  }

  private async recoveryBatch(): Promise<void> {
    const contentPending = await this.contentBackfill.step();
    const deadline = Date.now() + 5_000;
    let admitted = 0;
    while (!this.recoveryStopped && this.recoveryQueue.length > 0 && admitted++ < 100 && Date.now() < deadline) {
      const work = this.recoveryQueue.shift()!;
      await work().catch(() => undefined);
    }
    if (this.recoveryStopped) return;
    if (this.recoveryQueue.length > 0 || contentPending) this.scheduleRecovery(10);
    else {
      this.queueRecovery(false);
      this.scheduleRecovery(30_000);
    }
  }

  async stopRecovery(): Promise<void> {
    this.recoveryStopped = true;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.recoveryQueue = [];
    this.sources.cancelCollections();
    await this.recoveryWork;
  }

  async harvestFinalSessions(): Promise<void> {
    const eligible = new Set(this.eligibleSessions().map(({ id }) => id));
    const sessions = [...this.producers].filter((id) => eligible.has(id));
    // Persist the finite producer barrier before starting any awaited final collection.
    for (const id of sessions) this.db.prepare(
      "UPDATE agent_usage_harvests SET status = 'pending', error_code = NULL WHERE namespace = ? AND session_id = ?"
    ).run(this.namespace, String(id));
    for (const id of sessions) await this.harvestSession(id).catch(() => undefined);
  }

  private collectionFailureQuery(filter: UsageFilter) {
    return {
      from: `FROM agent_usage_harvests h JOIN sessions s ON CAST(s.id AS TEXT) = h.session_id
        JOIN agents a ON a.id = s.agent_id WHERE h.namespace = ? AND h.status != 'completed'
        AND s.storage_cleaned_at IS NULL AND (? IS NULL OR h.session_id = ?)
        AND (? IS NULL OR CAST(s.agent_id AS TEXT) = ?) AND (? IS NULL OR a.provider = ?)`,
      parameters: [this.namespace, filter.sessionId ?? null, filter.sessionId ?? null, filter.agentId ?? null,
        filter.agentId ?? null, filter.runtimeKind ?? null, filter.runtimeKind ?? null]
    };
  }

  collectionFailures(filter: UsageFilter = {}): Array<{ sessionId: string; status: string; errorCode: string | null }> {
    const query = this.collectionFailureQuery(filter);
    return this.db.prepare(`SELECT h.session_id AS sessionId, h.status, h.error_code AS errorCode ${query.from} ORDER BY s.id`)
      .all(...query.parameters) as Array<{ sessionId: string; status: string; errorCode: string | null }>;
  }

  collectionFailureCount(filter: UsageFilter = {}): number {
    const query = this.collectionFailureQuery(filter);
    return (this.db.prepare(`SELECT COUNT(*) AS total ${query.from}`).get(...query.parameters) as { total: number }).total;
  }

  collectionFailurePage(filter: UsageFilter, pagination: Pick<PaginationQuery, "page" | "pageSize">) {
    const query = this.collectionFailureQuery(filter);
    const items = this.db.prepare(`SELECT h.session_id AS sessionId, h.status, h.error_code AS errorCode
      ${query.from} ORDER BY s.id LIMIT ? OFFSET ?`).all(...query.parameters, pagination.pageSize, (pagination.page - 1) * pagination.pageSize) as Array<{ sessionId: string; status: string; errorCode: string | null }>;
    return pageResult(items, this.collectionFailureCount(filter), pagination);
  }

  finishMaintenance(sessionId: number): void {
    this.db.transaction(() => {
      this.sources.finishMaintenance(this.binding(sessionId));
      this.db.prepare("UPDATE agent_usage_harvests SET status = 'completed', error_code = NULL WHERE namespace = ? AND session_id = ?")
        .run(this.namespace, String(sessionId));
    })();
    this.observer?.revokeSession(sessionId);
  }
  deleteSession(sessionId: number): void {
    this.producers.delete(sessionId);
    this.capture?.deleteSession(sessionId);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM agent_usage_harvests WHERE namespace = ? AND session_id = ?").run(this.namespace, String(sessionId));
      this.runtimeCapabilities.deleteSession(this.namespace, String(sessionId));
      this.contentBackfill.deleteSession(String(sessionId));
      this.conversationContent.deleteSession(String(sessionId));
      this.sources.revokeSubject(this.namespace, String(sessionId));
    })();
    this.observer?.revokeSession(sessionId);
  }
}

const runtimeMetrics = (usage: Partial<TokenUsage>): Partial<UsageMetrics> => ({
  inputTotalTokens: usage.inputTokens ?? null, outputTotalTokens: usage.outputTokens ?? null,
  cacheReadTokens: usage.cachedReadTokens ?? null, cacheWriteTokens: usage.cachedWriteTokens ?? null,
  reasoningOutputTokens: usage.thoughtTokens ?? null, totalTokens: usage.totalTokens ?? null
});
type LegacyMetrics = { input_tokens: number | null; output_tokens: number | null; total_tokens: number | null;
  cached_read_tokens: number | null; cached_write_tokens: number | null; thought_tokens: number | null };
const legacyMetrics = (row: LegacyMetrics): Partial<UsageMetrics> => runtimeMetrics({
  inputTokens: row.input_tokens, outputTokens: row.output_tokens, totalTokens: row.total_tokens,
  cachedReadTokens: row.cached_read_tokens, cachedWriteTokens: row.cached_write_tokens, thoughtTokens: row.thought_tokens
});
