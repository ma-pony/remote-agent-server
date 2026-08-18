import type { SecretStore } from "../mcp/secret-store.js";
import type { RunRepository } from "../runs/run-repository.js";
import type { RunScheduler } from "../runs/run-scheduler.js";
import type { SessionManager } from "../sessions/session-manager.js";
import type { IntegrationProjection } from "./integration-projection.js";
import type { IntegrationStore } from "./integration-store.js";
import type { IntegrationTask } from "./integration-types.js";

export type IntegrationSchedulerFailure = {
  taskId: string;
  code: "integration_retry_exhausted";
};

export type IntegrationTaskSchedulerDependencies = {
  store: IntegrationStore;
  runRepository: Pick<RunRepository, "create">;
  runScheduler: Pick<RunScheduler, "enqueue">;
  sessionManager: Pick<SessionManager, "replaceMcpParametersInTransaction">;
  secrets: Pick<SecretStore, "decrypt">;
  projection: Pick<IntegrationProjection, "recover">;
  retryDelayMs?: number;
  onSchedulerError?: (failure: IntegrationSchedulerFailure) => undefined;
};

const MAX_AUTOMATIC_RETRIES = 3;

/** Writes the production-safe scheduler exhaustion report. */
export const reportIntegrationSchedulerError = (failure: IntegrationSchedulerFailure): undefined => {
  console.error(`${failure.code} taskId=${failure.taskId}`);
  return undefined;
};

const INVALID_PARAMETER_SNAPSHOT = {
  code: "invalid_parameter_snapshot",
  message: "Integration Task parameter snapshot is invalid"
} as const;
const DISPATCH_RETRY_EXHAUSTED = {
  code: "integration_dispatch_failed",
  message: "Integration Task could not be dispatched"
} as const;

const parseParameters = (serialized: string): Record<string, string | null> => {
  const value = JSON.parse(serialized) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid_integration_task_parameters");
  }
  for (const parameter of Object.values(value)) {
    if (parameter !== null && typeof parameter !== "string") {
      throw new Error("invalid_integration_task_parameters");
    }
  }
  return value as Record<string, string | null>;
};

/** Moves queued external Tasks into the global Run scheduler without polling. */
export class IntegrationTaskScheduler {
  private started = false;
  private draining = false;
  private notifiedWhileDraining = false;
  private readonly retryAttempts = new Map<string, number>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly exhaustedTasks = new Set<string>();
  private drainRetryAttempts = 0;
  private drainRetryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly dependencies: IntegrationTaskSchedulerDependencies) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.notify();
  }

  notify(): void {
    if (!this.started) return;
    if (this.draining) {
      this.notifiedWhileDraining = true;
      return;
    }

    this.draining = true;
    try {
      do {
        this.notifiedWhileDraining = false;
        for (const task of this.dependencies.store.listDispatchableTasks()) {
          if (!this.exhaustedTasks.has(task.id) && !this.retryTimers.has(task.id)) this.dispatch(task);
        }
      } while (this.notifiedWhileDraining && this.started);
      this.clearDrainRetry();
    } catch (_error) {
      this.scheduleDrainRetry();
    } finally {
      this.draining = false;
    }
  }

  stop(): void {
    this.started = false;
    this.notifiedWhileDraining = false;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.retryAttempts.clear();
    this.exhaustedTasks.clear();
    this.clearDrainRetry();
  }

  recover(): void {
    this.dependencies.projection.recover();
  }

  private dispatch(task: IntegrationTask): void {
    let parameters: Record<string, string | null>;
    try {
      parameters = task.encryptedParameters === null
        ? {}
        : parseParameters(this.dependencies.secrets.decrypt(task.encryptedParameters));
    } catch (_error) {
      this.failBeforeRun(task);
      return;
    }

    try {
      const run = this.dependencies.runRepository.create(
        { sessionId: task.sessionId, input: task.effectivePrompt },
        {
          afterInsert: (created) => {
            this.dependencies.sessionManager.replaceMcpParametersInTransaction(task.sessionId, parameters);
            this.dependencies.store.linkTaskRunInTransaction(task.id, created.id);
            return undefined;
          }
        }
      );
      this.clearTaskRetry(task.id);
      this.dependencies.store.notifyTaskChanged(task.id);
      this.dependencies.runScheduler.enqueue(run.id);
    } catch (_error) {
      this.scheduleTaskRetry(task.id);
    }
  }

  private failBeforeRun(task: IntegrationTask): void {
    try {
      const failed = this.dependencies.store.failTaskBeforeRun(task.id, INVALID_PARAMETER_SNAPSHOT);
      if (failed !== undefined) {
        this.clearTaskRetry(task.id);
        this.notify();
      }
    } catch (_error) {
      this.scheduleTaskRetry(task.id);
    }
  }

  private scheduleTaskRetry(taskId: string): void {
    if (!this.started || this.exhaustedTasks.has(taskId) || this.retryTimers.has(taskId)) return;
    const attempts = this.retryAttempts.get(taskId) ?? 0;
    if (attempts >= MAX_AUTOMATIC_RETRIES) {
      this.exhaustedTasks.add(taskId);
      this.reportSchedulerError({ taskId, code: "integration_retry_exhausted" });
      this.finalizeExhaustedTask(taskId);
      return;
    }

    this.retryAttempts.set(taskId, attempts + 1);
    const timer = setTimeout(() => {
      this.retryTimers.delete(taskId);
      if (!this.started || this.exhaustedTasks.has(taskId)) return;
      const task = this.dependencies.store.getTask(taskId);
      if (task?.status === "queued" && task.runId === null) this.dispatch(task);
      else this.clearTaskRetry(taskId);
    }, this.dependencies.retryDelayMs ?? 1_000);
    timer.unref?.();
    this.retryTimers.set(taskId, timer);
  }

  private finalizeExhaustedTask(taskId: string): void {
    try {
      const failed = this.dependencies.store.failTaskBeforeRun(taskId, DISPATCH_RETRY_EXHAUSTED);
      if (failed !== undefined || this.dependencies.store.getTask(taskId)?.status !== "queued") {
        this.clearTaskRetry(taskId);
        return;
      }
    } catch (_error) {
      // Retry the terminal write after transient database contention clears.
    }
    if (!this.started || this.retryTimers.has(taskId)) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(taskId);
      if (this.started) this.finalizeExhaustedTask(taskId);
    }, this.dependencies.retryDelayMs ?? 1_000);
    timer.unref?.();
    this.retryTimers.set(taskId, timer);
  }

  private clearTaskRetry(taskId: string): void {
    const timer = this.retryTimers.get(taskId);
    if (timer !== undefined) clearTimeout(timer);
    this.retryTimers.delete(taskId);
    this.retryAttempts.delete(taskId);
    this.exhaustedTasks.delete(taskId);
  }

  private scheduleDrainRetry(): void {
    if (!this.started || this.drainRetryTimer !== undefined || this.drainRetryAttempts >= MAX_AUTOMATIC_RETRIES) return;
    this.drainRetryAttempts += 1;
    this.drainRetryTimer = setTimeout(() => {
      this.drainRetryTimer = undefined;
      this.notify();
    }, this.dependencies.retryDelayMs ?? 1_000);
    this.drainRetryTimer.unref?.();
  }

  private clearDrainRetry(): void {
    if (this.drainRetryTimer !== undefined) clearTimeout(this.drainRetryTimer);
    this.drainRetryTimer = undefined;
    this.drainRetryAttempts = 0;
  }

  private reportSchedulerError(failure: IntegrationSchedulerFailure): void {
    try {
      const result = (this.dependencies.onSchedulerError ?? reportIntegrationSchedulerError)(failure) as unknown;
      if (result !== null && (typeof result === "object" || typeof result === "function")
        && typeof (result as { then?: unknown }).then === "function") {
        void Promise.resolve(result).catch(() => undefined);
      }
    } catch (_error) {
      // Scheduler error reporting is best effort and contains no raw failure details.
    }
  }
}
