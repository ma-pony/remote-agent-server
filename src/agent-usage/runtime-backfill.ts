import type Database from "better-sqlite3";
import { setImmediate } from "node:timers/promises";
import type { UsageFilter } from "./core/types.js";

export type RuntimeBackfillStatus = { status: "pending" | "running" | "completed" | "failed"; processedEvents: number; errorCode: string | null };
type EventMetadata = { id: number; seq: number; type: string; bytes: number; created_at: string };
const BATCH_EVENTS = 100;
const BATCH_BYTES = 4 * 1024 * 1024;
const MAX_EVENT_BYTES = 16 * 1024 * 1024;

/** Historical replay owns only progress and sanitized failures, never a second copy of event content. */
export class RuntimeContentBackfill {
  constructor(private readonly db: Database.Database, private readonly namespace: string,
    private readonly consume: (runId: number, content: Record<string, unknown>, event: { eventId: number; sequence: number; occurredAt: string }) => void,
    private readonly conversation?: {
      recordRun(runId: number): void;
      recordMessage(runId: number, content: Record<string, unknown>, event: { sequence: number; occurredAt: string }): void;
    }) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_usage_runtime_backfills (
      namespace TEXT NOT NULL, run_id INTEGER NOT NULL, session_id TEXT NOT NULL,
      last_seq INTEGER NOT NULL DEFAULT 0, processed_events INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending', error_code TEXT,
      PRIMARY KEY(namespace, run_id)
    );
    CREATE INDEX IF NOT EXISTS agent_usage_runtime_backfills_session
      ON agent_usage_runtime_backfills(namespace, session_id);
    CREATE TABLE IF NOT EXISTS agent_usage_runtime_backfill_deleted_sessions (
      namespace TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(namespace, session_id)
    )`);
    const columns = db.prepare("PRAGMA table_info(agent_usage_runtime_backfills)").all() as Array<{ name: string }>;
    if (!columns.some(({ name }) => name === "content_version")) db.exec("ALTER TABLE agent_usage_runtime_backfills ADD COLUMN content_version INTEGER NOT NULL DEFAULT 1");
    // Tool-only checkpoints predate conversation content. Replay them once; both sinks are idempotent.
    if (conversation) db.prepare(`UPDATE agent_usage_runtime_backfills SET content_version=2,
      last_seq=0,processed_events=0,status='pending',error_code=NULL WHERE namespace=? AND content_version<2`).run(namespace);
  }

  async step(): Promise<boolean> {
    const scope = this.scope();
    // Only business metadata is discovered here. Active Runs remain eligible when they later finish.
    this.db.prepare(`INSERT INTO agent_usage_runtime_backfills (namespace, run_id, session_id, content_version)
      SELECT ?, r.id, CAST(s.id AS TEXT), ${this.conversation ? 2 : 1} ${scope.sql} AND j.run_id IS NULL
      ORDER BY r.id DESC LIMIT ${BATCH_EVENTS} ON CONFLICT(namespace, run_id) DO NOTHING`)
      .run(this.namespace, ...scope.params);
    const job = this.db.prepare(`SELECT j.run_id, j.last_seq ${scope.sql}
      AND j.status IN ('pending', 'running') ORDER BY r.id DESC LIMIT 1`).get(...scope.params) as { run_id: number; last_seq: number } | undefined;
    if (!job) return false;
    this.db.prepare("UPDATE agent_usage_runtime_backfills SET status = 'running' WHERE namespace = ? AND run_id = ?")
      .run(this.namespace, job.run_id);
    try { this.conversation?.recordRun(job.run_id); }
    catch { this.progress(job.run_id, job.last_seq, 0, "usage_runtime_prompt_failed"); }
    // Bound traversal as well as replay: a Run containing many message events still yields promptly.
    const events = this.db.prepare(`SELECT id, seq, type, created_at,
      CASE WHEN type = 'tool' ${this.conversation ? "OR type = 'message'" : ""} THEN octet_length(content_json) ELSE 0 END AS bytes
      FROM events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ${BATCH_EVENTS}`)
      .all(job.run_id, job.last_seq) as EventMetadata[];
    let bytes = 0, lastSequence = job.last_seq;
    for (const event of events) {
      if (event.type !== "tool" && !(this.conversation && event.type === "message")) {
        lastSequence = event.seq; continue;
      }
      if (event.bytes > MAX_EVENT_BYTES) {
        this.progress(job.run_id, event.seq, 0, "usage_runtime_event_too_large"); lastSequence = event.seq; continue;
      }
      if (bytes > 0 && bytes + event.bytes > BATCH_BYTES) break;
      bytes += event.bytes;
      let errorCode = "usage_runtime_backfill_failed";
      try {
        this.db.transaction(() => {
          const row = this.db.prepare(`SELECT CASE WHEN octet_length(content_json) <= ? THEN content_json END AS content
            FROM events WHERE id = ? AND run_id = ?`).get(MAX_EVENT_BYTES, event.id, job.run_id) as { content: string | null } | undefined;
          if (!row || row.content === null) {
            errorCode = row ? "usage_runtime_event_too_large" : "usage_runtime_event_missing";
            throw new Error(errorCode);
          }
          errorCode = "usage_runtime_event_malformed";
          const content: unknown = JSON.parse(row.content);
          if (content === null || typeof content !== "object" || Array.isArray(content)) throw new Error(errorCode);
          errorCode = "usage_runtime_backfill_failed";
          const evidence = { eventId: event.id, sequence: event.seq, occurredAt: event.created_at };
          if (event.type === "message") this.conversation?.recordMessage(job.run_id, content as Record<string, unknown>, evidence);
          else this.consume(job.run_id, content as Record<string, unknown>, evidence);
          this.progress(job.run_id, event.seq, 1);
        })();
      } catch {
        // The failed record's writes rolled back. Keep a sanitized gap and continue subsequent records.
        this.progress(job.run_id, event.seq, 0, errorCode);
      }
      lastSequence = event.seq;
    }
    // Message events need only one durable cursor advance per batch.
    if (lastSequence !== job.last_seq) this.progress(job.run_id, lastSequence, 0);
    const remaining = this.db.prepare("SELECT 1 FROM events WHERE run_id = ? AND seq > ? LIMIT 1").get(job.run_id, lastSequence);
    if (!remaining) this.db.prepare(`UPDATE agent_usage_runtime_backfills
      SET status = CASE WHEN error_code IS NULL THEN 'completed' ELSE 'failed' END WHERE namespace = ? AND run_id = ?`)
      .run(this.namespace, job.run_id);
    await setImmediate();
    return this.db.prepare(`SELECT 1 ${scope.sql} AND (j.run_id IS NULL OR j.status IN ('pending', 'running')) LIMIT 1`)
      .get(...scope.params) !== undefined;
  }

  status(filter: UsageFilter = {}): RuntimeBackfillStatus {
    if (filter.namespace !== undefined && filter.namespace !== this.namespace) return { status: "completed", processedEvents: 0, errorCode: null };
    const scope = this.scope(filter);
    const row = this.db.prepare(`SELECT COALESCE(SUM(j.processed_events), 0) AS processed,
      SUM(CASE WHEN j.run_id IS NULL OR j.status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN j.status = 'running' THEN 1 ELSE 0 END) AS running, MIN(j.error_code) AS error
      ${scope.sql}`).get(...scope.params) as { processed: number; pending: number | null; running: number | null; error: string | null };
    return { status: row.running ? "running" : row.pending ? "pending" : row.error ? "failed" : "completed",
      processedEvents: row.processed, errorCode: row.error };
  }

  deleteSession(sessionId: string): void {
    this.db.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO agent_usage_runtime_backfill_deleted_sessions VALUES (?, ?)").run(this.namespace, sessionId);
      this.db.prepare("DELETE FROM agent_usage_runtime_backfills WHERE namespace = ? AND session_id = ?").run(this.namespace, sessionId);
    })();
  }

  private progress(runId: number, sequence: number, processed: number, error: string | null = null): void {
    this.db.prepare(`UPDATE agent_usage_runtime_backfills SET last_seq = ?, processed_events = processed_events + ?,
      error_code = COALESCE(error_code, ?) WHERE namespace = ? AND run_id = ?`).run(sequence, processed, error, this.namespace, runId);
  }

  private scope(filter: UsageFilter = {}): { sql: string; params: string[] } {
    const params = [this.namespace, this.namespace, this.namespace];
    const conditions = ["r.status NOT IN ('queued', 'running')", `NOT EXISTS (SELECT 1 FROM agent_usage_subjects u
      WHERE u.namespace = ? AND u.state != 'active' AND ((u.kind = 'session' AND u.subject_id = CAST(s.id AS TEXT))
        OR (u.kind = 'agent' AND u.subject_id = CAST(a.id AS TEXT))))`,
    `NOT EXISTS (SELECT 1 FROM agent_usage_runtime_backfill_deleted_sessions d WHERE d.namespace = ? AND d.session_id = CAST(s.id AS TEXT))`];
    for (const [field, column] of [["sessionId", "s.id"], ["agentId", "a.id"], ["runtimeKind", "a.provider"]] as const) {
      if (filter[field] !== undefined) { conditions.push(`${column} = ?`); params.push(filter[field]); }
    }
    // A Run may overlap the requested window even when it started before that window.
    if (filter.from !== undefined) { conditions.push("COALESCE(r.finished_at, r.created_at) >= ?"); params.push(new Date(filter.from).toISOString()); }
    if (filter.to !== undefined) { conditions.push("COALESCE(r.started_at, r.created_at) <= ?"); params.push(new Date(filter.to).toISOString()); }
    return { sql: `FROM runs r JOIN sessions s ON s.id = r.session_id JOIN agents a ON a.id = s.agent_id
      LEFT JOIN agent_usage_runtime_backfills j ON j.namespace = ? AND j.run_id = r.id WHERE ${conditions.join(" AND ")}`, params };
  }
}
