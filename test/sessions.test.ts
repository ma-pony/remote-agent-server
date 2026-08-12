import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { AgentManager } from "../src/agents/agent-manager.js";
import { SessionManager } from "../src/sessions/session-manager.js";
import { BtrfsWorkspaceManager } from "../src/workspaces/btrfs-workspace.js";
import type { CommandRunner } from "../src/workspaces/btrfs-workspace.js";
import type { AgentRuntime, RuntimeDoctor, RuntimeSession, RuntimeSessionInput, RuntimeTurn, RuntimeTurnInput } from "../src/runtime/agent-runtime.js";
import { createTestDatabase } from "./helpers.js";

const apiToken = "test-token";
const authHeaders = (): Record<string, string> => ({ authorization: `Bearer ${apiToken}` });

const tempDirs: string[] = [];
const apps: Array<{ app: FastifyInstance; close: () => Promise<void> }> = [];

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
  })
});

const createTestApp = async (options: {
  runtime?: AgentRuntime;
  commandRunner?: CommandRunner;
} = {}): Promise<{ app: FastifyInstance; db: ReturnType<typeof createTestDatabase>["db"] }> => {
  const { db } = createTestDatabase();
  const dataDir = mkdtempSync(join(tmpdir(), "remote-agent-sessions-"));
  tempDirs.push(dataDir);
  const app = buildApp({
    config: {
      host: "127.0.0.1",
      port: 3000,
      apiToken,
      dataDir,
      databasePath: ":memory:",
      workspaceTemplate: join(dataDir, "template"),
      sessionsRoot: join(dataDir, "sessions"),
      maxConcurrentRuns: 4
    },
    db,
    runtime: options.runtime ?? createFakeRuntime(),
    commandRunner: options.commandRunner ?? { run: async () => ({ stdout: "", stderr: "" }) }
  });
  apps.push({ app, close: async () => { await app.close(); db.close(); } });
  await app.ready();
  return { app, db };
};

const createAgent = async (app: FastifyInstance): Promise<{ id: string }> => {
  const response = await app.inject({
    method: "POST",
    url: "/api/agents",
    headers: authHeaders(),
    payload: { name: "Codex", provider: "codex" }
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
      providerSessionId: null
    });
    const session = created.json() as { id: string; workspacePath: string };
    expect(existsSync(session.workspacePath)).toBe(true);
    expect(db.prepare("SELECT id FROM sessions WHERE id = ?").get(session.id)).toEqual({ id: session.id });

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

    await expect(manager.create({ agentId: agent.id, title: "修复工单 1332" })).rejects.toMatchObject({
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

  it("重置成功后保留 Workspace 并只清空 Provider Session ID", async () => {
    let app!: FastifyInstance;
    let db!: ReturnType<typeof createTestDatabase>["db"];
    let providerSessionIdDuringRuntime: string | null = null;
    const reset = vi.fn(async (_input: RuntimeSessionInput): Promise<void> => {
      providerSessionIdDuringRuntime = (db.prepare("SELECT provider_session_id FROM sessions WHERE id = ?").get(_input.sessionId) as {
        provider_session_id: string | null;
      }).provider_session_id;
    });
    ({ app, db } = await createTestApp({ runtime: createFakeRuntime(reset) }));
    const agent = await createAgent(app);
    const session = await createSession(app, agent.id);
    db.prepare("UPDATE sessions SET provider_session_id = ? WHERE id = ?").run("provider-session-1", session.id);

    const response = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/reset`, headers: authHeaders() });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: session.id, providerSessionId: null, workspacePath: session.workspacePath });
    expect(reset).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: session.id,
      agentId: agent.id,
      provider: "codex",
      providerSessionId: "provider-session-1",
      workspacePath: session.workspacePath
    }));
    expect(providerSessionIdDuringRuntime).toBe("provider-session-1");
    expect(db.prepare("SELECT provider_session_id FROM sessions WHERE id = ?").get(session.id)).toEqual({ provider_session_id: null });
  });

  it("Runtime reset 失败时保留 Provider Session ID", async () => {
    const { app, db } = await createTestApp({
      runtime: createFakeRuntime(async () => Promise.reject(new Error("provider failed")))
    });
    const agent = await createAgent(app);
    const session = await createSession(app, agent.id);
    db.prepare("UPDATE sessions SET provider_session_id = ? WHERE id = ?").run("provider-session-1", session.id);

    const response = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/reset`, headers: authHeaders() });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: { code: "runtime_reset_failed", message: "Failed to reset runtime session" } });
    expect(db.prepare("SELECT provider_session_id FROM sessions WHERE id = ?").get(session.id)).toEqual({ provider_session_id: "provider-session-1" });
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
});
