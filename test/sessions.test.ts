import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { AgentManager } from "../src/agents/agent-manager.js";
import { McpManager } from "../src/mcp/mcp-manager.js";
import type { ProjectEnvironmentCommands } from "../src/project-environments/project-environment-commands.js";
import { recoverIncompleteSessions, SessionManager } from "../src/sessions/session-manager.js";
import { BtrfsWorkspaceManager } from "../src/workspaces/btrfs-workspace.js";
import type { CommandRunner } from "../src/workspaces/workspace-manager.js";
import type { AgentRuntime, RuntimeDoctor, RuntimeSession, RuntimeSessionInput, RuntimeTurn, RuntimeTurnInput } from "../src/runtime/agent-runtime.js";
import { createTestDatabase } from "./helpers.js";

const apiToken = "test-token";
const authHeaders = (): Record<string, string> => ({ authorization: `Bearer ${apiToken}` });

const tempDirs: string[] = [];
const apps: Array<{ app: FastifyInstance; close: () => Promise<void> }> = [];

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const createFakeRuntime = (
  reset = async (_input: RuntimeSessionInput): Promise<void> => undefined,
  forgetSession = async (_sessionId: number): Promise<void> => undefined
): AgentRuntime => ({
  ensureSession: async (_input: RuntimeSessionInput): Promise<RuntimeSession> => ({ providerSessionId: null }),
  startTurn: (_input: RuntimeTurnInput): RuntimeTurn => {
    throw new Error("Fake Runtime does not start turns in Session API tests");
  },
  cancel: async (_sessionId: number): Promise<void> => undefined,
  reset,
  forgetSession,
  doctor: async (_provider: "claude_code" | "codex" | "hermes", _agentId: number): Promise<RuntimeDoctor> => ({
    ok: true,
    message: "ready",
    details: []
  }),
  shutdown: async (): Promise<void> => undefined
});

const createTestApp = async (options: {
  runtime?: AgentRuntime;
  commandRunner?: CommandRunner;
  projectEnvironmentCommands?: ProjectEnvironmentCommands;
} = {}): Promise<{ app: FastifyInstance; db: ReturnType<typeof createTestDatabase>["db"]; dataDir: string }> => {
  const { db } = createTestDatabase();
  const dataDir = mkdtempSync(join(tmpdir(), "remote-agent-sessions-"));
  tempDirs.push(dataDir);
  const commandRunner = options.commandRunner ?? { run: async () => ({ stdout: "", stderr: "" }) };
  const config = {
    host: "127.0.0.1",
    port: 3000,
    apiToken,
    dataDir,
    databasePath: ":memory:",
    projectEnvironmentsRoot: join(dataDir, "environments"),
    sessionsRoot: join(dataDir, "sessions"),
    maxConcurrentRuns: 4,
    maxConcurrentWebhookDeliveries: 4,
    maxConcurrentEnvironmentBuilds: 1,
    projectEnvironmentCheckIntervalMs: 3 * 60 * 60 * 1000,
    projectPrepareTimeoutMs: 30 * 60 * 1000,
    sessionRetentionMs: 0
  };
  const app = buildApp({
    config,
    db,
    runtime: options.runtime ?? createFakeRuntime(),
    projectEnvironmentCommands: options.projectEnvironmentCommands,
    workspaceManager: new BtrfsWorkspaceManager({
      projectEnvironmentsRoot: config.projectEnvironmentsRoot,
      sessionsRoot: config.sessionsRoot,
      commandRunner
    })
  });
  apps.push({ app, close: async () => { await app.close(); db.close(); } });
  await app.ready();
  return { app, db, dataDir };
};

const createAgent = async (app: FastifyInstance): Promise<{ id: number }> => {
  const environments = await app.inject({ method: "GET", url: "/api/project-environments", headers: authHeaders() });
  const projectEnvironmentId = (environments.json() as Array<{ id: number }>)[0]!.id;
  const response = await app.inject({
    method: "POST",
    url: "/api/agents",
    headers: authHeaders(),
    payload: { name: "Codex", provider: "codex", projectEnvironmentId }
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: number };
};

const createSession = async (app: FastifyInstance, agentId: number): Promise<{ id: number; workspacePath: string }> => {
  const response = await app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: authHeaders(),
    payload: { agentId, title: "修复工单 1332" }
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: number; workspacePath: string };
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map(({ close }) => close()));
  tempDirs.splice(0).forEach((directory) => rmSync(directory, { force: true, recursive: true }));
});

describe("Session API", () => {
  it("启动时删除创建中断的 Session 和对应 Workspace", async () => {
    const { db, seed } = createTestDatabase();
    const inserted = db.prepare(
      "INSERT INTO sessions (agent_id, title, status, workspace_path, created_at, updated_at) VALUES (?, ?, 'running', ?, ?, ?)"
    ).run(seed.agent.id, "Incomplete", "pending:create", "2026-08-19", "2026-08-19");
    const id = Number(inserted.lastInsertRowid);
    const workspaceManager = {
      check: vi.fn(async () => undefined),
      createSession: vi.fn(),
      deleteSession: vi.fn(async () => undefined),
      createRevision: vi.fn(),
      removeRevision: vi.fn()
    };

    await recoverIncompleteSessions(db, workspaceManager);

    expect(workspaceManager.deleteSession).toHaveBeenCalledWith(id);
    expect(db.prepare("SELECT id FROM sessions WHERE id = ?").get(id)).toBeUndefined();
    db.close();
  });

  it("创建中断的 Workspace 删除失败时保留记录并在下次启动重试", async () => {
    const { db, seed } = createTestDatabase();
    const root = mkdtempSync(join(tmpdir(), "incomplete-session-retry-"));
    tempDirs.push(root);
    const workspacePath = join(root, "workspace");
    mkdirSync(workspacePath);
    const { id } = seed.session();
    db.prepare("UPDATE sessions SET status = 'running', workspace_path = 'pending:create' WHERE id = ?").run(id);
    let attempt = 0;
    const workspaceManager = {
      check: async () => undefined,
      createSession: async () => { throw new Error("unused"); },
      deleteSession: async () => {
        if (++attempt === 1) throw Object.assign(new Error("busy"), { code: "EBUSY" });
        rmSync(workspacePath, { recursive: true, force: true });
      },
      createRevision: async () => undefined,
      removeRevision: async () => undefined
    };

    await recoverIncompleteSessions(db, workspaceManager);

    expect(db.prepare("SELECT status, workspace_path FROM sessions WHERE id = ?").get(id))
      .toEqual({ status: "running", workspace_path: "pending:create" });
    expect(existsSync(workspacePath)).toBe(true);

    await recoverIncompleteSessions(db, workspaceManager);

    expect(existsSync(workspacePath)).toBe(false);
    expect(db.prepare("SELECT id FROM sessions WHERE id = ?").get(id)).toBeUndefined();
    db.close();
  });

  it("创建失败且回滚目录失败时也保留 pending Session", async () => {
    const { app, db, dataDir } = await createTestApp({
      commandRunner: {
        run: async (_command, args) => {
          if (args[1] === "snapshot") {
            mkdirSync(args[3]);
            throw new Error("snapshot failed after creating workspace");
          }
          if (args[1] === "delete") throw new Error("workspace busy");
          return { stdout: "", stderr: "" };
        }
      }
    });
    const agent = await createAgent(app);

    const response = await app.inject({
      method: "POST", url: "/api/sessions", headers: authHeaders(), payload: { agentId: agent.id, title: "failed creation" }
    });

    expect(response.statusCode).toBe(500);
    const row = db.prepare("SELECT id, status, workspace_path FROM sessions").get() as
      { id: number; status: string; workspace_path: string } | undefined;
    expect(row).toMatchObject({ status: "running", workspace_path: expect.stringMatching(/^pending:/) });
    expect(existsSync(join(dataDir, "sessions", String(row!.id), "workspace"))).toBe(true);
  });

  it("列表按创建时间倒序分页，并在全部会话中搜索", async () => {
    const { app, db } = await createTestApp();
    const agent = await createAgent(app);
    const ids: number[] = [];
    for (let index = 1; index <= 23; index += 1) {
      const session = await createSession(app, agent.id);
      ids.push(session.id);
      db.prepare("UPDATE sessions SET title = ?, created_at = ? WHERE id = ?").run(
        index === 2 ? "跨页命中" : `会话 ${index}`,
        `2026-08-${String(index).padStart(2, "0")}T00:00:00.000Z`,
        session.id
      );
    }

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions?page=2&pageSize=10",
      headers: authHeaders()
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ page: 2, pageSize: 10, total: 23, totalPages: 3 });
    expect((response.json() as { items: Array<{ id: number }> }).items.map(({ id }) => id))
      .toEqual(ids.toReversed().slice(10, 20));

    const searched = await app.inject({
      method: "GET",
      url: "/api/sessions?page=1&pageSize=10&query=%E8%B7%A8%E9%A1%B5",
      headers: authHeaders()
    });

    expect(searched.statusCode).toBe(200);
    expect(searched.json()).toMatchObject({ total: 1, totalPages: 1 });
    expect((searched.json() as { items: Array<{ id: number }> }).items.map(({ id }) => id)).toEqual([ids[1]]);

    db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(ids[4]);
    const filtered = await app.inject({
      method: "GET",
      url: `/api/sessions?page=1&pageSize=10&agentId=${agent.id}&status=running`,
      headers: authHeaders()
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json()).toMatchObject({ total: 1, items: [{ id: ids[4], status: "running" }] });

    const invalid = await app.inject({
      method: "GET",
      url: "/api/sessions?status=finished",
      headers: authHeaders()
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("列表返回可区分外部接入会话的摘要和累计 Token", async () => {
    const { app, db } = await createTestApp();
    const agent = await createAgent(app);
    const session = await createSession(app, agent.id);
    const now = "2026-08-24T08:00:00.000Z";
    db.prepare(`
      UPDATE sessions SET input_tokens = 9000, output_tokens = 2345, total_tokens = 12345
      WHERE id = ?
    `).run(session.id);
    const endpointId = Number(db.prepare(`
      INSERT INTO integration_endpoints
        (name, slug, agent_id, enabled, token_hash, created_at, updated_at)
      VALUES ('Crawler development', 'crawler-dev', ?, 1, 'list-summary-token', ?, ?)
    `).run(agent.id, now, now).lastInsertRowid);
    const conversationId = Number(db.prepare(`
      INSERT INTO integration_conversations
        (endpoint_id, conversation_key, session_id, status, created_at)
      VALUES (?, 'ticket-2084', ?, 'active', ?)
    `).run(endpointId, session.id, now).lastInsertRowid);
    db.prepare(`
      INSERT INTO integration_tasks
        (endpoint_id, conversation_id, session_id, request_id, request_fingerprint,
         message, effective_prompt, status, created_at)
      VALUES (?, ?, ?, 'dispatch-2084-2', 'list-summary-fingerprint',
        '继续处理工单', '继续处理工单', 'queued', ?)
    `).run(endpointId, conversationId, session.id, now);

    const response = await app.inject({ method: "GET", url: "/api/sessions", headers: authHeaders() });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [expect.objectContaining({
        id: session.id,
        agentName: "Codex",
        agentProvider: "codex",
        projectEnvironmentName: "Test environment",
        usage: expect.objectContaining({ totalTokens: 12345 }),
        integration: {
          endpointId,
          endpointName: "Crawler development",
          endpointSlug: "crawler-dev",
          conversationKey: "ticket-2084",
          latestRequestId: "dispatch-2084-2"
        }
      })],
      page: 1,
      pageSize: 20,
      total: 1,
      totalPages: 1
    });
  });

  it("列表批量计算 MCP 状态而不逐条查询 Session", async () => {
    const { app } = await createTestApp();
    const agent = await createAgent(app);
    await createSession(app, agent.id);
    await createSession(app, agent.id);
    const perSession = vi.spyOn(McpManager.prototype, "getSessionStatus");

    const response = await app.inject({ method: "GET", url: "/api/sessions", headers: authHeaders() });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { items: unknown[] }).items).toHaveLength(2);
    expect(perSession).not.toHaveBeenCalled();
  });

  it("会话详情只返回最近 20 个 Run 并支持向前分页", async () => {
    const { app, db } = await createTestApp();
    const agent = await createAgent(app);
    const session = await createSession(app, agent.id);
    const runIds: number[] = [];
    for (let index = 1; index <= 25; index += 1) {
      runIds.push(Number(db.prepare(`
        INSERT INTO runs (session_id, status, input, result, created_at, started_at, finished_at)
        VALUES (?, 'succeeded', ?, 'done', ?, ?, ?)
      `).run(
        session.id,
        `run-${index}`,
        `2026-08-20T00:00:${String(index).padStart(2, "0")}.000Z`,
        `2026-08-20T00:00:${String(index).padStart(2, "0")}.000Z`,
        `2026-08-20T00:00:${String(index).padStart(2, "0")}.000Z`
      ).lastInsertRowid));
    }

    const detail = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}`,
      headers: authHeaders()
    });
    const detailJson = detail.json() as { runs: Array<{ id: number }>; hasOlderRuns: boolean };
    expect(detailJson.runs.map(({ id }) => id)).toEqual(runIds.slice(5));
    expect(detailJson.hasOlderRuns).toBe(true);

    const older = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/runs?beforeId=${runIds[5]}&limit=20`,
      headers: authHeaders()
    });
    expect(older.statusCode).toBe(200);
    expect(older.json()).toEqual({
      items: runIds.slice(0, 5).map((id, index) => expect.objectContaining({ id, input: `run-${index + 1}` })),
      hasMore: false
    });
  });

  it("已清理存储的会话保留详情但拒绝创建新 Run", async () => {
    const { app, db } = await createTestApp();
    const agent = await createAgent(app);
    const session = await createSession(app, agent.id);
    db.prepare("UPDATE sessions SET storage_cleaned_at = ? WHERE id = ?")
      .run("2026-08-24T00:00:00.000Z", session.id);

    const detail = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}`,
      headers: authHeaders()
    });
    const created = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/runs`,
      headers: authHeaders(),
      payload: { input: "继续处理" }
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ storageCleanedAt: "2026-08-24T00:00:00.000Z" });
    expect(created.statusCode).toBe(410);
    expect(created.json()).toEqual({
      error: { code: "session_storage_cleaned", message: "Session storage has been cleaned" }
    });
  });

  it("创建 Session 时保存 Agent 指令快照，之后修改 Agent 不影响已有 Session", async () => {
    const { app, db } = await createTestApp();
    const agent = await createAgent(app);
    const configured = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agent.id}`,
      headers: authHeaders(),
      payload: { instructions: "创建时的智能体指令" }
    });
    expect(configured.statusCode).toBe(200);

    const session = await createSession(app, agent.id);
    const changed = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agent.id}`,
      headers: authHeaders(),
      payload: { instructions: "后来修改的智能体指令" }
    });
    expect(changed.statusCode).toBe(200);

    expect(db.prepare("SELECT instructions_snapshot FROM sessions WHERE id = ?").get(session.id)).toEqual({
      instructions_snapshot: "创建时的智能体指令"
    });
    const detail = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}`,
      headers: authHeaders()
    });
    expect(detail.json()).toMatchObject({ instructionsSnapshot: "创建时的智能体指令" });
  });

  it("创建 Session 时校验并加密保存必填 MCP 参数", async () => {
    const { app, db } = await createTestApp();
    const agent = await createAgent(app);
    await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/session-parameters`,
      headers: authHeaders(),
      payload: {
        key: "access_token",
        label: "访问令牌",
        description: "当前租户令牌",
        required: true,
        secret: true
      }
    });

    const missing = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: authHeaders(),
      payload: { agentId: agent.id, title: "缺少令牌", mcpParameters: {} }
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: { code: "missing_session_mcp_parameters" } });
    expect(db.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 0 });

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: authHeaders(),
      payload: {
        agentId: agent.id,
        title: "带令牌",
        mcpParameters: { access_token: "session-secret-token" }
      }
    });
    expect(created.statusCode).toBe(201);
    expect(JSON.stringify(created.json())).not.toContain("session-secret-token");
    expect(created.json()).toMatchObject({
      mcpParametersValid: true,
      missingMcpParameters: [],
      mcpParameters: [{ key: "access_token", secret: true, configured: true }]
    });
    const row = db.prepare(
      "SELECT plain_value, encrypted_value FROM session_mcp_parameter_values LIMIT 1"
    ).get() as { plain_value: string | null; encrypted_value: string | null };
    expect(row.plain_value).toBeNull();
    expect(row.encrypted_value).toEqual(expect.any(String));
    expect(row.encrypted_value).not.toContain("session-secret-token");
  });

  it("空闲 Session 可局部修改 MCP 参数，活动 Run 期间拒绝", async () => {
    const { app, db } = await createTestApp();
    const agent = await createAgent(app);
    for (const parameter of [
      { key: "tenant", label: "租户", required: true, secret: false },
      { key: "note", label: "备注", required: false, secret: false }
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/agents/${agent.id}/session-parameters`,
        headers: authHeaders(),
        payload: { ...parameter, description: null }
      });
      expect(response.statusCode).toBe(201);
    }
    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: authHeaders(),
      payload: { agentId: agent.id, title: "参数测试", mcpParameters: { tenant: "team-a", note: "old" } }
    });
    const sessionId = (created.json() as { id: number }).id;

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${sessionId}/mcp-parameters`,
      headers: authHeaders(),
      payload: { values: { tenant: "team-b", note: null } }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      mcpParametersValid: true,
      mcpParameters: [
        { key: "tenant", configured: true, value: "team-b" },
        { key: "note", configured: false }
      ]
    });

    db.prepare(
      "INSERT INTO runs (session_id, status, input, created_at) VALUES (?, 'queued', ?, ?)"
    ).run(sessionId, "queued", "2026-08-13T00:00:00.000Z");
    const busy = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${sessionId}/mcp-parameters`,
      headers: authHeaders(),
      payload: { values: { tenant: "team-c" } }
    });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toEqual({ error: { code: "session_busy", message: "Session is running" } });

    const detail = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}`, headers: authHeaders() });
    expect(detail.json()).toMatchObject({
      mcpParametersValid: true,
      mcpParameters: [{ key: "tenant", value: "team-b" }, { key: "note", configured: false }]
    });
  });

  it("拒绝为禁用 Agent 创建 Session", async () => {
    const { app, db } = await createTestApp();
    const agent = await createAgent(app);
    await app.inject({ method: "PATCH", url: `/api/agents/${agent.id}`, headers: authHeaders(), payload: { enabled: false } });

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: authHeaders(),
      payload: { agentId: agent.id, title: "修复工单 1332" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { code: "agent_disabled", message: "Agent is disabled" } });
    expect(db.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 0 });
  });

  it("快照成功后保存并返回 Session 详情", async () => {
    let db!: ReturnType<typeof createTestDatabase>["db"];
    let snapshotCompleted = false;
    const commandRunner: CommandRunner = {
      run: async (command, args) => {
        expect(command).toBe("btrfs");
        expect(args.slice(0, 2)).toEqual(["subvolume", "snapshot"]);
        const workspacePath = args[3];
        const sessionPath = dirname(workspacePath);
        expect(existsSync(sessionPath)).toBe(true);
        expect(existsSync(join(sessionPath, "runtime"))).toBe(true);
        expect(existsSync(join(sessionPath, "browser"))).toBe(true);
        const pending = db.prepare("SELECT id, status FROM sessions").get() as { id: number; status: string };
        expect(pending.status).toBe("running");
        const runDuringSnapshot = await app.inject({
          method: "POST",
          url: `/api/sessions/${pending.id}/runs`,
          headers: authHeaders(),
          payload: { input: "must not start before workspace is ready" }
        });
        expect(runDuringSnapshot.statusCode).toBe(409);
        mkdirSync(workspacePath);
        snapshotCompleted = true;
        return { stdout: "", stderr: "" };
      }
    };
    let app!: FastifyInstance;
    ({ app, db } = await createTestApp({ commandRunner }));
    const agent = await createAgent(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: authHeaders(),
      payload: { agentId: agent.id, title: "修复工单 1332" }
    });

    expect(created.statusCode).toBe(201);
    expect(snapshotCompleted).toBe(true);
    expect(created.json()).toMatchObject({
      agentId: agent.id,
      title: "修复工单 1332",
      status: "idle",
      providerSessionId: null,
      projectEnvironmentRevisionId: expect.any(Number)
    });
    const session = created.json() as { id: number; workspacePath: string };
    expect(existsSync(session.workspacePath)).toBe(true);
    expect(db.prepare("SELECT id, project_environment_revision_id FROM sessions WHERE id = ?").get(session.id)).toEqual({
      id: session.id,
      project_environment_revision_id: (created.json() as { projectEnvironmentRevisionId: number }).projectEnvironmentRevisionId
    });

    const detail = await app.inject({ method: "GET", url: `/api/sessions/${session.id}`, headers: authHeaders() });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ id: session.id, agentId: agent.id, title: "修复工单 1332" });

    const list = await app.inject({ method: "GET", url: "/api/sessions", headers: authHeaders() });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ items: [{ id: session.id, title: "修复工单 1332" }] });
  });

  it("创建 Session 后直接使用项目环境快照并写入就绪标记", async () => {
    let sessionWorkspace = "";
    const cleanIgnored = vi.fn(async (_repository, destination: string) => {
      expect(existsSync(join(destination, ".venv"))).toBe(true);
      rmSync(join(destination, ".venv"), { recursive: true, force: true });
    });
    const prepare = vi.fn(async (_repository, destination: string) => {
      expect(existsSync(join(destination, ".venv"))).toBe(false);
      mkdirSync(join(destination, ".venv", "bin"), { recursive: true });
      writeFileSync(join(destination, ".venv", "bin", "playwright"), `#!${destination}/.venv/bin/python\n`);
    });
    const projectEnvironmentCommands: ProjectEnvironmentCommands = {
      inspect: async () => { throw new Error("unused"); },
      isRepository: async () => true,
      clone: async () => { throw new Error("unused"); },
      update: async () => { throw new Error("unused"); },
      cleanIgnored,
      prepare
    };
    const { app, db } = await createTestApp({
      projectEnvironmentCommands,
      commandRunner: {
        run: async (_command, args) => {
          if (args[1] === "snapshot") {
            sessionWorkspace = args[3];
            const repositoryPath = join(sessionWorkspace, "bid-spiders");
            mkdirSync(join(repositoryPath, ".git"), { recursive: true });
            mkdirSync(join(repositoryPath, ".venv", "bin"), { recursive: true });
            writeFileSync(join(repositoryPath, ".venv", "bin", "playwright"), "#!/old/revision/.venv/bin/python\n");
            writeFileSync(join(repositoryPath, "local-notes.txt"), "keep me");
          }
          return { stdout: "", stderr: "" };
        }
      }
    });
    const projectEnvironment = db.prepare("SELECT id FROM project_environments LIMIT 1").get() as { id: number };
    db.prepare(`
      INSERT INTO environment_repositories
        (project_environment_id, name, git_url, prepare_command, created_at, updated_at)
      VALUES (?, 'bid-spiders', 'git:bid-spiders', 'uv sync', ?, ?)
    `).run(projectEnvironment.id, "2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z");
    const agent = await createAgent(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: authHeaders(),
      payload: { agentId: agent.id, title: "重建 Python 环境" }
    });

    expect(created.statusCode).toBe(201);
    expect(cleanIgnored).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    const repositoryPath = join(sessionWorkspace, "bid-spiders");
    expect(readFileSync(join(repositoryPath, ".venv", "bin", "playwright"), "utf8"))
      .toBe("#!/old/revision/.venv/bin/python\n");
    expect(readFileSync(join(repositoryPath, "local-notes.txt"), "utf8")).toBe("keep me");
    expect(readFileSync(join(dirname(sessionWorkspace), "runtime", ".project-environment-snapshot-v2"), "utf8"))
      .toBe("ready\n");
  });

  it("Session 快照完成后立即重试清理旧项目环境", async () => {
    const { db, seed } = createTestDatabase();
    const dataDir = mkdtempSync(join(tmpdir(), "remote-agent-session-cleanup-"));
    tempDirs.push(dataDir);
    const sessionRoot = join(dataDir, "sessions", "1");
    let cleanedEnvironmentId: number | undefined;
    const runtime = createFakeRuntime();
    const manager = new SessionManager({
      db,
      dataDir,
      agentManager: new AgentManager({ db, dataDir, runtime }),
      runtime,
      workspaceManager: {
        check: async () => undefined,
        createSession: async () => {
          mkdirSync(join(sessionRoot, "workspace"), { recursive: true });
          mkdirSync(join(sessionRoot, "runtime"), { recursive: true });
          mkdirSync(join(sessionRoot, "browser"), { recursive: true });
          return {
            workspacePath: join(sessionRoot, "workspace"),
            runtimePath: join(sessionRoot, "runtime"),
            browserProfilePath: join(sessionRoot, "browser")
          };
        },
        deleteSession: async () => undefined,
        createRevision: async () => undefined,
        removeRevision: async () => undefined
      },
      projectEnvironmentRevisionCleaner: {
        cleanupOldRevisions: async (environmentId) => { cleanedEnvironmentId = environmentId; }
      }
    });

    await manager.create({ agentId: seed.agent.id, title: "并发快照", mcpParameters: {} });

    expect(cleanedEnvironmentId).toBe(seed.projectEnvironment.id);
    db.close();
  });

  it("旧 Session 首次继续运行前只修复一次项目环境", async () => {
    const { db, seed } = createTestDatabase();
    const dataDir = mkdtempSync(join(tmpdir(), "remote-agent-existing-session-"));
    tempDirs.push(dataDir);
    const workspacePath = join(dataDir, "sessions", "1", "workspace");
    const repositoryPath = join(workspacePath, "bid-spiders");
    mkdirSync(join(repositoryPath, ".venv", "bin"), { recursive: true });
    mkdirSync(join(dirname(workspacePath), "runtime"), { recursive: true });
    writeFileSync(join(repositoryPath, ".venv", "bin", "playwright"), "#!/removed/revision/.venv/bin/python\n");
    db.prepare(`
      INSERT INTO environment_repositories
        (project_environment_id, name, git_url, prepare_command, created_at, updated_at)
      VALUES (?, 'bid-spiders', 'git:bid-spiders', 'uv sync', ?, ?)
    `).run(seed.projectEnvironment.id, "2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z");
    const session = seed.session();
    db.prepare("UPDATE sessions SET workspace_path = ?, project_environment_revision_id = ? WHERE id = ?")
      .run(workspacePath, seed.projectEnvironment.revisionId, session.id);
    const cleanIgnored = vi.fn(async (_repository, destination: string) => {
      rmSync(join(destination, ".venv"), { recursive: true, force: true });
    });
    const prepare = vi.fn(async (_repository, destination: string) => {
      mkdirSync(join(destination, ".venv", "bin"), { recursive: true });
      writeFileSync(join(destination, ".venv", "bin", "playwright"), `#!${destination}/.venv/bin/python\n`);
    });
    const runtime = createFakeRuntime();
    const manager = new SessionManager({
      db,
      dataDir,
      agentManager: new AgentManager({ db, dataDir, runtime }),
      runtime,
      workspaceManager: {
        check: async () => undefined,
        createSession: async () => { throw new Error("unused"); },
        deleteSession: async () => undefined,
        createRevision: async () => undefined,
        removeRevision: async () => undefined
      },
      projectEnvironmentCommands: {
        inspect: async () => { throw new Error("unused"); },
        isRepository: async () => true,
        clone: async () => { throw new Error("unused"); },
        update: async () => { throw new Error("unused"); },
        cleanIgnored,
        prepare
      }
    });

    await manager.ensureWorkspacePrepared(session.id);
    await manager.ensureWorkspacePrepared(session.id);

    expect(cleanIgnored).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(repositoryPath, ".venv", "bin", "playwright"), "utf8"))
      .toBe(`#!${repositoryPath}/.venv/bin/python\n`);
    db.close();
  });

  it("快照失败时不写入 Session", async () => {
    const { app, db } = await createTestApp({
      commandRunner: { run: async () => Promise.reject(new Error("snapshot failed")) }
    });
    const agent = await createAgent(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: authHeaders(),
      payload: { agentId: agent.id, title: "修复工单 1332" }
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: { code: "workspace_create_failed", message: "Failed to create workspace" } });
    expect(db.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 0 });
  });

  it("Session 保存失败时删除已创建的 Btrfs Subvolume", async () => {
    const { db } = createTestDatabase();
    const dataDir = mkdtempSync(join(tmpdir(), "remote-agent-session-compensation-"));
    tempDirs.push(dataDir);
    const calls: Array<{ command: string; args: string[] }> = [];
    let snapshotCompleted = false;
    const commandRunner: CommandRunner = {
      run: async (command, args) => {
        calls.push({ command, args });
        if (args[1] === "snapshot") {
          expect(command).toBe("btrfs");
          expect(db.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 1 });
          expect(existsSync(join(dirname(args[3]), "runtime"))).toBe(true);
          expect(existsSync(join(dirname(args[3]), "browser"))).toBe(true);
          mkdirSync(args[3]);
          snapshotCompleted = true;
        }
        if (args[1] === "delete") {
          expect(snapshotCompleted).toBe(true);
          expect(existsSync(args[2])).toBe(true);
          expect(db.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 1 });
        }
        return { stdout: "", stderr: "" };
      }
    };
    const originalPrepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql.startsWith("UPDATE sessions SET workspace_path")) {
        return { run: () => { throw new Error("database write failed"); } } as never;
      }
      return originalPrepare(sql);
    }) as typeof db.prepare);
    const runtime = createFakeRuntime();
    const agentManager = new AgentManager({ db, dataDir, runtime });
    const workspaceManager = new BtrfsWorkspaceManager({
      projectEnvironmentsRoot: join(dataDir, "environments"),
      sessionsRoot: join(dataDir, "sessions"),
      commandRunner
    });
    const manager = new SessionManager({ db, dataDir, agentManager, runtime, workspaceManager });
    const agent = db.prepare("SELECT id FROM agents").get() as { id: number };

    await expect(manager.create({ agentId: agent.id, title: "修复工单 1332", mcpParameters: {} })).rejects.toMatchObject({
      code: "session_create_failed"
    });

    expect(calls).toHaveLength(2);
    expect(snapshotCompleted).toBe(true);
    expect(calls[0]).toEqual({ command: "btrfs", args: ["subvolume", "snapshot", expect.any(String), expect.any(String)] });
    expect(calls[1]).toEqual({ command: "btrfs", args: ["subvolume", "delete", expect.any(String)] });
    expect(calls[1]?.args[2]).toBe(calls[0]?.args[3]);
    expect(db.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 0 });
    db.close();
  });

  it("reset 原子 claim Session，成功后释放并允许创建 Run", async () => {
    let app!: FastifyInstance;
    let db!: ReturnType<typeof createTestDatabase>["db"];
    let dataDir!: string;
    let providerSessionIdDuringRuntime: string | null = null;
    const resetRelease = deferred<void>();
    const reset = vi.fn(async (input: RuntimeSessionInput): Promise<void> => {
      providerSessionIdDuringRuntime = (db.prepare("SELECT provider_session_id FROM sessions WHERE id = ?").get(input.sessionId) as {
        provider_session_id: string | null;
      }).provider_session_id;
      await resetRelease.promise;
    });
    ({ app, db, dataDir } = await createTestApp({ runtime: createFakeRuntime(reset) }));
    const agent = await createAgent(app);
    const session = await createSession(app, agent.id);
    writeFileSync(join(dataDir, "agents", String(agent.id), "MEMORY.md"), "remember reset");
    db.prepare("UPDATE sessions SET provider_session_id = ? WHERE id = ?").run("provider-session-1", session.id);

    const resetting = app.inject({ method: "POST", url: `/api/sessions/${session.id}/reset`, headers: authHeaders() });
    await vi.waitFor(() => expect(reset).toHaveBeenCalledTimes(1));

    const statusDuringReset = db.prepare("SELECT status FROM sessions WHERE id = ?").get(session.id);
    const busy = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/runs`,
      headers: authHeaders(),
      payload: { input: "不能并发" }
    });

    resetRelease.resolve();
    const response = await resetting;

    expect(statusDuringReset).toEqual({ status: "running" });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toEqual({
      error: { code: "session_busy", message: "Session already has an active Run" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: session.id,
      status: "idle",
      providerSessionId: null,
      workspacePath: session.workspacePath
    });
    expect(reset).toHaveBeenCalledWith({
      sessionId: session.id,
      agentId: agent.id,
      provider: "codex",
      providerSessionId: "provider-session-1",
      workspacePath: session.workspacePath,
      browserProfilePath: join(dirname(session.workspacePath), "browser"),
      instructions: "",
      memory: "remember reset",
      mcpServers: []
    });
    expect(providerSessionIdDuringRuntime).toBe("provider-session-1");
    expect(db.prepare("SELECT status, provider_session_id FROM sessions WHERE id = ?").get(session.id)).toEqual({
      status: "idle",
      provider_session_id: null
    });

    const accepted = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/runs`,
      headers: authHeaders(),
      payload: { input: "reset 后继续" }
    });
    expect(accepted.statusCode).toBe(201);
  });

  it("Runtime reset 失败时释放 claim、保留 Provider Session ID 并允许创建 Run", async () => {
    const resetRelease = deferred<void>();
    const reset = vi.fn(async () => {
      await resetRelease.promise;
      throw new Error("provider failed");
    });
    const { app, db } = await createTestApp({ runtime: createFakeRuntime(reset) });
    const agent = await createAgent(app);
    const session = await createSession(app, agent.id);
    db.prepare("UPDATE sessions SET provider_session_id = ? WHERE id = ?").run("provider-session-1", session.id);

    const resetting = app.inject({ method: "POST", url: `/api/sessions/${session.id}/reset`, headers: authHeaders() });
    await vi.waitFor(() => expect(reset).toHaveBeenCalledTimes(1));
    const busy = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/runs`,
      headers: authHeaders(),
      payload: { input: "不能并发" }
    });

    resetRelease.resolve();
    const response = await resetting;

    expect(busy.statusCode).toBe(409);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: { code: "runtime_reset_failed", message: "Failed to reset runtime session" } });
    expect(db.prepare("SELECT status, provider_session_id FROM sessions WHERE id = ?").get(session.id)).toEqual({
      status: "idle",
      provider_session_id: "provider-session-1"
    });

    const accepted = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/runs`,
      headers: authHeaders(),
      payload: { input: "失败后继续" }
    });
    expect(accepted.statusCode).toBe(201);
  });

  it("运行中的 Session 拒绝 reset", async () => {
    const reset = vi.fn(async (_input: RuntimeSessionInput): Promise<void> => undefined);
    const { app, db } = await createTestApp({ runtime: createFakeRuntime(reset) });
    const agent = await createAgent(app);
    const session = await createSession(app, agent.id);
    db.prepare("UPDATE sessions SET status = ? WHERE id = ?").run("running", session.id);

    const response = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/reset`, headers: authHeaders() });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: { code: "session_busy", message: "Session is running" } });
    expect(reset).not.toHaveBeenCalled();
  });

  it("永久删除空闲 Session 的 Runtime 引用、Workspace、Run 和 Event", async () => {
    const reset = vi.fn(async (_input: RuntimeSessionInput): Promise<void> => undefined);
    const forgetSession = vi.fn(async (_sessionId: number): Promise<void> => undefined);
    const calls: Array<{ command: string; args: string[] }> = [];
    const { app, db } = await createTestApp({
      runtime: createFakeRuntime(reset, forgetSession),
      commandRunner: {
        run: async (command, args) => {
          calls.push({ command, args });
          if (args[1] === "snapshot") mkdirSync(args[3]);
          return { stdout: "", stderr: "" };
        }
      }
    });
    const agent = await createAgent(app);
    const session = await createSession(app, agent.id);
    db.prepare("UPDATE sessions SET provider_session_id = ? WHERE id = ?").run("provider-session-1", session.id);
    db.prepare(`
      INSERT INTO runs (session_id, status, input, result, created_at, started_at, finished_at)
      VALUES (?, 'succeeded', 'question', 'answer', ?, ?, ?)
    `).run(session.id, "2026-08-13T00:00:00.000Z", "2026-08-13T00:00:01.000Z", "2026-08-13T00:00:02.000Z");
    const runId = Number(db.prepare("SELECT id FROM runs WHERE session_id = ?").pluck().get(session.id));
    db.prepare(`
      INSERT INTO events (run_id, seq, type, content_json, created_at)
      VALUES (?, 1, 'message', '{"text":"answer"}', ?)
    `).run(runId, "2026-08-13T00:00:01.000Z");
    const response = await app.inject({ method: "DELETE", url: `/api/sessions/${session.id}`, headers: authHeaders() });

    expect(response.statusCode).toBe(204);
    expect(reset).not.toHaveBeenCalled();
    expect(forgetSession).toHaveBeenCalledWith(session.id);
    expect(calls.at(-1)).toEqual({
      command: "btrfs",
      args: ["subvolume", "delete", session.workspacePath]
    });
    expect(existsSync(dirname(session.workspacePath))).toBe(false);
    expect(db.prepare("SELECT count(*) AS count FROM events").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) AS count FROM runs").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 0 });
  });

  it("永久删除 Session 时同时删除关联的外部接入记录", async () => {
    const { app, db } = await createTestApp();
    const agent = await createAgent(app);
    const session = await createSession(app, agent.id);
    const now = "2026-08-24T00:00:00.000Z";
    const runId = Number(db.prepare(`
      INSERT INTO runs (session_id, status, input, result, created_at, started_at, finished_at)
      VALUES (?, 'succeeded', 'question', 'answer', ?, ?, ?)
    `).run(session.id, now, now, now).lastInsertRowid);
    const endpointId = Number(db.prepare(`
      INSERT INTO integration_endpoints
        (name, slug, agent_id, enabled, token_hash, created_at, updated_at)
      VALUES ('测试接入', 'session-delete', ?, 1, 'session-delete-token', ?, ?)
    `).run(agent.id, now, now).lastInsertRowid);
    const conversationId = Number(db.prepare(`
      INSERT INTO integration_conversations
        (endpoint_id, conversation_key, session_id, status, created_at)
      VALUES (?, 'ticket-2081', ?, 'active', ?)
    `).run(endpointId, session.id, now).lastInsertRowid);
    const taskId = Number(db.prepare(`
      INSERT INTO integration_tasks
        (endpoint_id, conversation_id, session_id, run_id, request_id, request_fingerprint,
         message, effective_prompt, status, created_at, started_at, finished_at)
      VALUES (?, ?, ?, ?, 'request-1', 'fingerprint-1', 'message', 'prompt', 'succeeded', ?, ?, ?)
    `).run(endpointId, conversationId, session.id, runId, now, now, now).lastInsertRowid);
    db.prepare(`
      INSERT INTO integration_task_events
        (task_id, event_key, event_type, sequence, dispatch_order, event_id, occurred_at, payload_json, created_at)
      VALUES (?, 'task.finished', 'task.finished', 1, 1, 'event-1', ?, '{}', ?)
    `).run(taskId, now, now);
    const subscriptionId = Number(db.prepare(`
      INSERT INTO webhook_subscriptions
        (endpoint_id, name, url, enabled, events_json, encrypted_signing_secret, created_at, updated_at)
      VALUES (?, '测试回调', 'https://example.test/webhook', 1, '["task.finished"]', 'secret', ?, ?)
    `).run(endpointId, now, now).lastInsertRowid);
    db.prepare(`
      INSERT INTO webhook_deliveries
        (event_id, event_key, sequence, dispatch_order, subscription_id, task_id, event_type,
         payload_json, status, next_attempt_at, created_at, updated_at)
      VALUES ('delivery-event-1', 'task.finished', 1, 1, ?, ?, 'task.finished', '{}', 'succeeded', ?, ?, ?)
    `).run(subscriptionId, taskId, now, now, now);

    const response = await app.inject({ method: "DELETE", url: `/api/sessions/${session.id}`, headers: authHeaders() });

    expect(response.statusCode).toBe(204);
    for (const table of [
      "webhook_deliveries",
      "integration_task_events",
      "integration_tasks",
      "integration_conversations",
      "runs",
      "sessions"
    ]) {
      expect(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    expect(db.prepare("SELECT count(*) AS count FROM integration_endpoints").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT count(*) AS count FROM webhook_subscriptions").get()).toEqual({ count: 1 });
  });

  it("删除 Session 后重试回收发布阶段遗留的旧环境 Workspace", async () => {
    const { app, db, dataDir } = await createTestApp();
    const agent = await createAgent(app);
    const first = await createSession(app, agent.id);
    const second = await createSession(app, agent.id);
    const environment = db.prepare("SELECT id FROM project_environments LIMIT 1").get() as { id: number };
    const oldRevision = db.prepare(`
      SELECT id FROM project_environment_revisions WHERE project_environment_id = ? ORDER BY id ASC LIMIT 1
    `).get(environment.id) as { id: number };
    const oldWorkspace = join(dataDir, "environments", String(environment.id), "revisions", String(oldRevision.id), "workspace");
    mkdirSync(oldWorkspace, { recursive: true });
    db.prepare("UPDATE project_environment_revisions SET workspace_path = ?, created_at = ? WHERE id = ?")
      .run(oldWorkspace, "2026-08-12T00:00:00.000Z", oldRevision.id);
    for (const [index, createdAt] of [
      "2026-08-13T00:00:00.000Z",
      "2026-08-14T00:00:00.000Z"
    ].entries()) {
      const revisionId = Number(db.prepare(`
        INSERT INTO project_environment_revisions
          (project_environment_id, status, workspace_path, input_fingerprint, created_at, finished_at)
        VALUES (?, 'ready', ?, ?, ?, ?)
      `).run(
        environment.id,
        join(dataDir, "environments", String(environment.id), "revisions", `new-${index}`, "workspace"),
        `new-${index}`,
        createdAt,
        createdAt
      ).lastInsertRowid);
      if (index === 1) {
        db.prepare("UPDATE project_environments SET current_revision_id = ? WHERE id = ?")
          .run(revisionId, environment.id);
      }
    }
    db.prepare("UPDATE sessions SET project_environment_revision_id = ? WHERE id IN (?, ?)")
      .run(oldRevision.id, first.id, second.id);

    const firstDelete = await app.inject({ method: "DELETE", url: `/api/sessions/${first.id}`, headers: authHeaders() });
    expect(firstDelete.statusCode).toBe(204);
    expect(existsSync(oldWorkspace)).toBe(false);
    expect(db.prepare("SELECT workspace_path AS path FROM project_environment_revisions WHERE id = ?")
      .get(oldRevision.id)).toEqual({ path: null });

    const secondDelete = await app.inject({ method: "DELETE", url: `/api/sessions/${second.id}`, headers: authHeaders() });
    expect(secondDelete.statusCode).toBe(204);
    expect(existsSync(oldWorkspace)).toBe(false);
    expect(db.prepare("SELECT workspace_path AS path FROM project_environment_revisions WHERE id = ?")
      .get(oldRevision.id)).toEqual({ path: null });
  });

  it("删除 Session 需要鉴权并区分不存在与运行中", async () => {
    const reset = vi.fn(async (_input: RuntimeSessionInput): Promise<void> => undefined);
    const { app, db } = await createTestApp({ runtime: createFakeRuntime(reset) });
    const agent = await createAgent(app);
    const session = await createSession(app, agent.id);
    db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(session.id);

    const unauthorized = await app.inject({ method: "DELETE", url: `/api/sessions/${session.id}` });
    const missing = await app.inject({ method: "DELETE", url: "/api/sessions/999999", headers: authHeaders() });
    const busy = await app.inject({ method: "DELETE", url: `/api/sessions/${session.id}`, headers: authHeaders() });

    expect(unauthorized.statusCode).toBe(401);
    expect(missing.statusCode).toBe(404);
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toEqual({ error: { code: "session_busy", message: "Session is running" } });
    expect(reset).not.toHaveBeenCalled();
  });

  it("Provider 清理失败不阻止删除本地 Session", async () => {
    const reset = vi.fn(async () => Promise.reject(new Error("provider delete failed")));
    const forgetSession = vi.fn(async () => Promise.reject(new Error("provider delete failed")));
    const { app, db } = await createTestApp({ runtime: createFakeRuntime(reset, forgetSession) });
    const agent = await createAgent(app);
    const session = await createSession(app, agent.id);
    db.prepare("UPDATE sessions SET provider_session_id = ? WHERE id = ?").run("provider-session-1", session.id);

    const response = await app.inject({ method: "DELETE", url: `/api/sessions/${session.id}`, headers: authHeaders() });

    expect(response.statusCode).toBe(204);
    expect(reset).not.toHaveBeenCalled();
    expect(forgetSession).toHaveBeenCalledWith(session.id);
    expect(db.prepare("SELECT id FROM sessions WHERE id = ?").get(session.id)).toBeUndefined();
    expect(existsSync(dirname(session.workspacePath))).toBe(false);
  });

  it("Workspace 删除失败后保持占用和历史，拒绝新 Run 并允许重试删除", async () => {
    let shouldFail = true;
    const reset = vi.fn(async (_input: RuntimeSessionInput): Promise<void> => undefined);
    const { app, db } = await createTestApp({
      runtime: createFakeRuntime(reset),
      commandRunner: {
        run: async (_command, args) => {
          if (args[1] === "snapshot") mkdirSync(args[3]);
          if (args[1] === "delete" && shouldFail) throw new Error("workspace delete failed");
          return { stdout: "", stderr: "" };
        }
      }
    });
    const agent = await createAgent(app);
    const session = await createSession(app, agent.id);
    db.prepare("UPDATE sessions SET provider_session_id = ? WHERE id = ?").run("provider-session-1", session.id);
    db.prepare(`INSERT INTO runs (session_id, status, input, created_at) VALUES (?, 'succeeded', 'question', ?)`)
      .run(session.id, "2026-08-13T00:00:00.000Z");

    const response = await app.inject({ method: "DELETE", url: `/api/sessions/${session.id}`, headers: authHeaders() });

    expect(response.statusCode).toBe(500);
    expect(db.prepare("SELECT * FROM sessions WHERE id = ?").get(session.id)).toMatchObject({
      status: "running",
      pending_operation: "delete",
      provider_session_id: "provider-session-1"
    });
    expect(db.prepare("SELECT count(*) AS count FROM runs WHERE session_id = ?").get(session.id)).toEqual({ count: 1 });
    expect(existsSync(dirname(session.workspacePath))).toBe(true);

    const rejected = await app.inject({
      method: "POST", url: `/api/sessions/${session.id}/runs`, headers: authHeaders(), payload: { input: "unsafe reuse" }
    });
    expect(rejected.statusCode).toBe(409);
    shouldFail = false;
    const retried = await app.inject({ method: "DELETE", url: `/api/sessions/${session.id}`, headers: authHeaders() });
    expect(retried.statusCode).toBe(204);
    expect(db.prepare("SELECT id FROM sessions WHERE id = ?").get(session.id)).toBeUndefined();
    expect(existsSync(dirname(session.workspacePath))).toBe(false);
  });
});
