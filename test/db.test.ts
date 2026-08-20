import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { migrate, openDatabase } from "../src/db.js";
import { createTestDatabase } from "./helpers.js";

const validEnv = {
  API_TOKEN: "test-token",
  DATA_DIR: "/var/lib/remote-agent",
  DATABASE_PATH: "/var/lib/remote-agent/remote-agent.sqlite3",
  SESSIONS_ROOT: "/var/lib/remote-agent/sessions"
};

describe("configuration", () => {
  it("拒绝缺少 API_TOKEN 的配置", () => {
    const { API_TOKEN: _apiToken, ...envWithoutToken } = validEnv;

    expect(() => loadConfig(envWithoutToken)).toThrow(/API_TOKEN/);
  });

  it("默认最大并发为 4", () => {
    expect(loadConfig(validEnv).maxConcurrentRuns).toBe(4);
  });

  it("项目环境默认每三小时检查且准备命令最多运行三十分钟", () => {
    const config = loadConfig(validEnv);

    expect(config.projectEnvironmentCheckIntervalMs).toBe(3 * 60 * 60 * 1000);
    expect(config.projectPrepareTimeoutMs).toBe(30 * 60 * 1000);
    expect(config.projectEnvironmentsRoot).toBe("/srv/remote-agent/environments");
  });
});

describe("database migration", () => {
  it("所有本地业务表使用公开数字自增主键", () => {
    const { db } = createTestDatabase();
    const tables = [
      "project_environments",
      "project_environment_revisions",
      "environment_repositories",
      "agents",
      "agent_mcp_servers",
      "agent_session_parameters",
      "agent_mcp_values",
      "sessions",
      "runs",
      "events",
      "integration_endpoints",
      "integration_conversations",
      "integration_tasks",
      "webhook_subscriptions",
      "webhook_deliveries"
    ];

    for (const table of tables) {
      const id = db.prepare(`PRAGMA table_info(${table})`).all()
        .find((row) => (row as { name: string }).name === "id") as { type: string; pk: number };
      expect(id, table).toMatchObject({ type: "INTEGER", pk: 1 });
    }

    const first = db.prepare(
      "INSERT INTO project_environments (name, created_at, updated_at) VALUES (?, ?, ?)"
    ).run("Auto ID 1", "2026-08-19T00:00:00.000Z", "2026-08-19T00:00:00.000Z");
    const second = db.prepare(
      "INSERT INTO project_environments (name, created_at, updated_at) VALUES (?, ?, ?)"
    ).run("Auto ID 2", "2026-08-19T00:00:00.000Z", "2026-08-19T00:00:00.000Z");

    expect(Number(second.lastInsertRowid)).toBe(Number(first.lastInsertRowid) + 1);
    db.close();
  });

  it("创建执行记录、项目环境、MCP 和 Integration 十六张业务表", () => {
    const { db } = createTestDatabase();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(tables).toEqual([
      "agent_mcp_servers",
      "agent_mcp_values",
      "agent_session_parameters",
      "agents",
      "environment_repositories",
      "events",
      "integration_conversations",
      "integration_endpoints",
      "integration_tasks",
      "project_environment_revisions",
      "project_environments",
      "runs",
      "session_mcp_parameter_values",
      "sessions",
      "sqlite_sequence",
      "webhook_deliveries",
      "webhook_subscriptions"
    ]);
  });

  it("将现有 UUID 业务数据一次性映射为数字主键并保持外键关系", () => {
    const db = openDatabase(":memory:");
    const root = mkdtempSync(join(tmpdir(), "remote-agent-id-migration-"));
    const dataDir = join(root, "data");
    const projectEnvironmentsRoot = join(root, "environments");
    const sessionsRoot = join(root, "sessions");
    db.exec(`
      CREATE TABLE project_environments (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, current_revision_id TEXT,
        last_checked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE project_environment_revisions (
        id TEXT PRIMARY KEY, project_environment_id TEXT NOT NULL, status TEXT NOT NULL,
        workspace_path TEXT UNIQUE, input_fingerprint TEXT NOT NULL, failure_stage TEXT,
        error TEXT, created_at TEXT NOT NULL, finished_at TEXT
      );
      CREATE TABLE agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        instructions TEXT NOT NULL DEFAULT '', project_environment_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
        provider_session_id TEXT, workspace_path TEXT NOT NULL UNIQUE, project_environment_revision_id TEXT,
        instructions_snapshot TEXT NOT NULL DEFAULT '', input_tokens INTEGER, output_tokens INTEGER,
        cached_read_tokens INTEGER, cached_write_tokens INTEGER, thought_tokens INTEGER, total_tokens INTEGER,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL,
        result TEXT, error TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
      );
      CREATE TABLE integration_endpoints (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL,
        enabled INTEGER NOT NULL, token_hash TEXT NOT NULL UNIQUE, prompt_prefix TEXT NOT NULL DEFAULT '',
        parameter_mappings_json TEXT NOT NULL DEFAULT '[]', encrypted_fixed_values TEXT,
        next_delivery_order INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE integration_tasks (
        id TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL, conversation_id TEXT, session_id TEXT NOT NULL,
        run_id TEXT UNIQUE, request_id TEXT NOT NULL, request_fingerprint TEXT NOT NULL, message TEXT NOT NULL,
        effective_prompt TEXT NOT NULL, encrypted_parameters TEXT, status TEXT NOT NULL, result TEXT, error TEXT,
        event_sequence INTEGER NOT NULL DEFAULT 0, event_sequences_json TEXT NOT NULL DEFAULT '{}',
        event_dispatch_orders_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
      );
      CREATE TABLE webhook_subscriptions (
        id TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL,
        enabled INTEGER NOT NULL, events_json TEXT NOT NULL, encrypted_headers TEXT,
        encrypted_signing_secret TEXT NOT NULL, timeout_seconds INTEGER NOT NULL DEFAULT 10,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE webhook_deliveries (
        id TEXT PRIMARY KEY, event_id TEXT NOT NULL, event_key TEXT NOT NULL, sequence INTEGER NOT NULL,
        dispatch_order INTEGER NOT NULL, subscription_id TEXT NOT NULL, task_id TEXT, event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL, status TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL, last_status_code INTEGER, last_duration_ms INTEGER, last_error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO project_environments VALUES
        ('environment-uuid', 'Legacy environment', 'revision-uuid', NULL, '2026-08-01', '2026-08-01');
      INSERT INTO project_environment_revisions VALUES
        ('revision-uuid', 'environment-uuid', 'ready', '/legacy/environment', 'fingerprint', NULL, NULL, '2026-08-01', '2026-08-01');
      INSERT INTO agents VALUES
        ('agent-uuid', 'Legacy agent', 'codex', 1, '', 'environment-uuid', '2026-08-01', '2026-08-01');
      INSERT INTO sessions VALUES
        ('session-uuid', 'agent-uuid', 'Legacy session', 'idle', 'provider-session', '/legacy/session',
         'revision-uuid', '', 10, 5, 2, 1, 0, 18, '2026-08-01', '2026-08-01');
      INSERT INTO runs VALUES
        ('run-uuid', 'session-uuid', 'succeeded', 'hello', 'done', NULL, '2026-08-01', '2026-08-01', '2026-08-01');
      INSERT INTO integration_endpoints VALUES
        ('endpoint-uuid', 'Legacy endpoint', 'legacy-endpoint', 'agent-uuid', 1, 'hash', '', '[]', NULL, 2,
         '2026-08-01', '2026-08-01');
      INSERT INTO integration_tasks VALUES
        ('task-uuid', 'endpoint-uuid', NULL, 'session-uuid', 'run-uuid', 'request-1', 'fingerprint', 'hello',
         'hello', NULL, 'succeeded', 'done', NULL, 1,
         '{"task-uuid:task.succeeded":1}', '{"task-uuid:task.succeeded":1}',
         '2026-08-01', '2026-08-01', '2026-08-01');
      INSERT INTO webhook_subscriptions VALUES
        ('webhook-uuid', 'endpoint-uuid', 'Legacy webhook', 'https://receiver.test', 1,
         '["task.succeeded"]', NULL, 'encrypted', 10, '2026-08-01', '2026-08-01');
      INSERT INTO webhook_deliveries VALUES
        ('delivery-uuid', 'event-1', 'task-uuid:task.succeeded', 1, 1, 'webhook-uuid', 'task-uuid',
         'task.succeeded',
         '{"eventId":"event-1","eventType":"task.succeeded","sequence":1,"occurredAt":"2026-08-01","endpoint":{"id":"endpoint-uuid","slug":"legacy-endpoint"},"task":{"id":"task-uuid","requestId":"request-1","conversationKey":null,"sessionId":"session-uuid","runId":"run-uuid","status":"succeeded"}}',
         'pending', 0, '2026-08-01', NULL, NULL, NULL, '2026-08-01', '2026-08-01');
    `);
    const legacyEnvironmentWorkspace = join(
      projectEnvironmentsRoot, "environment-uuid", "revisions", "revision-uuid", "workspace"
    );
    const legacySessionWorkspace = join(sessionsRoot, "session-uuid", "workspace");
    mkdirSync(join(dataDir, "agents", "agent-uuid"), { recursive: true });
    writeFileSync(join(dataDir, "agents", "agent-uuid", "MEMORY.md"), "legacy memory");
    const legacyCodexSession = join(
      dataDir, "agents", "agent-uuid", "provider-home", "codex", "sessions", "session-uuid"
    );
    mkdirSync(legacyCodexSession, { recursive: true });
    writeFileSync(join(legacyCodexSession, "rollout.jsonl"), "legacy rollout");
    const oldAcpxKey = "remote-agent:session-uuid";
    const oldAcpxRecord = join(dataDir, "acpx", "sessions", `${encodeURIComponent(oldAcpxKey)}.json`);
    const oldEventLog = join(root, `${encodeURIComponent(oldAcpxKey)}.stream.ndjson`);
    const oldEventLogSegment = join(root, `${encodeURIComponent(oldAcpxKey)}.stream.1.ndjson`);
    mkdirSync(dirname(oldAcpxRecord), { recursive: true });
    writeFileSync(oldEventLog, "legacy event log");
    writeFileSync(oldEventLogSegment, "legacy event log segment");
    writeFileSync(oldAcpxRecord, JSON.stringify({
      name: oldAcpxKey,
      acpx_record_id: oldAcpxKey,
      cwd: legacySessionWorkspace,
      event_log: { active_path: oldEventLog }
    }));
    mkdirSync(legacyEnvironmentWorkspace, { recursive: true });
    mkdirSync(legacySessionWorkspace, { recursive: true });
    db.prepare("UPDATE project_environment_revisions SET workspace_path = ?").run(legacyEnvironmentWorkspace);
    db.prepare("UPDATE sessions SET workspace_path = ?").run(legacySessionWorkspace);

    migrate(db, { dataDir, projectEnvironmentsRoot, sessionsRoot });

    const agent = db.prepare("SELECT id, project_environment_id FROM agents WHERE name = 'Legacy agent'").get() as {
      id: number; project_environment_id: number;
    };
    const session = db.prepare("SELECT id, agent_id, project_environment_revision_id FROM sessions").get() as {
      id: number; agent_id: number; project_environment_revision_id: number;
    };
    expect(agent.id).toEqual(expect.any(Number));
    expect(agent.project_environment_id).toEqual(expect.any(Number));
    expect(session).toMatchObject({ agent_id: agent.id });
    expect(session.project_environment_revision_id).toEqual(expect.any(Number));
    expect(existsSync(join(dataDir, "agents", String(agent.id), "MEMORY.md"))).toBe(true);
    expect(existsSync(join(
      dataDir, "agents", String(agent.id), "provider-home", "codex", "sessions", String(session.id), "rollout.jsonl"
    ))).toBe(true);
    const newAcpxKey = `remote-agent:${session.id}`;
    const newAcpxRecord = join(dataDir, "acpx", "sessions", `${encodeURIComponent(newAcpxKey)}.json`);
    const migratedAcpx = JSON.parse(readFileSync(newAcpxRecord, "utf8")) as {
      name: string; acpx_record_id: string; cwd: string; event_log: { active_path: string };
    };
    expect(migratedAcpx).toMatchObject({
      name: newAcpxKey,
      acpx_record_id: newAcpxKey,
      cwd: join(sessionsRoot, String(session.id), "workspace")
    });
    expect(existsSync(migratedAcpx.event_log.active_path)).toBe(true);
    expect(existsSync(join(root, `${encodeURIComponent(newAcpxKey)}.stream.1.ndjson`))).toBe(true);
    expect(existsSync(oldAcpxRecord)).toBe(false);
    expect(existsSync(oldEventLogSegment)).toBe(false);
    expect(existsSync(join(dataDir, "agents", "agent-uuid"))).toBe(false);
    expect(existsSync(join(sessionsRoot, String(session.id), "workspace"))).toBe(true);
    expect((db.prepare("SELECT workspace_path FROM sessions WHERE id = ?").get(session.id) as { workspace_path: string }).workspace_path)
      .toBe(join(sessionsRoot, String(session.id), "workspace"));
    expect(existsSync(join(projectEnvironmentsRoot, String(agent.project_environment_id), "revisions", "revision-uuid", "workspace")))
      .toBe(true);
    const task = db.prepare(
      "SELECT id, endpoint_id, session_id, run_id, event_sequences_json, event_dispatch_orders_json FROM integration_tasks"
    ).get() as {
      id: number; endpoint_id: number; session_id: number; run_id: number;
      event_sequences_json: string; event_dispatch_orders_json: string;
    };
    const delivery = db.prepare("SELECT event_key, payload_json FROM webhook_deliveries").get() as {
      event_key: string; payload_json: string;
    };
    const payload = JSON.parse(delivery.payload_json) as {
      endpoint: { id: number };
      task: { id: number; sessionId: number; runId: number };
    };
    expect(JSON.parse(task.event_sequences_json)).toEqual({ [`${task.id}:task.succeeded`]: 1 });
    expect(JSON.parse(task.event_dispatch_orders_json)).toEqual({ [`${task.id}:task.succeeded`]: 1 });
    expect(delivery.event_key).toBe(`${task.id}:task.succeeded`);
    expect(payload).toMatchObject({
      endpoint: { id: task.endpoint_id },
      task: { id: task.id, sessionId: task.session_id, runId: task.run_id }
    });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("创建 Integration 表和必要唯一索引", () => {
    const { db } = createTestDatabase();
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all().map((row) => (row as { name: string }).name);

    expect(indexes).toEqual(expect.arrayContaining([
      "one_active_conversation_per_key",
      "integration_tasks_dispatch_order",
      "webhook_deliveries_due"
    ]));
    db.close();
  });

  it("为 Agent 和 Session 增加项目环境关联", () => {
    const { db } = createTestDatabase();
    const agentColumns = db.prepare("PRAGMA table_info(agents)").all().map((row) => (row as { name: string }).name);
    const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all().map((row) => (row as { name: string }).name);

    expect(agentColumns).toContain("project_environment_id");
    expect(sessionColumns).toContain("project_environment_revision_id");
    db.close();
  });

  it("Integration 持久化 eventKey 顺序映射和 Endpoint 投递计数器", () => {
    const { db } = createTestDatabase();
    const taskColumns = db.prepare("PRAGMA table_info(integration_tasks)").all()
      .map((row) => (row as { name: string }).name);
    const endpointColumns = db.prepare("PRAGMA table_info(integration_endpoints)").all()
      .map((row) => (row as { name: string }).name);
    const deliveryColumns = db.prepare("PRAGMA table_info(webhook_deliveries)").all()
      .map((row) => (row as { name: string }).name);

    expect(taskColumns).toEqual(expect.arrayContaining([
      "event_sequences_json",
      "event_dispatch_orders_json",
      "public_notice_code",
      "public_notice_message",
      "public_notice_event_seq"
    ]));
    expect(endpointColumns).toContain("next_delivery_order");
    expect(deliveryColumns).toContain("dispatch_order");
    db.close();
  });

  it("已有 Integration Task 表迁移时原地增加公开 notice 来源列", () => {
    const db = openDatabase(":memory:");
    db.exec(`
      CREATE TABLE integration_tasks (
        id TEXT PRIMARY KEY,
        endpoint_id TEXT NOT NULL,
        conversation_id TEXT,
        session_id TEXT NOT NULL,
        run_id TEXT UNIQUE,
        request_id TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        message TEXT NOT NULL,
        effective_prompt TEXT NOT NULL,
        encrypted_parameters TEXT,
        status TEXT NOT NULL,
        result TEXT,
        error TEXT,
        event_sequence INTEGER NOT NULL DEFAULT 0,
        event_sequences_json TEXT NOT NULL DEFAULT '{}',
        event_dispatch_orders_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      )
    `);

    migrate(db);

    const columns = db.prepare("PRAGMA table_info(integration_tasks)").all()
      .map((row) => (row as { name: string }).name);
    expect(columns).toEqual(expect.arrayContaining([
      "public_notice_code",
      "public_notice_message",
      "public_notice_event_seq"
    ]));
    db.close();
  });

  it("已有 MCP 表迁移时原地增加共享来源列", () => {
    const db = openDatabase(":memory:");
    db.exec(`
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE agent_mcp_servers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id INTEGER NOT NULL REFERENCES agents(id),
        name TEXT NOT NULL,
        transport TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        url TEXT,
        command TEXT,
        check_timeout_seconds INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    migrate(db);

    const columns = db.prepare("PRAGMA table_info(agent_mcp_servers)").all()
      .map((row) => (row as { name: string }).name);
    expect(columns).toContain("source_mcp_server_id");
    db.close();
  });

  it("为新旧 runs 表增加可空 Token 用量列", () => {
    const expected = [
      "input_tokens",
      "output_tokens",
      "cached_read_tokens",
      "cached_write_tokens",
      "thought_tokens",
      "total_tokens",
      "context_used_tokens",
      "context_window_tokens"
    ];
    const fresh = createTestDatabase();
    expect(fresh.db.prepare("PRAGMA table_info(runs)").all().map((row) => (row as { name: string }).name))
      .toEqual(expect.arrayContaining(expected));
    fresh.db.close();

    const existing = openDatabase(":memory:");
    existing.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        input TEXT NOT NULL,
        result TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      )
    `);

    migrate(existing);

    expect(existing.prepare("PRAGMA table_info(runs)").all().map((row) => (row as { name: string }).name))
      .toEqual(expect.arrayContaining(expected));
    existing.close();
  });

  it("拒绝同一 Session 的第二个活动 Run", () => {
    const { db, seed } = createTestDatabase();
    const session = seed.session();
    seed.run(session.id, "queued");

    expect(() => seed.run(session.id, "running")).toThrow(/UNIQUE/);

    db.close();
  });
});
