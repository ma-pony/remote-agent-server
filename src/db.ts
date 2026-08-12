import Database from "better-sqlite3";

/**
 * Opens a SQLite database with the service connection settings.
 */
export const openDatabase = (path: string): Database.Database => {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
};

/**
 * Creates the first-version database schema.
 */
export const migrate = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('claude_code', 'codex', 'hermes')),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('idle', 'running')),
      provider_session_id TEXT,
      workspace_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
      input TEXT NOT NULL,
      result TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_active_run_per_session
    ON runs(session_id) WHERE status IN ('queued', 'running');

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      seq INTEGER NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('message', 'tool', 'status', 'error')),
      content_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(run_id, seq)
    );
  `);
};
