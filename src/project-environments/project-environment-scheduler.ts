import type { ProjectEnvironmentBuilder } from "./project-environment-builder.js";
import type { ProjectEnvironmentStore } from "./project-environment-store.js";
import type { ConcurrencySettingsStore } from "../settings/concurrency-settings-store.js";

export interface ProjectEnvironmentBuilderLike {
  checkAndBuild(environmentId: number): Promise<{ outcome: "unchanged" | "published"; revisionId?: number }>;
  stop(): Promise<void>;
}

export type ProjectEnvironmentSyncState = {
  status: "idle" | "queued" | "running";
  automatic: true;
  intervalMs: number;
  nextScheduledAt: string;
};

export interface ProjectEnvironmentCheckScheduler {
  start(): void;
  requestCheck(environmentId: number): Promise<void>;
  getState(environmentId: number): ProjectEnvironmentSyncState;
  stop(): Promise<void>;
}

type QueueEntry = {
  id: number;
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
};

/** Runs project-environment checks on a dynamically limited process-wide queue. */
export class ProjectEnvironmentScheduler implements ProjectEnvironmentCheckScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private queue: QueueEntry[] = [];
  private pending = new Map<number, QueueEntry>();
  private running = new Map<number, Promise<void>>();
  private unsubscribeSettings: (() => void) | undefined;
  private nextScheduledAtMs: number;

  constructor(private readonly dependencies: {
    store: ProjectEnvironmentStore;
    builder: ProjectEnvironmentBuilderLike | ProjectEnvironmentBuilder;
    intervalMs: number;
    concurrencySettings?: Pick<ConcurrencySettingsStore, "get" | "subscribe">;
  }) {
    this.nextScheduledAtMs = Date.now() + dependencies.intervalMs;
  }

  start(): void {
    if (this.timer !== undefined || this.stopped) return;
    this.ensureSettingsSubscription();
    this.nextScheduledAtMs = Date.now() + this.dependencies.intervalMs;
    this.timer = setInterval(() => {
      this.nextScheduledAtMs = Date.now() + this.dependencies.intervalMs;
      void this.runScheduledCheck();
    }, this.dependencies.intervalMs);
    this.timer.unref();
  }

  async runScheduledCheck(): Promise<void> {
    const requests = this.dependencies.store.list().map(({ id }) => this.requestCheck(id));
    await Promise.allSettled(requests);
  }

  requestCheck(environmentId: number): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("environment_scheduler_stopped"));
    this.ensureSettingsSubscription();
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
    this.drain();
    return promise;
  }

  getState(environmentId: number): ProjectEnvironmentSyncState {
    const status = this.running.has(environmentId)
      ? "running"
      : this.pending.has(environmentId) ? "queued" : "idle";
    return {
      status,
      automatic: true,
      intervalMs: this.dependencies.intervalMs,
      nextScheduledAt: new Date(this.nextScheduledAtMs).toISOString()
    };
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      await Promise.allSettled(this.running.values());
      return;
    }
    this.stopped = true;
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = undefined;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    const queued = this.queue.splice(0);
    for (const entry of queued) {
      this.pending.delete(entry.id);
      entry.reject(new Error("environment_scheduler_stopped"));
    }
    await this.dependencies.builder.stop();
    await Promise.allSettled(this.running.values());
  }

  private drain(): void {
    if (this.stopped) return;
    while (this.queue.length > 0 && this.running.size < this.buildConcurrency()) {
      const entry = this.queue.shift()!;
      const promise = this.runEntry(entry);
      this.running.set(entry.id, promise);
    }
  }

  private async runEntry(entry: QueueEntry): Promise<void> {
    try {
      await this.dependencies.builder.checkAndBuild(entry.id);
      entry.resolve();
    } catch (error) {
      entry.reject(error);
    } finally {
      this.running.delete(entry.id);
      this.pending.delete(entry.id);
      this.drain();
    }
  }

  private buildConcurrency(): number {
    return this.dependencies.concurrencySettings?.get().environmentBuildConcurrency ?? 1;
  }

  private ensureSettingsSubscription(): void {
    this.unsubscribeSettings ??= this.dependencies.concurrencySettings?.subscribe(() => this.drain());
  }
}
