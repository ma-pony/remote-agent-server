import type { Run } from "../domain.js";
import { settleBestEffort } from "../runtime/bounded-operation.js";
import type { RunExecutor } from "./run-executor.js";
import type { RunRepository } from "./run-repository.js";

export type RunSchedulerDependencies = {
  runRepository: Pick<RunRepository, "get" | "listQueued">;
  executor: Pick<RunExecutor, "execute" | "cancel">;
  maxConcurrentRuns: number;
  onExecutionError?: (error: unknown, runId: string) => void;
  retryDelayMs?: number;
};

const defaultExecutionErrorReporter = (_error: unknown, runId: string): void => {
  console.error(`Run execution failed (${runId})`);
};

/**
 * Applies the process-wide Run concurrency limit without polling SQLite.
 */
export class RunScheduler {
  private readonly pending: string[] = [];
  private readonly active = new Set<string>();
  private readonly runRepository: Pick<RunRepository, "get" | "listQueued">;
  private readonly executor: Pick<RunExecutor, "execute" | "cancel">;
  private readonly maxConcurrentRuns: number;
  private readonly onExecutionError: (error: unknown, runId: string) => void;
  private readonly retryDelayMs: number;
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private started = false;
  private loadedQueued = false;

  constructor({
    runRepository,
    executor,
    maxConcurrentRuns,
    onExecutionError = defaultExecutionErrorReporter,
    retryDelayMs = 1_000
  }: RunSchedulerDependencies) {
    this.runRepository = runRepository;
    this.executor = executor;
    this.maxConcurrentRuns = maxConcurrentRuns;
    this.onExecutionError = onExecutionError;
    this.retryDelayMs = retryDelayMs;
  }

  /**
   * Loads queued Runs exactly once, then starts draining the in-memory queue.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.loadedQueued) {
      this.loadedQueued = true;
      for (const run of this.runRepository.listQueued()) this.addPending(run.id);
    }
    this.drain();
  }

  /**
   * Adds a newly-created Run to the in-memory queue.
   */
  enqueue(runId: string): void {
    this.addPending(runId);
    this.drain();
  }

  /**
   * Stops scheduling queued work and requests cancellation of active Turns.
   */
  async stop(): Promise<void> {
    this.started = false;
    this.pending.splice(0);
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    await Promise.all([...this.active].map(async (runId) => {
      await settleBestEffort(() => this.executor.cancel(runId));
    }));
  }

  private addPending(runId: string): void {
    if (!this.pending.includes(runId) && !this.active.has(runId)) this.pending.push(runId);
  }

  private drain(): void {
    if (!this.started) return;
    while (this.active.size < this.maxConcurrentRuns) {
      const runId = this.pending.shift();
      if (runId === undefined) return;

      this.active.add(runId);
      void this.executor.execute(runId)
        .catch((error: unknown) => this.handleExecutionError(error, runId))
        .finally(() => {
          this.active.delete(runId);
          this.drain();
        });
    }
  }

  private handleExecutionError(error: unknown, runId: string): void {
    try {
      this.onExecutionError(error, runId);
    } catch (_reportingError) {
      defaultExecutionErrorReporter(undefined, runId);
    }

    let run: Run | undefined;
    try {
      run = this.runRepository.get(runId);
    } catch (_inspectionError) {
      return;
    }
    if (run?.status !== "queued" || !this.started || this.retryTimers.has(runId)) return;

    const timer = setTimeout(() => {
      this.retryTimers.delete(runId);
      if (this.started) this.enqueue(runId);
    }, this.retryDelayMs);
    timer.unref?.();
    this.retryTimers.set(runId, timer);
  }
}
