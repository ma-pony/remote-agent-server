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
    CREATE TABLE IF NOT EXISTS project_environments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      current_revision_id TEXT,
      last_checked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_environment_revisions (
      id TEXT PRIMARY KEY,
      project_environment_id TEXT NOT NULL REFERENCES project_environments(id),
      status TEXT NOT NULL CHECK (status IN ('preparing', 'ready', 'failed')),
      workspace_path TEXT UNIQUE,
      input_fingerprint TEXT NOT NULL,
      failure_stage TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_preparing_revision_per_environment
    ON project_environment_revisions(project_environment_id) WHERE status = 'preparing';

    CREATE TABLE IF NOT EXISTS environment_repositories (
      id TEXT PRIMARY KEY,
      project_environment_id TEXT NOT NULL REFERENCES project_environments(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      git_url TEXT NOT NULL,
      prepare_command TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_environment_id, name)
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('claude_code', 'codex', 'hermes')),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      project_environment_id TEXT REFERENCES project_environments(id),
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
      project_environment_revision_id TEXT REFERENCES project_environment_revisions(id),
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

  const hasColumn = (table: string, column: string): boolean =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((item) => item.name === column);

  if (!hasColumn("agents", "project_environment_id")) {
    db.exec("ALTER TABLE agents ADD COLUMN project_environment_id TEXT REFERENCES project_environments(id)");
  }
  if (!hasColumn("sessions", "project_environment_revision_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN project_environment_revision_id TEXT REFERENCES project_environment_revisions(id)");
  }
};
