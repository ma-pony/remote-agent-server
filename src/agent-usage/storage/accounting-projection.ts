import type Database from "better-sqlite3";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { UsageAnalysis, type UsageAnalysisProjection } from "../core/usage-analysis.js";
import type { UsageFilter, UsageRecord } from "../core/types.js";

export type AccountingProjectionJob = {
  namespace: string; agent_id: string; session_id: string; epoch_id: string; revision: number;
};
export type AccountingProjectionBatch = { job: AccountingProjectionJob;
  items: Array<{ runtimeScope: string; payload: Uint8Array }> };

/** Reconciles only dirty epochs; completed epochs retain compact, body-free accounting facts. */
export class AccountingProjectionStore {
  constructor(private readonly db: Database.Database) {
    if (db.readonly) return;
    db.transaction(() => {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE name='agent_usage_accounting_projections'").get();
      db.exec(`CREATE TABLE IF NOT EXISTS agent_usage_accounting_jobs (
        namespace TEXT NOT NULL,agent_id TEXT NOT NULL,session_id TEXT NOT NULL,epoch_id TEXT NOT NULL,
        revision INTEGER NOT NULL,ready_revision INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(namespace,session_id,epoch_id));
        CREATE INDEX IF NOT EXISTS agent_usage_accounting_pending ON agent_usage_accounting_jobs(namespace,session_id,epoch_id)
          WHERE revision!=ready_revision;
        CREATE TABLE IF NOT EXISTS agent_usage_accounting_projections (
        namespace TEXT NOT NULL,agent_id TEXT NOT NULL,session_id TEXT NOT NULL,epoch_id TEXT NOT NULL,
        runtime_scope TEXT NOT NULL,revision INTEGER NOT NULL,payload_blob BLOB NOT NULL,
        PRIMARY KEY(namespace,session_id,epoch_id,runtime_scope));
        CREATE TABLE IF NOT EXISTS agent_usage_storage_cursors (name TEXT PRIMARY KEY,last_rowid INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS agent_usage_storage_limits (name TEXT PRIMARY KEY,last_legacy_rowid INTEGER NOT NULL);
        INSERT OR IGNORE INTO agent_usage_storage_limits SELECT 'event-payload',COALESCE(MAX(rowid),0) FROM agent_usage_events`);
      db.exec(`CREATE INDEX IF NOT EXISTS agent_usage_ledger_epoch ON agent_usage_ledger(namespace,session_id,epoch_id)`);
      if (!exists) db.exec(`INSERT OR IGNORE INTO agent_usage_accounting_jobs
        SELECT namespace,agent_id,session_id,epoch_id,1,0 FROM agent_usage_ledger GROUP BY namespace,session_id,epoch_id`);
      for (const event of ["INSERT", "UPDATE", "DELETE"]) {
        const row = event === "DELETE" ? "OLD" : "NEW";
        db.exec(`CREATE TRIGGER IF NOT EXISTS agent_usage_ledger_accounting_${event.toLowerCase()}
          AFTER ${event} ON agent_usage_ledger BEGIN
          INSERT INTO agent_usage_accounting_jobs(namespace,agent_id,session_id,epoch_id,revision)
            VALUES(${row}.namespace,${row}.agent_id,${row}.session_id,${row}.epoch_id,1)
            ON CONFLICT(namespace,session_id,epoch_id) DO UPDATE SET revision=revision+1;
          END`);
      }
    })();
  }

  hasProjection(): boolean { return !!this.db.prepare("SELECT 1 FROM agent_usage_accounting_projections LIMIT 1").get(); }

  next(after?: AccountingProjectionJob): AccountingProjectionJob | undefined {
    const select = "SELECT namespace,agent_id,session_id,epoch_id,revision FROM agent_usage_accounting_jobs WHERE revision!=ready_revision";
    const order = "ORDER BY namespace,session_id,epoch_id LIMIT 1";
    if (after) {
      const next = this.db.prepare(`${select} AND (namespace,session_id,epoch_id)>(?,?,?) ${order}`)
        .get(after.namespace,after.session_id,after.epoch_id) as AccountingProjectionJob | undefined;
      if (next) return next;
    }
    return this.db.prepare(`${select} ${order}`).get() as AccountingProjectionJob | undefined;
  }

  /** Executed inside the read-only worker's snapshot transaction. */
  project(job: AccountingProjectionJob): AccountingProjectionBatch {
    const current = this.db.prepare(`SELECT revision FROM agent_usage_accounting_jobs
      WHERE namespace=? AND session_id=? AND epoch_id=?`).get(job.namespace,job.session_id,job.epoch_id) as { revision: number } | undefined;
    if (current?.revision !== job.revision) return { job,items: [] };
    const records = (this.db.prepare(`SELECT payload_json FROM agent_usage_ledger
      WHERE namespace=? AND session_id=? AND epoch_id=?`).all(job.namespace,job.session_id,job.epoch_id) as Array<{ payload_json: string }>)
      .map(row => JSON.parse(row.payload_json) as UsageRecord);
    const runtimeKinds = [...new Set(records.map(row => row.runtimeKind).filter(kind => kind !== undefined))];
    const encode = (rows: UsageRecord[]) => deflateRawSync(JSON.stringify(new UsageAnalysis(rows).project()),{ level: 1 });
    return { job, items: [{ runtimeScope: "", payload: encode(records) },
      ...runtimeKinds.map(kind => ({ runtimeScope: JSON.stringify(kind),
        payload: encode(records.filter(row => row.runtimeKind === kind)) }))] };
  }

  commit(batch: AccountingProjectionBatch): boolean {
    if (!batch.items.length) return false;
    return this.db.transaction(() => {
      const { job } = batch;
      const current = this.db.prepare(`SELECT revision FROM agent_usage_accounting_jobs
        WHERE namespace=? AND session_id=? AND epoch_id=?`).get(job.namespace,job.session_id,job.epoch_id) as { revision: number } | undefined;
      if (current?.revision !== job.revision) return false;
      this.db.prepare("DELETE FROM agent_usage_accounting_projections WHERE namespace=? AND session_id=? AND epoch_id=?")
        .run(job.namespace,job.session_id,job.epoch_id);
      const insert = this.db.prepare("INSERT INTO agent_usage_accounting_projections VALUES(?,?,?,?,?,?,?)");
      for (const item of batch.items) insert.run(job.namespace,job.agent_id,job.session_id,job.epoch_id,
        item.runtimeScope,job.revision,Buffer.from(item.payload));
      this.db.prepare(`UPDATE agent_usage_accounting_jobs SET ready_revision=revision
        WHERE namespace=? AND session_id=? AND epoch_id=?`).run(job.namespace,job.session_id,job.epoch_id);
      return true;
    })();
  }

  private facts(filter: UsageFilter, sessionIds?: string[]): Array<{ sessionId: string; projection: UsageAnalysisProjection }> {
    const clauses: string[] = [], params: string[] = [];
    for (const [field,column] of [["namespace","namespace"],["agentId","agent_id"],["sessionId","session_id"]] as const)
      if (filter[field] !== undefined) { clauses.push(`j.${column}=?`); params.push(filter[field]); }
    if (sessionIds) { clauses.push(`j.session_id IN (${sessionIds.map(() => "?").join(",")})`); params.push(...sessionIds); }
    const where = clauses.length ? clauses.join(" AND ") : "1";
    const ready = this.db.prepare(`SELECT p.session_id,p.payload_blob FROM agent_usage_accounting_jobs j
      JOIN agent_usage_accounting_projections p USING(namespace,session_id,epoch_id)
      WHERE ${where} AND j.ready_revision=j.revision AND p.revision=j.revision AND p.runtime_scope=?`)
      .all(...params,filter.runtimeKind === undefined ? "" : JSON.stringify(filter.runtimeKind)) as Array<{ session_id: string; payload_blob: Buffer }>;
    const projections = ready.map(row => ({sessionId:row.session_id,
      projection:JSON.parse(inflateRawSync(row.payload_blob).toString("utf8")) as UsageAnalysisProjection}));
    if (this.db.prepare(`SELECT 1 FROM agent_usage_accounting_jobs j WHERE ${where} AND revision!=ready_revision LIMIT 1`).get(...params)) {
      const runtime = filter.runtimeKind === undefined ? "" : " AND json_extract(l.payload_json,'$.runtimeKind')=?";
      const rows = this.db.prepare(`SELECT l.payload_json FROM agent_usage_ledger l
        JOIN agent_usage_accounting_jobs j ON j.namespace=l.namespace AND j.session_id=l.session_id AND j.epoch_id=l.epoch_id
        WHERE ${where} AND j.revision!=j.ready_revision${runtime}`)
        .all(...params,...(filter.runtimeKind === undefined ? [] : [filter.runtimeKind])) as Array<{ payload_json: string }>;
      const grouped = new Map<string,UsageRecord[]>();
      for (const row of rows) {
        const record = JSON.parse(row.payload_json) as UsageRecord;
        const group = grouped.get(record.sessionId) ?? []; group.push(record); grouped.set(record.sessionId,group);
      }
      for (const [sessionId,records] of grouped) projections.push({sessionId,projection:new UsageAnalysis(records).project()});
    }
    return projections;
  }

  read(filter: UsageFilter): UsageAnalysis {
    return UsageAnalysis.combine(this.facts(filter).map(row => row.projection));
  }

  analysesBySession(filter: UsageFilter, sessionIds?: string[]): Map<string, UsageAnalysis> {
    const grouped = new Map<string,UsageAnalysisProjection[]>();
    for (const row of this.facts(filter,sessionIds)) {
      const group = grouped.get(row.sessionId) ?? []; group.push(row.projection); grouped.set(row.sessionId,group);
    }
    return new Map([...grouped].map(([sessionId, projections]) => [sessionId, UsageAnalysis.combine(projections)]));
  }

  summariesBySession(namespace: string, sessionIds: string[]) {
    const grouped = this.analysesBySession({ namespace }, sessionIds);
    return sessionIds.map(sessionId => ({sessionId,summary:(grouped.get(sessionId) ?? new UsageAnalysis([])).summary()}));
  }

  compactEventPayloads(limit: number): number {
    return this.db.transaction(() => {
      const cursor = this.db.prepare("SELECT last_rowid FROM agent_usage_storage_cursors WHERE name='event-payload'").get() as { last_rowid: number } | undefined;
      const target = (this.db.prepare("SELECT last_legacy_rowid FROM agent_usage_storage_limits WHERE name='event-payload'").get() as { last_legacy_rowid: number }).last_legacy_rowid;
      const rows = this.db.prepare("SELECT rowid,payload_json!='{}' AS pending FROM agent_usage_events WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT ?")
        .all(cursor?.last_rowid ?? 0,target,limit) as Array<{ rowid: number; pending: number }>;
      const lastRowid = rows.at(-1)?.rowid ?? target;
      if (lastRowid === (cursor?.last_rowid ?? 0)) return 0;
      const update = this.db.prepare("UPDATE agent_usage_events SET payload_json='{}' WHERE rowid=?");
      for (const row of rows) if (row.pending) update.run(row.rowid);
      this.db.prepare(`INSERT INTO agent_usage_storage_cursors VALUES('event-payload',?)
        ON CONFLICT(name) DO UPDATE SET last_rowid=excluded.last_rowid`).run(lastRowid);
      return rows.filter(row => row.pending).length;
    })();
  }

  eventPayloadCompactionPending(): boolean {
    const cursor = this.db.prepare("SELECT last_rowid FROM agent_usage_storage_cursors WHERE name='event-payload'").get() as { last_rowid: number } | undefined;
    const target = this.db.prepare("SELECT last_legacy_rowid FROM agent_usage_storage_limits WHERE name='event-payload'").get() as { last_legacy_rowid: number };
    return (cursor?.last_rowid ?? 0)<target.last_legacy_rowid;
  }

  deleteSession(namespace: string, sessionId: string): void {
    for (const table of ["agent_usage_accounting_projections","agent_usage_accounting_jobs"])
      this.db.prepare(`DELETE FROM ${table} WHERE namespace=? AND session_id=?`).run(namespace,sessionId);
  }
}
