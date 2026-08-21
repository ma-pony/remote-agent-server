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
    projectEnvironmentCheckIntervalMs: 3 * 60 * 60 * 1000,
    projectPrepareTimeoutMs: 30 * 60 * 1000
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

  it("列表按创建时间倒序返回最新会话", async () => {
    const { app, db } = await createTestApp();
    const agent = await createAgent(app);
    const older = await createSession(app, agent.id);
    const newer = await createSession(app, agent.id);
    db.prepare("UPDATE sessions SET created_at = ? WHERE id = ?").run("2026-08-18T00:00:00.000Z", older.id);
    db.prepare("UPDATE sessions SET created_at = ? WHERE id = ?").run("2026-08-19T00:00:00.000Z", newer.id);

    const response = await app.inject({ method: "GET", url: "/api/sessions", headers: authHeaders() });

    expect(response.statusCode).toBe(200);
    expect((response.json() as Array<{ id: number }>).map(({ id }) => id)).toEqual([newer.id, older.id]);
  });

  it("列表批量计算 MCP 状态而不逐条查询 Session", async () => {
    const { app } = await createTestApp();
    const agent = await createAgent(app);
    await createSession(app, agent.id);
    await createSession(app, agent.id);
    const perSession = vi.spyOn(McpManager.prototype, "getSessionStatus");

    const response = await app.inject({ method: "GET", url: "/api/sessions", headers: authHeaders() });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(2);
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
    expect(list.json()).toMatchObject([{ id: session.id, title: "修复工单 1332" }]);
  });

  it("创建 Session 后按项目 gitignore 清理并重新准备环境", async () => {
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
    expect(cleanIgnored).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);
    const repositoryPath = join(sessionWorkspace, "bid-spiders");
    expect(readFileSync(join(repositoryPath, ".venv", "bin", "playwright"), "utf8"))
      .toBe(`#!${repositoryPath}/.venv/bin/python\n`);
    expect(readFileSync(join(repositoryPath, "local-notes.txt"), "utf8")).toBe("keep me");
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
          expect(db.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 0 });
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

  it("Workspace 清理失败时清除 Provider ID、释放 claim 并保留历史", async () => {
    const reset = vi.fn(async (_input: RuntimeSessionInput): Promise<void> => undefined);
    const { app, db } = await createTestApp({
      runtime: createFakeRuntime(reset),
      commandRunner: {
        run: async (_command, args) => {
          if (args[1] === "snapshot") mkdirSync(args[3]);
          if (args[1] === "delete") throw new Error("workspace delete failed");
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
    expect(db.prepare("SELECT status, provider_session_id FROM sessions WHERE id = ?").get(session.id)).toEqual({
      status: "idle",
      provider_session_id: null
    });
    expect(db.prepare("SELECT count(*) AS count FROM runs WHERE session_id = ?").get(session.id)).toEqual({ count: 1 });
    expect(existsSync(dirname(session.workspacePath))).toBe(true);
  });
});
