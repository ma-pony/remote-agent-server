import type Database from "better-sqlite3";

export type UsageAnalysisSettings = { enabled: boolean };

/** Usage analysis is opt-in: a missing row means disabled. */
export const readUsageAnalysisEnabled = (db: Database.Database): boolean => {
  const row = db.prepare("SELECT usage_analysis_enabled AS enabled FROM system_settings WHERE scope = 'global'")
    .get() as { enabled: number } | undefined;
  return row?.enabled === 1;
};

/** Persists the global usage-analysis switch. Runs snapshot it when they start. */
export class UsageAnalysisSettingsStore {
  constructor(private readonly db: Database.Database) {}

  get(): UsageAnalysisSettings {
    return { enabled: readUsageAnalysisEnabled(this.db) };
  }

  update(input: UsageAnalysisSettings): UsageAnalysisSettings {
    this.db.prepare("UPDATE system_settings SET usage_analysis_enabled = ?, updated_at = ? WHERE scope = 'global'")
      .run(Number(input.enabled), new Date().toISOString());
    return this.get();
  }
}
