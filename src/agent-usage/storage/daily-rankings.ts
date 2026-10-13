import type Database from "better-sqlite3";
import type { UsageFilter } from "../core/types.js";
import { dailyBounds, dayStart, localDay, shiftDay } from "../core/daily-time.js";
import { runtimeContentTokenSql } from "../runtime-content-evidence.js";

type Sql = { sql: string; params: Array<string | number> };
export type DailyRankingJob = { id: number };
export type DailyRankingBatch = { id: number; revision: number; data: string | null };
type DiscoveryRow = { rowid: number; namespace: string; agent_id: string; session_id: string; occurred_at: string | null };
const dimensions = [["namespace", "namespace"], ["agentId", "agent_id"], ["sessionId", "session_id"]] as const;
const inputColumns = ["capability_key", "block_kind", "evidence", "estimate_id", "first_use", "runtime_first_use",
  "byte_length", "token_count", "exposure_count", "known_count", "runtime_kind", "model"];
const coverageColumns = ["capability_key", "runtime_kind", "full", "partial", "opaque", "none"];
const latestColumns = ["capability_key", "runtime_kind", "capability_json", "occurred_at", "context_id", "position"];
const contentColumns = ["category", "runtime_kind", "estimate_id", "legacy_estimate_json", "tokens", "observations"];
const projections = { inputs: inputColumns, coverage: coverageColumns, latest: latestColumns, content: contentColumns };
type Projection = keyof typeof projections;
const numeric = new Set(["estimate_id", "byte_length", "token_count", "exposure_count", "known_count",
  "full", "partial", "opaque", "none", "position", "tokens", "observations"]);

/** Rebuild only changed Session/day partitions, off-thread; readers never consume stale partitions. */
export class DailyRankingStore {
  constructor(private readonly db: Database.Database) {
    db.function("usage_local_day", { deterministic: true }, (time: string | null, zone: string) => localDay(time, zone));
    db.function("usage_day_start", { deterministic: true }, (day: string, zone: string) => day ? dayStart(day, zone) : null);
    db.function("usage_day_end", { deterministic: true }, (day: string, zone: string) => day ? dayStart(shiftDay(day, 1), zone) : null);
    if (db.readonly) return;
    db.exec(`CREATE TABLE IF NOT EXISTS agent_usage_ranking_timezones (
      timezone TEXT PRIMARY KEY, context_cursor INTEGER NOT NULL DEFAULT 0, content_cursor INTEGER NOT NULL DEFAULT 0,
      context_complete INTEGER NOT NULL DEFAULT 0, content_complete INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS agent_usage_ranking_days (
        id INTEGER PRIMARY KEY AUTOINCREMENT, timezone TEXT NOT NULL, namespace TEXT NOT NULL, agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL, day TEXT NOT NULL, from_at TEXT, to_at TEXT, revision INTEGER NOT NULL DEFAULT 1,
        ready INTEGER NOT NULL DEFAULT 0, UNIQUE(timezone,namespace,agent_id,session_id,day));
      CREATE INDEX IF NOT EXISTS agent_usage_ranking_days_time ON agent_usage_ranking_days(timezone,day,namespace);
      CREATE INDEX IF NOT EXISTS agent_usage_ranking_days_session ON agent_usage_ranking_days(namespace,session_id);
      CREATE INDEX IF NOT EXISTS agent_usage_ranking_days_pending ON agent_usage_ranking_days(id) WHERE ready=0`);
    for (const [kind, columns] of Object.entries(projections)) {
      // Cluster each partition by capability/category, so page detail queries read only selected keys.
      const key = kind === "content" ? "category" : "capability_key";
      db.exec(`CREATE TABLE IF NOT EXISTS agent_usage_ranking_${kind} (
        partition_id INTEGER NOT NULL,ordinal INTEGER NOT NULL,
        ${columns.map(column => `${column} ${numeric.has(column) ? "INTEGER" : "TEXT"}`).join(",")},
        PRIMARY KEY(partition_id,${key},ordinal)) WITHOUT ROWID`);
    }
    this.ensureTimezone("UTC");
    this.track("agent_usage_contexts", "UPDATE OF revision,occurred_at,runtime_kind,model,coverage,history_complete,ranking_inputs_ready,namespace,agent_id,session_id");
    this.attachContent();
  }

  ensureTimezone(timezone: string): boolean {
    // Route validation already checks IANA names; direct callers get the same validation.
    localDay("2000-01-01T00:00:00Z", timezone);
    return this.db.prepare("INSERT OR IGNORE INTO agent_usage_ranking_timezones(timezone) VALUES(?)").run(timezone).changes > 0;
  }

  attachContent(): void {
    if (this.db.readonly || !this.hasContent()) return;
    const installed = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='agent_usage_conversation_content_daily_insert'").get();
    if (!installed) this.db.prepare("UPDATE agent_usage_ranking_timezones SET content_complete=0").run();
    this.track("agent_usage_conversation_content", "UPDATE");
  }

  private hasContent(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_usage_conversation_content'").get());
  }

  private track(table: string, update: string): void {
    const invalidate = (row: string) => `INSERT INTO agent_usage_ranking_days(timezone,namespace,agent_id,session_id,day,from_at,to_at)
      SELECT timezone,${row}.namespace,${row}.agent_id,${row}.session_id,usage_local_day(${row}.occurred_at,timezone),
        usage_day_start(usage_local_day(${row}.occurred_at,timezone),timezone),
        usage_day_end(usage_local_day(${row}.occurred_at,timezone),timezone)
      FROM agent_usage_ranking_timezones WHERE 1
      ON CONFLICT(timezone,namespace,agent_id,session_id,day) DO UPDATE SET revision=revision+1,ready=0;`;
    for (const [event, suffix, rows] of [["INSERT", "insert", ["NEW"]], [update, "update", ["OLD", "NEW"]],
      ["DELETE", "delete", ["OLD"]]] as const) {
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_daily_${suffix} AFTER ${event} ON ${table}
        BEGIN ${rows.map(invalidate).join("\n")} END`);
    }
  }

  /** Startup discovers metadata in bounded rowid batches, never aggregates historical bodies. */
  discover(limit = 500): boolean {
    return this.db.transaction(() => {
      const zone = this.db.prepare(`SELECT timezone,context_cursor,content_cursor,context_complete,content_complete FROM agent_usage_ranking_timezones
        WHERE context_complete=0 OR content_complete=0 ORDER BY timezone LIMIT 1`).get() as
        { timezone: string; context_cursor: number; content_cursor: number; context_complete: number; content_complete: number } | undefined;
      if (!zone) return false;
      const insert = this.db.prepare(`INSERT OR IGNORE INTO agent_usage_ranking_days
        (timezone,namespace,agent_id,session_id,day,from_at,to_at) VALUES(?,?,?,?,?,?,?)`);
      for (const [kind, table] of [["context", "agent_usage_contexts"], ["content", "agent_usage_conversation_content"]] as const) {
        if (zone[`${kind}_complete`]) continue;
        const rows = kind === "content" && !this.hasContent() ? [] : this.db.prepare(`SELECT rowid,namespace,agent_id,session_id,occurred_at
          FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT ?`).all(zone[`${kind}_cursor`], limit) as DiscoveryRow[];
        for (const row of rows) {
          const day = localDay(row.occurred_at, zone.timezone);
          insert.run(zone.timezone, row.namespace, row.agent_id, row.session_id, day,
            day ? dayStart(day, zone.timezone) : null, day ? dayStart(shiftDay(day, 1), zone.timezone) : null);
        }
        this.db.prepare(`UPDATE agent_usage_ranking_timezones SET ${kind}_cursor=?,${kind}_complete=? WHERE timezone=?`)
          .run(rows.at(-1)?.rowid ?? zone[`${kind}_cursor`], Number(rows.length < limit), zone.timezone);
      }
      return Boolean(this.db.prepare("SELECT 1 FROM agent_usage_ranking_timezones WHERE context_complete=0 OR content_complete=0 LIMIT 1").get());
    })();
  }

  pending(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM agent_usage_ranking_timezones WHERE context_complete=0 OR content_complete=0 LIMIT 1").get()
      || this.db.prepare("SELECT 1 FROM agent_usage_ranking_days WHERE ready=0 LIMIT 1").get());
  }

  nextJob(afterId = 0): DailyRankingJob | undefined {
    // Keep job selection metadata-only on the writer; readiness is checked in the worker.
    return (this.db.prepare(`SELECT id FROM agent_usage_ranking_days WHERE ready=0 AND id>?
      ORDER BY id LIMIT 1`).get(afterId) ?? this.db.prepare(`SELECT id FROM agent_usage_ranking_days
      WHERE ready=0 AND id<=? ORDER BY id LIMIT 1`).get(afterId)) as DailyRankingJob | undefined;
  }

  project(job: DailyRankingJob): DailyRankingBatch | undefined {
    return this.db.transaction(() => {
      const current = this.db.prepare("SELECT day,revision FROM agent_usage_ranking_days WHERE id=? AND ready=0").get(job.id) as { day: string; revision: number } | undefined;
      if (!current) return;
      const contexts = `FROM agent_usage_ranking_days j CROSS JOIN agent_usage_contexts c ON ${this.member("c", "j", !current.day)}
        CROSS JOIN agent_usage_context_inputs e ON e.context_id=c.context_id WHERE j.id=?`;
      if (this.db.prepare(`SELECT 1 FROM agent_usage_ranking_days j JOIN agent_usage_contexts c ON ${this.member("c", "j", !current.day)}
        WHERE j.id=? AND c.ranking_inputs_ready=0 LIMIT 1`).get(job.id)) return;
      const inputs = this.db.prepare(`SELECT e.capability_key,e.block_kind,e.evidence,e.estimate_id,e.first_use,e.runtime_first_use,
        SUM(e.byte_length) AS byte_length,SUM(e.token_count) AS token_count,SUM(e.exposure_count) AS exposure_count,
        SUM(e.known_count) AS known_count,c.runtime_kind,c.model ${contexts}
        GROUP BY e.capability_key,c.runtime_kind,e.block_kind,e.evidence,e.estimate_id,e.first_use,e.runtime_first_use`).all(job.id);
      const coverage = this.db.prepare(`SELECT capability_key,runtime_kind,SUM(coverage='full') AS full,SUM(coverage='partial') AS partial,
        SUM(coverage='opaque') AS opaque,SUM(coverage='none') AS none FROM (
          SELECT DISTINCT e.capability_key,c.context_id,c.runtime_kind,c.coverage ${contexts}) GROUP BY capability_key,runtime_kind`).all(job.id);
      const latest = this.db.prepare(`SELECT capability_key,runtime_kind,capability_json,occurred_at,context_id,position FROM (
        SELECT e.capability_key,c.runtime_kind,e.capability_json,c.occurred_at,c.context_id,e.position,
        ROW_NUMBER() OVER(PARTITION BY e.capability_key,c.runtime_kind
          ORDER BY c.occurred_at IS NOT NULL,c.occurred_at DESC,c.context_id DESC,e.position DESC) AS ordinal ${contexts}) WHERE ordinal=1`).all(job.id);
      const content = this.hasContent() ? this.db.prepare(`SELECT c.category,c.runtime_kind,c.estimate_id,c.estimate_json AS legacy_estimate_json,
        SUM(c.tokens) AS tokens,COUNT(*) AS observations FROM agent_usage_ranking_days j
        CROSS JOIN agent_usage_conversation_content c ON ${this.member("c", "j", !current.day)} WHERE j.id=?
        GROUP BY c.category,c.runtime_kind,c.estimate_id,c.estimate_json`).all(job.id) : [];
      return { id: job.id, revision: current.revision, data: inputs.length || content.length ? JSON.stringify({ inputs, coverage, latest, content }) : null };
    })();
  }

  commit(batch: DailyRankingBatch | undefined): boolean {
    if (!batch) return false;
    return this.db.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM agent_usage_ranking_days WHERE id=? AND revision=? AND ready=0")
        .get(batch.id, batch.revision)) return false;
      for (const [kind, columns] of Object.entries(projections)) {
        this.db.prepare(`DELETE FROM agent_usage_ranking_${kind} WHERE partition_id=?`).run(batch.id);
        if (batch.data !== null) this.db.prepare(`INSERT INTO agent_usage_ranking_${kind}
          (partition_id,ordinal,${columns.join(",")}) SELECT ?,CAST(v.key AS INTEGER),
          ${columns.map(column => `json_extract(v.value,'$.${column}')`).join(",")}
          FROM json_each(?,'$.${kind}') v`).run(batch.id, batch.data);
      }
      if (batch.data === null) this.db.prepare("DELETE FROM agent_usage_ranking_days WHERE id=?").run(batch.id);
      else this.db.prepare("UPDATE agent_usage_ranking_days SET ready=1 WHERE id=?").run(batch.id);
      return true;
    })();
  }

  deleteSession(namespace: string, sessionId: string): void {
    this.db.transaction(() => {
      for (const kind of Object.keys(projections)) this.db.prepare(`DELETE FROM agent_usage_ranking_${kind}
        WHERE partition_id IN (SELECT id FROM agent_usage_ranking_days WHERE namespace=? AND session_id=?)`)
        .run(namespace, sessionId);
      this.db.prepare("DELETE FROM agent_usage_ranking_days WHERE namespace=? AND session_id=?").run(namespace, sessionId);
    })();
  }

  private member(alias: string, job: string, missingTime = false): string {
    return `${alias}.namespace=${job}.namespace AND ${alias}.agent_id=${job}.agent_id AND ${alias}.session_id=${job}.session_id
      AND ${missingTime ? `${alias}.occurred_at IS NULL` : `${alias}.occurred_at>=${job}.from_at AND ${alias}.occurred_at<${job}.to_at`}`;
  }

  /** Partial-day internal queries retain their original path; management queries normalize to days. */
  private scope(filter: UsageFilter): Sql | undefined {
    const timezone = filter.timezone ?? "UTC", normalized = dailyBounds(filter.from, filter.to, timezone);
    if (filter.from !== undefined && normalized.from !== filter.from
      || filter.to !== undefined && normalized.to !== filter.to) return;
    const zone = this.db.prepare("SELECT context_complete,content_complete FROM agent_usage_ranking_timezones WHERE timezone=?")
      .get(timezone) as { context_complete: number; content_complete: number } | undefined;
    if (!zone?.context_complete || !zone.content_complete) return;
    const clauses = ["j.timezone=?"], params: string[] = [timezone];
    for (const [field, column] of dimensions) if (filter[field] !== undefined) { clauses.push(`j.${column}=?`); params.push(filter[field]); }
    if (filter.from !== undefined) { clauses.push("j.day>=?"); params.push(localDay(filter.from, timezone)); }
    if (filter.to !== undefined) { clauses.push("j.day<?"); params.push(localDay(filter.to, timezone)); }
    if (filter.from !== undefined || filter.to !== undefined) clauses.push("j.day!=''");
    return { sql: clauses.join(" AND "), params };
  }

  private cached(scope: Sql, filter: UsageFilter, kind: Projection,
    columns = projections[kind].map(column => `v.${column}`).join(",")): Sql {
    return { sql: `SELECT ${columns}
      FROM agent_usage_ranking_days j CROSS JOIN agent_usage_ranking_${kind} v ON v.partition_id=j.id
      WHERE ${scope.sql} AND j.ready=1 ${filter.runtimeKind === undefined ? "" : "AND v.runtime_kind=?"}`,
      params: [...scope.params, ...(filter.runtimeKind === undefined ? [] : [filter.runtimeKind])] };
  }

  private raw(scope: Sql, filter: UsageFilter, table: string, columns: string): Sql {
    // Keep the timestamp predicates indexable. Only unbounded queries need the NULL-time branch.
    const missing = filter.from === undefined && filter.to === undefined ? [false, true] : [false];
    const params = [...scope.params, ...(filter.runtimeKind === undefined ? [] : [filter.runtimeKind])];
    return { sql: missing.map(missingTime => `SELECT ${columns} FROM agent_usage_ranking_days j
      CROSS JOIN ${table} c ON ${this.member("c", "j", missingTime)}
      ${table === "agent_usage_contexts" ? "CROSS JOIN agent_usage_context_inputs e ON e.context_id=c.context_id" : ""}
      WHERE ${scope.sql} AND j.ready=0 AND j.day${missingTime ? "=" : "!="}''
      ${filter.runtimeKind === undefined ? "" : "AND c.runtime_kind=?"}`).join(" UNION ALL "),
      params: missing.flatMap(() => params) };
  }

  inputs(filter: UsageFilter): Sql | undefined {
    const scope = this.scope(filter); if (!scope) return;
    const raw = this.raw(scope, filter, "agent_usage_contexts",
      inputColumns.map(column => `${["runtime_kind", "model"].includes(column) ? "c" : "e"}.${column}`).join(","));
    const cached = this.cached(scope, filter, "inputs");
    // Display metadata lives in its own small projection, not every numeric profile.
    return { sql: `SELECT ${inputColumns.join(",")},NULL AS capability_json FROM (${raw.sql} UNION ALL ${cached.sql})`,
      params: [...raw.params, ...cached.params] };
  }

  coverage(filter: UsageFilter, keys: string[]): Sql {
    const scope = this.scope(filter)!;
    const raw = this.raw(scope, filter, "agent_usage_contexts", "e.capability_key,c.context_id,c.runtime_kind,c.coverage");
    const cached = this.cached(scope, filter, "coverage"), selected = JSON.stringify(keys);
    const where = "capability_key IN (SELECT value FROM json_each(?))";
    // Filter dirty inputs before DISTINCT/GROUP BY; an outer filter cannot skip that work.
    return { sql: `SELECT capability_key,runtime_kind,SUM(coverage='full') AS full,SUM(coverage='partial') AS partial,
      SUM(coverage='opaque') AS opaque,SUM(coverage='none') AS none FROM (
        SELECT DISTINCT capability_key,context_id,runtime_kind,coverage FROM (${raw.sql}) WHERE ${where}) GROUP BY capability_key,runtime_kind
      UNION ALL SELECT ${coverageColumns.join(",")} FROM (${cached.sql}) WHERE ${where}`,
      params: [...raw.params, selected, ...cached.params, selected] };
  }

  latest(filter: UsageFilter): Sql {
    const scope = this.scope(filter)!;
    const raw = this.raw(scope, filter, "agent_usage_contexts",
      "e.capability_key,c.runtime_kind,e.capability_json,c.occurred_at,c.context_id,e.position");
    const cached = this.cached(scope, filter, "latest");
    return { sql: `${raw.sql} UNION ALL ${cached.sql}`, params: [...raw.params, ...cached.params] };
  }

  content(filter: UsageFilter, tokenPart?: "arguments" | "result"): Sql | undefined {
    const scope = this.scope(filter); if (!scope || !this.hasContent()) return;
    const raw = this.raw(scope, filter, "agent_usage_conversation_content",
      `c.category,c.runtime_kind,c.estimate_id,c.estimate_json AS legacy_estimate_json,${runtimeContentTokenSql("c", tokenPart)} AS tokens,1 AS observations`);
    const cached = this.cached(scope, filter, "content", contentColumns.map(column => column === "tokens"
      ? `${runtimeContentTokenSql("v", tokenPart)} AS tokens` : `v.${column}`).join(","));
    return { sql: `${raw.sql} UNION ALL ${cached.sql}`, params: [...raw.params, ...cached.params] };
  }
}
