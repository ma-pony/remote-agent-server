import type Database from "better-sqlite3";

/** A durable revision shared by the writer and read-only query workers. */
export const ensureUsageQueryVersion = (db: Database.Database): void => {
  if (db.readonly) return;
  db.exec(`CREATE TABLE IF NOT EXISTS agent_usage_query_version (
    id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, generation INTEGER NOT NULL);
    INSERT OR IGNORE INTO agent_usage_query_version VALUES(1,0,0)`);
};

/** Table and column names are internal constants, never request input. */
export const trackUsageQueryChanges = (db: Database.Database, table: string, columns?: readonly string[]): void => {
  if (db.readonly) return;
  ensureUsageQueryVersion(db);
  const update = columns ? `UPDATE OF ${columns.join(",")}` : "UPDATE";
  const changed = columns ? `WHEN ${columns.map(column => `NEW.${column} IS NOT OLD.${column}`).join(" OR ")}` : "";
  for (const [event, clause] of [["INSERT", ""], [update, changed], ["DELETE", ""]]) {
    const suffix = event.split(" ")[0]!.toLowerCase();
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_query_${suffix} AFTER ${event} ON ${table} ${clause}
      BEGIN UPDATE agent_usage_query_version SET revision=revision+1 WHERE id=1; END`);
  }
};

export const usageQueryVersion = (db: Database.Database): { revision: string; generation: number } => {
  const row = db.prepare("SELECT revision,generation FROM agent_usage_query_version WHERE id=1").get() as
    { revision: number; generation: number };
  return { revision: `${row.generation}:${row.revision}`, generation: row.generation };
};
