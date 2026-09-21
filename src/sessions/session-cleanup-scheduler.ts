import type { ConcurrencySettingsStore } from "../settings/concurrency-settings-store.js";
import { SessionManagerError, type SessionManager } from "./session-manager.js";

export interface SessionCleanupSchedulerLike {
  start(): void;
  runCleanup(): Promise<void>;
  stop(): void | Promise<void>;
}

/** Periodically releases large storage owned by idle Sessions after their retention period. */
export class SessionCleanupScheduler implements SessionCleanupSchedulerLike {
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private running: Promise<void> | undefined;

  constructor(private readonly dependencies: {
    sessionManager: Pick<SessionManager, "listExpiredIds" | "cleanupStorage">;
    runtimeSettings?: Pick<ConcurrencySettingsStore, "getRuntime">;
    retentionMs: number;
    intervalMs: number;
    now?: () => Date;
    onError?: (error: unknown) => void;
  }) {}

  start(): void {
    if (this.stopped || this.timer !== undefined) return;
    void this.runCleanup().catch((error: unknown) => (this.dependencies.onError ?? console.error)(error));
    this.timer = setInterval(() => {
      void this.runCleanup().catch((error: unknown) => (this.dependencies.onError ?? console.error)(error));
    }, this.dependencies.intervalMs);
    this.timer.unref();
  }

  runCleanup(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const retentionMs = this.retentionMs();
    this.running ??= this.cleanup(retentionMs).finally(() => { this.running = undefined; });
    return this.running;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  private async cleanup(retentionMs: number): Promise<void> {
    const now = this.dependencies.now?.() ?? new Date();
    // Disabling retention prevents new claims but still completes already admitted cleanup.
    const cutoff = retentionMs === 0 ? "" : new Date(now.getTime() - retentionMs).toISOString();
    for (const id of this.dependencies.sessionManager.listExpiredIds(cutoff)) {
      try {
        await this.dependencies.sessionManager.cleanupStorage(id, cutoff, now.toISOString());
      } catch (error) {
        if (error instanceof SessionManagerError && (error.code === "session_not_found" || error.code === "session_busy")) {
          continue;
        }
        (this.dependencies.onError ?? console.error)(error);
      }
    }
  }

  private retentionMs(): number {
    if (this.dependencies.runtimeSettings === undefined) return this.dependencies.retentionMs;
    return this.dependencies.runtimeSettings.getRuntime().sessionStorageRetentionHours * 60 * 60 * 1000;
  }
}
