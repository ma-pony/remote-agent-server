import { SessionManagerError, type SessionManager } from "./session-manager.js";

export interface SessionCleanupSchedulerLike {
  start(): void;
  runCleanup(): Promise<void>;
  stop(): void;
}

/** Periodically removes idle Sessions after their configured retention period. */
export class SessionCleanupScheduler implements SessionCleanupSchedulerLike {
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private running: Promise<void> | undefined;

  constructor(private readonly dependencies: {
    sessionManager: Pick<SessionManager, "listExpiredIds" | "delete">;
    retentionMs: number;
    intervalMs: number;
    now?: () => Date;
    onError?: (error: unknown) => void;
  }) {}

  start(): void {
    if (this.stopped || this.timer !== undefined || this.dependencies.retentionMs === 0) return;
    this.timer = setInterval(() => void this.runCleanup(), this.dependencies.intervalMs);
    this.timer.unref();
  }

  runCleanup(): Promise<void> {
    if (this.dependencies.retentionMs === 0) return Promise.resolve();
    this.running ??= this.cleanup().finally(() => { this.running = undefined; });
    return this.running;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async cleanup(): Promise<void> {
    const now = this.dependencies.now?.() ?? new Date();
    const cutoff = new Date(now.getTime() - this.dependencies.retentionMs).toISOString();
    for (const id of this.dependencies.sessionManager.listExpiredIds(cutoff)) {
      try {
        await this.dependencies.sessionManager.delete(id);
      } catch (error) {
        if (error instanceof SessionManagerError && (error.code === "session_not_found" || error.code === "session_busy")) {
          continue;
        }
        (this.dependencies.onError ?? console.error)(error);
      }
    }
  }
}
