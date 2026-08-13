import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { AgentManager } from "../src/agents/agent-manager.js";
import { SessionManager } from "../src/sessions/session-manager.js";
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

const createFakeRuntime = (reset = async (_input: RuntimeSessionInput): Promise<void> => undefined): AgentRuntime => ({
  ensureSession: async (_input: RuntimeSessionInput): Promise<RuntimeSession> => ({ providerSessionId: null }),
  startTurn: (_input: RuntimeTurnInput): RuntimeTurn => {
    throw new Error("Fake Runtime does not start turns in Session API tests");
  },
  cancel: async (_sessionId: string): Promise<void> => undefined,
  reset,
  doctor: async (_provider: "claude_code" | "codex" | "hermes", _agentId: string): Promise<RuntimeDoctor> => ({
    ok: true,
    message: "ready",
    details: []
  }),
  shutdown: async (): Promise<void> => undefined
});

const createTestApp = async (options: {
  runtime?: AgentRuntime;
  commandRunner?: CommandRunner;
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
    workspaceTemplate: join(dataDir, "template"),
    sessionsRoot: join(dataDir, "sessions"),
    maxConcurrentRuns: 4
  };
  const app = buildApp({
    config,
    db,
    runtime: options.runtime ?? createFakeRuntime(),
    workspaceManager: new BtrfsWorkspaceManager({
      workspaceTemplate: config.workspaceTemplate,
      sessionsRoot: config.sessionsRoot,
      commandRunner
    })
  });
  apps.push({ app, close: async () => { await app.close(); db.close(); } });
  await app.ready();
  return { app, db, dataDir };
};

const createAgent = async (app: FastifyInstance): Promise<{ id: string }> => {
  const environments = await app.inject({ method: "GET", url: "/api/project-environments", headers: authHeaders() });
  const projectEnvironmentId = (environments.json() as Array<{ id: string }>)[0]!.id;
  const response = await app.inject({
    method: "POST",
    url: "/api/agents",
    headers: authHeaders(),
    payload: { name: "Codex", provider: "codex", projectEnvironmentId }
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string };
};

const createSession = async (app: FastifyInstance, agentId: string): Promise<{ id: string; workspacePath: string }> => {
  const response = await app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: authHeaders(),
    payload: { agentId, title: "修复工单 1332" }
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string; workspacePath: string };
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map(({ close }) => close()));
  tempDirs.splice(0).forEach((directory) => rmSync(directory, { force: true, recursive: true }));
});

describe("Session API", () => {
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
    const sessionId = (created.json() as { id: string }).id;

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
      "INSERT INTO runs (id, session_id, status, input, created_at) VALUES (?, ?, 'queued', ?, ?)"
    ).run("busy-run", sessionId, "queued", "2026-08-13T00:00:00.000Z");
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
        expect(db.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 0 });
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
      projectEnvironmentRevisionId: expect.any(String)
    });
    const session = created.json() as { id: string; workspacePath: string };
    expect(existsSync(session.workspacePath)).toBe(true);
    expect(db.prepare("SELECT id, project_environment_revision_id FROM sessions WHERE id = ?").get(session.id)).toEqual({
      id: session.id,
      project_environment_revision_id: (created.json() as { projectEnvironmentRevisionId: string }).projectEnvironmentRevisionId
    });

    const detail = await app.inject({ method: "GET", url: `/api/sessions/${session.id}`, headers: authHeaders() });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ id: session.id, agentId: agent.id, title: "修复工单 1332" });

    const list = await app.inject({ method: "GET", url: "/api/sessions", headers: authHeaders() });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject([{ id: session.id, title: "修复工单 1332" }]);
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
          expect(db.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 0 });
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
      if (sql.startsWith("INSERT INTO sessions")) {
        return { run: () => { throw new Error("database write failed"); } } as never;
      }
      return originalPrepare(sql);
    }) as typeof db.prepare);
    const runtime = createFakeRuntime();
    const agentManager = new AgentManager({ db, dataDir, runtime });
    const workspaceManager = new BtrfsWorkspaceManager({
      workspaceTemplate: join(dataDir, "template"),
      sessionsRoot: join(dataDir, "sessions"),
      commandRunner
    });
    const manager = new SessionManager({ db, dataDir, agentManager, runtime, workspaceManager });
    const agent = db.prepare("SELECT id FROM agents").get() as { id: string };

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
    writeFileSync(join(dataDir, "agents", agent.id, "MEMORY.md"), "remember reset");
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
      memory: "remember reset"
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

  it("永久删除空闲 Session 的 Provider、Workspace、Run 和 Event", async () => {
    const reset = vi.fn(async (_input: RuntimeSessionInput): Promise<void> => undefined);
    const calls: Array<{ command: string; args: string[] }> = [];
    const { app, db, dataDir } = await createTestApp({
      runtime: createFakeRuntime(reset),
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
    writeFileSync(join(dataDir, "agents", agent.id, "MEMORY.md"), "remember delete");
    db.prepare("UPDATE sessions SET provider_session_id = ? WHERE id = ?").run("provider-session-1", session.id);
    db.prepare(`
      INSERT INTO runs (id, session_id, status, input, result, created_at, started_at, finished_at)
      VALUES ('run-delete-1', ?, 'succeeded', 'question', 'answer', ?, ?, ?)
    `).run(session.id, "2026-08-13T00:00:00.000Z", "2026-08-13T00:00:01.000Z", "2026-08-13T00:00:02.000Z");
    db.prepare(`
      INSERT INTO events (id, run_id, seq, type, content_json, created_at)
      VALUES ('event-delete-1', 'run-delete-1', 1, 'message', '{"text":"answer"}', ?)
    `).run("2026-08-13T00:00:01.000Z");

    const response = await app.inject({ method: "DELETE", url: `/api/sessions/${session.id}`, headers: authHeaders() });

    expect(response.statusCode).toBe(204);
    expect(reset).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: session.id,
      agentId: agent.id,
      providerSessionId: "provider-session-1",
      workspacePath: session.workspacePath,
      memory: "remember delete"
    }));
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
    const missing = await app.inject({ method: "DELETE", url: "/api/sessions/00000000-0000-0000-0000-000000000000", headers: authHeaders() });
    const busy = await app.inject({ method: "DELETE", url: `/api/sessions/${session.id}`, headers: authHeaders() });

    expect(unauthorized.statusCode).toBe(401);
    expect(missing.statusCode).toBe(404);
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toEqual({ error: { code: "session_busy", message: "Session is running" } });
    expect(reset).not.toHaveBeenCalled();
  });

  it("Provider 清理失败时释放删除 claim 并保留全部本地资源", async () => {
    const reset = vi.fn(async () => Promise.reject(new Error("provider delete failed")));
    const { app, db } = await createTestApp({ runtime: createFakeRuntime(reset) });
    const agent = await createAgent(app);
    const session = await createSession(app, agent.id);
    db.prepare("UPDATE sessions SET provider_session_id = ? WHERE id = ?").run("provider-session-1", session.id);

    const response = await app.inject({ method: "DELETE", url: `/api/sessions/${session.id}`, headers: authHeaders() });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: { code: "session_delete_failed", message: "Failed to delete session" } });
    expect(db.prepare("SELECT status, provider_session_id FROM sessions WHERE id = ?").get(session.id)).toEqual({
      status: "idle",
      provider_session_id: "provider-session-1"
    });
    expect(existsSync(dirname(session.workspacePath))).toBe(true);
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
    db.prepare(`INSERT INTO runs (id, session_id, status, input, created_at) VALUES ('run-preserved', ?, 'succeeded', 'question', ?)`)
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
