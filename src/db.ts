import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export type MigrationStorage = {
  dataDir: string;
  projectEnvironmentsRoot: string;
  sessionsRoot: string;
};

type IdMappings = Map<string, Map<string, number>>;

const mappedId = (mappings: IdMappings, table: string, value: unknown): unknown =>
  typeof value === "string" ? mappings.get(table)?.get(value) ?? value : value;

const moveDirectory = (source: string, destination: string, moved: Array<[string, string]>): void => {
  if (!existsSync(source) || source === destination) return;
  mkdirSync(dirname(destination), { recursive: true });
  renameSync(source, destination);
  moved.push([destination, source]);
};

const migrateAcpxSession = (
  storage: MigrationStorage,
  oldSessionId: string,
  newSessionId: number,
  oldWorkspaceRoot: string,
  newWorkspaceRoot: string,
  moved: Array<[string, string]>,
  rewrittenFiles: Array<[string, string]>
): void => {
  const oldKey = `remote-agent:${oldSessionId}`;
  const newKey = `remote-agent:${newSessionId}`;
  const oldRecord = join(storage.dataDir, "acpx", "sessions", `${encodeURIComponent(oldKey)}.json`);
  if (!existsSync(oldRecord)) return;
  const original = readFileSync(oldRecord, "utf8");
  const record = JSON.parse(original) as {
    name?: string;
    acpx_record_id?: string;
    cwd?: string;
    event_log?: { active_path?: string } | null;
  };
  record.name = newKey;
  record.acpx_record_id = newKey;
  if (typeof record.cwd === "string" && !relative(oldWorkspaceRoot, record.cwd).startsWith("..")) {
    record.cwd = resolve(newWorkspaceRoot, relative(oldWorkspaceRoot, record.cwd));
  }
  const activePath = record.event_log?.active_path;
  if (typeof activePath === "string") {
    const nextActivePath = activePath.replace(encodeURIComponent(oldKey), encodeURIComponent(newKey));
    const eventDirectory = dirname(activePath);
    if (existsSync(eventDirectory)) {
      for (const file of readdirSync(eventDirectory)) {
        if (!file.startsWith(`${encodeURIComponent(oldKey)}.stream`)) continue;
        moveDirectory(
          join(eventDirectory, file),
          join(eventDirectory, file.replace(encodeURIComponent(oldKey), encodeURIComponent(newKey))),
          moved
        );
      }
    }
    record.event_log!.active_path = nextActivePath;
  }
  writeFileSync(oldRecord, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  rewrittenFiles.push([oldRecord, original]);
  moveDirectory(
    oldRecord,
    join(storage.dataDir, "acpx", "sessions", `${encodeURIComponent(newKey)}.json`),
    moved
  );
};

const rewriteTaskKey = (key: string, taskIds: Map<string, number>): string => {
  const separator = key.indexOf(":");
  if (separator === -1) return key;
  const taskId = taskIds.get(key.slice(0, separator));
  return taskId === undefined ? key : `${taskId}${key.slice(separator)}`;
};

const rewriteIntegrationState = (db: Database.Database, mappings: IdMappings): void => {
  const taskIds = mappings.get("integration_tasks") ?? new Map();
  const rewriteKeyObject = (serialized: string): string => {
    const entries = Object.entries(JSON.parse(serialized) as Record<string, number>);
    return JSON.stringify(Object.fromEntries(entries.map(([key, value]) => [rewriteTaskKey(key, taskIds), value])));
  };
  const taskRows = db.prepare(
    "SELECT id, event_sequences_json, event_dispatch_orders_json FROM integration_tasks"
  ).all() as Array<{ id: number; event_sequences_json: string; event_dispatch_orders_json: string }>;
  const updateTask = db.prepare(
    "UPDATE integration_tasks SET event_sequences_json = ?, event_dispatch_orders_json = ? WHERE id = ?"
  );
  for (const row of taskRows) {
    updateTask.run(rewriteKeyObject(row.event_sequences_json), rewriteKeyObject(row.event_dispatch_orders_json), row.id);
  }

  const deliveryRows = db.prepare("SELECT id, event_key, payload_json FROM webhook_deliveries").all() as Array<{
    id: number; event_key: string; payload_json: string;
  }>;
  const updateDelivery = db.prepare(
    "UPDATE webhook_deliveries SET event_key = ?, payload_json = ? WHERE id = ?"
  );
  for (const row of deliveryRows) {
    const payload = JSON.parse(row.payload_json) as {
      endpoint?: { id?: unknown };
      task?: { id?: unknown; sessionId?: unknown; runId?: unknown } | null;
    };
    if (payload.endpoint) payload.endpoint.id = mappedId(mappings, "integration_endpoints", payload.endpoint.id);
    if (payload.task) {
      payload.task.id = mappedId(mappings, "integration_tasks", payload.task.id);
      payload.task.sessionId = mappedId(mappings, "sessions", payload.task.sessionId);
      payload.task.runId = mappedId(mappings, "runs", payload.task.runId);
    }
    updateDelivery.run(rewriteTaskKey(row.event_key, taskIds), JSON.stringify(payload), row.id);
  }
};

const migrateStorage = (
  db: Database.Database,
  storage: MigrationStorage,
  mappings: IdMappings,
  moved: Array<[string, string]>,
  rewrittenFiles: Array<[string, string]>
): void => {
  for (const [oldId, newId] of mappings.get("agents") ?? []) {
    moveDirectory(join(storage.dataDir, "agents", oldId), join(storage.dataDir, "agents", String(newId)), moved);
  }
  const oldAgentByNewId = new Map(
    [...(mappings.get("agents") ?? [])].map(([oldId, newId]) => [newId, oldId])
  );
  for (const [oldId, newId] of mappings.get("sessions") ?? []) {
    const session = db.prepare("SELECT agent_id, workspace_path FROM sessions WHERE id = ?").get(newId) as
      | { agent_id: number; workspace_path: string }
      | undefined;
    const oldAgentId = session === undefined ? undefined : oldAgentByNewId.get(session.agent_id);
    if (session !== undefined && oldAgentId !== undefined) {
      const codexSessions = join(
        storage.dataDir, "agents", String(session.agent_id), "provider-home", "codex", "sessions"
      );
      moveDirectory(join(codexSessions, oldId), join(codexSessions, String(newId)), moved);
    }
    const source = resolve(storage.sessionsRoot, oldId);
    const destination = resolve(storage.sessionsRoot, String(newId));
    migrateAcpxSession(storage, oldId, newId, source, destination, moved, rewrittenFiles);
    moveDirectory(source, destination, moved);
    if (session !== undefined && !relative(source, session.workspace_path).startsWith("..")) {
      db.prepare("UPDATE sessions SET workspace_path = ? WHERE id = ?")
        .run(resolve(destination, relative(source, session.workspace_path)), newId);
    }
  }
  for (const [oldId, newId] of mappings.get("project_environments") ?? []) {
    const source = resolve(storage.projectEnvironmentsRoot, oldId);
    const destination = resolve(storage.projectEnvironmentsRoot, String(newId));
    moveDirectory(source, destination, moved);
    const revisions = db.prepare(
      "SELECT id, workspace_path FROM project_environment_revisions WHERE project_environment_id = ? AND workspace_path IS NOT NULL"
    ).all(newId) as Array<{ id: number; workspace_path: string }>;
    for (const revision of revisions) {
      if (relative(source, revision.workspace_path).startsWith("..")) continue;
      db.prepare("UPDATE project_environment_revisions SET workspace_path = ? WHERE id = ?")
        .run(resolve(destination, relative(source, revision.workspace_path)), revision.id);
    }
  }
};

const BUSINESS_TABLES = [
  "project_environments",
  "project_environment_revisions",
  "environment_repositories",
  "agents",
  "agent_mcp_servers",
  "agent_session_parameters",
  "agent_mcp_values",
  "sessions",
  "session_mcp_parameter_values",
  "runs",
  "events",
  "integration_endpoints",
  "integration_conversations",
  "integration_tasks",
  "webhook_subscriptions",
  "webhook_deliveries"
] as const;

const FOREIGN_ID_TABLES: Record<string, Record<string, string>> = {
  project_environments: { current_revision_id: "project_environment_revisions" },
  project_environment_revisions: { project_environment_id: "project_environments" },
  environment_repositories: { project_environment_id: "project_environments" },
  agents: { project_environment_id: "project_environments" },
  agent_mcp_servers: { agent_id: "agents" },
  agent_session_parameters: { agent_id: "agents" },
  agent_mcp_values: {
    mcp_server_id: "agent_mcp_servers",
    session_parameter_id: "agent_session_parameters"
  },
  sessions: {
    agent_id: "agents",
    project_environment_revision_id: "project_environment_revisions"
  },
  session_mcp_parameter_values: {
    session_id: "sessions",
    parameter_id: "agent_session_parameters"
  },
  runs: { session_id: "sessions" },
  events: { run_id: "runs" },
  integration_endpoints: { agent_id: "agents" },
  integration_conversations: {
    endpoint_id: "integration_endpoints",
    session_id: "sessions"
  },
  integration_tasks: {
    endpoint_id: "integration_endpoints",
    conversation_id: "integration_conversations",
    session_id: "sessions",
    run_id: "runs"
  },
  webhook_subscriptions: { endpoint_id: "integration_endpoints" },
  webhook_deliveries: {
    subscription_id: "webhook_subscriptions",
    task_id: "integration_tasks"
  }
};

const tableExists = (db: Database.Database, table: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;

const columnNames = (db: Database.Database, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name);

const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

const migrateTextIds = (db: Database.Database, storage?: MigrationStorage): void => {
  const existingTables = BUSINESS_TABLES.filter((table) => tableExists(db, table));
  const moved: Array<[string, string]> = [];
  const rewrittenFiles: Array<[string, string]> = [];
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      for (const index of [
        "one_preparing_revision_per_environment",
        "one_active_run_per_session",
        "one_active_conversation_per_key",
        "integration_tasks_dispatch_order",
        "webhook_deliveries_due"
      ]) {
        db.exec(`DROP INDEX IF EXISTS ${quote(index)}`);
      }
      for (const table of existingTables) {
        db.exec(`ALTER TABLE ${quote(table)} RENAME TO ${quote(`legacy_${table}`)}`);
      }

      migrate(db);

      const mappedTables = existingTables.filter((table) =>
        columnNames(db, `legacy_${table}`).includes("id")
      );
      const mappedTableSet = new Set<string>(mappedTables);
      for (const table of mappedTables) {
        db.exec(`
          CREATE TEMP TABLE ${quote(`id_map_${table}`)} AS
          SELECT id AS old_id, ROW_NUMBER() OVER (ORDER BY rowid) AS new_id
          FROM ${quote(`legacy_${table}`)}
        `);
        db.exec(`CREATE UNIQUE INDEX ${quote(`id_map_${table}_old`)} ON ${quote(`id_map_${table}`)}(old_id)`);
      }
      const mappings: IdMappings = new Map(mappedTables.map((table) => [
        table,
        new Map((db.prepare(`SELECT old_id, new_id FROM ${quote(`id_map_${table}`)}`).all() as Array<{
          old_id: string; new_id: number;
        }>).map(({ old_id: oldId, new_id: newId }) => [oldId, newId]))
      ]));

      for (const table of existingTables) {
        const legacyTable = `legacy_${table}`;
        const sourceColumns = columnNames(db, legacyTable);
        const targetColumns = columnNames(db, table);
        const ownMap = mappedTables.includes(table);
        const columns = targetColumns.filter((column) =>
          (column === "id" && ownMap) || sourceColumns.includes(column)
        );
        const joins: string[] = [];
        const selections = columns.map((column) => {
          if (column === "id" && ownMap) return "own_id.new_id";
          const referencedTable = FOREIGN_ID_TABLES[table]?.[column];
          if (referencedTable && mappedTableSet.has(referencedTable)) {
            const alias = `fk_${column}`;
            joins.push(
              `LEFT JOIN ${quote(`id_map_${referencedTable}`)} ${quote(alias)} ` +
              `ON source.${quote(column)} = ${quote(alias)}.old_id`
            );
            return `${quote(alias)}.new_id`;
          }
          return `source.${quote(column)}`;
        });
        const ownJoin = ownMap
          ? `JOIN ${quote(`id_map_${table}`)} own_id ON source.id = own_id.old_id`
          : "";
        db.exec(`
          INSERT INTO ${quote(table)} (${columns.map(quote).join(", ")})
          SELECT ${selections.join(", ")}
          FROM ${quote(legacyTable)} source
          ${ownJoin}
          ${joins.join("\n")}
        `);
        const sourceCount = (db.prepare(`SELECT COUNT(*) AS count FROM ${quote(legacyTable)}`).get() as { count: number }).count;
        const targetCount = (db.prepare(`SELECT COUNT(*) AS count FROM ${quote(table)}`).get() as { count: number }).count;
        if (sourceCount !== targetCount) throw new Error(`ID migration count mismatch for ${table}`);
      }

      const foreignKeyErrors = db.prepare("PRAGMA foreign_key_check").all();
      if (foreignKeyErrors.length > 0) throw new Error("ID migration produced invalid foreign keys");

      rewriteIntegrationState(db, mappings);
      if (storage !== undefined) migrateStorage(db, storage, mappings, moved, rewrittenFiles);

      for (const table of [...existingTables].reverse()) {
        db.exec(`DROP TABLE ${quote(`legacy_${table}`)}`);
      }
      for (const table of mappedTables) {
        db.exec(`DROP TABLE ${quote(`id_map_${table}`)}`);
      }
      db.pragma("user_version = 2");
    })();
  } catch (error) {
    for (const [source, destination] of moved.reverse()) {
      if (existsSync(source) && !existsSync(destination)) renameSync(source, destination);
    }
    for (const [path, original] of rewrittenFiles) writeFileSync(path, original, "utf8");
    throw error;
  } finally {
    db.pragma("foreign_keys = ON");
  }
};

/**
 * Opens a SQLite database with the service connection settings.
 */
export const openDatabase = (path: string): Database.Database => {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
};

/** Returns the numeric primary key generated by SQLite. */
export const insertedId = (result: Database.RunResult): number => Number(result.lastInsertRowid);

/**
 * Creates the first-version database schema.
 */
export const migrate = (db: Database.Database, storage?: MigrationStorage): void => {
  if (tableExists(db, "agents")) {
    const idColumn = (db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string; type: string }>)
      .find(({ name }) => name === "id");
    if (idColumn?.type.toUpperCase() === "TEXT") {
      migrateTextIds(db, storage);
      return;
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS project_environments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      current_revision_id INTEGER,
      last_checked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_environment_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_environment_id INTEGER NOT NULL REFERENCES project_environments(id),
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
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_environment_id INTEGER NOT NULL REFERENCES project_environments(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      git_url TEXT NOT NULL,
      prepare_command TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_environment_id, name)
    );

    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('claude_code', 'codex', 'hermes')),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      instructions TEXT NOT NULL DEFAULT '',
      project_environment_id INTEGER REFERENCES project_environments(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_mcp_servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      transport TEXT NOT NULL CHECK (transport IN ('http', 'stdio')),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      url TEXT,
      command TEXT,
      check_timeout_seconds INTEGER NOT NULL DEFAULT 30,
      last_checked_at TEXT,
      last_check_status TEXT CHECK (last_check_status IN ('passed', 'failed')),
      last_check_message TEXT,
      last_tool_count INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id, name)
    );

    CREATE TABLE IF NOT EXISTS agent_session_parameters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      label TEXT NOT NULL,
      description TEXT,
      required INTEGER NOT NULL CHECK (required IN (0, 1)),
      secret INTEGER NOT NULL CHECK (secret IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id, key)
    );

    CREATE TABLE IF NOT EXISTS agent_mcp_values (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mcp_server_id INTEGER NOT NULL REFERENCES agent_mcp_servers(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('argument', 'header', 'environment')),
      position INTEGER NOT NULL,
      target_name TEXT,
      source_type TEXT NOT NULL CHECK (source_type IN ('fixed', 'session_parameter', 'runtime')),
      plain_value TEXT,
      encrypted_value TEXT,
      secret INTEGER NOT NULL DEFAULT 0 CHECK (secret IN (0, 1)),
      session_parameter_id INTEGER REFERENCES agent_session_parameters(id),
      runtime_key TEXT,
      UNIQUE(mcp_server_id, kind, position)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL REFERENCES agents(id),
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('idle', 'running')),
      provider_session_id TEXT,
      workspace_path TEXT NOT NULL UNIQUE,
      project_environment_revision_id INTEGER REFERENCES project_environment_revisions(id),
      instructions_snapshot TEXT NOT NULL DEFAULT '',
      input_tokens INTEGER,
      output_tokens INTEGER,
      cached_read_tokens INTEGER,
      cached_write_tokens INTEGER,
      thought_tokens INTEGER,
      total_tokens INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_mcp_parameter_values (
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      parameter_id INTEGER NOT NULL REFERENCES agent_session_parameters(id) ON DELETE RESTRICT,
      plain_value TEXT,
      encrypted_value TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(session_id, parameter_id)
    );

    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id),
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
      input TEXT NOT NULL,
      result TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cached_read_tokens INTEGER,
      cached_write_tokens INTEGER,
      thought_tokens INTEGER,
      total_tokens INTEGER,
      context_used_tokens INTEGER,
      context_window_tokens INTEGER
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_active_run_per_session
    ON runs(session_id) WHERE status IN ('queued', 'running');

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES runs(id),
      seq INTEGER NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('message', 'tool', 'status', 'error')),
      content_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(run_id, seq)
    );

    CREATE TABLE IF NOT EXISTS integration_endpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      agent_id INTEGER NOT NULL REFERENCES agents(id),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      token_hash TEXT NOT NULL UNIQUE,
      prompt_prefix TEXT NOT NULL DEFAULT '',
      parameter_mappings_json TEXT NOT NULL DEFAULT '[]',
      encrypted_fixed_values TEXT,
      next_delivery_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS integration_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint_id INTEGER NOT NULL REFERENCES integration_endpoints(id),
      conversation_key TEXT NOT NULL,
      session_id INTEGER NOT NULL REFERENCES sessions(id),
      status TEXT NOT NULL CHECK (status IN ('active', 'ended')),
      created_at TEXT NOT NULL,
      ended_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_active_conversation_per_key
    ON integration_conversations(endpoint_id, conversation_key) WHERE status = 'active';

    CREATE TABLE IF NOT EXISTS integration_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint_id INTEGER NOT NULL REFERENCES integration_endpoints(id),
      conversation_id INTEGER REFERENCES integration_conversations(id),
      session_id INTEGER NOT NULL REFERENCES sessions(id),
      run_id INTEGER UNIQUE REFERENCES runs(id),
      request_id TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      message TEXT NOT NULL,
      effective_prompt TEXT NOT NULL,
      encrypted_parameters TEXT,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
      result TEXT,
      error TEXT,
      event_sequence INTEGER NOT NULL DEFAULT 0,
      event_sequences_json TEXT NOT NULL DEFAULT '{}',
      event_dispatch_orders_json TEXT NOT NULL DEFAULT '{}',
      public_notice_code TEXT,
      public_notice_message TEXT,
      public_notice_event_seq INTEGER,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      UNIQUE(endpoint_id, request_id)
    );

    CREATE INDEX IF NOT EXISTS integration_tasks_dispatch_order
    ON integration_tasks(status, created_at, id);

    CREATE TABLE IF NOT EXISTS webhook_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint_id INTEGER NOT NULL REFERENCES integration_endpoints(id),
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      events_json TEXT NOT NULL,
      encrypted_headers TEXT,
      encrypted_signing_secret TEXT NOT NULL,
      timeout_seconds INTEGER NOT NULL DEFAULT 10,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      dispatch_order INTEGER NOT NULL,
      subscription_id INTEGER NOT NULL REFERENCES webhook_subscriptions(id),
      task_id INTEGER REFERENCES integration_tasks(id),
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'delivering', 'succeeded', 'failed')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      last_status_code INTEGER,
      last_duration_ms INTEGER,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(subscription_id, event_key)
    );

    CREATE INDEX IF NOT EXISTS webhook_deliveries_due
    ON webhook_deliveries(status, next_attempt_at, dispatch_order);
  `);

  const hasColumn = (table: string, column: string): boolean =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((item) => item.name === column);

  if (!hasColumn("agents", "project_environment_id")) {
    db.exec("ALTER TABLE agents ADD COLUMN project_environment_id INTEGER REFERENCES project_environments(id)");
  }
  if (!hasColumn("agents", "instructions")) {
    db.exec("ALTER TABLE agents ADD COLUMN instructions TEXT NOT NULL DEFAULT ''");
  }
  if (!hasColumn("sessions", "project_environment_revision_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN project_environment_revision_id INTEGER REFERENCES project_environment_revisions(id)");
  }
  if (!hasColumn("sessions", "instructions_snapshot")) {
    db.exec("ALTER TABLE sessions ADD COLUMN instructions_snapshot TEXT NOT NULL DEFAULT ''");
  }
  for (const column of [
    "input_tokens",
    "output_tokens",
    "cached_read_tokens",
    "cached_write_tokens",
    "thought_tokens",
    "total_tokens"
  ]) {
    if (!hasColumn("sessions", column)) db.exec(`ALTER TABLE sessions ADD COLUMN ${column} INTEGER`);
  }
  if (!hasColumn("integration_tasks", "event_sequences_json")) {
    db.exec("ALTER TABLE integration_tasks ADD COLUMN event_sequences_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!hasColumn("integration_endpoints", "next_delivery_order")) {
    db.exec("ALTER TABLE integration_endpoints ADD COLUMN next_delivery_order INTEGER NOT NULL DEFAULT 0");
  }
  if (!hasColumn("integration_tasks", "event_dispatch_orders_json")) {
    db.exec("ALTER TABLE integration_tasks ADD COLUMN event_dispatch_orders_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!hasColumn("webhook_deliveries", "dispatch_order")) {
    db.exec("ALTER TABLE webhook_deliveries ADD COLUMN dispatch_order INTEGER NOT NULL DEFAULT 0");
  }
  if (!hasColumn("integration_tasks", "public_notice_code")) {
    db.exec("ALTER TABLE integration_tasks ADD COLUMN public_notice_code TEXT");
  }
  if (!hasColumn("integration_tasks", "public_notice_message")) {
    db.exec("ALTER TABLE integration_tasks ADD COLUMN public_notice_message TEXT");
  }
  if (!hasColumn("integration_tasks", "public_notice_event_seq")) {
    db.exec("ALTER TABLE integration_tasks ADD COLUMN public_notice_event_seq INTEGER");
  }
  for (const column of [
    "input_tokens",
    "output_tokens",
    "cached_read_tokens",
    "cached_write_tokens",
    "thought_tokens",
    "total_tokens",
    "context_used_tokens",
    "context_window_tokens"
  ]) {
    if (!hasColumn("runs", column)) db.exec(`ALTER TABLE runs ADD COLUMN ${column} INTEGER`);
  }
};
