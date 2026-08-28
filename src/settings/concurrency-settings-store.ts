import type Database from "better-sqlite3";

export type ConcurrencySettings = {
  globalRunConcurrency: number;
  webhookConcurrency: number;
  environmentBuildConcurrency: number;
};

export type RuntimeSettings = {
  runTimeoutMinutes: number;
  sessionStorageRetentionHours: number;
};

export type SystemSettings = ConcurrencySettings & RuntimeSettings;

type ConcurrencySettingsRow = {
  global_run_concurrency: number;
  webhook_concurrency: number;
  environment_build_concurrency: number;
  run_timeout_minutes: number;
  session_storage_retention_hours: number;
};

const toSettings = (row: ConcurrencySettingsRow): SystemSettings => ({
  globalRunConcurrency: row.global_run_concurrency,
  webhookConcurrency: row.webhook_concurrency,
  environmentBuildConcurrency: row.environment_build_concurrency,
  runTimeoutMinutes: row.run_timeout_minutes,
  sessionStorageRetentionHours: row.session_storage_retention_hours
});

/** Persists the single global concurrency snapshot and publishes committed updates. */
export class ConcurrencySettingsStore {
  private readonly listeners = new Set<(settings: ConcurrencySettings) => void>();

  constructor(private readonly db: Database.Database) {}

  get(): ConcurrencySettings {
    const row = this.db.prepare(`
      SELECT global_run_concurrency, webhook_concurrency, environment_build_concurrency,
             run_timeout_minutes, session_storage_retention_hours
      FROM system_settings
      WHERE scope = 'global'
    `).get() as ConcurrencySettingsRow | undefined;
    if (row === undefined) throw new Error("global_concurrency_settings_missing");
    const settings = toSettings(row);
    return {
      globalRunConcurrency: settings.globalRunConcurrency,
      webhookConcurrency: settings.webhookConcurrency,
      environmentBuildConcurrency: settings.environmentBuildConcurrency
    };
  }

  getRuntime(): RuntimeSettings {
    const settings = this.getAll();
    return {
      runTimeoutMinutes: settings.runTimeoutMinutes,
      sessionStorageRetentionHours: settings.sessionStorageRetentionHours
    };
  }

  getAll(): SystemSettings {
    const row = this.db.prepare(`
      SELECT global_run_concurrency, webhook_concurrency, environment_build_concurrency,
             run_timeout_minutes, session_storage_retention_hours
      FROM system_settings
      WHERE scope = 'global'
    `).get() as ConcurrencySettingsRow | undefined;
    if (row === undefined) throw new Error("global_system_settings_missing");
    return toSettings(row);
  }

  update(input: ConcurrencySettings): ConcurrencySettings {
    const updatedAt = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE system_settings
        SET global_run_concurrency = ?, webhook_concurrency = ?,
            environment_build_concurrency = ?, updated_at = ?
        WHERE scope = 'global'
      `).run(
        input.globalRunConcurrency,
        input.webhookConcurrency,
        input.environmentBuildConcurrency,
        updatedAt
      );
    })();
    const settings = this.get();
    this.publish(settings);
    return settings;
  }

  updateAll(input: SystemSettings): SystemSettings {
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE system_settings
        SET global_run_concurrency = ?, webhook_concurrency = ?,
            environment_build_concurrency = ?, run_timeout_minutes = ?,
            session_storage_retention_hours = ?, updated_at = ?
        WHERE scope = 'global'
      `).run(
        input.globalRunConcurrency,
        input.webhookConcurrency,
        input.environmentBuildConcurrency,
        input.runTimeoutMinutes,
        input.sessionStorageRetentionHours,
        new Date().toISOString()
      );
    })();
    const settings = this.getAll();
    this.publish({
      globalRunConcurrency: settings.globalRunConcurrency,
      webhookConcurrency: settings.webhookConcurrency,
      environmentBuildConcurrency: settings.environmentBuildConcurrency
    });
    return settings;
  }

  /** Wakes live schedulers after an Agent-specific concurrency limit changes. */
  notify(): void {
    this.publish(this.get());
  }

  subscribe(listener: (settings: ConcurrencySettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(settings: ConcurrencySettings): void {
    for (const listener of this.listeners) listener(settings);
  }
}
