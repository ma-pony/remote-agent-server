import type Database from "better-sqlite3";

import { insertedId } from "../db.js";
import type { Run, RunStatus, TokenUsage, TokenUsageSummary } from "../domain.js";
import { assertSynchronousTransactionHook } from "../transaction-hook.js";

type RunRow = {
  id: number;
  session_id: number;
  status: RunStatus;
  input: string;
  result: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_read_tokens: number | null;
  cached_write_tokens: number | null;
  thought_tokens: number | null;
  total_tokens: number | null;
  context_used_tokens: number | null;
  context_window_tokens: number | null;
};

const rowUsage = (row: RunRow): TokenUsage | null => {
  const usage: TokenUsage = {
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cachedReadTokens: row.cached_read_tokens,
    cachedWriteTokens: row.cached_write_tokens,
    thoughtTokens: row.thought_tokens,
    totalTokens: row.total_tokens,
    contextUsedTokens: row.context_used_tokens,
    contextWindowTokens: row.context_window_tokens
  };
  return Object.values(usage).some((value) => value !== null) ? usage : null;
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
  finishedAt: row.finished_at,
  usage: rowUsage(row)
});

const isTerminalStatus = (status: RunStatus): status is "succeeded" | "failed" | "cancelled" =>
  status === "succeeded" || status === "failed" || status === "cancelled";

export type CreateRunInput = {
  sessionId: number;
  input: string;
};

export type FinishRunInput = {
  status: "succeeded" | "failed" | "cancelled";
  result?: string;
  error?: string;
  usage?: Partial<TokenUsage>;
};

type UsageSummaryRow = {
  session_count: number;
  measured_session_count: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_read_tokens: number | null;
  cached_write_tokens: number | null;
  thought_tokens: number | null;
  total_tokens: number | null;
};

const toUsageSummary = (row: UsageSummaryRow): TokenUsageSummary => ({
  sessionCount: row.session_count,
  measuredSessionCount: row.measured_session_count,
  usage: {
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cachedReadTokens: row.cached_read_tokens,
    cachedWriteTokens: row.cached_write_tokens,
    thoughtTokens: row.thought_tokens,
    totalTokens: row.total_tokens
  }
});

export type RunStateProjection = {
  onStarted(run: Run): undefined;
  onFinished(run: Run): undefined;
  afterCommit(run: Run): undefined;
};

export type RunPostCommitTransition = "started" | "finished" | "cancelled";

const noOpRunStateProjection: RunStateProjection = {
  onStarted: () => undefined,
  onFinished: () => undefined,
  afterCommit: () => undefined
};

export type RunRepositoryDependencies = {
  db: Database.Database;
  projection?: RunStateProjection;
  onPostCommitError?: (runId: number, transition: RunPostCommitTransition) => undefined;
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
  private readonly onPostCommitError: (runId: number, transition: RunPostCommitTransition) => undefined;

  constructor({
    db,
    projection = noOpRunStateProjection,
    onPostCommitError = () => undefined
  }: RunRepositoryDependencies) {
    this.db = db;
    this.projection = projection;
    this.onPostCommitError = onPostCommitError;
  }

  /**
   * Creates a queued Run and marks its Session active in one transaction.
   */
  create(input: CreateRunInput, options?: { afterInsert?(run: Run): undefined }): Run {
    const createdAt = new Date().toISOString();

    try {
      return this.inImmediateTransaction(() => {
        const claimed = this.db
          .prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
          .run("running", createdAt, input.sessionId, "idle");
        if (claimed.changes !== 1) throw new RunRepositoryError("session_busy");
        const id = insertedId(this.db
          .prepare("INSERT INTO runs (session_id, status, input, created_at) VALUES (?, ?, ?, ?)")
          .run(input.sessionId, "queued", input.input, createdAt));
        const run: Run = {
          id,
          sessionId: input.sessionId,
          status: "queued",
          input: input.input,
          result: null,
          error: null,
          createdAt,
          startedAt: null,
          finishedAt: null,
          usage: null
        };
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
  get(id: number): Run | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
    return row === undefined ? undefined : toRun(row);
  }

  /**
   * Lists a Session's Runs in creation order.
   */
  listBySession(sessionId: number): Run[] {
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

  /** Returns the exact cumulative usage stored for one Session. */
  summarizeBySession(sessionId: number): TokenUsageSummary {
    return toUsageSummary(this.db.prepare(`
      SELECT
        COUNT(*) AS session_count,
        COALESCE(SUM(CASE WHEN
          input_tokens IS NOT NULL OR output_tokens IS NOT NULL OR cached_read_tokens IS NOT NULL OR
          cached_write_tokens IS NOT NULL OR thought_tokens IS NOT NULL OR total_tokens IS NOT NULL
        THEN 1 ELSE 0 END), 0) AS measured_session_count,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(cached_read_tokens) AS cached_read_tokens,
        SUM(cached_write_tokens) AS cached_write_tokens,
        SUM(thought_tokens) AS thought_tokens,
        SUM(total_tokens) AS total_tokens
      FROM sessions
      WHERE id = ?
    `).get(sessionId) as UsageSummaryRow);
  }

  /** Sums the latest cumulative usage of every Session owned by one Agent. */
  summarizeByAgent(agentId: number): TokenUsageSummary {
    return toUsageSummary(this.db.prepare(`
      SELECT
        COUNT(*) AS session_count,
        COALESCE(SUM(CASE WHEN
          input_tokens IS NOT NULL OR output_tokens IS NOT NULL OR cached_read_tokens IS NOT NULL OR
          cached_write_tokens IS NOT NULL OR thought_tokens IS NOT NULL OR total_tokens IS NOT NULL
        THEN 1 ELSE 0 END), 0) AS measured_session_count,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(cached_read_tokens) AS cached_read_tokens,
        SUM(cached_write_tokens) AS cached_write_tokens,
        SUM(thought_tokens) AS thought_tokens,
        SUM(total_tokens) AS total_tokens
      FROM sessions
      WHERE agent_id = ?
    `).get(agentId) as UsageSummaryRow);
  }

  /**
   * Transitions a queued Run to running before an external execution starts.
   */
  markRunning(id: number): Run {
    const started = this.inImmediateTransaction(() => {
      const run = this.requireRun(id);
      if (run.status !== "queued") throw new RunRepositoryError("invalid_run_state");

      const startedAt = new Date().toISOString();
      this.db.prepare("UPDATE runs SET status = ?, started_at = ? WHERE id = ?").run("running", startedAt, id);
      const started = { ...run, status: "running" as const, startedAt };
      assertSynchronousTransactionHook(this.projection.onStarted(started));
      return started;
    });
    this.runAfterCommit(started, "started");
    return started;
  }

  /**
   * Completes a running Run and releases its Session in one transaction.
   */
  finish(id: number, input: FinishRunInput): Run {
    if (!isTerminalStatus(input.status)) throw new RunRepositoryError("invalid_finish_status");

    const finished = this.inImmediateTransaction(() => {
      const run = this.requireRun(id);
      if (run.status !== "running") throw new RunRepositoryError("invalid_run_state");

      const finishedAt = new Date().toISOString();
      const result = input.result ?? null;
      const error = input.error ?? null;
      const usage = input.usage;
      this.db
        .prepare(`
          UPDATE runs SET
            status = ?, result = ?, error = ?, finished_at = ?,
            input_tokens = ?, output_tokens = ?, cached_read_tokens = ?, cached_write_tokens = ?,
            thought_tokens = ?, total_tokens = ?, context_used_tokens = ?, context_window_tokens = ?
          WHERE id = ?
        `)
        .run(
          input.status,
          result,
          error,
          finishedAt,
          usage?.inputTokens ?? null,
          usage?.outputTokens ?? null,
          usage?.cachedReadTokens ?? null,
          usage?.cachedWriteTokens ?? null,
          usage?.thoughtTokens ?? null,
          usage?.totalTokens ?? null,
          usage?.contextUsedTokens ?? null,
          usage?.contextWindowTokens ?? null,
          id
        );
      this.db.prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?").run("idle", finishedAt, run.sessionId);
      const finished = this.requireRun(id);
      assertSynchronousTransactionHook(this.projection.onFinished(finished));
      return finished;
    });
    this.runAfterCommit(finished, "finished");
    return finished;
  }

  /**
   * Cancels a queued Run and releases its Session in one transaction.
   */
  cancelQueued(id: number): Run {
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
    this.runAfterCommit(cancelled, "cancelled");
    return cancelled;
  }

  /** Fails a queued Run after the scheduler has exhausted its recovery attempts. */
  failQueued(id: number, error: string): Run {
    const failed = this.inImmediateTransaction(() => {
      const run = this.requireRun(id);
      if (run.status !== "queued") throw new RunRepositoryError("invalid_run_state");

      const finishedAt = new Date().toISOString();
      this.db.prepare("UPDATE runs SET status = ?, error = ?, finished_at = ? WHERE id = ?")
        .run("failed", error, finishedAt, id);
      this.db.prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?")
        .run("idle", finishedAt, run.sessionId);
      const failed = { ...run, status: "failed" as const, error, finishedAt };
      assertSynchronousTransactionHook(this.projection.onFinished(failed));
      return failed;
    });
    this.runAfterCommit(failed, "finished");
    return failed;
  }

  /**
   * Fails Runs interrupted by a process restart while leaving queued Runs intact.
   */
  recoverAfterRestart(): void {
    const now = new Date().toISOString();
    this.inImmediateTransaction(() => {
      const interruptedRuns = this.db.prepare("SELECT id FROM runs WHERE status = 'running' ORDER BY created_at, id")
        .all() as Array<{ id: number }>;
      for (const run of interruptedRuns) {
        const nextSeq = (this.db.prepare(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE run_id = ?"
        ).get(run.id) as { seq: number }).seq;
        this.db.prepare(`
          INSERT INTO events (run_id, seq, type, content_json, created_at)
          VALUES (?, ?, 'error', ?, ?)
        `).run(
          run.id,
          nextSeq,
          JSON.stringify({ code: "server_restarted", message: "Run interrupted by server restart" }),
          now
        );
      }
      this.db
        .prepare("UPDATE runs SET status = 'failed', error = 'server_restarted', finished_at = ? WHERE status = 'running'")
        .run(now);
      this.db
        .prepare("UPDATE sessions SET status = 'idle', updated_at = ? WHERE workspace_path NOT LIKE 'pending:%' AND id NOT IN (SELECT session_id FROM runs WHERE status = 'queued')")
        .run(now);
    });
  }

  private requireRun(id: number): Run {
    const run = this.get(id);
    if (run === undefined) throw new RunRepositoryError("run_not_found");
    return run;
  }

  private runAfterCommit(run: Run, transition: RunPostCommitTransition): void {
    try {
      assertSynchronousTransactionHook(this.projection.afterCommit(run));
    } catch (_error) {
      try {
        assertSynchronousTransactionHook(this.onPostCommitError(run.id, transition));
      } catch (_reportingError) {
        // Post-commit notification and reporting are best effort; source state is already committed.
      }
    }
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
