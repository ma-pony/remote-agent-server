import type Database from "better-sqlite3";
import { metricNames, type UsageBinding, type UsageFilter, type UsageObservation, type UsageRecord, type UsageSummary } from "../core/types.js";
import { accountingRows, intervalIntersects, intervalOverlapConflicts, completeUsage, containedDetail, isAccountable, normalizeUsage, rangeConflicts, reconcileSources, sumUsage } from "../core/usage.js";

type SubjectRow = { agent_id: string | null; generation: number; state: "active" | "draining" | "deleted" };

/** Small, independently migratable SQLite module; no foreign keys to host business tables. */
export class UsageStore {
  constructor(readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_usage_migrations (version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS agent_usage_subjects (
        namespace TEXT NOT NULL, kind TEXT NOT NULL, subject_id TEXT NOT NULL,
        agent_id TEXT, generation INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'active',
        epoch INTEGER NOT NULL DEFAULT 1, maintenance_json TEXT,
        PRIMARY KEY(namespace, kind, subject_id)
      );
      CREATE TABLE IF NOT EXISTS agent_usage_events (
        namespace TEXT NOT NULL, source_id TEXT NOT NULL, event_id TEXT NOT NULL,
        agent_id TEXT NOT NULL, session_id TEXT NOT NULL, observed_at TEXT NOT NULL,
        payload_json TEXT NOT NULL, PRIMARY KEY(namespace, source_id, event_id)
      );
      CREATE TABLE IF NOT EXISTS agent_usage_ledger (
        namespace TEXT NOT NULL, source_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL,
        epoch_id TEXT NOT NULL, scope TEXT NOT NULL, coverage_id TEXT NOT NULL,
        occurred_at TEXT, revision INTEGER NOT NULL, finality TEXT NOT NULL, payload_json TEXT NOT NULL,
        PRIMARY KEY(namespace, source_id, session_id, epoch_id, scope, coverage_id)
      );
      CREATE INDEX IF NOT EXISTS agent_usage_ledger_session ON agent_usage_ledger(namespace, session_id, occurred_at);
      CREATE INDEX IF NOT EXISTS agent_usage_ledger_agent ON agent_usage_ledger(namespace, agent_id, occurred_at);
      CREATE INDEX IF NOT EXISTS agent_usage_events_session ON agent_usage_events(namespace, session_id);
      INSERT OR IGNORE INTO agent_usage_migrations VALUES (1);
    `);
  }

  bindSession(namespace: string, agentId: string, sessionId: string): UsageBinding {
    return this.db.transaction(() => {
      for (const [kind, id] of [["agent", agentId], ["session", sessionId]] as const) {
        this.db.prepare(`INSERT INTO agent_usage_subjects (namespace, kind, subject_id, agent_id)
          VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`).run(namespace, kind, id, kind === "session" ? agentId : null);
        const row = this.subject(namespace, kind, id)!;
        if (row.state === "deleted") throw new Error("usage_subject_deleted");
        if (kind === "session" && row.agent_id !== agentId) throw new Error("usage_subject_mismatch");
      }
      return { namespace, agentId, sessionId, generation: this.subject(namespace, "session", sessionId)!.generation };
    })();
  }

  assertBinding(binding: UsageBinding): void {
    const session = this.subject(binding.namespace, "session", binding.sessionId);
    const agent = this.subject(binding.namespace, "agent", binding.agentId);
    if (session?.state === "deleted" || agent?.state === "deleted") throw new Error("usage_subject_deleted");
    if (session === undefined || agent === undefined || session.generation !== binding.generation || session.agent_id !== binding.agentId) {
      throw new Error("usage_binding_stale");
    }
  }

  observe(binding: UsageBinding, observation: UsageObservation): void {
    this.db.transaction(() => {
      this.assertBinding(binding);
      if (!Number.isSafeInteger(observation.revision) || observation.revision < 0) throw new Error("invalid_usage_revision");
      if (observation.occurredAt !== null && !Number.isFinite(Date.parse(observation.occurredAt))) throw new Error("invalid_usage_time");
      const record: UsageRecord = { ...observation, ...binding, metrics: normalizeUsage(observation.metrics) };
      if (record.occurredAt !== null) record.occurredAt = new Date(record.occurredAt).toISOString();
      const inserted = this.db.prepare(`INSERT INTO agent_usage_events
        (namespace, source_id, event_id, agent_id, session_id, observed_at, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`).run(binding.namespace, observation.sourceId, observation.eventId,
        binding.agentId, binding.sessionId, new Date().toISOString(), JSON.stringify({ ...observation, ...binding }));
      if (inserted.changes === 0) return;
      const key = [binding.namespace, observation.sourceId, binding.sessionId, observation.providerEpochId, observation.scope, observation.coverageId];
      const old = this.db.prepare(`SELECT payload_json FROM agent_usage_ledger WHERE
        namespace = ? AND source_id = ? AND session_id = ? AND epoch_id = ? AND scope = ? AND coverage_id = ?`).get(...key) as { payload_json: string } | undefined;
      if (old !== undefined) {
        const previous = JSON.parse(old.payload_json) as UsageRecord;
        if (record.semantics === "delta" && previous.semantics === "delta") {
          record.metrics = normalizeUsage(sumUsage([previous, record]));
          record.revision = Math.max(previous.revision, record.revision);
          if (previous.finality === "final") record.finality = "final";
        } else {
          if (record.revision <= previous.revision || (previous.finality === "final" && record.finality !== "final" && record.semantics !== "cumulative")) return;
          if (record.semantics === "cumulative" && !record.correctionReason) {
            const decreased = metricNames.some((key) => previous.metrics[key] !== null && record.metrics[key] !== null
              && record.metrics[key]! < previous.metrics[key]!);
            const missing = metricNames.some((key) => previous.metrics[key] !== null && record.metrics[key] === null);
            const issues = new Set(previous.issues?.filter((issue) => issue !== "cumulative_fields_missing"));
            if (missing) issues.add("cumulative_fields_missing");
            if (decreased) {
              record.metrics = previous.metrics;
              issues.add("cumulative_decreased");
            } else {
              for (const key of metricNames) record.metrics[key] ??= previous.metrics[key];
            }
            record.issues = [...issues];
          } else if (!record.correctionReason && previous.issues?.length) record.issues = previous.issues;
        }
      }
      this.db.prepare(`INSERT INTO agent_usage_ledger
        (namespace, source_id, session_id, epoch_id, scope, coverage_id, agent_id, occurred_at, revision, finality, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(namespace, source_id, session_id, epoch_id, scope, coverage_id) DO UPDATE SET
          occurred_at = excluded.occurred_at, revision = excluded.revision, finality = excluded.finality, payload_json = excluded.payload_json
      `).run(...key, binding.agentId, record.occurredAt, record.revision, record.finality, JSON.stringify(record));
    })();
  }

  records(filter: UsageFilter = {}): UsageRecord[] {
    const clauses: string[] = [];
    const params: string[] = [];
    for (const [field, column] of [["namespace", "namespace"], ["agentId", "agent_id"], ["sessionId", "session_id"]] as const) {
      if (filter[field] !== undefined) { clauses.push(`${column} = ?`); params.push(filter[field]); }
    }
    const rows = this.db.prepare(`SELECT payload_json FROM agent_usage_ledger ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}`)
      .all(...params) as Array<{ payload_json: string }>;
    return rows.map((row) => JSON.parse(row.payload_json) as UsageRecord)
      .filter((row) => filter.runtimeKind === undefined || row.runtimeKind === filter.runtimeKind);
  }

  summary(filter: UsageFilter = {}): UsageSummary {
    const all = reconcileSources(this.records(filter));
    const isLocated = (row: UsageRecord) => row.occurredAt !== null && row.scope !== "provider_session";
    const inPeriod = (row: UsageRecord) => {
      if (filter.from === undefined && filter.to === undefined) return true;
      return isLocated(row) && (filter.from === undefined || Date.parse(row.intervalStart ?? row.occurredAt!) >= Date.parse(filter.from))
        && (filter.to === undefined || Date.parse(row.occurredAt!) < Date.parse(filter.to));
    };
    const records = all.records.filter(inPeriod);
    const datedBasis = accountingRows(all.records.filter(isLocated));
    const selected = filter.from === undefined && filter.to === undefined ? accountingRows(records) : datedBasis.filter(inPeriod);
    const ambiguous = datedBasis.filter((row) => intervalIntersects(row, filter) && !inPeriod(row));
    const conflicts = all.conflicts + rangeConflicts(all.records) + intervalOverlapConflicts(all.records)
      + all.records.filter((row) => row.issues?.some((issue) => issue !== "cumulative_fields_missing")).length;
    const requests = records.filter((row) => row.scope === "model_request");
    const complete = requests.filter(completeUsage).length;
    const missing = requests.filter((row) => !isAccountable(row) || Object.values(row.metrics).every((value) => value === null)).length;
    const unknown = records.filter((row) => !isAccountable(row)).length;
    const totalRows = selected.filter((row) => row.metrics.totalTokens !== null);
    const scopes = new Set((totalRows.length > 0 ? totalRows : selected).map((row) => row.scope));
    const basis = scopes.size === 0 ? "none" : scopes.size > 1 ? "mixed" : scopes.has("provider_session") ? "range_totals"
      : scopes.has("turn") ? "turn_totals" : scopes.has("interval") ? "interval_totals" : "model_requests";
    const unplaced = accountingRows(all.records).filter((row) => !isLocated(row)).map((parent) => {
      const detail = sumUsage(accountingRows(containedDetail(parent, all.records).filter(isLocated)));
      const metrics = { ...parent.metrics };
      for (const key of metricNames) {
        if (metrics[key] !== null && detail[key] !== null) {
          const residual = metrics[key]! - detail[key]!;
          metrics[key] = residual >= 0 ? residual : null;
        }
      }
      return { metrics };
    });
    return {
      usage: sumUsage(selected),
      locatedUsage: sumUsage(datedBasis.filter(inPeriod)),
      unplacedUsage: sumUsage([...unplaced, ...ambiguous]),
      accountingBasis: basis,
      completeness: conflicts > 0 ? "conflict" : ambiguous.length > 0 ? "partial" : records.length === 0 ? "none"
        : unknown > 0 || complete < requests.length || records.some((row) => !completeUsage(row) || row.finality !== "final"
          || row.issues?.includes("cumulative_fields_missing")) ? "partial" : "complete",
      observedModelRequests: requests.length,
      requestsWithCompleteUsage: complete,
      requestsWithMissingUsage: missing,
      requestsWithPartialUsage: requests.length - complete - missing,
      unverifiedObservations: unknown,
      conflictingRanges: conflicts,
      asOf: new Date().toISOString()
    };
  }

  deleteSession(namespace: string, sessionId: string): void {
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO agent_usage_subjects (namespace, kind, subject_id, state)
        VALUES (?, 'session', ?, 'deleted') ON CONFLICT(namespace, kind, subject_id) DO UPDATE SET
        generation = generation + 1, state = 'deleted', agent_id = NULL, maintenance_json = NULL`).run(namespace, sessionId);
      this.db.prepare("DELETE FROM agent_usage_events WHERE namespace = ? AND session_id = ?").run(namespace, sessionId);
      this.db.prepare("DELETE FROM agent_usage_ledger WHERE namespace = ? AND session_id = ?").run(namespace, sessionId);
    })();
  }

  private subject(namespace: string, kind: string, id: string): SubjectRow | undefined {
    return this.db.prepare("SELECT agent_id, generation, state FROM agent_usage_subjects WHERE namespace = ? AND kind = ? AND subject_id = ?")
      .get(namespace, kind, id) as SubjectRow | undefined;
  }
}
