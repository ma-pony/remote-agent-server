import type Database from "better-sqlite3";
import type { DailyRankingStore } from "./storage/daily-rankings.js";

type SkipReason = "session_busy" | "not_expired" | "source_active" | "backfill_incomplete" | "projection_pending" | "already_retired";
type StepResult = { reason: SkipReason } | { action: "archived" | "retired"; rows: number; completed?: boolean };
const BATCH_ROWS = 250;

/** Retire only closed storage: live Sessions keep their complete attribution history. */
export class UsageDetailRetention {
  private nextSessionId = 0;
  private nextSweepAt = 0;
  private checkedSessions = 0;
  private retiredSessions = 0;
  private retiredRows = 0;
  private lastSessionId: number | null = null;
  private lastAction: "idle" | "scanned" | "archived" | "retired" | "failed" = "idle";
  private lastStepAt: string | null = null;
  private lastStepMs: number | null = null;
  private lastErrorAt: string | null = null;
  private readonly skippedByReason: Partial<Record<SkipReason,number>> = {};

  constructor(private readonly db: Database.Database, private readonly namespace: string,
    private readonly daily: DailyRankingStore, private readonly retentionMs = 7 * 86_400_000) {}

  status() {
    return { enabled: this.retentionMs > 0, retentionDays: this.retentionMs / 86_400_000,
      checkedSessions: this.checkedSessions, retiredSessions: this.retiredSessions, retiredRows: this.retiredRows,
      lastSessionId: this.lastSessionId, lastAction: this.lastAction, lastStepAt: this.lastStepAt,
      lastStepMs: this.lastStepMs, lastErrorAt: this.lastErrorAt, skippedByReason: { ...this.skippedByReason },
      nextSweepAt: this.nextSweepAt ? new Date(this.nextSweepAt).toISOString() : null };
  }

  step(now = Date.now()): "idle" | "scanned" | "archived" | "retired" {
    if (this.retentionMs === 0 || now < this.nextSweepAt) return "idle";
    const started = performance.now();
    try {
      const pending = this.db.prepare(`SELECT a.session_id FROM agent_usage_detail_archives a
        JOIN sessions s ON s.id=CAST(a.session_id AS INTEGER)
        WHERE a.namespace=? AND a.completed_at IS NULL AND s.storage_cleaned_at IS NOT NULL
          AND s.status='idle' AND s.pending_operation IS NULL
          AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.session_id=s.id AND r.status IN ('queued','running'))
        ORDER BY a.archived_at LIMIT 1`).get(this.namespace) as { session_id: string } | undefined;
      const candidate = pending ? { id: Number(pending.session_id) } : this.db.prepare(`SELECT id FROM sessions
        WHERE id>=? AND storage_cleaned_at IS NOT NULL ORDER BY id LIMIT 1`).get(this.nextSessionId) as { id: number } | undefined;
      if (!candidate) {
        this.nextSessionId = 0; this.nextSweepAt = now + 5 * 60_000; this.lastAction = "idle";
        return "idle";
      }
      const sessionId = String(candidate.id), timestamp = new Date(now).toISOString();
      const result = this.db.transaction((): StepResult => {
        const session = this.db.prepare(`SELECT agent_id,storage_cleaned_at,status,pending_operation FROM sessions WHERE id=?`)
          .get(candidate.id) as { agent_id: number; storage_cleaned_at: string | null; status: string; pending_operation: string | null } | undefined;
        if (!session || !session.storage_cleaned_at || session.status !== "idle" || session.pending_operation !== null
          || this.db.prepare("SELECT 1 FROM runs WHERE session_id=? AND status IN ('queued','running') LIMIT 1").get(candidate.id))
          return { reason: "session_busy" as const };
        const archive = this.db.prepare("SELECT completed_at FROM agent_usage_detail_archives WHERE namespace=? AND session_id=?")
          .get(this.namespace,sessionId) as { completed_at: string | null } | undefined;
        if (archive?.completed_at) return { reason: "already_retired" as const };
        if (!archive) {
          const cutoff = new Date(now-this.retentionMs).toISOString();
          if (!this.db.prepare("SELECT 1 FROM runs WHERE session_id=? LIMIT 1").get(candidate.id)
            || this.db.prepare("SELECT 1 FROM runs WHERE session_id=? AND (finished_at IS NULL OR finished_at>?) LIMIT 1").get(candidate.id,cutoff))
            return { reason: "not_expired" as const };
          for (const table of ["agent_usage_contexts","agent_usage_conversation_content"]) {
            if (this.db.prepare(`SELECT 1 FROM ${table} WHERE namespace=? AND session_id=? AND occurred_at>? LIMIT 1`)
              .get(this.namespace,sessionId,cutoff)) return { reason: "not_expired" };
          }
          if (this.db.prepare(`SELECT 1 FROM agent_usage_source_mappings m LEFT JOIN agent_usage_sources s ON s.id=m.source_id
            WHERE m.namespace=? AND m.session_id=? AND (m.state='active' OR s.status='collecting') LIMIT 1`).get(this.namespace,sessionId))
            return { reason: "source_active" as const };
          if (this.db.prepare(`SELECT 1 FROM runs r LEFT JOIN agent_usage_runtime_backfills b ON b.namespace=? AND b.run_id=r.id
            WHERE r.session_id=? AND r.events_pruned_through_seq=0
              AND (b.run_id IS NULL OR b.status!='completed' OR b.error_code IS NOT NULL
                OR EXISTS (SELECT 1 FROM events e WHERE e.run_id=r.id AND e.seq>b.last_seq AND e.type IN ('message','tool')))
            LIMIT 1`).get(this.namespace,candidate.id)
            || this.db.prepare(`SELECT 1 FROM agent_usage_conversation_content WHERE namespace=? AND session_id=? AND tokens IS NULL LIMIT 1`).get(this.namespace,sessionId))
            return { reason: "backfill_incomplete" as const };
          if (!this.daily.archiveSession(this.namespace,String(session.agent_id),sessionId,timestamp))
            return { reason: "projection_pending" as const };
          return { action: "archived" as const, rows: 0 };
        }
        // Always start at the remaining primary keys: the durable marker plus committed deletes
        // is the resume cursor, and does not depend on implicit rowid stability across VACUUM.
        for (const table of ["agent_usage_exposures","agent_usage_context_inputs"] as const) {
          const rows = this.db.prepare(`DELETE FROM ${table} WHERE rowid IN (
            SELECT e.rowid FROM agent_usage_contexts c JOIN ${table} e ON e.context_id=c.context_id
            WHERE c.namespace=? AND c.session_id=? LIMIT ${BATCH_ROWS})`).run(this.namespace,sessionId).changes;
          if (rows) return { action: "retired" as const, rows };
        }
        const rows = this.db.prepare(`DELETE FROM agent_usage_conversation_content WHERE rowid IN (
          SELECT rowid FROM agent_usage_conversation_content WHERE namespace=? AND session_id=? LIMIT ${BATCH_ROWS})`)
          .run(this.namespace,sessionId).changes;
        if (rows) return { action: "retired" as const, rows };
        this.db.prepare("UPDATE agent_usage_detail_archives SET completed_at=? WHERE namespace=? AND session_id=?")
          .run(timestamp,this.namespace,sessionId);
        return { action: "retired" as const, rows: 0, completed: true };
      })();
      this.checkedSessions++; this.lastSessionId = candidate.id;
      if ("reason" in result) {
        this.skippedByReason[result.reason] = (this.skippedByReason[result.reason] ?? 0)+1;
        this.lastAction = "scanned";
      } else {
        this.lastAction = result.action; this.retiredRows += result.rows;
        if (result.completed) this.retiredSessions++;
      }
      this.nextSessionId = candidate.id + 1;
      return this.lastAction;
    } catch (error) {
      this.lastAction = "failed"; this.lastErrorAt = new Date(now).toISOString(); throw error;
    } finally {
      this.lastStepAt = new Date(now).toISOString(); this.lastStepMs = Math.round((performance.now()-started)*1000)/1000;
    }
  }
}
