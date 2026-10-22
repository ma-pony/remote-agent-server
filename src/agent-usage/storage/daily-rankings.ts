import type Database from "better-sqlite3";
import type { UsageFilter } from "../core/types.js";
import { dailyBounds, dayStart, dayKey, shiftDay } from "../core/daily-time.js";
import { runtimeContentTokenSql } from "../runtime-content-evidence.js";
import { rankingCapabilityMetadata } from "./ranking-inputs.js";
import { unarchivedDetails } from "./detail-archives.js";
import { ResultFirstUseIndex } from "./result-first-use.js";
import { UsageError } from "../core/errors.js";

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
    db.function("usage_day", { deterministic: true }, dayKey);
    db.function("usage_day_start", { deterministic: true }, (day: string) => day ? dayStart(day) : null);
    db.function("usage_day_end", { deterministic: true }, (day: string) => day ? dayStart(shiftDay(day, 1)) : null);
    if (db.readonly) return;
    db.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS agent_usage_ranking_discovery (
        id INTEGER PRIMARY KEY CHECK(id=1), context_cursor INTEGER NOT NULL DEFAULT 0, content_cursor INTEGER NOT NULL DEFAULT 0,
        context_complete INTEGER NOT NULL DEFAULT 0, content_complete INTEGER NOT NULL DEFAULT 0);
        INSERT OR IGNORE INTO agent_usage_ranking_discovery(id) VALUES(1)`);
      const migrated = this.migrateCalendars();
      db.exec(`CREATE TABLE IF NOT EXISTS agent_usage_ranking_days (
        id INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL, agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL, day TEXT NOT NULL, from_at TEXT, to_at TEXT, revision INTEGER NOT NULL DEFAULT 1,
        ready INTEGER NOT NULL DEFAULT 0, UNIQUE(namespace,agent_id,session_id,day));
        CREATE INDEX IF NOT EXISTS agent_usage_ranking_days_time ON agent_usage_ranking_days(namespace,day);
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
      for (const kind of ["inputs","content"]) db.exec(`CREATE INDEX IF NOT EXISTS agent_usage_ranking_${kind}_estimate
        ON agent_usage_ranking_${kind}(estimate_id)`);
      this.track("agent_usage_contexts", "UPDATE OF revision,occurred_at,runtime_kind,model,coverage,history_complete,ranking_inputs_ready,namespace,agent_id,session_id");
      // Replacing legacy triggers must not restart the preserved UTC discovery cursor.
      if (migrated && this.hasContent()) this.track("agent_usage_conversation_content", "UPDATE");
      this.attachContent();
    })();
  }

  /** Preserve UTC identities, completed aggregates and cursors in one retryable migration. */
  private migrateCalendars(): boolean {
    const columns = this.db.prepare("PRAGMA table_info(agent_usage_ranking_days)").all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === "timezone")) return false;
    const sequence = (this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='agent_usage_ranking_days'").get() as { seq: number } | undefined)?.seq ?? 0;
    for (const table of ["agent_usage_contexts", "agent_usage_conversation_content"]) {
      for (const event of ["insert", "update", "delete"]) this.db.exec(`DROP TRIGGER IF EXISTS ${table}_daily_${event}`);
    }
    for (const kind of Object.keys(projections)) this.db.exec(`DELETE FROM agent_usage_ranking_${kind}
      WHERE partition_id IN (SELECT id FROM agent_usage_ranking_days WHERE timezone!='UTC')`);
    this.db.exec(`CREATE TABLE agent_usage_ranking_days_single (
      id INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL, agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL, day TEXT NOT NULL, from_at TEXT, to_at TEXT, revision INTEGER NOT NULL DEFAULT 1,
      ready INTEGER NOT NULL DEFAULT 0, UNIQUE(namespace,agent_id,session_id,day));
      INSERT INTO agent_usage_ranking_days_single SELECT id,namespace,agent_id,session_id,day,from_at,to_at,revision,ready
        FROM agent_usage_ranking_days WHERE timezone='UTC';
      DROP TABLE agent_usage_ranking_days;
      ALTER TABLE agent_usage_ranking_days_single RENAME TO agent_usage_ranking_days;
      INSERT OR REPLACE INTO agent_usage_ranking_discovery SELECT 1,context_cursor,content_cursor,context_complete,content_complete
        FROM agent_usage_ranking_timezones WHERE timezone='UTC';
      DROP TABLE agent_usage_ranking_timezones;`);
    if (!this.db.prepare("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='agent_usage_ranking_days'").run(sequence).changes)
      this.db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('agent_usage_ranking_days',?)").run(sequence);
    return true;
  }

  attachContent(): void {
    if (this.db.readonly || !this.hasContent()) return;
    const installed = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='agent_usage_conversation_content_daily_insert'").get();
    if (!installed) this.db.prepare("UPDATE agent_usage_ranking_discovery SET content_complete=0").run();
    this.track("agent_usage_conversation_content", "UPDATE");
  }

  private hasContent(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_usage_conversation_content'").get());
  }

  private track(table: string, update: string): void {
    const invalidate = (row: string) => `INSERT INTO agent_usage_ranking_days(namespace,agent_id,session_id,day,from_at,to_at)
      SELECT ${row}.namespace,${row}.agent_id,${row}.session_id,usage_day(${row}.occurred_at),
        usage_day_start(usage_day(${row}.occurred_at)),usage_day_end(usage_day(${row}.occurred_at)) WHERE ${unarchivedDetails(row)}
      ON CONFLICT(namespace,agent_id,session_id,day) DO UPDATE SET revision=revision+1,ready=0;`;
    for (const [event, suffix, rows] of [["INSERT", "insert", ["NEW"]], [update, "update", ["OLD", "NEW"]],
      ["DELETE", "delete", ["OLD"]]] as const) {
      const name = `${table}_daily_${suffix}`;
      const old = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as { sql: string } | undefined;
      if (old && !old.sql.includes("agent_usage_detail_archives")) this.db.exec(`DROP TRIGGER ${name}`);
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS ${name} AFTER ${event} ON ${table}
        BEGIN ${rows.map(invalidate).join("\n")} END`);
    }
  }

  /** Startup discovers metadata in bounded rowid batches, never aggregates historical bodies. */
  discover(limit = 500): boolean {
    return this.db.transaction(() => {
      const progress = this.db.prepare(`SELECT context_cursor,content_cursor,context_complete,content_complete FROM agent_usage_ranking_discovery
        WHERE context_complete=0 OR content_complete=0`).get() as
        { context_cursor: number; content_cursor: number; context_complete: number; content_complete: number } | undefined;
      if (!progress) return false;
      const insert = this.db.prepare(`INSERT OR IGNORE INTO agent_usage_ranking_days
        (namespace,agent_id,session_id,day,from_at,to_at) VALUES(?,?,?,?,?,?)`);
      for (const [kind, table] of [["context", "agent_usage_contexts"], ["content", "agent_usage_conversation_content"]] as const) {
        if (progress[`${kind}_complete`]) continue;
        const rows = kind === "content" && !this.hasContent() ? [] : this.db.prepare(`SELECT rowid,namespace,agent_id,session_id,occurred_at
          FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT ?`).all(progress[`${kind}_cursor`], limit) as DiscoveryRow[];
        for (const row of rows) {
          const day = dayKey(row.occurred_at);
          insert.run(row.namespace, row.agent_id, row.session_id, day,
            day ? dayStart(day) : null, day ? dayStart(shiftDay(day, 1)) : null);
        }
        this.db.prepare(`UPDATE agent_usage_ranking_discovery SET ${kind}_cursor=?,${kind}_complete=? WHERE id=1`)
          .run(rows.at(-1)?.rowid ?? progress[`${kind}_cursor`], Number(rows.length < limit));
      }
      return Boolean(this.db.prepare("SELECT 1 FROM agent_usage_ranking_discovery WHERE context_complete=0 OR content_complete=0").get());
    })();
  }

  pending(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM agent_usage_ranking_discovery WHERE context_complete=0 OR content_complete=0").get()
      || this.db.prepare(`SELECT 1 FROM agent_usage_ranking_days j WHERE ready=0 AND ${unarchivedDetails("j")} LIMIT 1`).get());
  }

  nextJob(afterId = 0): DailyRankingJob | undefined {
    // Keep job selection metadata-only on the writer; readiness is checked in the worker.
    return (this.db.prepare(`SELECT id FROM agent_usage_ranking_days j WHERE ready=0 AND ${unarchivedDetails("j")} AND id>?
      ORDER BY id LIMIT 1`).get(afterId) ?? this.db.prepare(`SELECT id FROM agent_usage_ranking_days
      j WHERE ready=0 AND ${unarchivedDetails("j")} AND id<=? ORDER BY id LIMIT 1`).get(afterId)) as DailyRankingJob | undefined;
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
      const latest = this.db.prepare(`SELECT capability_key,runtime_kind,${rankingCapabilityMetadata("ranked")} AS capability_json,occurred_at,context_id,position FROM (
        SELECT e.capability_key,c.runtime_kind,c.occurred_at,c.context_id,e.position,
        ROW_NUMBER() OVER(PARTITION BY e.capability_key,c.runtime_kind
          ORDER BY c.occurred_at IS NOT NULL,c.occurred_at DESC,c.context_id DESC,e.position DESC) AS ordinal ${contexts}) ranked WHERE ordinal=1`).all(job.id);
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
      if (!this.db.prepare(`SELECT 1 FROM agent_usage_ranking_days j WHERE id=? AND revision=? AND ready=0 AND ${unarchivedDetails("j")}`)
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
      this.db.prepare("DELETE FROM agent_usage_detail_archives WHERE namespace=? AND session_id=?").run(namespace,sessionId);
    })();
  }

  /** Publish only after every source partition has a current, self-contained projection. */
  archiveSession(namespace: string, agentId: string, sessionId: string, archivedAt: string): boolean {
    return this.db.transaction(() => {
      if (this.db.prepare(`SELECT 1 FROM agent_usage_contexts WHERE namespace=? AND session_id=?
        AND (ranking_inputs_ready=0 OR estimated_input_ready=0) LIMIT 1`).get(namespace,sessionId)) return false;
      for (const table of ["agent_usage_contexts","agent_usage_conversation_content"]) {
        const hasDetails = table === "agent_usage_contexts"
          ? "AND EXISTS (SELECT 1 FROM agent_usage_exposures e WHERE e.context_id=c.context_id)" : "";
        if (this.db.prepare(`SELECT 1 FROM ${table} c WHERE c.namespace=? AND c.session_id=? ${hasDetails} AND NOT EXISTS (
          SELECT 1 FROM agent_usage_ranking_days j WHERE j.namespace=c.namespace AND j.agent_id=c.agent_id
            AND j.session_id=c.session_id AND j.day=usage_day(c.occurred_at) AND j.ready=1) LIMIT 1`).get(namespace,sessionId)) return false;
      }
      if (this.db.prepare("SELECT 1 FROM agent_usage_ranking_days WHERE namespace=? AND session_id=? AND ready=0 LIMIT 1").get(namespace,sessionId)) return false;
      this.db.prepare("INSERT INTO agent_usage_detail_archives(namespace,session_id,agent_id,archived_at) VALUES(?,?,?,?)")
        .run(namespace,sessionId,agentId,archivedAt);
      // Evidence caches must not survive the atomic publication of expiry.
      this.db.prepare("UPDATE agent_usage_query_version SET revision=revision+1,generation=generation+1 WHERE id=1").run();
      return true;
    })();
  }

  private member(alias: string, job: string, missingTime = false): string {
    return `${alias}.namespace=${job}.namespace AND ${alias}.agent_id=${job}.agent_id AND ${alias}.session_id=${job}.session_id
      AND ${missingTime ? `${alias}.occurred_at IS NULL` : `${alias}.occurred_at>=${job}.from_at AND ${alias}.occurred_at<${job}.to_at`}`;
  }

  /** Partial-day internal queries retain their original path; management queries normalize to days. */
  private scope(filter: UsageFilter): Sql | undefined {
    const normalized = dailyBounds(filter.from, filter.to);
    const partialDay = filter.from !== undefined && normalized.from !== new Date(filter.from).toISOString()
      || filter.to !== undefined && normalized.to !== new Date(filter.to).toISOString();
    const progress = this.db.prepare("SELECT context_complete,content_complete FROM agent_usage_ranking_discovery WHERE id=1")
      .get() as { context_complete: number; content_complete: number };
    const clauses = ["1"], params: string[] = [];
    for (const [field, column] of dimensions) if (filter[field] !== undefined) { clauses.push(`j.${column}=?`); params.push(filter[field]); }
    if (normalized.from !== undefined) { clauses.push("j.day>=?"); params.push(dayKey(normalized.from)); }
    if (normalized.to !== undefined) { clauses.push("j.day<?"); params.push(dayKey(normalized.to)); }
    if (filter.from !== undefined || filter.to !== undefined) clauses.push("j.day!=''");
    const archived = Boolean(this.db.prepare(`SELECT 1 FROM agent_usage_ranking_days j
      WHERE ${clauses.join(" AND ")} AND NOT (${unarchivedDetails("j")}) LIMIT 1`).get(...params));
    // Management queries use UTC days. Never silently return partial archived totals to
    // internal exact-time callers, for which the retired evidence is no longer available.
    if (partialDay) {
      if (archived) throw new UsageError("usage_details_expired");
      return;
    }
    if ((!progress.context_complete || !progress.content_complete) && !archived) return;
    return { sql: clauses.join(" AND "), params };
  }

  private cached(scope: Sql, filter: UsageFilter, kind: Projection,
    columns = projections[kind].map(column => `v.${column}`).join(",")): Sql {
    return { sql: `SELECT ${columns}
      FROM agent_usage_ranking_days j CROSS JOIN agent_usage_ranking_${kind} v ON v.partition_id=j.id
      WHERE ${scope.sql} AND (j.ready=1 OR NOT (${unarchivedDetails("j")})) ${filter.runtimeKind === undefined ? "" : "AND v.runtime_kind=?"}`,
      params: [...scope.params, ...(filter.runtimeKind === undefined ? [] : [filter.runtimeKind])] };
  }

  private raw(scope: Sql, filter: UsageFilter, table: string, columns: string): Sql {
    const clauses = [unarchivedDetails("c")], sourceParams: string[] = [];
    for (const [field,column] of [...dimensions,["runtimeKind","runtime_kind"]] as const)
      if (filter[field] !== undefined) { clauses.push(`c.${column}=?`); sourceParams.push(filter[field]); }
    if (filter.from !== undefined) { clauses.push("c.occurred_at>=?"); sourceParams.push(new Date(filter.from).toISOString()); }
    if (filter.to !== undefined) { clauses.push("c.occurred_at<?"); sourceParams.push(new Date(filter.to).toISOString()); }
    const contexts = table === "agent_usage_contexts";
    const detailed = contexts && Boolean(this.db.prepare(`SELECT 1 FROM agent_usage_contexts c
      WHERE ${clauses.join(" AND ")} AND ranking_inputs_ready=0 LIMIT 1`).get(...sourceParams));
    const discovering = Boolean(this.db.prepare("SELECT 1 FROM agent_usage_ranking_discovery WHERE context_complete=0 OR content_complete=0").get());
    const missing = filter.from === undefined && filter.to === undefined ? [false,true] : [false];
    const queries: string[] = [], params: Array<string | number> = [];
    for (const raw of detailed ? [false,true] : [false]) {
      const first = ResultFirstUseIndex.classification;
      const expanded = raw ? columns.replace(/e\.exposure_count\b/g,"1").replace(/e\.known_count\b/g,"(e.token_count IS NOT NULL)")
        .replace(/e\.first_use\b/g,`COALESCE(${first},'')`)
        .replace(/e\.runtime_first_use\b/g,`COALESCE(${first.replace(/\bf\b/g,"fr")},'')`) : columns;
      const joins = (contexts ? `CROSS JOIN ${raw ? "agent_usage_exposures" : "agent_usage_context_inputs"} e ON e.context_id=c.context_id` : "")
        + (raw && /e\.(first_use|runtime_first_use)\b/.test(columns)
          ? ` ${ResultFirstUseIndex.join.replace("f.runtime_scope=?","f.runtime_scope=''")}
            ${ResultFirstUseIndex.join.replace(/\bf\b/g,"fr").replace("fr.runtime_scope=?","fr.runtime_scope=json_quote(c.runtime_kind)")}` : "");
      const readiness = contexts ? `AND c.ranking_inputs_ready=${raw ? 0 : 1}` : "";
      // Keep known partitions driving indexed Session/time lookups, including NULL-time history.
      for (const missingTime of missing) {
        queries.push(`SELECT ${expanded} FROM agent_usage_ranking_days j
          CROSS JOIN ${table} c ON ${this.member("c","j",missingTime)} ${joins}
          WHERE ${scope.sql} AND j.ready=0 AND ${unarchivedDetails("j")} AND j.day${missingTime ? "=" : "!="}''
          ${filter.runtimeKind === undefined ? "" : "AND c.runtime_kind=?"} ${readiness}`);
        params.push(...scope.params,...(filter.runtimeKind === undefined ? [] : [filter.runtimeKind]));
      }
      // An interrupted historical discovery must still combine undiscovered live data with archives.
      if (discovering) {
        queries.push(`SELECT ${expanded} FROM ${table} c ${joins}
          WHERE ${clauses.join(" AND ")} ${readiness} AND NOT EXISTS (
            SELECT 1 FROM agent_usage_ranking_days j WHERE j.namespace=c.namespace AND j.agent_id=c.agent_id
              AND j.session_id=c.session_id AND j.day=usage_day(c.occurred_at))`);
        params.push(...sourceParams);
      }
    }
    return { sql: queries.join(" UNION ALL "), params };
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
      "e.capability_key,c.runtime_kind,NULL AS capability_json,c.occurred_at,c.context_id,e.position");
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
