import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type { Run, RunStatus } from "../domain.js";

type RunRow = {
  id: string;
  session_id: string;
  status: RunStatus;
  input: string;
  result: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

const toRun = (row: RunRow): Run => ({
  id: row.id,
  sessionId: row.session_id,
  status: row.status,
  input: row.input,
  result: row.result,
  error: row.error,
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at
});

const isTerminalStatus = (status: RunStatus): status is "succeeded" | "failed" | "cancelled" =>
  status === "succeeded" || status === "failed" || status === "cancelled";

export type CreateRunInput = {
  sessionId: string;
  input: string;
};

export type FinishRunInput = {
  status: "succeeded" | "failed" | "cancelled";
  result?: string;
  error?: string;
};

export type RunRepositoryDependencies = {
  db: Database.Database;
};

export class RunRepositoryError extends Error {
  constructor(readonly code: "session_busy" | "run_not_found" | "invalid_run_state" | "invalid_finish_status") {
    super(code);
  }
}

/**
 * Persists Run state transitions together with their owning Session state.
 */
export class RunRepository {
  private readonly db: Database.Database;

  constructor({ db }: RunRepositoryDependencies) {
    this.db = db;
  }

  /**
   * Creates a queued Run and marks its Session active in one transaction.
   */
  create(input: CreateRunInput): Run {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const run: Run = {
      id,
      sessionId: input.sessionId,
      status: "queued",
      input: input.input,
      result: null,
      error: null,
      createdAt,
      startedAt: null,
      finishedAt: null
    };

    try {
      return this.inImmediateTransaction(() => {
        this.db
          .prepare("INSERT INTO runs (id, session_id, status, input, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(run.id, run.sessionId, run.status, run.input, run.createdAt);
        this.db.prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?").run("running", createdAt, run.sessionId);
        return run;
      });
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed: runs\.session_id/.test(error.message)) {
        throw new RunRepositoryError("session_busy");
      }
      throw error;
    }
  }

  /**
   * Finds one Run.
   */
  get(id: string): Run | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
    return row === undefined ? undefined : toRun(row);
  }

  /**
   * Lists a Session's Runs in creation order.
   */
  listBySession(sessionId: string): Run[] {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE session_id = ? ORDER BY created_at ASC, id ASC")
      .all(sessionId) as RunRow[];
    return rows.map(toRun);
  }

  /**
   * Lists queued Runs in creation order for scheduler recovery.
   */
  listQueued(): Run[] {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE status = 'queued' ORDER BY created_at ASC, id ASC")
      .all() as RunRow[];
    return rows.map(toRun);
  }

  /**
   * Transitions a queued Run to running before an external execution starts.
   */
  markRunning(id: string): Run {
    return this.inImmediateTransaction(() => {
      const run = this.requireRun(id);
      if (run.status !== "queued") throw new RunRepositoryError("invalid_run_state");

      const startedAt = new Date().toISOString();
      this.db.prepare("UPDATE runs SET status = ?, started_at = ? WHERE id = ?").run("running", startedAt, id);
      return { ...run, status: "running", startedAt };
    });
  }

  /**
   * Completes a running Run and releases its Session in one transaction.
   */
  finish(id: string, input: FinishRunInput): Run {
    if (!isTerminalStatus(input.status)) throw new RunRepositoryError("invalid_finish_status");

    return this.inImmediateTransaction(() => {
      const run = this.requireRun(id);
      if (run.status !== "running") throw new RunRepositoryError("invalid_run_state");

      const finishedAt = new Date().toISOString();
      const result = input.result ?? null;
      const error = input.error ?? null;
      this.db
        .prepare("UPDATE runs SET status = ?, result = ?, error = ?, finished_at = ? WHERE id = ?")
        .run(input.status, result, error, finishedAt, id);
      this.db.prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?").run("idle", finishedAt, run.sessionId);
      return { ...run, status: input.status, result, error, finishedAt };
    });
  }

  /**
   * Cancels a queued Run and releases its Session in one transaction.
   */
  cancelQueued(id: string): Run {
    return this.inImmediateTransaction(() => {
      const run = this.requireRun(id);
      if (run.status !== "queued") throw new RunRepositoryError("invalid_run_state");

      const finishedAt = new Date().toISOString();
      this.db.prepare("UPDATE runs SET status = ?, finished_at = ? WHERE id = ?").run("cancelled", finishedAt, id);
      this.db.prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?").run("idle", finishedAt, run.sessionId);
      return { ...run, status: "cancelled", finishedAt };
    });
  }

  /**
   * Fails Runs interrupted by a process restart while leaving queued Runs intact.
   */
  recoverAfterRestart(): void {
    const now = new Date().toISOString();
    this.inImmediateTransaction(() => {
      this.db
        .prepare("UPDATE runs SET status = 'failed', error = 'server_restarted', finished_at = ? WHERE status = 'running'")
        .run(now);
      this.db
        .prepare("UPDATE sessions SET status = 'idle', updated_at = ? WHERE id NOT IN (SELECT session_id FROM runs WHERE status = 'queued')")
        .run(now);
    });
  }

  private requireRun(id: string): Run {
    const run = this.get(id);
    if (run === undefined) throw new RunRepositoryError("run_not_found");
    return run;
  }

  private inImmediateTransaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
