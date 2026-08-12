import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import type Database from "better-sqlite3";

import type { Event, EventType } from "../domain.js";

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
};

/**
 * Persists ordered Run events and emits each event after its transaction commits.
 */
export class EventStore {
  private readonly db: Database.Database;
  private readonly emitter = new EventEmitter();

  constructor({ db }: EventStoreDependencies) {
    this.db = db;
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
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    this.emitter.emit(runId, event!);
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
   * Subscribes to Events appended to a Run in this process.
   */
  subscribe(runId: string, listener: (event: Event) => void): () => void {
    this.emitter.on(runId, listener);
    return () => this.emitter.off(runId, listener);
  }
}
