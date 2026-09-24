import { pageResult, type PaginationQuery } from "../pagination.js";
import { createHash, randomUUID } from "node:crypto";
import { UsageError } from "./core/errors.js";
import type { UsageBinding, UsageObservation } from "./core/types.js";
import type { UsageStore } from "./storage/usage-store.js";
import type { TokenCount } from "./core/tokenizers.js";
import type { ModelContextInput, InvocationInput } from "./core/context-types.js";
export type SourceCapabilities = { usage: string; context: "full" | "partial" | "opaque" | "none"; identity: "explicit" | "partial"; version: string };
export type SourceConfig = { namespace: string; sourceKey: string; kind: string; inputRef: Record<string, string>; mappings: Array<{ sourceSessionKey: string; agentId: string; sessionId: string; providerEpochId: string }> };
export type SourceRecord = {
  id: string; sourceKey: string; kind: string; capabilities: SourceCapabilities;
  checkpoint: string | null; status: string; collectionId: string | null;
  errorCode: string | null; rejectedRecords: number; lastSuccessAt: string | null;
  mappings: Array<{ sourceSessionKey: string; sessionId: string; providerEpochId: string; state: string }>;
};
export type SourceFilter = {
  id?: string; sourceKey?: string; agentId?: string; sessionId?: string; mappingState?: "active";
};
export interface UsageSourceAdapter {
  describe(): SourceCapabilities;
  freeze(input: Record<string, string>): Promise<string>;
  collect(input: Record<string, string>, checkpoint: string | null, boundary: string, signal: AbortSignal, rebuild?: boolean): AsyncIterable<UsageCollectionEntry>;
}
export type UsageSourceEntry = { sourceSessionKey: string; observation: UsageObservation; context?: ModelContextInput; invocations?: InvocationInput[] };
export type UsageCollectionEntry = (UsageSourceEntry | { observation?: never }) & { checkpoint: string };
export type AttributionSink = {
  prepareContext(input: ModelContextInput, signal?: AbortSignal): Promise<Map<number, TokenCount>>;
  commitContext(binding: UsageBinding, input: ModelContextInput, estimates: Map<number, TokenCount>): void;
  observeInvocation(binding: UsageBinding, input: InvocationInput): void;
  deleteSession(namespace: string, sessionId: string): void;
};
type SourceRow = { id: string; namespace: string; source_key: string; kind: string; input_json: string; config_json: string;
  capabilities_json: string; checkpoint: string | null; status: string; collection_id: string | null;
  error_code: string | null; rejected_records: number; last_success_at: string | null };
type MappingRow = { source_session_key: string; namespace: string; agent_id: string; session_id: string;
  epoch_id: string; subject_generation: number; state: string };
type Maintenance = { id: string; state: "draining" | "ready"; operation: "reset" | "cleanup"; boundaries: Record<string, string> };

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item !== null && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const COLLECTION_YIELD_INTERVAL = 100;
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export class UsageSourceCoordinator {
  private readonly jobs = new Map<string, { promise: Promise<void>; controller: AbortController }>();
  private closed = false;

  constructor(private readonly store: UsageStore, private readonly adapters: Record<string, UsageSourceAdapter>, private readonly timeoutMs = 30_000,
    private readonly attribution?: AttributionSink) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_usage_sources (
        id TEXT PRIMARY KEY, namespace TEXT NOT NULL, source_key TEXT NOT NULL, kind TEXT NOT NULL,
        input_json TEXT NOT NULL, config_json TEXT NOT NULL, capabilities_json TEXT NOT NULL,
        checkpoint TEXT, status TEXT NOT NULL DEFAULT 'idle', collection_id TEXT,
        error_code TEXT, rejected_records INTEGER NOT NULL DEFAULT 0, last_success_at TEXT,
        UNIQUE(namespace, source_key)
      );
      CREATE TABLE IF NOT EXISTS agent_usage_source_mappings (
        source_id TEXT NOT NULL, source_session_key TEXT NOT NULL, namespace TEXT NOT NULL,
        agent_id TEXT NOT NULL, session_id TEXT NOT NULL, epoch_id TEXT NOT NULL,
        subject_generation INTEGER NOT NULL, generation INTEGER NOT NULL DEFAULT 1,
        state TEXT NOT NULL DEFAULT 'active', PRIMARY KEY(source_id, source_session_key)
      );
      CREATE INDEX IF NOT EXISTS agent_usage_source_mapping_session ON agent_usage_source_mappings(namespace, session_id);
    `);
  }

  registerSource(config: SourceConfig): SourceRecord {
    const adapter = this.adapters[config.kind];
    if (!adapter) throw new UsageError("usage_source_unsupported");
    const id = createHash("sha256").update(JSON.stringify([config.namespace, config.sourceKey])).digest("hex").slice(0, 32);
    return this.store.db.transaction(() => {
      const mappings = this.mappings(id);
      if (mappings.some((row) => row.state === "revoked")) throw new UsageError("usage_mapping_revoked");
      const previous = this.source(id);
      if (previous !== undefined) {
        if (previous.config_json !== canonical(config)) throw new UsageError("usage_source_conflict");
        for (const row of mappings) this.store.assertBinding(this.binding(row));
        return this.project(previous);
      }
      if (new Set(config.mappings.map((mapping) => mapping.sourceSessionKey)).size !== config.mappings.length) throw new UsageError("usage_mapping_conflict");
      this.store.db.prepare(`INSERT INTO agent_usage_sources
        (id, namespace, source_key, kind, input_json, config_json, capabilities_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, config.namespace, config.sourceKey, config.kind, canonical(config.inputRef), canonical(config), canonical(adapter.describe()));
      for (const mapping of config.mappings) {
        const binding = this.store.bindSession(config.namespace, mapping.agentId, mapping.sessionId);
        this.store.db.prepare(`INSERT INTO agent_usage_source_mappings
          (source_id, source_session_key, namespace, agent_id, session_id, epoch_id, subject_generation) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(id, mapping.sourceSessionKey, config.namespace, mapping.agentId, mapping.sessionId, mapping.providerEpochId, binding.generation);
      }
      return this.project(this.source(id)!);
    })();
  }

  collect(id: string, frozenBoundary?: string, rebuild = false): Promise<void> {
    if (this.closed) return Promise.reject(new UsageError("usage_collector_closed"));
    const current = this.jobs.get(id);
    if (current) return rebuild ? Promise.reject(new UsageError("usage_collection_pending")) : current.promise;
    const source = this.source(id);
    if (!source) return Promise.reject(new UsageError("usage_source_not_found"));
    const adapter = this.adapters[source.kind];
    if (!adapter) return Promise.reject(new UsageError("usage_source_unsupported"));
    this.store.db.prepare("UPDATE agent_usage_sources SET capabilities_json=? WHERE id=? AND capabilities_json!=?")
      .run(canonical(adapter.describe()), id, canonical(adapter.describe()));
    const collectionId = source.status === "collecting" && source.collection_id !== null ? source.collection_id : randomUUID();
    this.store.db.prepare("UPDATE agent_usage_sources SET status = 'collecting', collection_id = ?, error_code = NULL WHERE id = ?").run(collectionId, id);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new UsageError("usage_collection_timeout")); }, this.timeoutMs);
      timer.unref();
    });
    const collect = async () => {
      const input = JSON.parse(source.input_json) as Record<string, string>;
      const boundary = frozenBoundary ?? await adapter.freeze(input);
      controller.signal.throwIfAborted();
      let pending: UsageCollectionEntry[] = [];
      let lastFlush = Date.now();
      const flush = async () => {
        if (!pending.length) return;
        const batch = pending; pending = [];
        const estimates = new Map<UsageCollectionEntry, Map<number, TokenCount>>();
        for (const entry of batch) {
          controller.signal.throwIfAborted();
          if (entry.observation && entry.context) {
            if (!this.attribution) throw new UsageError("usage_attribution_unavailable");
            estimates.set(entry, await this.attribution.prepareContext(entry.context, controller.signal));
          }
        }
        controller.signal.throwIfAborted();
        this.store.db.transaction(() => {
          // Re-read authority after awaits. No await occurs inside this atomic batch.
          const mappings = new Map(this.mappings(id).map((row) => [row.source_session_key, row]));
          let rejectedRecords = 0;
          for (const entry of batch) {
            if (!entry.observation) continue;
            const mapping = mappings.get(entry.sourceSessionKey);
            let rejected = mapping === undefined || mapping.state === "revoked";
            if (!rejected && mapping !== undefined) {
              try {
                this.store.observe(this.binding(mapping), { ...entry.observation, sourceId: id, providerEpochId: mapping.epoch_id });
                if (entry.context || entry.invocations?.length) {
                  if (!this.attribution) throw new UsageError("usage_attribution_unavailable");
                  if (entry.context) this.attribution.commitContext(this.binding(mapping), { ...entry.context, sourceId: id, providerEpochId: mapping.epoch_id }, estimates.get(entry)!);
                  for (const invocation of entry.invocations ?? []) this.attribution.observeInvocation(this.binding(mapping), { ...invocation, sourceId: id, providerEpochId: mapping.epoch_id });
                }
              } catch (error) {
                if (!(error instanceof UsageError) || !["usage_subject_deleted", "usage_binding_stale"].includes(error.code)) throw error;
                rejected = true;
              }
            }
            rejectedRecords += Number(rejected);
          }
          this.store.db.prepare(`UPDATE agent_usage_sources SET checkpoint = ?, rejected_records = rejected_records + ?
            WHERE id = ? AND collection_id = ?`).run(batch.at(-1)!.checkpoint, rejectedRecords, id, collectionId);
        })();
        lastFlush = Date.now();
      };
      try {
        for await (const entry of adapter.collect(input, source.checkpoint, boundary, controller.signal, rebuild)) {
          controller.signal.throwIfAborted();
          pending.push(entry);
          if (!entry.observation || pending.length >= COLLECTION_YIELD_INTERVAL || Date.now() - lastFlush >= 1000) {
            await flush(); await yieldToEventLoop(); controller.signal.throwIfAborted();
          }
        }
        controller.signal.throwIfAborted(); await flush();
      } catch (error) {
        // Preserve valid entries before a read/parse failure, but never commit work after cancellation.
        if (!controller.signal.aborted) await flush();
        throw error;
      }
      controller.signal.throwIfAborted();
    };
    const promise = Promise.race([collect(), timeout]).then(() => {
      this.store.db.prepare(`UPDATE agent_usage_sources SET status = 'completed', last_success_at = ?, error_code = NULL
        WHERE id = ? AND collection_id = ?`).run(new Date().toISOString(), id, collectionId);
    }).catch((error: unknown) => {
      const code = error instanceof UsageError && ["usage_collection_timeout", "usage_tokenizer_pending"].includes(error.code) ? error.code : "usage_source_failed";
      this.store.db.prepare("UPDATE agent_usage_sources SET status = 'failed', error_code = ? WHERE id = ? AND collection_id = ?").run(code, id, collectionId);
      throw new UsageError(code, { cause: error });
    }).finally(() => { clearTimeout(timer); this.jobs.delete(id); });
    this.jobs.set(id, { promise, controller });
    return promise;
  }

  /** HTTP callers can return the persisted collection identity immediately. */
  startCollect(id: string, rebuild = false): SourceRecord {
    if (rebuild && this.jobs.has(id)) throw new UsageError("usage_collection_pending");
    void this.collect(id, undefined, rebuild).catch(() => { /* The persisted source state reports the sanitized error. */ });
    const row = this.source(id);
    if (!row) throw new UsageError("usage_source_not_found");
    return this.project(row);
  }

  listSourcesPage(namespace: string, filter: SourceFilter, pagination: Pick<PaginationQuery, "page" | "pageSize">) {
    const scope = this.sourceWhere(namespace, filter);
    const total = (this.store.db.prepare(`SELECT COUNT(*) AS total FROM agent_usage_sources s WHERE ${scope.where}`).get(...scope.params) as { total: number }).total;
    return pageResult(this.listSources(namespace, filter, pagination), total, pagination);
  }

  sourceStatusCounts(namespace: string, filter: SourceFilter = {}): Record<string, number> {
    const scope = this.sourceWhere(namespace, filter);
    const rows = this.store.db.prepare(`SELECT s.status, COUNT(*) AS count FROM agent_usage_sources s WHERE ${scope.where} GROUP BY s.status`).all(...scope.params) as Array<{ status: string; count: number }>;
    return Object.fromEntries(rows.map(({ status, count }) => [status, count]));
  }

  private sourceWhere(namespace: string, filter: SourceFilter): { where: string; params: string[] } {
    const clauses = ["s.namespace = ?"];
    const params = [namespace];
    for (const [field, column] of [["id", "id"], ["sourceKey", "source_key"]] as const) {
      if (filter[field] !== undefined) { clauses.push(`s.${column} = ?`); params.push(filter[field]); }
    }
    const mappings = ["m.source_id = s.id"];
    for (const [field, column] of [["sessionId", "session_id"], ["mappingState", "state"]] as const) {
      if (filter[field] !== undefined) { mappings.push(`m.${column} = ?`); params.push(filter[field]); }
    }
    if (filter.agentId !== undefined) {
      mappings.push(`EXISTS (SELECT 1 FROM agent_usage_subjects u WHERE u.namespace = m.namespace
        AND u.kind = 'session' AND u.subject_id = m.session_id AND u.agent_id = ?)`);
      params.push(filter.agentId);
    }
    if (mappings.length > 1) clauses.push(`EXISTS (SELECT 1 FROM agent_usage_source_mappings m WHERE ${mappings.join(" AND ")})`);
    const where = clauses.join(" AND ");
    return { where, params };
  }

  listSources(namespace: string, filter: SourceFilter = {}, pagination?: Pick<PaginationQuery, "page" | "pageSize">): SourceRecord[] {
    const { where, params } = this.sourceWhere(namespace, filter);
    const columns = pagination
      ? `s.id, s.namespace, s.source_key, s.kind, s.capabilities_json, NULL AS checkpoint,
        s.status, s.collection_id, s.error_code, s.rejected_records, s.last_success_at`
      : "s.*";
    const rows = this.store.db.prepare(`SELECT ${columns} FROM agent_usage_sources s WHERE ${where} ORDER BY s.source_key, s.id ${pagination ? "LIMIT ? OFFSET ?" : ""}`)
      .all(...params, ...(pagination ? [pagination.pageSize, (pagination.page - 1) * pagination.pageSize] : [])) as SourceRow[];
    if (rows.length === 0) return [];
    // Load every mapping of selected sources together; filtering must not truncate a source's public mappings.
    const mappingRows = this.store.db.prepare(`SELECT mapping.* FROM agent_usage_source_mappings mapping
      ${pagination ? `WHERE mapping.source_id IN (${rows.map(() => "?").join(",")})` : `JOIN agent_usage_sources s ON s.id = mapping.source_id WHERE ${where}`}`)
      .all(...(pagination ? rows.map((row) => row.id) : params)) as Array<MappingRow & { source_id: string }>;
    const bySource = new Map<string, MappingRow[]>();
    for (const row of mappingRows) {
      const group = bySource.get(row.source_id) ?? [];
      group.push(row);
      bySource.set(row.source_id, group);
    }
    return rows.map((row) => this.project(row, bySource.get(row.id) ?? []));
  }

  async prepareMaintenance(binding: UsageBinding, operation: "reset" | "cleanup", id: string): Promise<void> {
    this.store.assertBinding(binding);
    let pending = this.maintenance(binding);
    if (pending && (pending.id !== id || pending.operation !== operation)) throw new UsageError("usage_maintenance_conflict");
    if (pending?.state === "ready") return;
    pending ??= { id, operation, state: "draining", boundaries: {} };
    this.saveMaintenance(binding, pending);
    try {
      const sources = this.store.db.prepare(`SELECT DISTINCT s.* FROM agent_usage_sources s
        JOIN agent_usage_source_mappings m ON m.source_id = s.id
        WHERE m.namespace = ? AND m.session_id = ? AND m.state = 'active'`).all(binding.namespace, binding.sessionId) as SourceRow[];
      for (const source of sources) {
        // The host must have stopped the producer without discarding its files before this entrypoint.
        if (this.jobs.has(source.id)) await this.jobs.get(source.id)!.promise;
        if (pending.boundaries[source.id] === undefined) {
          const adapter = this.adapters[source.kind];
          if (!adapter) throw new UsageError("usage_source_unsupported");
          let timer: ReturnType<typeof setTimeout>;
          try {
            pending.boundaries[source.id] = await Promise.race([
              adapter.freeze(JSON.parse(source.input_json) as Record<string, string>),
              new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new UsageError("usage_collection_timeout")), this.timeoutMs); timer.unref(); })
            ]);
          } finally { clearTimeout(timer!); }
          this.saveMaintenance(binding, pending);
        }
        await this.collect(source.id, pending.boundaries[source.id]);
      }
      pending.state = "ready";
      this.saveMaintenance(binding, pending);
    } catch { throw new UsageError("usage_collection_pending"); }
  }

  maintenance(binding: UsageBinding): Maintenance | null {
    const row = this.store.db.prepare("SELECT maintenance_json FROM agent_usage_subjects WHERE namespace = ? AND kind = 'session' AND subject_id = ?")
      .get(binding.namespace, binding.sessionId) as { maintenance_json: string | null } | undefined;
    return row?.maintenance_json ? JSON.parse(row.maintenance_json) as Maintenance : null;
  }

  finishMaintenance(binding: UsageBinding): void {
    this.store.db.transaction(() => {
      this.store.assertBinding(binding);
      const pending = this.maintenance(binding);
      if (!pending) return;
      if (pending.state !== "ready") throw new UsageError("usage_collection_pending");
      this.store.db.prepare(`UPDATE agent_usage_subjects SET state = 'active', maintenance_json = NULL,
        epoch = epoch + ? WHERE namespace = ? AND kind = 'session' AND subject_id = ?`)
        .run(Number(pending.operation === "reset"), binding.namespace, binding.sessionId);
      // Purged Provider files cannot participate in the next maintenance barrier.
      this.store.db.prepare(`UPDATE agent_usage_source_mappings SET state = 'retained'
        WHERE namespace = ? AND session_id = ? AND state = 'active'`).run(binding.namespace, binding.sessionId);
    })();
  }

  revokeSubject(namespace: string, sessionId: string): void {
    this.store.db.transaction(() => {
      this.store.db.prepare(`UPDATE agent_usage_source_mappings SET state = 'revoked', generation = generation + 1
        WHERE namespace = ? AND session_id = ? AND state != 'revoked'`).run(namespace, sessionId);
      this.store.deleteSession(namespace, sessionId);
      this.attribution?.deleteSession(namespace, sessionId);
    })();
  }

  recoverySources(): Array<{ id: string; sessionIds: string[] }> {
    const rows = this.store.db.prepare(`SELECT s.id FROM agent_usage_sources s WHERE s.status IN ('collecting', 'failed')
      AND EXISTS (SELECT 1 FROM agent_usage_source_mappings m JOIN agent_usage_subjects u
        ON u.namespace = m.namespace AND u.kind = 'session' AND u.subject_id = m.session_id
        WHERE m.source_id = s.id AND m.state = 'active' AND u.state = 'active')`).all() as Array<{ id: string }>;
    return rows.map((row) => ({ id: row.id, sessionIds: this.mappings(row.id).map((mapping) => mapping.session_id) }));
  }

  cancelCollections(): void {
    for (const job of this.jobs.values()) job.controller.abort();
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map((job) => job.promise));
  }

  private saveMaintenance(binding: UsageBinding, pending: Maintenance): void {
    this.store.db.transaction(() => {
      this.store.assertBinding(binding);
      this.store.db.prepare("UPDATE agent_usage_subjects SET state = 'draining', maintenance_json = ? WHERE namespace = ? AND kind = 'session' AND subject_id = ?")
        .run(JSON.stringify(pending), binding.namespace, binding.sessionId);
    })();
  }

  private source(id: string): SourceRow | undefined {
    return this.store.db.prepare("SELECT * FROM agent_usage_sources WHERE id = ?").get(id) as SourceRow | undefined;
  }

  private mappings(id: string): MappingRow[] {
    return this.store.db.prepare("SELECT * FROM agent_usage_source_mappings WHERE source_id = ?").all(id) as MappingRow[];
  }

  private binding(row: MappingRow): UsageBinding {
    return { namespace: row.namespace, agentId: row.agent_id, sessionId: row.session_id, generation: row.subject_generation };
  }

  private project(row: SourceRow, mappings = this.mappings(row.id)): SourceRecord {
    return { id: row.id, sourceKey: row.source_key, kind: row.kind, capabilities: JSON.parse(row.capabilities_json) as SourceCapabilities,
      checkpoint: row.checkpoint, status: row.status, collectionId: row.collection_id, errorCode: row.error_code,
      rejectedRecords: row.rejected_records, lastSuccessAt: row.last_success_at,
      mappings: mappings.map((mapping) => ({ sourceSessionKey: mapping.source_session_key, sessionId: mapping.session_id,
        providerEpochId: mapping.epoch_id, state: mapping.state })) };
  }
}
