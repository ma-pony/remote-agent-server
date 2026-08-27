import type { Run } from "../domain.js";
import { settleBestEffort } from "../runtime/bounded-operation.js";
import type { RunExecutor } from "./run-executor.js";
import type { RunRepository } from "./run-repository.js";
import type { ConcurrencySettings, ConcurrencySettingsStore } from "../settings/concurrency-settings-store.js";

export type RunSchedulerDependencies = {
  runRepository: Pick<RunRepository, "get" | "listQueued" | "failQueued"> &
    Partial<Pick<RunRepository, "getSchedulingContext">>;
  executor: Pick<RunExecutor, "execute" | "cancel">;
  concurrencySettings?: Pick<ConcurrencySettingsStore, "get" | "subscribe">;
  maxConcurrentRuns?: number;
  onExecutionError?: (error: unknown, runId: number) => void;
  retryDelayMs?: number;
};

const defaultExecutionErrorReporter = (_error: unknown, runId: number): void => {
  console.error(`Run execution failed (${runId})`);
};

const MAX_AUTOMATIC_RETRIES = 3;

export class RunSchedulerError extends Error {
  constructor(readonly code: "run_retry_exhausted") {
    super(code);
  }
}

/**
 * Applies the process-wide Run concurrency limit without polling SQLite.
 */
export class RunScheduler {
  private readonly pending: number[] = [];
  private readonly active = new Map<number, number>();
  private readonly activeByAgent = new Map<number, number>();
  private readonly runRepository: RunSchedulerDependencies["runRepository"];
  private readonly executor: Pick<RunExecutor, "execute" | "cancel">;
  private readonly concurrencySettings: Pick<ConcurrencySettingsStore, "get" | "subscribe">;
  private readonly onExecutionError: (error: unknown, runId: number) => void;
  private readonly retryDelayMs: number;
  private readonly retryTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly retryAttempts = new Map<number, number>();
  private readonly exhaustedRuns = new Set<number>();
  private started = false;
  private loadedQueued = false;
  private unsubscribeSettings: (() => void) | undefined;

  constructor({
    runRepository,
    executor,
    concurrencySettings,
    maxConcurrentRuns,
    onExecutionError = defaultExecutionErrorReporter,
    retryDelayMs = 1_000
  }: RunSchedulerDependencies) {
    this.runRepository = runRepository;
    this.executor = executor;
    const staticConcurrency: ConcurrencySettings = {
      globalRunConcurrency: maxConcurrentRuns ?? 4,
      webhookConcurrency: 4,
      environmentBuildConcurrency: 1
    };
    this.concurrencySettings = concurrencySettings ?? {
      get: () => staticConcurrency,
      subscribe: () => () => undefined
    };
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
    this.unsubscribeSettings = this.concurrencySettings.subscribe(() => this.drain());
    this.drain();
  }

  /**
   * Adds a newly-created Run to the in-memory queue.
   */
  enqueue(runId: number): void {
    this.addPending(runId);
    this.drain();
  }

  /**
   * Stops scheduling queued work and requests cancellation of active Turns.
   */
  async stop(): Promise<void> {
    this.started = false;
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = undefined;
    this.pending.splice(0);
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.retryAttempts.clear();
    this.exhaustedRuns.clear();
    await Promise.all([...this.active.keys()].map(async (runId) => {
      await settleBestEffort(() => this.executor.cancel(runId));
    }));
  }

  private addPending(runId: number): void {
    if (!this.exhaustedRuns.has(runId) && !this.pending.includes(runId) && !this.active.has(runId)) {
      this.pending.push(runId);
    }
  }

  private drain(): void {
    if (!this.started) return;
    const globalLimit = this.concurrencySettings.get().globalRunConcurrency;
    while (this.active.size < globalLimit) {
      const next = this.nextRunnable(globalLimit);
      if (next === undefined) return;
      const { pendingIndex, runId, agentId } = next;
      this.pending.splice(pendingIndex, 1);
      this.active.set(runId, agentId);
      this.activeByAgent.set(agentId, (this.activeByAgent.get(agentId) ?? 0) + 1);
      void this.executor.execute(runId)
        .then((run) => this.handleExecutionSuccess(runId, run))
        .catch((error: unknown) => this.handleExecutionError(error, runId))
        .finally(() => {
          this.active.delete(runId);
          const activeForAgent = (this.activeByAgent.get(agentId) ?? 1) - 1;
          if (activeForAgent === 0) this.activeByAgent.delete(agentId);
          else this.activeByAgent.set(agentId, activeForAgent);
          this.drain();
        });
    }
  }

  private nextRunnable(globalLimit: number): {
    pendingIndex: number;
    runId: number;
    agentId: number;
  } | undefined {
    for (let pendingIndex = 0; pendingIndex < this.pending.length; pendingIndex += 1) {
      const runId = this.pending[pendingIndex]!;
      const context = this.runRepository.getSchedulingContext?.(runId) ?? {
        agentId: 0,
        maxConcurrentRuns: null
      };
      const agentLimit = Math.min(globalLimit, context.maxConcurrentRuns ?? globalLimit);
      if ((this.activeByAgent.get(context.agentId) ?? 0) < agentLimit) {
        return { pendingIndex, runId, agentId: context.agentId };
      }
    }
    return undefined;
  }

  private handleExecutionError(error: unknown, runId: number): void {
    this.reportExecutionError(error, runId);

    let run: Run | undefined;
    try {
      run = this.runRepository.get(runId);
    } catch (_inspectionError) {
      return;
    }
    if (run?.status !== "queued") {
      this.clearRunRetry(runId);
      return;
    }
    if (!this.started || this.retryTimers.has(runId) || this.exhaustedRuns.has(runId)) return;

    const attempts = this.retryAttempts.get(runId) ?? 0;
    if (attempts >= MAX_AUTOMATIC_RETRIES) {
      this.exhaustedRuns.add(runId);
      this.reportExecutionError(new RunSchedulerError("run_retry_exhausted"), runId);
      this.finalizeExhaustedRun(runId);
      return;
    }
    this.retryAttempts.set(runId, attempts + 1);

    const timer = setTimeout(() => {
      this.retryTimers.delete(runId);
      if (this.started) this.enqueue(runId);
    }, this.retryDelayMs);
    timer.unref?.();
    this.retryTimers.set(runId, timer);
  }

  private finalizeExhaustedRun(runId: number): void {
    try {
      const run = this.runRepository.get(runId);
      if (run?.status === "queued") this.runRepository.failQueued(runId, "run_retry_exhausted");
      const timer = this.retryTimers.get(runId);
      if (timer !== undefined) clearTimeout(timer);
      this.retryTimers.delete(runId);
      this.retryAttempts.delete(runId);
      return;
    } catch (_failureError) {
      if (!this.started || this.retryTimers.has(runId)) return;
    }

    const timer = setTimeout(() => {
      this.retryTimers.delete(runId);
      if (this.started) this.finalizeExhaustedRun(runId);
    }, this.retryDelayMs);
    timer.unref?.();
    this.retryTimers.set(runId, timer);
  }

  private handleExecutionSuccess(runId: number, run: Run): void {
    if (run.status !== "queued") this.clearRunRetry(runId);
  }

  private clearRunRetry(runId: number): void {
    const timer = this.retryTimers.get(runId);
    if (timer !== undefined) clearTimeout(timer);
    this.retryTimers.delete(runId);
    this.retryAttempts.delete(runId);
    this.exhaustedRuns.delete(runId);
  }

  private reportExecutionError(error: unknown, runId: number): void {
    try {
      const result = this.onExecutionError(error, runId) as unknown;
      if (result !== null && (typeof result === "object" || typeof result === "function")
        && typeof (result as { then?: unknown }).then === "function") {
        void Promise.resolve(result).catch(() => undefined);
      }
    } catch (_reportingError) {
      defaultExecutionErrorReporter(undefined, runId);
    }
  }
}
