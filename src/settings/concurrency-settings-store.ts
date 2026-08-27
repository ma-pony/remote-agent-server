import type Database from "better-sqlite3";

export type ConcurrencySettings = {
  globalRunConcurrency: number;
  webhookConcurrency: number;
  environmentBuildConcurrency: number;
};

type ConcurrencySettingsRow = {
  global_run_concurrency: number;
  webhook_concurrency: number;
  environment_build_concurrency: number;
};

const toSettings = (row: ConcurrencySettingsRow): ConcurrencySettings => ({
  globalRunConcurrency: row.global_run_concurrency,
  webhookConcurrency: row.webhook_concurrency,
  environmentBuildConcurrency: row.environment_build_concurrency
});

/** Persists the single global concurrency snapshot and publishes committed updates. */
export class ConcurrencySettingsStore {
  private readonly listeners = new Set<(settings: ConcurrencySettings) => void>();

  constructor(private readonly db: Database.Database) {}

  get(): ConcurrencySettings {
    const row = this.db.prepare(`
      SELECT global_run_concurrency, webhook_concurrency, environment_build_concurrency
      FROM system_settings
      WHERE scope = 'global'
    `).get() as ConcurrencySettingsRow | undefined;
    if (row === undefined) throw new Error("global_concurrency_settings_missing");
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
