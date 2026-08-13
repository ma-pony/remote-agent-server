import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type { Event, EventType } from "../domain.js";
import { assertSynchronousTransactionHook } from "../transaction-hook.js";

type EventRow = {
  id: string;
  run_id: string;
  seq: number;
  type: EventType;
  content_json: string;
  created_at: string;
};

const toEvent = (row: EventRow): Event => ({
  id: row.id,
  runId: row.run_id,
  seq: row.seq,
  type: row.type,
  contentJson: row.content_json,
  createdAt: row.created_at
});

export type EventStoreDependencies = {
  db: Database.Database;
  projection?: RunEventProjection;
};

export type RunEventProjection = {
  onAppended(event: Event): undefined;
};

const noOpRunEventProjection: RunEventProjection = {
  onAppended: () => undefined
};

/**
 * Persists ordered Run events and emits each event after its transaction commits.
 */
export class EventStore {
  private readonly db: Database.Database;
  private readonly projection: RunEventProjection;
  private readonly listeners = new Map<string, Set<(event: Event) => unknown>>();

  constructor({ db, projection = noOpRunEventProjection }: EventStoreDependencies) {
    this.db = db;
    this.projection = projection;
  }

  /**
   * Appends an Event with the next sequence number for its Run.
   */
  append(runId: string, type: EventType, content: unknown): Event {
    this.db.exec("BEGIN IMMEDIATE");
    let event: Event;
    try {
      const nextSeq = (this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE run_id = ?").get(runId) as { seq: number }).seq;
      const createdAt = new Date().toISOString();
      const row: EventRow = {
        id: randomUUID(),
        run_id: runId,
        seq: nextSeq,
        type,
        content_json: JSON.stringify(content) ?? "null",
        created_at: createdAt
      };
      this.db
        .prepare("INSERT INTO events (id, run_id, seq, type, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(row.id, row.run_id, row.seq, row.type, row.content_json, row.created_at);
      event = toEvent(row);
      assertSynchronousTransactionHook(this.projection.onAppended(event));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    for (const listener of [...(this.listeners.get(runId) ?? [])]) {
      try {
        void Promise.resolve(listener(event!)).catch(() => undefined);
      } catch (_error) {
        // A subscriber cannot roll back an already-committed Event or affect other subscribers.
      }
    }
    return event!;
  }

  /**
   * Lists persisted Events after the supplied sequence number.
   */
  list(runId: string, afterSeq: number): Event[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq ASC")
      .all(runId, afterSeq) as EventRow[];
    return rows.map(toEvent);
  }

  /**
   * Reads a bounded Event page for streaming history without unbounded memory use.
   */
  listBatch(runId: string, afterSeq: number, throughSeq: number, limit: number): Event[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE run_id = ? AND seq > ? AND seq <= ? ORDER BY seq ASC LIMIT ?")
      .all(runId, afterSeq, throughSeq, limit) as EventRow[];
    return rows.map(toEvent);
  }

  /**
   * Returns the latest committed sequence number for a Run.
   */
  latestSeq(runId: string): number {
    return (this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE run_id = ?").get(runId) as { seq: number }).seq;
  }

  /**
   * Subscribes to Events appended to a Run in this process.
   */
  subscribe(runId: string, listener: (event: Event) => unknown): () => void {
    let listeners = this.listeners.get(runId);
    if (listeners === undefined) {
      listeners = new Set();
      this.listeners.set(runId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners!.delete(listener);
      if (listeners!.size === 0) this.listeners.delete(runId);
    };
  }
}
