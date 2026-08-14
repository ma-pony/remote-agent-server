import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { migrate, openDatabase } from "../src/db.js";
import { createTestDatabase } from "./helpers.js";

const validEnv = {
  API_TOKEN: "test-token",
  DATA_DIR: "/var/lib/remote-agent",
  DATABASE_PATH: "/var/lib/remote-agent/remote-agent.sqlite3",
  WORKSPACE_TEMPLATE: "/var/lib/remote-agent/template/workspace",
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
      "webhook_deliveries",
      "webhook_subscriptions"
    ]);
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

  it("拒绝同一 Session 的第二个活动 Run", () => {
    const { db, seed } = createTestDatabase();
    const session = seed.session();
    seed.run(session.id, "queued");

    expect(() => seed.run(session.id, "running")).toThrow(/UNIQUE/);

    db.close();
  });
});
