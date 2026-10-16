import type Database from "better-sqlite3";
import { ResultFirstUseIndex } from "./result-first-use.js";

export const rankingExposureColumns = ["context_id","position","block_kind","tool_invocation_id","capability_key",
  "capability_json","evidence","content_key","modality","byte_length","token_count","estimate_id","result_first_use"] as const;

/** Fetch display metadata only after selecting a representative numeric input. */
export const rankingCapabilityMetadata = (alias: string): string => `(SELECT metadata.capability_json FROM agent_usage_exposures metadata
  WHERE metadata.context_id=${alias}.context_id AND metadata.position=${alias}.position AND metadata.capability_key=${alias}.capability_key)`;

/** Compact numeric inputs retain the existing ranking dimensions and null semantics. */
export class RankingInputStore {
  constructor(private readonly db: Database.Database) {
    if (db.readonly) return;
    const columns = db.prepare("PRAGMA table_info(agent_usage_contexts)").all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === "ranking_inputs_ready"))
      db.exec("ALTER TABLE agent_usage_contexts ADD COLUMN ranking_inputs_ready INTEGER NOT NULL DEFAULT 0");
    db.exec(`CREATE TABLE IF NOT EXISTS agent_usage_context_inputs (
      context_id TEXT NOT NULL,capability_key TEXT NOT NULL,block_kind TEXT NOT NULL,evidence TEXT NOT NULL,
      estimate_id INTEGER NOT NULL,first_use TEXT NOT NULL,runtime_first_use TEXT NOT NULL,
      byte_length INTEGER,token_count INTEGER,exposure_count INTEGER NOT NULL,known_count INTEGER NOT NULL,
      position INTEGER NOT NULL,capability_json TEXT NOT NULL,
      PRIMARY KEY(context_id,capability_key,block_kind,evidence,estimate_id,first_use,runtime_first_use));
      CREATE INDEX IF NOT EXISTS agent_usage_context_inputs_estimate ON agent_usage_context_inputs(estimate_id);
      CREATE TABLE IF NOT EXISTS agent_usage_context_calls (
        context_id TEXT NOT NULL,capability_key TEXT NOT NULL,tool_invocation_id TEXT NOT NULL,
        PRIMARY KEY(tool_invocation_id,capability_key,context_id));
      CREATE INDEX IF NOT EXISTS agent_usage_context_calls_context ON agent_usage_context_calls(context_id);
      CREATE INDEX IF NOT EXISTS agent_usage_ranking_pending ON agent_usage_contexts(occurred_at DESC,context_id)
        WHERE ranking_inputs_ready=0;
      INSERT OR IGNORE INTO agent_usage_storage_limits SELECT 'exposure-identities',COALESCE(MAX(rowid),0) FROM agent_usage_exposures;
      INSERT OR IGNORE INTO agent_usage_storage_limits SELECT 'ranking-input-metadata',COALESCE(MAX(rowid),0) FROM agent_usage_context_inputs`);
    for (const event of ["INSERT","UPDATE","DELETE"]) {
      const row = event === "DELETE" ? "OLD" : "NEW";
      const operation = event === "UPDATE" ? `UPDATE OF ${rankingExposureColumns.join(",")}` : event;
      db.exec(`CREATE TRIGGER IF NOT EXISTS agent_usage_exposures_inputs_${event.toLowerCase()}
        AFTER ${operation} ON agent_usage_exposures BEGIN
        UPDATE agent_usage_contexts SET ranking_inputs_ready=0 WHERE context_id=${row}.context_id AND ranking_inputs_ready=1;
        END`);
    }
    db.exec(`CREATE TRIGGER IF NOT EXISTS agent_usage_contexts_inputs_update
      AFTER UPDATE OF history_complete,runtime_kind ON agent_usage_contexts
      WHEN NEW.history_complete IS NOT OLD.history_complete OR NEW.runtime_kind IS NOT OLD.runtime_kind
      BEGIN UPDATE agent_usage_contexts SET ranking_inputs_ready=0 WHERE context_id=NEW.context_id AND ranking_inputs_ready=1; END`);
  }

  ready(clauses: string[], params: string[]): boolean {
    return !this.db.prepare(`SELECT 1 FROM agent_usage_contexts c
      WHERE ${clauses.length ? clauses.join(" AND ") : "1"} AND ranking_inputs_ready=0 LIMIT 1`).get(...params);
  }

  refresh(contextId: string): void {
    this.db.prepare("DELETE FROM agent_usage_context_inputs WHERE context_id=?").run(contextId);
    this.db.prepare("DELETE FROM agent_usage_context_calls WHERE context_id=?").run(contextId);
    this.db.prepare(`INSERT INTO agent_usage_context_calls SELECT DISTINCT context_id,capability_key,tool_invocation_id
      FROM agent_usage_exposures WHERE context_id=? AND tool_invocation_id IS NOT NULL`).run(contextId);
    const classification = ResultFirstUseIndex.classification;
    const runtimeClassification = classification.replace(/\bf\b/g,"fr");
    this.db.prepare(`INSERT INTO agent_usage_context_inputs
      SELECT e.context_id,e.capability_key,e.block_kind,e.evidence,e.estimate_id,
        COALESCE(${classification},''),COALESCE(${runtimeClassification},''),
        SUM(e.byte_length),SUM(e.token_count),COUNT(*),COUNT(e.token_count),MAX(e.position),''
      FROM agent_usage_contexts c JOIN agent_usage_exposures e ON e.context_id=c.context_id
      ${ResultFirstUseIndex.join.replace("f.runtime_scope=?","f.runtime_scope=''")}
      ${ResultFirstUseIndex.join.replace(/\bf\b/g,"fr").replace("fr.runtime_scope=?","fr.runtime_scope=json_quote(c.runtime_kind)")}
      WHERE c.context_id=? GROUP BY e.context_id,e.capability_key,e.block_kind,e.evidence,e.estimate_id,
        COALESCE(${classification},''),COALESCE(${runtimeClassification},'')`).run(contextId);
    this.db.prepare("UPDATE agent_usage_contexts SET ranking_inputs_ready=1 WHERE context_id=?").run(contextId);
  }

  backfill(limit: number): boolean {
    const rows = this.db.prepare(`SELECT context_id FROM agent_usage_contexts WHERE ranking_inputs_ready=0
      ORDER BY occurred_at DESC,context_id LIMIT ?`).all(limit+1) as Array<{ context_id: string }>;
    this.db.transaction(() => { for (const row of rows.slice(0,limit)) this.refresh(row.context_id); })();
    return rows.length>limit;
  }

  compactMetadata(limit: number): number {
    return this.db.transaction(() => {
      const cursor = this.db.prepare("SELECT last_rowid FROM agent_usage_storage_cursors WHERE name='ranking-input-metadata'").get() as { last_rowid: number } | undefined;
      const target = (this.db.prepare("SELECT last_legacy_rowid FROM agent_usage_storage_limits WHERE name='ranking-input-metadata'").get() as { last_legacy_rowid: number }).last_legacy_rowid;
      const rows = this.db.prepare(`SELECT rowid,capability_json!='' AS redundant FROM agent_usage_context_inputs
        WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT ?`).all(cursor?.last_rowid ?? 0,target,limit) as Array<{ rowid: number; redundant: number }>;
      const lastRowid = rows.at(-1)?.rowid ?? target;
      if (lastRowid === (cursor?.last_rowid ?? 0)) return 0;
      const redundant = rows.filter(row => row.redundant).map(row => row.rowid);
      this.db.prepare("UPDATE agent_usage_context_inputs SET capability_json='' WHERE rowid IN (SELECT value FROM json_each(?))")
        .run(JSON.stringify(redundant));
      this.db.prepare(`INSERT INTO agent_usage_storage_cursors VALUES('ranking-input-metadata',?)
        ON CONFLICT(name) DO UPDATE SET last_rowid=excluded.last_rowid`).run(lastRowid);
      return redundant.length;
    })();
  }

  metadataCompactionPending(): boolean {
    const cursor = this.db.prepare("SELECT last_rowid FROM agent_usage_storage_cursors WHERE name='ranking-input-metadata'").get() as { last_rowid: number } | undefined;
    const target = this.db.prepare("SELECT last_legacy_rowid FROM agent_usage_storage_limits WHERE name='ranking-input-metadata'").get() as { last_legacy_rowid: number };
    return (cursor?.last_rowid ?? 0)<target.last_legacy_rowid;
  }
}
