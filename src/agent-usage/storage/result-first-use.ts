import type Database from "better-sqlite3";

type FirstUseKey = { namespace: string; session_id: string; provider_epoch_id: string;
  runtime_scope: string; capability_key: string; content_key: string };
const columns = "namespace, session_id, provider_epoch_id, runtime_scope, capability_key, content_key";
const conflict = `ON CONFLICT(${columns}) DO UPDATE SET
  context_id=excluded.context_id, position=excluded.position, time_missing=excluded.time_missing, time_key=excluded.time_key
  WHERE (excluded.time_missing, excluded.time_key, excluded.context_id, excluded.position)
    < (time_missing, time_key, context_id, position)`;

/** Small, rebuildable index of lifetime first results; no payloads and no historical totals. */
export class ResultFirstUseIndex {
  constructor(private readonly db: Database.Database) {
    if (db.readonly) return;
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_usage_result_first'").get();
    db.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS agent_usage_result_first (
        namespace TEXT NOT NULL, session_id TEXT NOT NULL, provider_epoch_id TEXT NOT NULL,
        runtime_scope TEXT NOT NULL, capability_key TEXT NOT NULL, content_key TEXT NOT NULL,
        context_id TEXT NOT NULL, position INTEGER NOT NULL, time_missing INTEGER NOT NULL, time_key TEXT NOT NULL,
        PRIMARY KEY (${columns})
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS agent_usage_result_first_context ON agent_usage_result_first(context_id);
      CREATE INDEX IF NOT EXISTS agent_usage_exposures_content
        ON agent_usage_exposures(content_key, capability_key, block_kind, context_id);
      CREATE INDEX IF NOT EXISTS agent_usage_contexts_latest ON agent_usage_contexts(namespace, occurred_at IS NULL DESC, occurred_at DESC, context_id DESC);
      CREATE INDEX IF NOT EXISTS agent_usage_contexts_session_latest ON agent_usage_contexts(namespace, session_id, occurred_at IS NULL DESC, occurred_at DESC, context_id DESC);
      CREATE INDEX IF NOT EXISTS agent_usage_contexts_time ON agent_usage_contexts(namespace, occurred_at);
      CREATE INDEX IF NOT EXISTS agent_usage_contexts_session_time ON agent_usage_contexts(namespace, session_id, occurred_at);
      CREATE INDEX IF NOT EXISTS agent_usage_invocations_time ON agent_usage_invocations(namespace, started_at);
      CREATE INDEX IF NOT EXISTS agent_usage_invocations_session_time ON agent_usage_invocations(namespace, session_id, started_at);`);
      if (!exists) {
        // One migration pass. Subsequent opens never rescan old exposures.
        db.exec(`INSERT INTO agent_usage_result_first
          SELECT ${columns}, context_id, position, time_missing, time_key FROM (
            SELECT c.namespace, c.session_id, c.provider_epoch_id,
              CASE WHEN scopes.specific=0 THEN '' ELSE json_quote(c.runtime_kind) END AS runtime_scope,
              e.capability_key, e.content_key, c.context_id, e.position,
              c.occurred_at IS NULL AS time_missing, COALESCE(c.occurred_at, '') AS time_key,
              ROW_NUMBER() OVER (PARTITION BY c.namespace, c.session_id, c.provider_epoch_id,
                CASE WHEN scopes.specific=0 THEN '' ELSE json_quote(c.runtime_kind) END, e.capability_key, e.content_key
                ORDER BY c.occurred_at IS NULL, c.occurred_at, c.context_id, e.position) AS ordinal
            FROM agent_usage_contexts c JOIN agent_usage_exposures e USING(context_id)
            CROSS JOIN (SELECT 0 AS specific UNION ALL SELECT 1) scopes WHERE e.block_kind='result'
          ) WHERE ordinal=1`);
      }
    })();
  }

  /** Runs in the context upsert transaction, including when an old first result was removed. */
  refresh(contextId: string): void {
    const previous = this.db.prepare(`SELECT ${columns} FROM agent_usage_result_first WHERE context_id=?`)
      .all(contextId) as FirstUseKey[];
    const remove = this.db.prepare(`DELETE FROM agent_usage_result_first WHERE namespace=? AND session_id=?
      AND provider_epoch_id=? AND runtime_scope=? AND capability_key=? AND content_key=?`);
    for (const key of previous) {
      remove.run(key.namespace, key.session_id, key.provider_epoch_id, key.runtime_scope, key.capability_key, key.content_key);
      this.db.prepare(`INSERT INTO agent_usage_result_first
        SELECT c.namespace, c.session_id, c.provider_epoch_id, ?, e.capability_key, e.content_key,
          c.context_id, e.position, c.occurred_at IS NULL, COALESCE(c.occurred_at, '')
        FROM agent_usage_exposures e JOIN agent_usage_contexts c USING(context_id)
        WHERE c.namespace=? AND c.session_id=? AND c.provider_epoch_id=?
          AND (?='' OR json_quote(c.runtime_kind)=?) AND e.capability_key=? AND e.content_key=? AND e.block_kind='result'
        ORDER BY c.occurred_at IS NULL, c.occurred_at, c.context_id, e.position LIMIT 1`)
        .run(key.runtime_scope, key.namespace, key.session_id, key.provider_epoch_id,
          key.runtime_scope, key.runtime_scope, key.capability_key, key.content_key);
    }
    this.db.prepare(`INSERT INTO agent_usage_result_first
      SELECT c.namespace, c.session_id, c.provider_epoch_id,
        CASE WHEN scopes.specific=0 THEN '' ELSE json_quote(c.runtime_kind) END,
        e.capability_key, e.content_key, c.context_id, e.position, c.occurred_at IS NULL, COALESCE(c.occurred_at, '')
      FROM agent_usage_contexts c JOIN agent_usage_exposures e USING(context_id)
      CROSS JOIN (SELECT 0 AS specific UNION ALL SELECT 1) scopes
      WHERE c.context_id=? AND e.block_kind='result' ${conflict}`).run(contextId);
  }

  static join = `LEFT JOIN agent_usage_result_first f ON e.block_kind='result' AND f.namespace=c.namespace
    AND f.session_id=c.session_id AND f.provider_epoch_id=c.provider_epoch_id
    AND f.capability_key=e.capability_key AND f.content_key=e.content_key AND f.runtime_scope=?`;
  static classification = `CASE WHEN e.block_kind!='result' THEN NULL
    WHEN f.context_id=e.context_id AND f.position=e.position THEN CASE WHEN c.history_complete=1 THEN 'first' ELSE 'unknown' END
    WHEN f.context_id IS NOT NULL THEN 'repeat' ELSE 'unknown' END`;
}
