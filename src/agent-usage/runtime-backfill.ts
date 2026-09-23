import type Database from "better-sqlite3";
import { setImmediate } from "node:timers/promises";
import type { UsageFilter } from "./core/types.js";
import { UsageError } from "./core/errors.js";
import type { PreparedRuntimeContent } from "./runtime-content.js";

export type RuntimeBackfillStatus = { status: "pending" | "running" | "completed" | "failed"; processedEvents: number; errorCode: string | null };
type EventMetadata = { id: number; seq: number; type: string; bytes: number; created_at: string };
const BATCH_EVENTS = 100;
const BATCH_BYTES = 4 * 1024 * 1024;
const MAX_EVENT_BYTES = 16 * 1024 * 1024;
const BATCH_WORK_MS = 25;

/** Historical replay owns only progress and sanitized failures, never a second copy of event content. */
export class RuntimeContentBackfill {
  constructor(private readonly db: Database.Database, private readonly namespace: string,
    private readonly consume: (runId: number, content: Record<string, unknown>, event: { eventId: number; sequence: number; occurredAt: string }, signal?: AbortSignal) => PreparedRuntimeContent | void | Promise<PreparedRuntimeContent | void>,
    private readonly conversation?: {
      prepareRun(runId: number, signal?: AbortSignal): Promise<PreparedRuntimeContent | undefined>;
      prepareMessage(runId: number, content: Record<string, unknown>, event: { sequence: number; occurredAt: string }, signal?: AbortSignal): Promise<PreparedRuntimeContent | undefined>;
    }, private readonly knownModels: string[] = []) {
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
    if (!columns.some(({ name }) => name === "retry_after")) db.exec("ALTER TABLE agent_usage_runtime_backfills ADD COLUMN retry_after INTEGER NOT NULL DEFAULT 0");
    if (!columns.some(({ name }) => name === "tokenizer_model")) db.exec("ALTER TABLE agent_usage_runtime_backfills ADD COLUMN tokenizer_model TEXT");
    // Tool-only checkpoints predate conversation content. Replay them once; both sinks are idempotent.
    if (conversation) db.prepare(`UPDATE agent_usage_runtime_backfills SET content_version=2,
      last_seq=0,processed_events=0,status='pending',error_code=NULL WHERE namespace=? AND content_version<2`).run(namespace);
    // Replay retained content once for models that now have a vocabulary. Other history is untouched.
    if (knownModels.length) db.prepare(`UPDATE agent_usage_runtime_backfills SET content_version=3,
      last_seq=0,processed_events=0,status='pending',error_code=NULL,retry_after=0,
      tokenizer_model=(SELECT resolved_model FROM runs WHERE id=agent_usage_runtime_backfills.run_id)
      WHERE namespace=? AND tokenizer_model IS NULL AND run_id IN (
        SELECT id FROM runs WHERE events_pruned_through_seq=0 AND resolved_model IN (SELECT value FROM json_each(?)))`).run(namespace, JSON.stringify(knownModels));
  }

  async step(signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const scope = this.scope();
    // Only business metadata is discovered here. Active Runs remain eligible when they later finish.
    this.db.prepare(`INSERT INTO agent_usage_runtime_backfills (namespace, run_id, session_id, content_version, tokenizer_model)
      SELECT ?, r.id, CAST(s.id AS TEXT), ${this.conversation ? 3 : 1},
      CASE WHEN r.resolved_model IN (SELECT value FROM json_each(?)) THEN r.resolved_model ELSE NULL END ${scope.sql} AND j.run_id IS NULL
      ORDER BY r.id DESC LIMIT ${BATCH_EVENTS} ON CONFLICT(namespace, run_id) DO NOTHING`)
      .run(this.namespace, JSON.stringify(this.knownModels), ...scope.params);
    const job = this.db.prepare(`SELECT j.run_id, j.last_seq, j.error_code ${scope.sql}
      AND j.status IN ('pending', 'running') AND j.retry_after<=? ORDER BY r.id DESC LIMIT 1`).get(...scope.params, Date.now()) as {
        run_id: number; last_seq: number; error_code: string | null
      } | undefined;
    if (!job) return false;
    const deadline = performance.now() + BATCH_WORK_MS;
    let errorCode = job.error_code === "usage_tokenizer_pending" ? null : job.error_code;
    let prompt: PreparedRuntimeContent | undefined, pending = false;
    try { prompt = await this.conversation?.prepareRun(job.run_id, signal); pending = prompt?.pending ?? false; }
    catch (error) {
      signal?.throwIfAborted();
      if (error instanceof UsageError && error.code === "usage_tokenizer_pending") pending = true;
      else errorCode ??= "usage_runtime_prompt_failed";
    }
    const batch: Array<{ sequence: number; counted: boolean; prepared?: PreparedRuntimeContent; error?: string; pending?: boolean }> = [];
    const events = pending ? [] : this.db.prepare(`SELECT id, seq, type, created_at,
      CASE WHEN type = 'tool' ${this.conversation ? "OR type = 'message'" : ""} THEN octet_length(content_json) ELSE 0 END AS bytes
      FROM events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ${BATCH_EVENTS}`)
      .all(job.run_id, job.last_seq) as EventMetadata[];
    let bytes = 0;
    for (const event of events) {
      signal?.throwIfAborted();
      if (batch.length && (performance.now() >= deadline || bytes + event.bytes > BATCH_BYTES)) break;
      if (event.type !== "tool" && !(this.conversation && event.type === "message")) {
        batch.push({ sequence: event.seq, counted: false }); continue;
      }
      if (event.bytes > MAX_EVENT_BYTES) {
        batch.push({ sequence: event.seq, counted: false, error: "usage_runtime_event_too_large" }); continue;
      }
      bytes += event.bytes;
      let failure = "usage_runtime_backfill_failed";
      try {
        const row = this.db.prepare(`SELECT CASE WHEN octet_length(content_json) <= ? THEN content_json END AS content
          FROM events WHERE id = ? AND run_id = ?`).get(MAX_EVENT_BYTES, event.id, job.run_id) as { content: string | null } | undefined;
        if (!row || row.content === null) {
          failure = row ? "usage_runtime_event_too_large" : "usage_runtime_event_missing";
          throw new Error(failure);
        }
        failure = "usage_runtime_event_malformed";
        const content: unknown = JSON.parse(row.content);
        if (content === null || typeof content !== "object" || Array.isArray(content)) throw new Error(failure);
        failure = "usage_runtime_backfill_failed";
        const evidence = { eventId: event.id, sequence: event.seq, occurredAt: event.created_at };
        const prepared = (event.type === "message"
          ? await this.conversation?.prepareMessage(job.run_id, content as Record<string, unknown>, evidence, signal)
          : await this.consume(job.run_id, content as Record<string, unknown>, evidence, signal)) || undefined;
        batch.push({ sequence: event.seq, counted: true, prepared, pending: prepared?.pending });
        if (prepared?.pending) break;
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof UsageError && error.code === "usage_tokenizer_pending") {
          batch.push({ sequence: event.seq, counted: false, pending: true }); break;
        }
        batch.push({ sequence: event.seq, counted: false, error: failure });
      }
    }
    signal?.throwIfAborted();
    // Commit projections and their cursor together. No tokenization or other await holds the lock.
    this.db.transaction(() => {
      let sequence = job.last_seq, processed = 0;
      try { prompt?.commit(); } catch { errorCode ??= "usage_runtime_prompt_failed"; }
      for (const item of batch) {
        let counted = item.counted;
        try { item.prepared?.commit(); }
        catch { errorCode ??= "usage_runtime_backfill_failed"; counted = false; }
        errorCode ??= item.error ?? null;
        if (item.pending) { pending = true; break; }
        sequence = item.sequence;
        processed += Number(counted);
      }
      if (pending) errorCode ??= "usage_tokenizer_pending";
      const remaining = this.db.prepare("SELECT 1 FROM events WHERE run_id = ? AND seq > ? LIMIT 1").get(job.run_id, sequence);
      const status = pending ? "pending" : remaining ? "running" : errorCode ? "failed" : "completed";
      this.db.prepare(`UPDATE agent_usage_runtime_backfills SET last_seq = ?, processed_events = processed_events + ?,
        status=?,error_code=?,retry_after=? WHERE namespace=? AND run_id=?`)
        .run(sequence, processed, status, errorCode, pending ? Date.now() + 60_000 : 0, this.namespace, job.run_id);
    })();
    await setImmediate(undefined, { signal });
    return pending || this.db.prepare(`SELECT 1 ${scope.sql} AND (j.run_id IS NULL OR (j.status IN ('pending', 'running') AND j.retry_after<=?)) LIMIT 1`)
      .get(...scope.params, Date.now()) !== undefined;
  }

  /** A live Run can request deferred counting without waiting for network downloads. */
  schedule(runId: number, errorCode: "usage_tokenizer_pending" | null = "usage_tokenizer_pending"): void {
    this.db.prepare(`INSERT INTO agent_usage_runtime_backfills
      (namespace,run_id,session_id,content_version,status,error_code,retry_after,tokenizer_model)
      SELECT ?,id,CAST(session_id AS TEXT),3,'pending',?,?,
        CASE WHEN resolved_model IN (SELECT value FROM json_each(?)) THEN resolved_model ELSE NULL END FROM runs WHERE id=?
      ON CONFLICT(namespace,run_id) DO UPDATE SET status='pending',
        error_code=COALESCE(agent_usage_runtime_backfills.error_code,excluded.error_code),
        retry_after=MIN(agent_usage_runtime_backfills.retry_after,excluded.retry_after)`)
      .run(this.namespace, errorCode, Date.now() + 1000, JSON.stringify(this.knownModels), runId);
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

  private scope(filter: UsageFilter = {}): { sql: string; params: string[] } {
    const params = [this.namespace, this.namespace, this.namespace];
    const conditions = ["(r.status NOT IN ('queued', 'running') OR (r.status='running' AND j.run_id IS NOT NULL))", `NOT EXISTS (SELECT 1 FROM agent_usage_subjects u
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
