import type Database from "better-sqlite3";
import type { RuntimeConversationCollector } from "./runtime-conversation.js";

type SkipReason = "run_not_expired" | "session_busy" | "no_raw_events";
type RetentionAction = "idle" | "scanned" | "retired" | "failed";

/** Retires expired replay bodies independently of usage collection and counting. */
export class RuntimeEventRetention {
  // Recheck a Run while it has more raw events; otherwise advance one Run per step.
  private nextRunId = 0;
  private nextSweepAt = 0;
  private checkedRuns = 0;
  private retiredEvents = 0;
  private skippedByReason: Partial<Record<SkipReason, number>> = {};
  private lastAction: RetentionAction = "idle";
  private lastRunId: number | null = null;
  private lastStepAt: string | null = null;
  private lastStepMs: number | null = null;
  private lastRetiredAt: string | null = null;
  private lastErrorAt: string | null = null;

  constructor(private readonly db: Database.Database, private readonly namespace: string,
    private readonly conversation: RuntimeConversationCollector, private readonly retentionMs: number) {}

  status() {
    return { enabled: this.retentionMs > 0, lastAction: this.lastAction, lastRunId: this.lastRunId,
      checkedRuns: this.checkedRuns, retiredEvents: this.retiredEvents, skippedByReason: { ...this.skippedByReason },
      lastStepAt: this.lastStepAt, lastStepMs: this.lastStepMs, lastRetiredAt: this.lastRetiredAt,
      lastErrorAt: this.lastErrorAt, nextSweepAt: this.nextSweepAt ? new Date(this.nextSweepAt).toISOString() : null };
  }

  step(now = Date.now()): "idle" | "scanned" | "retired" {
    if (this.retentionMs === 0 || now < this.nextSweepAt) return "idle";
    const started = performance.now();
    try {
      const run = this.db.prepare("SELECT id FROM runs WHERE id>=? ORDER BY id LIMIT 1")
        .get(this.nextRunId) as { id: number } | undefined;
      if (!run) {
        this.nextRunId = 0;
        this.nextSweepAt = now + 5 * 60_000;
        this.lastAction = "idle";
        return "idle";
      }
      const result = this.db.transaction(() => {
        const job = this.db.prepare(`SELECT r.id,r.events_pruned_through_seq,
          CASE
            WHEN r.status IN ('queued','running') OR r.finished_at IS NULL OR r.finished_at>=? THEN 'run_not_expired'
            WHEN s.status!='idle' OR s.pending_operation IS NOT NULL OR EXISTS (
              SELECT 1 FROM runs active WHERE active.session_id=s.id AND active.status IN ('queued','running'))
              THEN 'session_busy'
            WHEN EXISTS (SELECT 1 FROM events e WHERE e.run_id=r.id AND e.seq>r.events_pruned_through_seq
              AND e.type IN ('message','tool')) THEN 'ready'
            ELSE 'no_raw_events'
          END AS reason FROM runs r JOIN sessions s ON s.id=r.session_id WHERE r.id=?`)
          .get(new Date(now - this.retentionMs).toISOString(), run.id) as {
            id: number; events_pruned_through_seq: number; reason: SkipReason | "ready"
          };
        if (job.reason !== "ready") return { retired: 0, reason: job.reason };
        const candidates = this.db.prepare(`SELECT id,seq,octet_length(content_json) AS bytes FROM events
          WHERE run_id=? AND seq>? AND type IN ('message','tool') ORDER BY seq LIMIT 100`)
          .all(job.id, job.events_pruned_through_seq) as Array<{ id: number; seq: number; bytes: number }>;
        const batch: typeof candidates = [];
        let bytes = 0;
        for (const event of candidates) {
          if (batch.length && bytes + event.bytes > 4 * 1024 * 1024) break;
          batch.push(event); bytes += event.bytes;
        }
        if (!batch.length) return { retired: 0, reason: "no_raw_events" as const };
        try {
          this.db.transaction(() => this.conversation.compactEstimates(job.id, batch.map(event => String(event.seq))))();
        } catch { console.warn(`usage_estimate_compaction_failed runId=${job.id}`); }
        this.db.prepare("DELETE FROM events WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(batch.map(event => event.id)));
        this.db.prepare(`UPDATE runs SET events_pruned_at=COALESCE(events_pruned_at,?),
          events_pruned_through_seq=MAX(events_pruned_through_seq,?) WHERE id=?`)
          .run(new Date(now).toISOString(), batch.at(-1)!.seq, job.id);
        // Preserve completed counts and failure reasons; missing raw evidence cannot be retried.
        this.db.prepare(`UPDATE agent_usage_runtime_backfills SET status='failed',
          error_code=COALESCE(error_code,'usage_runtime_events_expired'),retry_after=0
          WHERE namespace=? AND run_id=? AND (status IN ('pending','running') OR last_seq<?)`)
          .run(this.namespace, job.id, batch.at(-1)!.seq);
        return { retired: batch.length, reason: "ready" as const };
      })();
      this.checkedRuns++;
      this.lastRunId = run.id;
      this.lastAction = result.retired > 0 ? "retired" : "scanned";
      if (result.retired > 0) {
        this.retiredEvents += result.retired;
        this.lastRetiredAt = new Date(now).toISOString();
      } else if (result.reason !== "ready") {
        this.skippedByReason[result.reason] = (this.skippedByReason[result.reason] ?? 0) + 1;
      }
      this.nextRunId = run.id + Number(result.retired === 0);
      return result.retired > 0 ? "retired" : "scanned";
    } catch (error) {
      this.lastAction = "failed";
      this.lastErrorAt = new Date(now).toISOString();
      throw error;
    } finally {
      this.lastStepAt = new Date(now).toISOString();
      this.lastStepMs = Math.round((performance.now() - started) * 1_000) / 1_000;
    }
  }
}
