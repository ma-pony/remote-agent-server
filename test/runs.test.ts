import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { migrate, openDatabase } from "../src/db.js";
import type { Run } from "../src/domain.js";
import { startServer, type RunningServer } from "../src/main.js";
import { SecretStore } from "../src/mcp/secret-store.js";
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
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
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
      projectEnvironmentsRoot: join(root, "environments"),
      sessionsRoot: join(root, "sessions"),
      maxConcurrentRuns: options.maxConcurrentRuns ?? 2,
      projectEnvironmentCheckIntervalMs: 3 * 60 * 60 * 1000,
      projectPrepareTimeoutMs: 30 * 60 * 1000
    },
    db,
    runtime: options.runtime ?? createFakeRuntime(),
    commandRunner: { run: async () => ({ stdout: "", stderr: "" }) }
  });
  applications.push({ app, db });
  await app.ready();
  return { app, db, root };
};

const seedSession = (db: ReturnType<typeof createTestDatabase>["db"], root: string, id: number): void => {
  const agent = db.prepare("SELECT id FROM agents ORDER BY created_at LIMIT 1").get() as { id: number };
  const workspacePath = join(root, "sessions", String(id), "workspace");
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(join(dirname(workspacePath), "browser"), { recursive: true });
  const createdAt = new Date().toISOString();
  db.prepare(
    "INSERT INTO sessions (id, agent_id, title, status, workspace_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, agent.id, `Session ${id}`, "idle", workspacePath, createdAt, createdAt);
};

const postRun = (app: FastifyInstance, sessionId: number, input: string) => app.inject({
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

  it("Run insert 后的关联失败时回滚 Run 和 Session claim", () => {
    const { db, seed } = createTestDatabase();
    const session = seed.session();
    const repository = new RunRepository({ db });

    expect(() => repository.create(
      { sessionId: session.id, input: "work" },
      { afterInsert: () => { throw new Error("link failed"); } }
    )).toThrow("link failed");

    expect(repository.listQueued()).toEqual([]);
    expect(db.prepare("SELECT status FROM sessions WHERE id = ?").get(session.id)).toEqual({ status: "idle" });
    db.close();
  });

  it("拒绝异步 afterInsert hook 并回滚 Run 和 Session claim", () => {
    const { db, seed } = createTestDatabase();
    const session = seed.session();
    const repository = new RunRepository({ db });
    const asyncHook = (() => Promise.reject(new Error("async hook rejected"))) as unknown as (run: Run) => undefined;

    expect(() => repository.create(
      { sessionId: session.id, input: "work" },
      { afterInsert: asyncHook }
    )).toThrow("async_transaction_hook");

    expect(repository.listQueued()).toEqual([]);
    expect(db.prepare("SELECT status FROM sessions WHERE id = ?").get(session.id)).toEqual({ status: "idle" });
    db.close();
  });

  it("状态投影异常时回滚 Run 状态转换", () => {
    const { db, seed } = createTestDatabase();
    const session = seed.session();
    const projection = {
      onStarted: () => { throw new Error("projection failed"); },
      onFinished: () => undefined,
      afterCommit: () => undefined
    };
    const repository = new RunRepository({ db, projection });
    const run = repository.create({ sessionId: session.id, input: "work" });

    expect(() => repository.markRunning(run.id)).toThrow("projection failed");

    expect(repository.get(run.id)).toMatchObject({ status: "queued", startedAt: null });
    expect(db.prepare("SELECT status FROM sessions WHERE id = ?").get(session.id)).toEqual({ status: "running" });
    db.close();
  });

  it("拒绝异步 Run 状态投影并回滚状态转换", () => {
    const { db, seed } = createTestDatabase();
    const session = seed.session();
    const projection = {
      onStarted: (() => Promise.resolve()) as unknown as (run: Run) => undefined,
      onFinished: () => undefined,
      afterCommit: () => undefined
    };
    const repository = new RunRepository({ db, projection });
    const run = repository.create({ sessionId: session.id, input: "work" });

    expect(() => repository.markRunning(run.id)).toThrow("async_transaction_hook");

    expect(repository.get(run.id)).toMatchObject({ status: "queued", startedAt: null });
    db.close();
  });

  it("afterCommit thenable 被报告但不反抛或产生 unhandled rejection", async () => {
    const { db, seed } = createTestDatabase();
    const session = seed.session();
    const onPostCommitError = vi.fn();
    const repository = new RunRepository({
      db,
      projection: {
        onStarted: () => undefined,
        onFinished: () => undefined,
        afterCommit: (() => Promise.reject(new Error("async notifier rejected"))) as unknown as () => undefined
      },
      onPostCommitError
    });
    const run = repository.create({ sessionId: session.id, input: "work" });

    expect(repository.markRunning(run.id)).toMatchObject({ status: "running" });
    await Promise.resolve();

    expect(repository.get(run.id)?.status).toBe("running");
    expect(onPostCommitError).toHaveBeenCalledWith(run.id, "started");
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

  it("Session 已被 reset claim 时即使没有活动 Run 也返回 session_busy", () => {
    const { db, seed } = createTestDatabase();
    const session = seed.session();
    const repository = new RunRepository({ db });
    db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(session.id);

    expect(() => repository.create({ sessionId: session.id, input: "work" })).toThrow(
      expect.objectContaining({ code: "session_busy" })
    );
    expect(repository.listBySession(session.id)).toEqual([]);
    expect(db.prepare("SELECT status FROM sessions WHERE id = ?").get(session.id)).toEqual({ status: "running" });
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

  it("重启恢复不会把创建中的 Session 变为可运行", () => {
    const { db, seed } = createTestDatabase();
    const inserted = db.prepare(
      "INSERT INTO sessions (agent_id, title, status, workspace_path, created_at, updated_at) VALUES (?, ?, 'running', ?, ?, ?)"
    ).run(seed.agent.id, "Incomplete", "pending:create", "2026-08-19", "2026-08-19");
    const id = Number(inserted.lastInsertRowid);

    new RunRepository({ db }).recoverAfterRestart();

    expect(db.prepare("SELECT status, workspace_path FROM sessions WHERE id = ?").get(id)).toEqual({
      status: "running",
      workspace_path: "pending:create"
    });
    db.close();
  });

  it("按 Session 和 Agent 聚合 Session 累计 Token 字段", () => {
    const { db, seed } = createTestDatabase();
    const session = seed.session();
    const unknownSession = seed.session();
    db.prepare(`
      UPDATE sessions SET input_tokens = 300, output_tokens = 40, cached_read_tokens = 80, total_tokens = 340
      WHERE id = ?
    `).run(session.id);
    const repository = new RunRepository({ db });

    const expected = {
      sessionCount: 1,
      measuredSessionCount: 1,
      usage: {
        inputTokens: 300,
        outputTokens: 40,
        cachedReadTokens: 80,
        cachedWriteTokens: null,
        thoughtTokens: null,
        totalTokens: 340
      }
    };
    expect(repository.summarizeBySession(session.id)).toEqual(expected);
    expect(repository.summarizeBySession(unknownSession.id)).toMatchObject({
      sessionCount: 1,
      measuredSessionCount: 0
    });
    expect(repository.summarizeByAgent(seed.agent.id)).toEqual({
      ...expected,
      sessionCount: 2
    });
    db.close();
  });
});

describe("RunScheduler", () => {
  it("每个 queued Run 最多自动重试 3 次，exhausted 后写入失败终态", async () => {
    vi.useFakeTimers();
    try {
      const { db, seed } = createTestDatabase();
      const session = seed.session();
      const repository = new RunRepository({
        db,
        projection: {
          onStarted: () => { throw new Error("persistent start projection failure"); },
          onFinished: () => undefined,
          afterCommit: () => undefined
        }
      });
      const run = repository.create({ sessionId: session.id, input: "retry exhausted" });
      const execute = vi.fn(async (runId: string) => repository.markRunning(runId));
      const onExecutionError = vi.fn();
      const scheduler = new RunScheduler({
        runRepository: repository,
        executor: { execute, cancel: async () => ({}) as Run },
        maxConcurrentRuns: 1,
        retryDelayMs: 1_000,
        onExecutionError
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(3_000);

      expect(execute).toHaveBeenCalledTimes(4);
      expect(repository.get(run.id)).toMatchObject({ status: "failed", error: "run_retry_exhausted" });
      expect(vi.getTimerCount()).toBe(0);
      expect(onExecutionError).toHaveBeenCalledWith(expect.objectContaining({
        code: "run_retry_exhausted"
      }), run.id);

      scheduler.enqueue(run.id);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(execute).toHaveBeenCalledTimes(4);
      await scheduler.stop();
      expect(vi.getTimerCount()).toBe(0);
      db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("写入 exhausted 终态暂时失败时继续重试终态写入，不再执行 Run", async () => {
    vi.useFakeTimers();
    try {
      const { db, seed } = createTestDatabase();
      const session = seed.session();
      const repository = new RunRepository({
        db,
        projection: {
          onStarted: () => { throw new Error("persistent start projection failure"); },
          onFinished: () => undefined,
          afterCommit: () => undefined
        }
      });
      const run = repository.create({ sessionId: session.id, input: "retry terminal write" });
      const execute = vi.fn(async (runId: string) => repository.markRunning(runId));
      const failQueued = repository.failQueued.bind(repository);
      let terminalWriteLocked = true;
      vi.spyOn(repository, "failQueued").mockImplementation((runId, error) => {
        if (terminalWriteLocked) throw new Error("SQLITE_BUSY");
        return failQueued(runId, error);
      });
      const scheduler = new RunScheduler({
        runRepository: repository,
        executor: { execute, cancel: async () => ({}) as Run },
        maxConcurrentRuns: 1,
        retryDelayMs: 1_000,
        onExecutionError: () => undefined
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(3_000);

      expect(execute).toHaveBeenCalledTimes(4);
      expect(repository.get(run.id)).toMatchObject({ status: "queued", error: null });
      expect(vi.getTimerCount()).toBe(1);

      scheduler.enqueue(run.id);
      await vi.advanceTimersByTimeAsync(500);
      expect(execute).toHaveBeenCalledTimes(4);

      terminalWriteLocked = false;
      await vi.advanceTimersByTimeAsync(500);

      expect(execute).toHaveBeenCalledTimes(4);
      expect(repository.get(run.id)).toMatchObject({ status: "failed", error: "run_retry_exhausted" });
      expect(vi.getTimerCount()).toBe(0);
      await scheduler.stop();
      db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("markRunning 投影失败且 Run 仍 queued 时有界延迟重试成功", async () => {
    vi.useFakeTimers();
    try {
      const { db, seed } = createTestDatabase();
      const session = seed.session();
      const onStarted = vi.fn<() => undefined>()
        .mockImplementationOnce(() => { throw new Error("projection failed once"); })
        .mockReturnValue(undefined);
      const repository = new RunRepository({
        db,
        projection: { onStarted, onFinished: () => undefined, afterCommit: () => undefined }
      });
      const run = repository.create({ sessionId: session.id, input: "retry projection" });
      const execute = vi.fn(async (runId: string) => repository.markRunning(runId));
      const onExecutionError = vi.fn();
      const scheduler = new RunScheduler({
        runRepository: repository,
        executor: { execute, cancel: async () => ({}) as Run },
        maxConcurrentRuns: 1,
        retryDelayMs: 1_000,
        onExecutionError
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(execute).toHaveBeenCalledTimes(1);
      expect(repository.get(run.id)?.status).toBe("queued");
      expect(onExecutionError).toHaveBeenCalledWith(expect.any(Error), run.id);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(1_000);

      expect(execute).toHaveBeenCalledTimes(2);
      expect(repository.get(run.id)?.status).toBe("running");
      await scheduler.stop();
      expect(vi.getTimerCount()).toBe(0);
      db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminal 投影持续失败且 Run 已 running 时报告错误但不重复 Turn", async () => {
    vi.useFakeTimers();
    try {
      const { db, seed } = createTestDatabase();
      const session = seed.session();
      const repository = new RunRepository({
        db,
        projection: {
          onStarted: () => undefined,
          onFinished: () => { throw new Error("terminal projection failed"); },
          afterCommit: () => undefined
        }
      });
      const run = repository.create({ sessionId: session.id, input: "terminal projection" });
      const execute = vi.fn(async (runId: string) => {
        repository.markRunning(runId);
        return repository.finish(runId, { status: "succeeded", result: "done" });
      });
      const onExecutionError = vi.fn();
      const scheduler = new RunScheduler({
        runRepository: repository,
        executor: { execute, cancel: async () => ({}) as Run },
        maxConcurrentRuns: 1,
        retryDelayMs: 1_000,
        onExecutionError
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(onExecutionError).toHaveBeenCalledWith(expect.objectContaining({
        message: "terminal projection failed"
      }), run.id);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(repository.get(run.id)?.status).toBe("running");
      expect(vi.getTimerCount()).toBe(0);
      await scheduler.stop();
      db.close();
    } finally {
      vi.useRealTimers();
    }
  });

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
      runRepository: {
        get: (id) => queued.find((run) => run.id === id),
        listQueued: () => queued,
        failQueued: () => ({}) as Run
      },
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
      runRepository: {
        get: (id) => ({ id, status: "failed" }) as Run,
        listQueued: () => [{ id: "run-1" }, { id: "run-2" }] as Run[]
      },
      executor: { execute, cancel: async () => ({}) as Run },
      maxConcurrentRuns: 1,
      onExecutionError: vi.fn()
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
        runRepository: {
          get: (id) => ({ id, status: "running" }) as Run,
          listQueued: () => [{ id: "run-1" }] as Run[]
        },
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
    seedSession(db, root, 1);

    const created = await postRun(app, 1, "first");
    const run = created.json() as Run;
    const busy = await postRun(app, 1, "second");
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
    seedSession(db, root, 1);
    seedSession(db, root, 2);
    const running = (await postRun(app, 1, "first")).json() as Run;
    const queued = (await postRun(app, 2, "second")).json() as Run;

    const queuedCancel = await app.inject({ method: "POST", url: `/api/runs/${queued.id}/cancel`, headers: authHeaders() });
    expect(queuedCancel.statusCode).toBe(200);
    expect(queuedCancel.json()).toMatchObject({ status: "cancelled" });
    expect(cancel).not.toHaveBeenCalled();

    const runningCancel = await app.inject({ method: "POST", url: `/api/runs/${running.id}/cancel`, headers: authHeaders() });
    expect(runningCancel.statusCode).toBe(200);
    expect(cancel).toHaveBeenCalledWith(1);
    await vi.waitFor(() => expect(new RunRepository({ db }).get(running.id)?.status).toBe("cancelled"));
  });

  it("Session detail 返回按创建时间升序排列的完整 Run 历史", async () => {
    const { app, db, root } = await createApiTestApp();
    seedSession(db, root, 1);
    const first = (await postRun(app, 1, "first")).json() as Run;
    await vi.waitFor(() => expect(new RunRepository({ db }).get(first.id)?.status).toBe("succeeded"));
    const second = (await postRun(app, 1, "second")).json() as Run;
    await vi.waitFor(() => expect(new RunRepository({ db }).get(second.id)?.status).toBe("succeeded"));
    db.prepare("UPDATE sessions SET input_tokens = 100, output_tokens = 20, total_tokens = 120 WHERE id = ?")
      .run(1);

    const response = await app.inject({ method: "GET", url: "/api/sessions/1", headers: authHeaders() });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: 1,
      runs: [
        {
          id: first.id,
          input: "first",
          status: "succeeded",
          usage: null
        },
        { id: second.id, input: "second", status: "succeeded", usage: null }
      ],
      usageSummary: {
        sessionCount: 1,
        measuredSessionCount: 1,
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }
      }
    });
  });
});

describe("Server startup and shutdown", () => {
  const OLD_SESSION_ID = 1;
  const QUEUED_SESSION_ID = 2;
  const OLD_RUN_ID = 1;
  const QUEUED_RUN_ID = 2;
  const ENDPOINT_ID = 1;
  const OLD_TASK_ID = 1;
  const WEBHOOK_ID = 1;
  const DELIVERY_ID = 1;
  const seedRestartDatabase = (databasePath: string, root: string, includeRunning: boolean) => {
    const db = openDatabase(databasePath);
    migrate(db);
    const timestamp = "2026-08-12T00:00:00.000Z";
    db.prepare("INSERT INTO agents (id, name, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(1, "Codex", "codex", timestamp, timestamp);
    for (const sessionId of includeRunning ? [OLD_SESSION_ID, QUEUED_SESSION_ID] : [QUEUED_SESSION_ID]) {
      const workspacePath = join(root, "sessions", String(sessionId), "workspace");
      mkdirSync(workspacePath, { recursive: true });
      mkdirSync(join(dirname(workspacePath), "browser"), { recursive: true });
      db.prepare(
        "INSERT INTO sessions (id, agent_id, title, status, workspace_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(sessionId, 1, `session-${sessionId}`, "running", workspacePath, timestamp, timestamp);
    }
    if (includeRunning) {
      db.prepare("INSERT INTO runs (id, session_id, status, input, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(OLD_RUN_ID, OLD_SESSION_ID, "running", "do not replay", timestamp);
      db.prepare(`
        INSERT INTO integration_endpoints
          (id, name, slug, agent_id, enabled, token_hash, prompt_prefix, parameter_mappings_json,
           next_delivery_order, created_at, updated_at)
        VALUES (?, 'Endpoint', 'endpoint-1', 1, 1, 'token-hash', '', '[]', 1, ?, ?)
      `).run(ENDPOINT_ID, timestamp, timestamp);
      db.prepare(`
        INSERT INTO integration_tasks
          (id, endpoint_id, conversation_id, session_id, run_id, request_id, request_fingerprint, message,
           effective_prompt, status, created_at)
        VALUES (?, ?, NULL, ?, ?, 'request-1', 'fingerprint-1',
                'old message', 'do not replay', 'running', ?)
      `).run(OLD_TASK_ID, ENDPOINT_ID, OLD_SESSION_ID, OLD_RUN_ID, timestamp);
      const secrets = SecretStore.open({ dataDir: join(root, "data") });
      db.prepare(`
        INSERT INTO webhook_subscriptions
          (id, endpoint_id, name, url, enabled, events_json, encrypted_signing_secret, timeout_seconds, created_at, updated_at)
        VALUES (?, ?, 'Restart webhook', 'https://receiver.test/restart', 1, '[]', ?, 10, ?, ?)
      `).run(WEBHOOK_ID, ENDPOINT_ID, secrets.encrypt("restart-signing-secret"), timestamp, timestamp);
      const restartPayload = JSON.stringify({
        eventId: "restart-event",
        eventType: "task.started",
        sequence: 1,
        occurredAt: timestamp,
        endpoint: { id: ENDPOINT_ID, slug: "endpoint-1" },
        task: {
          id: OLD_TASK_ID,
          requestId: "request-1",
          conversationKey: null,
          sessionId: OLD_SESSION_ID,
          runId: OLD_RUN_ID,
          status: "running"
        }
      });
      db.prepare(`
        INSERT INTO webhook_deliveries
          (id, event_id, event_key, sequence, dispatch_order, subscription_id, task_id, event_type, payload_json, status,
           attempt_count, next_attempt_at, created_at, updated_at)
        VALUES (?, 'restart-event', 'restart:event', 1, 1, ?, ?,
                'task.started', ?,
                'delivering', 1, ?, ?, ?)
      `).run(DELIVERY_ID, WEBHOOK_ID, OLD_TASK_ID, restartPayload, timestamp, timestamp, timestamp);
    }
    db.prepare("INSERT INTO runs (id, session_id, status, input, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(QUEUED_RUN_ID, QUEUED_SESSION_ID, "queued", "resume queued", timestamp);
    db.close();
  };

  const startOptions = (root: string, runtime: AgentRuntime, commandRunner: { run: () => Promise<{ stdout: string; stderr: string }> }) => ({
    env: {
      HOST: "127.0.0.1",
      PORT: "3001",
      API_TOKEN: apiToken,
      DATA_DIR: join(root, "data"),
      DATABASE_PATH: join(root, "server.sqlite3"),
      PROJECT_ENVIRONMENTS_ROOT: join(root, "environments"),
      SESSIONS_ROOT: join(root, "sessions"),
      MAX_CONCURRENT_RUNS: "1"
    },
    runtime,
    commandRunner,
    platform: "linux" as const,
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
      expect(observer.prepare("SELECT status, error FROM runs WHERE id = 1").get()).toEqual({
        status: "failed",
        error: "server_restarted"
      });
      expect(observer.prepare("SELECT status, error FROM integration_tasks WHERE id = 1").get()).toEqual({
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
        expect(observer.prepare("SELECT status FROM runs WHERE id = 1").get()).toEqual({ status: "running" });
        observer.close();
        return { stdout: "", stderr: "" };
      })
    };
    const options = startOptions(root, runtime, commandRunner);
    options.listen = async (app) => {
      order.push("listen");
      await app.ready();
    };

    const webhookFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const server = await startServer({ ...options, platform: "linux", webhookFetch });
    await vi.waitFor(() => expect(server.runRepository.get(QUEUED_RUN_ID)?.status).toBe("succeeded"));
    await vi.waitFor(() => {
      const observer = openDatabase(databasePath);
      const delivery = observer.prepare("SELECT status FROM webhook_deliveries WHERE id = 1").get();
      observer.close();
      expect(delivery).toEqual({ status: "succeeded" });
    });

    expect(order).toEqual(["check", "check", "runtime", "listen"]);
    expect(commandRunner.run.mock.calls).toEqual([
      ["btrfs", ["filesystem", "show", join(root, "environments")]],
      ["btrfs", ["filesystem", "show", join(root, "sessions")]]
    ]);
    expect(runtime.startTurn).toHaveBeenCalledTimes(1);
    expect(webhookFetch).toHaveBeenCalledTimes(1);
    expect(runtime.startTurn).toHaveBeenCalledWith({
      sessionId: QUEUED_SESSION_ID,
      requestId: QUEUED_RUN_ID,
      text: "resume queued"
    });
    expect(server.runRepository.get(OLD_RUN_ID)).toMatchObject({ status: "failed", error: "server_restarted" });
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

    await expect(startServer({
      ...startOptions(root, runtime, {
        run: async () => Promise.reject(new Error("not a btrfs subvolume"))
      }),
      platform: "linux"
    })).rejects.toThrow("Linux workspace root is not on Btrfs or is not accessible");

    const observer = openDatabase(databasePath);
    expect(observer.prepare("SELECT status, error FROM runs WHERE id = ?").get(OLD_RUN_ID)).toEqual({
      status: "running",
      error: null
    });
    expect(observer.prepare("SELECT status, error FROM integration_tasks WHERE id = ?").get(OLD_TASK_ID)).toEqual({
      status: "running",
      error: null
    });
    expect(observer.prepare("SELECT status FROM runs WHERE id = 2").get()).toEqual({ status: "queued" });
    expect(runtime.ensureSession).not.toHaveBeenCalled();
    expect(runtime.startTurn).not.toHaveBeenCalled();
    observer.close();
  });

  it("macOS 启动时检查 APFS 同卷后才执行 recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "remote-agent-apfs-startup-"));
    tempDirectories.push(root);
    const databasePath = join(root, "server.sqlite3");
    seedRestartDatabase(databasePath, root, false);
    const runtime = createFakeRuntime({ result: { status: "completed" } });
    const commandRunner = {
      run: vi.fn(async () => ({ stdout: "", stderr: "" }))
    };
    const fileSystemCalls: Array<{ operation: "statfs" | "stat"; path: string }> = [];
    const fileSystemInspector = {
      statfs: vi.fn(async (path: string) => {
        fileSystemCalls.push({ operation: "statfs", path });
        return { type: 26 };
      }),
      stat: vi.fn(async (path: string) => {
        fileSystemCalls.push({ operation: "stat", path });
        return { dev: 42 };
      })
    };

    const server = await startServer({
      ...startOptions(root, runtime, commandRunner),
      platform: "darwin",
      fileSystemInspector
    });
    await vi.waitFor(() => expect(server.runRepository.get(QUEUED_RUN_ID)?.status).toBe("succeeded"));

    expect(fileSystemCalls).toEqual([
      { operation: "statfs", path: join(root, "environments") },
      { operation: "statfs", path: join(root, "sessions") },
      { operation: "stat", path: join(root, "environments") },
      { operation: "stat", path: join(root, "sessions") }
    ]);
    expect(commandRunner.run).not.toHaveBeenCalled();
    await server.close();
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
      expect(server.runRepository.get(QUEUED_RUN_ID)?.status).toBe("running");
      result.resolve({ status: "cancelled" });
    });
    runtime.shutdown = vi.fn(async () => {
      expect(server.runRepository.get(QUEUED_RUN_ID)?.status).toBe("running");
    });
    server = await startServer(startOptions(root, runtime, { run: async () => ({ stdout: "", stderr: "" }) }));
    await vi.waitFor(() => expect(server.runRepository.get(QUEUED_RUN_ID)?.status).toBe("running"));

    await server.close();

    expect(runtime.cancel).toHaveBeenCalledWith(QUEUED_SESSION_ID);
    expect(runtime.shutdown).toHaveBeenCalledTimes(1);
    expect(() => server.runRepository.get(QUEUED_RUN_ID)).toThrow(/database connection is not open/i);
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
    await vi.waitFor(() => expect(server.runRepository.get(QUEUED_RUN_ID)?.status).toBe("succeeded"));
    expect(server.app.server.listening).toBe(true);

    await expect(server.close()).rejects.toBe(shutdownError);

    expect(server.app.server.listening).toBe(false);
    expect(() => server.runRepository.get(QUEUED_RUN_ID)).toThrow(/database connection is not open/i);
  });

  it("SIGTERM 在有界 graceful close 后显式退出进程以兜底残留 Provider 资源", async () => {
    const root = mkdtempSync(join(tmpdir(), "remote-agent-signal-"));
    tempDirectories.push(root);
    seedRestartDatabase(join(root, "server.sqlite3"), root, false);
    const runtime = createFakeRuntime({ result: { status: "completed" } });
    const shutdown = deferred<void>();
    runtime.shutdown = vi.fn(() => shutdown.promise);
    const exitProcess = vi.fn();
    const options = startOptions(root, runtime, { run: async () => ({ stdout: "", stderr: "" }) });
    options.installSignalHandlers = true;
    options.listen = async (app) => app.listen({ host: "127.0.0.1", port: 0 });
    const server = await startServer({ ...options, exitProcess });
    await vi.waitFor(() => expect(server.runRepository.get(QUEUED_RUN_ID)?.status).toBe("succeeded"));
    expect(server.app.server.listening).toBe(true);

    process.emit("SIGTERM", "SIGTERM");
    await vi.waitFor(() => expect(runtime.shutdown).toHaveBeenCalledTimes(1));
    process.emit("SIGINT", "SIGINT");
    expect(exitProcess).not.toHaveBeenCalled();
    shutdown.resolve();

    await vi.waitFor(() => expect(exitProcess).toHaveBeenCalledWith(0));
    expect(exitProcess).toHaveBeenCalledTimes(1);
    expect(() => server.runRepository.get(QUEUED_RUN_ID)).toThrow(/database connection is not open/i);
  });

  it("SIGTERM shutdown 失败时完成关闭并以 exit code 1 退出", async () => {
    const root = mkdtempSync(join(tmpdir(), "remote-agent-signal-failed-"));
    tempDirectories.push(root);
    seedRestartDatabase(join(root, "server.sqlite3"), root, false);
    const runtime = createFakeRuntime({ result: { status: "completed" } });
    const shutdown = deferred<void>();
    runtime.shutdown = vi.fn(() => shutdown.promise);
    const exitProcess = vi.fn();
    const options = startOptions(root, runtime, { run: async () => ({ stdout: "", stderr: "" }) });
    options.installSignalHandlers = true;
    options.listen = async (app) => app.listen({ host: "127.0.0.1", port: 0 });
    const server = await startServer({ ...options, exitProcess });
    await vi.waitFor(() => expect(server.runRepository.get(QUEUED_RUN_ID)?.status).toBe("succeeded"));
    expect(server.app.server.listening).toBe(true);

    process.emit("SIGTERM", "SIGTERM");
    await vi.waitFor(() => expect(runtime.shutdown).toHaveBeenCalledTimes(1));
    process.emit("SIGINT", "SIGINT");
    expect(exitProcess).not.toHaveBeenCalled();
    shutdown.reject(new AggregateError([new Error("close failed")]));

    await vi.waitFor(() => expect(exitProcess).toHaveBeenCalledWith(1));
    expect(exitProcess).toHaveBeenCalledTimes(1);
    expect(server.app.server.listening).toBe(false);
    expect(() => server.runRepository.get(QUEUED_RUN_ID)).toThrow(/database connection is not open/i);
  });
});
