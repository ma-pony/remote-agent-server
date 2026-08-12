import type { Run } from "../domain.js";
import { settleBestEffort } from "../runtime/bounded-operation.js";
import type { RunExecutor } from "./run-executor.js";
import type { RunRepository } from "./run-repository.js";

export type RunSchedulerDependencies = {
  runRepository: Pick<RunRepository, "listQueued">;
  executor: Pick<RunExecutor, "execute" | "cancel">;
  maxConcurrentRuns: number;
};

/**
 * Applies the process-wide Run concurrency limit without polling SQLite.
 */
export class RunScheduler {
  private readonly pending: string[] = [];
  private readonly active = new Set<string>();
  private readonly runRepository: Pick<RunRepository, "listQueued">;
  private readonly executor: Pick<RunExecutor, "execute" | "cancel">;
  private readonly maxConcurrentRuns: number;
  private started = false;
  private loadedQueued = false;

  constructor({ runRepository, executor, maxConcurrentRuns }: RunSchedulerDependencies) {
    this.runRepository = runRepository;
    this.executor = executor;
    this.maxConcurrentRuns = maxConcurrentRuns;
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
        .catch(() => undefined)
        .finally(() => {
          this.active.delete(runId);
          this.drain();
        });
    }
  }
}
