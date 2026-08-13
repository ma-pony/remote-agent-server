import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type { Run, RunStatus } from "../domain.js";
import { assertSynchronousTransactionHook } from "../transaction-hook.js";

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

export type RunStateProjection = {
  onStarted(run: Run): undefined;
  onFinished(run: Run): undefined;
  afterCommit(run: Run): undefined;
};

const noOpRunStateProjection: RunStateProjection = {
  onStarted: () => undefined,
  onFinished: () => undefined,
  afterCommit: () => undefined
};

export type RunRepositoryDependencies = {
  db: Database.Database;
  projection?: RunStateProjection;
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
  private readonly projection: RunStateProjection;

  constructor({ db, projection = noOpRunStateProjection }: RunRepositoryDependencies) {
    this.db = db;
    this.projection = projection;
  }

  /**
   * Creates a queued Run and marks its Session active in one transaction.
   */
  create(input: CreateRunInput, options?: { afterInsert?(run: Run): undefined }): Run {
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
        const claimed = this.db
          .prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
          .run("running", createdAt, run.sessionId, "idle");
        if (claimed.changes !== 1) throw new RunRepositoryError("session_busy");
        this.db
          .prepare("INSERT INTO runs (id, session_id, status, input, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(run.id, run.sessionId, run.status, run.input, run.createdAt);
        assertSynchronousTransactionHook(options?.afterInsert?.(run));
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
    const started = this.inImmediateTransaction(() => {
      const run = this.requireRun(id);
      if (run.status !== "queued") throw new RunRepositoryError("invalid_run_state");

      const startedAt = new Date().toISOString();
      this.db.prepare("UPDATE runs SET status = ?, started_at = ? WHERE id = ?").run("running", startedAt, id);
      const started = { ...run, status: "running" as const, startedAt };
      assertSynchronousTransactionHook(this.projection.onStarted(started));
      return started;
    });
    this.projection.afterCommit(started);
    return started;
  }

  /**
   * Completes a running Run and releases its Session in one transaction.
   */
  finish(id: string, input: FinishRunInput): Run {
    if (!isTerminalStatus(input.status)) throw new RunRepositoryError("invalid_finish_status");

    const finished = this.inImmediateTransaction(() => {
      const run = this.requireRun(id);
      if (run.status !== "running") throw new RunRepositoryError("invalid_run_state");

      const finishedAt = new Date().toISOString();
      const result = input.result ?? null;
      const error = input.error ?? null;
      this.db
        .prepare("UPDATE runs SET status = ?, result = ?, error = ?, finished_at = ? WHERE id = ?")
        .run(input.status, result, error, finishedAt, id);
      this.db.prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?").run("idle", finishedAt, run.sessionId);
      const finished = { ...run, status: input.status, result, error, finishedAt };
      assertSynchronousTransactionHook(this.projection.onFinished(finished));
      return finished;
    });
    this.projection.afterCommit(finished);
    return finished;
  }

  /**
   * Cancels a queued Run and releases its Session in one transaction.
   */
  cancelQueued(id: string): Run {
    const cancelled = this.inImmediateTransaction(() => {
      const run = this.requireRun(id);
      if (run.status !== "queued") throw new RunRepositoryError("invalid_run_state");

      const finishedAt = new Date().toISOString();
      this.db.prepare("UPDATE runs SET status = ?, finished_at = ? WHERE id = ?").run("cancelled", finishedAt, id);
      this.db.prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?").run("idle", finishedAt, run.sessionId);
      const cancelled = { ...run, status: "cancelled" as const, finishedAt };
      assertSynchronousTransactionHook(this.projection.onFinished(cancelled));
      return cancelled;
    });
    this.projection.afterCommit(cancelled);
    return cancelled;
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
