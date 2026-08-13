import type { SecretStore } from "../mcp/secret-store.js";
import type { RunRepository } from "../runs/run-repository.js";
import { RunRepositoryError } from "../runs/run-repository.js";
import type { RunScheduler } from "../runs/run-scheduler.js";
import type { SessionManager } from "../sessions/session-manager.js";
import type { IntegrationProjection } from "./integration-projection.js";
import type { IntegrationStore } from "./integration-store.js";
import type { IntegrationTask } from "./integration-types.js";

export type IntegrationTaskSchedulerDependencies = {
  store: IntegrationStore;
  runRepository: Pick<RunRepository, "create">;
  runScheduler: Pick<RunScheduler, "enqueue">;
  sessionManager: Pick<SessionManager, "replaceMcpParametersInTransaction">;
  secrets: Pick<SecretStore, "decrypt">;
  projection: Pick<IntegrationProjection, "recover">;
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

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
        for (const task of this.dependencies.store.listDispatchableTasks()) this.dispatch(task);
      } while (this.notifiedWhileDraining && this.started);
    } finally {
      this.draining = false;
    }
  }

  stop(): void {
    this.started = false;
    this.notifiedWhileDraining = false;
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
    } catch (error) {
      this.failBeforeRun(task, error);
      return;
    }

    try {
      const run = this.dependencies.runRepository.create(
        { sessionId: task.sessionId, input: task.effectivePrompt },
        {
          afterInsert: (created) => {
            this.dependencies.sessionManager.replaceMcpParametersInTransaction(task.sessionId, parameters);
            this.dependencies.store.linkTaskRunInTransaction(task.id, created.id);
          }
        }
      );
      this.dependencies.runScheduler.enqueue(run.id);
    } catch (error) {
      if (error instanceof RunRepositoryError && error.code === "session_busy") return;
      this.failBeforeRun(task, error);
    }
  }

  private failBeforeRun(task: IntegrationTask, error: unknown): void {
    const failed = this.dependencies.store.failTaskBeforeRun(task.id, errorMessage(error));
    if (failed !== undefined) queueMicrotask(() => this.notify());
  }
}
