import type Database from "better-sqlite3";
import type { RuntimeConversationCollector } from "./runtime-conversation.js";

/** Retires raw replay bodies only after their durable usage projections have completed. */
export class RuntimeEventRetention {
  // Recheck the current Run after each batch, then wrap to revisit deferred Runs.
  private nextRunId = 0;

  constructor(private readonly db: Database.Database, private readonly namespace: string,
    private readonly conversation: RuntimeConversationCollector, private readonly retentionMs: number) {}

  step(now = Date.now()): boolean {
    if (this.retentionMs === 0) return false;
    return this.db.transaction(() => {
      const job = this.db.prepare(`SELECT r.id,j.last_seq FROM runs r
        JOIN sessions s ON s.id=r.session_id
        JOIN agent_usage_runtime_backfills j ON j.namespace=? AND j.run_id=r.id
        WHERE r.id>=? AND r.status NOT IN ('queued','running') AND r.finished_at<?
          AND s.status='idle' AND s.pending_operation IS NULL
          AND j.status='completed' AND j.error_code IS NULL
          AND NOT EXISTS (SELECT 1 FROM agent_usage_conversation_content c
            WHERE c.namespace=j.namespace AND c.run_id=r.id AND c.tokens IS NULL)
          AND NOT EXISTS (SELECT 1 FROM agent_usage_invocations i
            JOIN agent_usage_invocation_payloads p ON p.public_id=i.public_id
            WHERE i.namespace=j.namespace AND i.agent_id=CAST(s.agent_id AS TEXT)
              AND i.session_id=j.session_id AND i.execution_id=CAST(r.id AS TEXT)
              AND p.token_count IS NULL)
          AND NOT EXISTS (SELECT 1 FROM runs active WHERE active.session_id=s.id AND active.status IN ('queued','running'))
          AND EXISTS (SELECT 1 FROM events e WHERE e.run_id=r.id AND e.seq<=j.last_seq AND e.type IN ('message','tool'))
        ORDER BY r.id LIMIT 1`).get(this.namespace, this.nextRunId, new Date(now - this.retentionMs).toISOString()) as { id: number; last_seq: number } | undefined;
      if (!job) {
        this.nextRunId = 0;
        return false;
      }
      const candidates = this.db.prepare(`SELECT id,seq,octet_length(content_json) AS bytes FROM events
        WHERE run_id=? AND seq<=? AND type IN ('message','tool') ORDER BY seq LIMIT 100`)
        .all(job.id, job.last_seq) as Array<{ id: number; seq: number; bytes: number }>;
      const batch: typeof candidates = [];
      let bytes = 0;
      for (const event of candidates) {
        if (batch.length && bytes + event.bytes > 4 * 1024 * 1024) break;
        batch.push(event); bytes += event.bytes;
      }
      if (!batch.length) return false;
      this.conversation.compactEstimates(job.id, batch.map(event => String(event.seq)));
      this.db.prepare("DELETE FROM events WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(batch.map(event => event.id)));
      this.db.prepare(`UPDATE runs SET events_pruned_at=COALESCE(events_pruned_at,?),
        events_pruned_through_seq=MAX(events_pruned_through_seq,?) WHERE id=?`)
        .run(new Date(now).toISOString(), batch.at(-1)!.seq, job.id);
      this.nextRunId = job.id;
      return true;
    })();
  }
}
