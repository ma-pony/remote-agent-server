import type { ProjectEnvironmentBuilder } from "./project-environment-builder.js";
import type { ProjectEnvironmentStore } from "./project-environment-store.js";

export interface ProjectEnvironmentBuilderLike {
  checkAndBuild(environmentId: string): Promise<{ outcome: "unchanged" | "published"; revisionId?: string }>;
  stop(): Promise<void>;
}

export interface ProjectEnvironmentCheckScheduler {
  start(): void;
  requestCheck(environmentId: string): Promise<void>;
  stop(): Promise<void>;
}

type QueueEntry = {
  id: string;
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
};

/** Runs project-environment checks on one process-wide serial queue. */
export class ProjectEnvironmentScheduler implements ProjectEnvironmentCheckScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private queue: QueueEntry[] = [];
  private pending = new Map<string, QueueEntry>();
  private draining: Promise<void> | undefined;

  constructor(private readonly dependencies: {
    store: ProjectEnvironmentStore;
    builder: ProjectEnvironmentBuilderLike | ProjectEnvironmentBuilder;
    intervalMs: number;
  }) {}

  start(): void {
    if (this.timer !== undefined || this.stopped) return;
    this.timer = setInterval(() => { void this.runScheduledCheck(); }, this.dependencies.intervalMs);
    this.timer.unref();
  }

  async runScheduledCheck(): Promise<void> {
    const requests = this.dependencies.store.list().map(({ id }) => this.requestCheck(id));
    await Promise.allSettled(requests);
  }

  requestCheck(environmentId: string): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("environment_scheduler_stopped"));
    const existing = this.pending.get(environmentId);
    if (existing !== undefined) return existing.promise;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    const entry = { id: environmentId, promise, resolve, reject };
    this.pending.set(environmentId, entry);
    this.queue.push(entry);
    this.draining ??= this.drain().finally(() => { this.draining = undefined; });
    return promise;
  }

  async stop(): Promise<void> {
    if (this.stopped) return this.draining;
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    const queued = this.queue.splice(0);
    for (const entry of queued) {
      this.pending.delete(entry.id);
      entry.reject(new Error("environment_scheduler_stopped"));
    }
    await this.dependencies.builder.stop();
    await this.draining;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const entry = this.queue.shift()!;
      try {
        await this.dependencies.builder.checkAndBuild(entry.id);
        entry.resolve();
      } catch (error) {
        entry.reject(error);
      } finally {
        this.pending.delete(entry.id);
      }
    }
  }
}
