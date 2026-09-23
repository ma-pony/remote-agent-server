import type Database from "better-sqlite3";
import type { RuntimeConversationCollector } from "./runtime-conversation.js";

type SkipReason = "run_not_expired" | "session_busy" | "backfill_incomplete" |
  "content_uncounted" | "tool_uncounted" | "backfill_cursor_behind" | "no_raw_events";
type RetentionAction = "idle" | "scanned" | "retired" | "failed";

/** Retires raw replay bodies only after their durable usage projections have completed. */
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
        const job = this.db.prepare(`SELECT r.id,j.last_seq,r.events_pruned_through_seq,
          CASE
            WHEN r.status IN ('queued','running') OR r.finished_at IS NULL OR r.finished_at>=? THEN 'run_not_expired'
            WHEN s.status!='idle' OR s.pending_operation IS NOT NULL OR EXISTS (
              SELECT 1 FROM runs active WHERE active.session_id=s.id AND active.status IN ('queued','running'))
              THEN 'session_busy'
            WHEN j.run_id IS NULL OR j.status!='completed' OR j.error_code IS NOT NULL THEN 'backfill_incomplete'
            WHEN EXISTS (SELECT 1 FROM agent_usage_conversation_content c
              WHERE c.namespace=j.namespace AND c.run_id=r.id AND c.tokens IS NULL) THEN 'content_uncounted'
            WHEN EXISTS (SELECT 1 FROM agent_usage_invocations i
              JOIN agent_usage_invocation_payloads p ON p.public_id=i.public_id
              WHERE i.namespace=j.namespace AND i.agent_id=CAST(s.agent_id AS TEXT)
                AND i.session_id=j.session_id AND i.execution_id=CAST(r.id AS TEXT)
                AND p.token_count IS NULL) THEN 'tool_uncounted'
            WHEN EXISTS (SELECT 1 FROM events e WHERE e.run_id=r.id AND e.seq>r.events_pruned_through_seq
              AND e.seq<=j.last_seq AND e.type IN ('message','tool')) THEN 'ready'
            WHEN EXISTS (SELECT 1 FROM events e WHERE e.run_id=r.id AND e.seq>j.last_seq
              AND e.type IN ('message','tool')) THEN 'backfill_cursor_behind'
            ELSE 'no_raw_events'
          END AS reason FROM runs r JOIN sessions s ON s.id=r.session_id
          LEFT JOIN agent_usage_runtime_backfills j ON j.namespace=? AND j.run_id=r.id WHERE r.id=?`)
          .get(new Date(now - this.retentionMs).toISOString(), this.namespace, run.id) as {
            id: number; last_seq: number; events_pruned_through_seq: number; reason: SkipReason | "ready"
          };
        if (job.reason !== "ready") return { retired: 0, reason: job.reason };
        const candidates = this.db.prepare(`SELECT id,seq,octet_length(content_json) AS bytes FROM events
          WHERE run_id=? AND seq>? AND seq<=? AND type IN ('message','tool') ORDER BY seq LIMIT 100`)
          .all(job.id, job.events_pruned_through_seq, job.last_seq) as Array<{ id: number; seq: number; bytes: number }>;
        const batch: typeof candidates = [];
        let bytes = 0;
        for (const event of candidates) {
          if (batch.length && bytes + event.bytes > 4 * 1024 * 1024) break;
          batch.push(event); bytes += event.bytes;
        }
        if (!batch.length) return { retired: 0, reason: "no_raw_events" as const };
        this.conversation.compactEstimates(job.id, batch.map(event => String(event.seq)));
        this.db.prepare("DELETE FROM events WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(batch.map(event => event.id)));
        this.db.prepare(`UPDATE runs SET events_pruned_at=COALESCE(events_pruned_at,?),
          events_pruned_through_seq=MAX(events_pruned_through_seq,?) WHERE id=?`)
          .run(new Date(now).toISOString(), batch.at(-1)!.seq, job.id);
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
