import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { migrate, openDatabase } from "../src/db.js";
import type { Run } from "../src/domain.js";
import { startServer, type RunningServer } from "../src/main.js";
import type { AgentRuntime, RuntimeTurnResult } from "../src/runtime/agent-runtime.js";
import { BEST_EFFORT_TIMEOUT_MS } from "../src/runtime/bounded-operation.js";
import { RunScheduler } from "../src/runs/run-scheduler.js";
import { RunRepository, RunRepositoryError } from "../src/runs/run-repository.js";
import { createFakeRuntime, createTestDatabase } from "./helpers.js";

const apiToken = "test-token";
const authHeaders = (): Record<string, string> => ({ authorization: `Bearer ${apiToken}` });
const tempDirectories: string[] = [];
const applications: Array<{ app: FastifyInstance; db: ReturnType<typeof createTestDatabase>["db"] }> = [];

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const createApiTestApp = async (options: { runtime?: AgentRuntime; maxConcurrentRuns?: number } = {}) => {
  const { db } = createTestDatabase();
  const root = mkdtempSync(join(tmpdir(), "remote-agent-runs-"));
  tempDirectories.push(root);
  const app = buildApp({
    config: {
      host: "127.0.0.1",
      port: 3000,
      apiToken,
      dataDir: join(root, "data"),
      databasePath: ":memory:",
      workspaceTemplate: join(root, "template"),
      sessionsRoot: join(root, "sessions"),
      maxConcurrentRuns: options.maxConcurrentRuns ?? 2
    },
    db,
    runtime: options.runtime ?? createFakeRuntime(),
    commandRunner: { run: async () => ({ stdout: "", stderr: "" }) }
  });
  applications.push({ app, db });
  await app.ready();
  return { app, db, root };
};

const seedSession = (db: ReturnType<typeof createTestDatabase>["db"], root: string, id: string): void => {
  const agent = db.prepare("SELECT id FROM agents ORDER BY created_at LIMIT 1").get() as { id: string };
  const workspacePath = join(root, "sessions", id, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(join(dirname(workspacePath), "browser"), { recursive: true });
  const createdAt = new Date().toISOString();
  db.prepare(
    "INSERT INTO sessions (id, agent_id, title, status, workspace_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, agent.id, `Session ${id}`, "idle", workspacePath, createdAt, createdAt);
};

const postRun = (app: FastifyInstance, sessionId: string, input: string) => app.inject({
  method: "POST",
  url: `/api/sessions/${sessionId}/runs`,
  headers: authHeaders(),
  payload: { input }
});

afterEach(async () => {
  await Promise.all(applications.splice(0).map(async ({ app, db }) => {
    await app.close();
    db.close();
  }));
  tempDirectories.splice(0).forEach((directory) => rmSync(directory, { force: true, recursive: true }));
});

describe("RunRepository", () => {
  it("创建 queued Run 时同步将 Session 标为 running", () => {
    const { db, seed } = createTestDatabase();
    const session = seed.session();
    const repository = new RunRepository({ db });

    const run = repository.create({ sessionId: session.id, input: "修复工单 1332" });

    expect(run).toMatchObject({ sessionId: session.id, status: "queued", input: "修复工单 1332" });
    expect(db.prepare("SELECT status FROM sessions WHERE id = ?").get(session.id)).toEqual({ status: "running" });
    db.close();
  });

  it("同一个 Session 的第二个活动 Run 返回 session_busy", () => {
    const { db, seed } = createTestDatabase();
    const session = seed.session();
    const repository = new RunRepository({ db });
    repository.create({ sessionId: session.id, input: "first" });

    expect(() => repository.create({ sessionId: session.id, input: "second" })).toThrow(
      expect.objectContaining({ code: "session_busy" })
    );
    expect(repository.listBySession(session.id)).toHaveLength(1);
    db.close();
  });

  it("结束 running Run 时原子恢复 Session 为 idle", () => {
    const { db, seed } = createTestDatabase();
    const session = seed.session();
    const repository = new RunRepository({ db });
    const run = repository.create({ sessionId: session.id, input: "work" });
    repository.markRunning(run.id);
    db.exec(`
      CREATE TRIGGER reject_idle_session
      BEFORE UPDATE OF status ON sessions
      WHEN NEW.status = 'idle'
      BEGIN
        SELECT RAISE(ABORT, 'session update rejected');
      END;
    `);

    expect(() => repository.finish(run.id, { status: "succeeded", result: "done" })).toThrow("session update rejected");
    expect(repository.get(run.id)).toMatchObject({ status: "running", result: null, finishedAt: null });
    expect(db.prepare("SELECT status FROM sessions WHERE id = ?").get(session.id)).toEqual({ status: "running" });
    db.exec("DROP TRIGGER reject_idle_session");

    expect(repository.finish(run.id, { status: "succeeded", result: "done" })).toMatchObject({
      status: "succeeded",
      result: "done",
      error: null
    });
    expect(db.prepare("SELECT status FROM sessions WHERE id = ?").get(session.id)).toEqual({ status: "idle" });
    db.close();
  });

  it("拒绝非法的 Run 状态转换", () => {
    const { db, seed } = createTestDatabase();
    const session = seed.session();
    const repository = new RunRepository({ db });
    const run = repository.create({ sessionId: session.id, input: "work" });

    expect(() => repository.finish(run.id, { status: "succeeded", result: "done" })).toThrow(
      expect.objectContaining({ code: "invalid_run_state" } satisfies Partial<RunRepositoryError>)
    );
    repository.markRunning(run.id);
    expect(() => repository.cancelQueued(run.id)).toThrow(
      expect.objectContaining({ code: "invalid_run_state" } satisfies Partial<RunRepositoryError>)
    );
    db.close();
  });

  it("取消 queued Run 时恢复 Session 为 idle", () => {
    const { db, seed } = createTestDatabase();
    const session = seed.session();
    const repository = new RunRepository({ db });
    const run = repository.create({ sessionId: session.id, input: "work" });

    expect(repository.cancelQueued(run.id)).toMatchObject({ status: "cancelled" });
    expect(db.prepare("SELECT status FROM sessions WHERE id = ?").get(session.id)).toEqual({ status: "idle" });
    db.close();
  });

  it("重启后仅失败旧 running Run，并保留 queued Run", () => {
    const { db, seed } = createTestDatabase();
    const runningSession = seed.session();
    const queuedSession = seed.session();
    seed.run(runningSession.id, "running");
    seed.run(queuedSession.id, "queued");
    db.prepare("UPDATE sessions SET status = 'running'").run();
    const repository = new RunRepository({ db });

    repository.recoverAfterRestart();

    expect(repository.listBySession(runningSession.id)).toMatchObject([{ status: "failed", error: "server_restarted" }]);
    expect(repository.listBySession(queuedSession.id)).toMatchObject([{ status: "queued", error: null }]);
    expect(db.prepare("SELECT status FROM sessions WHERE id = ?").get(runningSession.id)).toEqual({ status: "idle" });
    expect(db.prepare("SELECT status FROM sessions WHERE id = ?").get(queuedSession.id)).toEqual({ status: "running" });
    expect(repository.listQueued()).toMatchObject([{ sessionId: queuedSession.id, status: "queued" }]);
    db.close();
  });
});

describe("RunScheduler", () => {
  it("最多并行执行 MAX_CONCURRENT_RUNS 个不同 Run，并在 finally 后继续 drain", async () => {
    const queued = ["run-1", "run-2", "run-3"].map((id) => ({ id })) as Run[];
    const releases = new Map<string, () => void>();
    let concurrent = 0;
    let maximum = 0;
    const execute = vi.fn((runId: string) => new Promise<Run>((resolve) => {
      concurrent += 1;
      maximum = Math.max(maximum, concurrent);
      releases.set(runId, () => {
        concurrent -= 1;
        resolve({ id: runId } as Run);
      });
    }));
    const scheduler = new RunScheduler({
      runRepository: { listQueued: () => queued },
      executor: { execute, cancel: async () => ({}) as Run },
      maxConcurrentRuns: 2
    });

    scheduler.start();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(maximum).toBe(2);
    expect(execute.mock.calls.map(([runId]) => runId)).toEqual(["run-1", "run-2"]);

    releases.get("run-1")?.();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
    expect(maximum).toBe(2);
    releases.get("run-2")?.();
    releases.get("run-3")?.();
    await scheduler.stop();
  });

  it("执行异常仍释放全局并发名额并继续下一个 queued Run", async () => {
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error("executor failed"))
      .mockResolvedValueOnce({ id: "run-2" } as Run);
    const scheduler = new RunScheduler({
      runRepository: { listQueued: () => [{ id: "run-1" }, { id: "run-2" }] as Run[] },
      executor: { execute, cancel: async () => ({}) as Run },
      maxConcurrentRuns: 1
    });

    scheduler.start();

    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(execute.mock.calls.map(([runId]) => runId)).toEqual(["run-1", "run-2"]);
    await scheduler.stop();
  });

  it("stop 的 active cancel 永不结束时仍在固定 timeout 后返回", async () => {
    vi.useFakeTimers();
    try {
      const execute = vi.fn(() => new Promise<Run>(() => undefined));
      const cancel = vi.fn(() => new Promise<Run>(() => undefined));
      const scheduler = new RunScheduler({
        runRepository: { listQueued: () => [{ id: "run-1" }] as Run[] },
        executor: { execute, cancel },
        maxConcurrentRuns: 1
      });
      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);

      const stopping = scheduler.stop();
      await vi.advanceTimersByTimeAsync(BEST_EFFORT_TIMEOUT_MS);
      await stopping;

      expect(cancel).toHaveBeenCalledWith("run-1");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Run API", () => {
  it("创建 Run 后可读取，并拒绝同一 Session 的第二个未结束 Run", async () => {
    const result = deferred<RuntimeTurnResult>();
    const runtime = createFakeRuntime();
    runtime.startTurn = () => ({
      events: { async *[Symbol.asyncIterator]() {} },
      result: result.promise,
      cancel: async () => undefined,
      closeEvents: async () => undefined
    });
    runtime.cancel = async () => result.resolve({ status: "cancelled" });
    const { app, db, root } = await createApiTestApp({ runtime, maxConcurrentRuns: 1 });
    seedSession(db, root, "session-1");

    const created = await postRun(app, "session-1", "first");
    const run = created.json() as Run;
    const busy = await postRun(app, "session-1", "second");
    const detail = await app.inject({ method: "GET", url: `/api/runs/${run.id}`, headers: authHeaders() });

    expect(created.statusCode).toBe(201);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ id: run.id, input: "first" });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toEqual({ error: { code: "session_busy", message: "Session already has an active Run" } });
    await app.inject({ method: "POST", url: `/api/runs/${run.id}/cancel`, headers: authHeaders() });
    await vi.waitFor(() => expect(new RunRepository({ db }).get(run.id)?.status).toBe("cancelled"));
  });

  it("取消 queued Run 不调用 Runtime，取消 running Run 调用 Runtime cancel", async () => {
    const firstResult = deferred<RuntimeTurnResult>();
    const cancel = vi.fn(async () => firstResult.resolve({ status: "cancelled" }));
    const runtime = createFakeRuntime();
    runtime.startTurn = () => ({
      events: { async *[Symbol.asyncIterator]() {} },
      result: firstResult.promise,
      cancel: async () => undefined,
      closeEvents: async () => undefined
    });
    runtime.cancel = cancel;
    const { app, db, root } = await createApiTestApp({ runtime, maxConcurrentRuns: 1 });
    seedSession(db, root, "session-1");
    seedSession(db, root, "session-2");
    const running = (await postRun(app, "session-1", "first")).json() as Run;
    const queued = (await postRun(app, "session-2", "second")).json() as Run;

    const queuedCancel = await app.inject({ method: "POST", url: `/api/runs/${queued.id}/cancel`, headers: authHeaders() });
    expect(queuedCancel.statusCode).toBe(200);
    expect(queuedCancel.json()).toMatchObject({ status: "cancelled" });
    expect(cancel).not.toHaveBeenCalled();

    const runningCancel = await app.inject({ method: "POST", url: `/api/runs/${running.id}/cancel`, headers: authHeaders() });
    expect(runningCancel.statusCode).toBe(200);
    expect(cancel).toHaveBeenCalledWith("session-1");
    await vi.waitFor(() => expect(new RunRepository({ db }).get(running.id)?.status).toBe("cancelled"));
  });

  it("Session detail 返回按创建时间升序排列的完整 Run 历史", async () => {
    const { app, db, root } = await createApiTestApp();
    seedSession(db, root, "session-1");
    const first = (await postRun(app, "session-1", "first")).json() as Run;
    await vi.waitFor(() => expect(new RunRepository({ db }).get(first.id)?.status).toBe("succeeded"));
    const second = (await postRun(app, "session-1", "second")).json() as Run;
    await vi.waitFor(() => expect(new RunRepository({ db }).get(second.id)?.status).toBe("succeeded"));

    const response = await app.inject({ method: "GET", url: "/api/sessions/session-1", headers: authHeaders() });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "session-1",
      runs: [
        { id: first.id, input: "first", status: "succeeded" },
        { id: second.id, input: "second", status: "succeeded" }
      ]
    });
  });
});

describe("Server startup and shutdown", () => {
  const seedRestartDatabase = (databasePath: string, root: string, includeRunning: boolean) => {
    const db = openDatabase(databasePath);
    migrate(db);
    const timestamp = "2026-08-12T00:00:00.000Z";
    db.prepare("INSERT INTO agents (id, name, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("agent-1", "Codex", "codex", timestamp, timestamp);
    for (const sessionId of includeRunning ? ["old-session", "queued-session"] : ["queued-session"]) {
      const workspacePath = join(root, "sessions", sessionId, "workspace");
      mkdirSync(workspacePath, { recursive: true });
      mkdirSync(join(dirname(workspacePath), "browser"), { recursive: true });
      db.prepare(
        "INSERT INTO sessions (id, agent_id, title, status, workspace_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(sessionId, "agent-1", sessionId, "running", workspacePath, timestamp, timestamp);
    }
    if (includeRunning) {
      db.prepare("INSERT INTO runs (id, session_id, status, input, created_at) VALUES (?, ?, ?, ?, ?)")
        .run("old-run", "old-session", "running", "do not replay", timestamp);
    }
    db.prepare("INSERT INTO runs (id, session_id, status, input, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("queued-run", "queued-session", "queued", "resume queued", timestamp);
    db.close();
  };

  const startOptions = (root: string, runtime: AgentRuntime, commandRunner: { run: () => Promise<{ stdout: string; stderr: string }> }) => ({
    env: {
      HOST: "127.0.0.1",
      PORT: "3001",
      API_TOKEN: apiToken,
      DATA_DIR: join(root, "data"),
      DATABASE_PATH: join(root, "server.sqlite3"),
      WORKSPACE_TEMPLATE: join(root, "template"),
      SESSIONS_ROOT: join(root, "sessions"),
      MAX_CONCURRENT_RUNS: "1"
    },
    runtime,
    commandRunner,
    listen: async (app: FastifyInstance) => app.ready(),
    installSignalHandlers: false
  });

  it("按 Btrfs check → recovery → queued 调度 → listen 启动，且不重放旧 running 输入", async () => {
    const root = mkdtempSync(join(tmpdir(), "remote-agent-startup-"));
    tempDirectories.push(root);
    const databasePath = join(root, "server.sqlite3");
    seedRestartDatabase(databasePath, root, true);
    const order: string[] = [];
    const ensureSession = vi.fn(async () => {
      order.push("runtime");
      const observer = openDatabase(databasePath);
      expect(observer.prepare("SELECT status, error FROM runs WHERE id = 'old-run'").get()).toEqual({
        status: "failed",
        error: "server_restarted"
      });
      observer.close();
      return { providerSessionId: "provider-session-1" };
    });
    const runtime = createFakeRuntime({ result: { status: "completed" } });
    runtime.ensureSession = ensureSession;
    runtime.startTurn = vi.fn(runtime.startTurn);
    const commandRunner = {
      run: vi.fn(async () => {
        order.push("check");
        const observer = openDatabase(databasePath);
        expect(observer.prepare("SELECT status FROM runs WHERE id = 'old-run'").get()).toEqual({ status: "running" });
        observer.close();
        return { stdout: "", stderr: "" };
      })
    };
    const options = startOptions(root, runtime, commandRunner);
    options.listen = async (app) => {
      order.push("listen");
      await app.ready();
    };

    const server = await startServer(options);
    await vi.waitFor(() => expect(server.runRepository.get("queued-run")?.status).toBe("succeeded"));

    expect(order).toEqual(["check", "runtime", "listen"]);
    expect(commandRunner.run).toHaveBeenCalledWith("btrfs", ["subvolume", "show", join(root, "template")]);
    expect(runtime.startTurn).toHaveBeenCalledTimes(1);
    expect(runtime.startTurn).toHaveBeenCalledWith({
      sessionId: "queued-session",
      requestId: "queued-run",
      text: "resume queued"
    });
    expect(server.runRepository.get("old-run")).toMatchObject({ status: "failed", error: "server_restarted" });
    await server.close();
  });

  it("Btrfs check 失败时不执行 recovery、Runtime 或 queued 调度", async () => {
    const root = mkdtempSync(join(tmpdir(), "remote-agent-check-failed-"));
    tempDirectories.push(root);
    const databasePath = join(root, "server.sqlite3");
    seedRestartDatabase(databasePath, root, true);
    const runtime = createFakeRuntime();
    runtime.ensureSession = vi.fn(runtime.ensureSession);
    runtime.startTurn = vi.fn(runtime.startTurn);

    await expect(startServer(startOptions(root, runtime, {
      run: async () => Promise.reject(new Error("not a btrfs subvolume"))
    }))).rejects.toThrow("not a btrfs subvolume");

    const observer = openDatabase(databasePath);
    expect(observer.prepare("SELECT status, error FROM runs WHERE id = 'old-run'").get()).toEqual({
      status: "running",
      error: null
    });
    expect(observer.prepare("SELECT status FROM runs WHERE id = 'queued-run'").get()).toEqual({ status: "queued" });
    expect(runtime.ensureSession).not.toHaveBeenCalled();
    expect(runtime.startTurn).not.toHaveBeenCalled();
    observer.close();
  });

  it("关闭时先拒绝新请求，再取消 active Turn，最后关闭 SQLite", async () => {
    const root = mkdtempSync(join(tmpdir(), "remote-agent-shutdown-"));
    tempDirectories.push(root);
    seedRestartDatabase(join(root, "server.sqlite3"), root, false);
    const result = deferred<RuntimeTurnResult>();
    let server!: RunningServer;
    const runtime = createFakeRuntime();
    runtime.startTurn = () => ({
      events: { async *[Symbol.asyncIterator]() {} },
      result: result.promise,
      cancel: async () => undefined,
      closeEvents: async () => undefined
    });
    runtime.cancel = vi.fn(async () => {
      const duringClose = await server.app.inject({ method: "GET", url: "/api/health" });
      expect(duringClose.statusCode).toBe(503);
      expect(server.runRepository.get("queued-run")?.status).toBe("running");
      result.resolve({ status: "cancelled" });
    });
    runtime.shutdown = vi.fn(async () => {
      expect(server.runRepository.get("queued-run")?.status).toBe("running");
    });
    server = await startServer(startOptions(root, runtime, { run: async () => ({ stdout: "", stderr: "" }) }));
    await vi.waitFor(() => expect(server.runRepository.get("queued-run")?.status).toBe("running"));

    await server.close();

    expect(runtime.cancel).toHaveBeenCalledWith("queued-session");
    expect(runtime.shutdown).toHaveBeenCalledTimes(1);
    expect(() => server.runRepository.get("queued-run")).toThrow(/database connection is not open/i);
  });

  it("programmatic close 在 Runtime shutdown 失败时完成 server/DB 关闭后 reject", async () => {
    const root = mkdtempSync(join(tmpdir(), "remote-agent-close-failed-"));
    tempDirectories.push(root);
    seedRestartDatabase(join(root, "server.sqlite3"), root, false);
    const runtime = createFakeRuntime({ result: { status: "completed" } });
    const shutdownError = new AggregateError([new Error("handle close failed")], "runtime shutdown failed");
    runtime.shutdown = vi.fn(async () => Promise.reject(shutdownError));
    const options = startOptions(root, runtime, { run: async () => ({ stdout: "", stderr: "" }) });
    options.listen = async (app) => app.listen({ host: "127.0.0.1", port: 0 });
    const server = await startServer(options);
    await vi.waitFor(() => expect(server.runRepository.get("queued-run")?.status).toBe("succeeded"));
    expect(server.app.server.listening).toBe(true);

    await expect(server.close()).rejects.toBe(shutdownError);

    expect(server.app.server.listening).toBe(false);
    expect(() => server.runRepository.get("queued-run")).toThrow(/database connection is not open/i);
  });

  it("SIGTERM 在有界 graceful close 后显式退出进程以兜底残留 Provider 资源", async () => {
    const root = mkdtempSync(join(tmpdir(), "remote-agent-signal-"));
    tempDirectories.push(root);
    seedRestartDatabase(join(root, "server.sqlite3"), root, false);
    const runtime = createFakeRuntime({ result: { status: "completed" } });
    const exitProcess = vi.fn();
    const options = startOptions(root, runtime, { run: async () => ({ stdout: "", stderr: "" }) });
    options.installSignalHandlers = true;
    options.listen = async (app) => app.listen({ host: "127.0.0.1", port: 0 });
    const server = await startServer({ ...options, exitProcess });
    await vi.waitFor(() => expect(server.runRepository.get("queued-run")?.status).toBe("succeeded"));
    expect(server.app.server.listening).toBe(true);

    process.emit("SIGTERM", "SIGTERM");

    await vi.waitFor(() => expect(exitProcess).toHaveBeenCalledWith(0));
    expect(() => server.runRepository.get("queued-run")).toThrow(/database connection is not open/i);
  });

  it("SIGTERM shutdown 失败时完成关闭并以 exit code 1 退出", async () => {
    const root = mkdtempSync(join(tmpdir(), "remote-agent-signal-failed-"));
    tempDirectories.push(root);
    seedRestartDatabase(join(root, "server.sqlite3"), root, false);
    const runtime = createFakeRuntime({ result: { status: "completed" } });
    runtime.shutdown = vi.fn(async () => Promise.reject(new AggregateError([new Error("close failed")] )));
    const exitProcess = vi.fn();
    const options = startOptions(root, runtime, { run: async () => ({ stdout: "", stderr: "" }) });
    options.installSignalHandlers = true;
    options.listen = async (app) => app.listen({ host: "127.0.0.1", port: 0 });
    const server = await startServer({ ...options, exitProcess });
    await vi.waitFor(() => expect(server.runRepository.get("queued-run")?.status).toBe("succeeded"));
    expect(server.app.server.listening).toBe(true);

    process.emit("SIGTERM", "SIGTERM");

    await vi.waitFor(() => expect(exitProcess).toHaveBeenCalledWith(1));
    expect(server.app.server.listening).toBe(false);
    expect(() => server.runRepository.get("queued-run")).toThrow(/database connection is not open/i);
  });
});
