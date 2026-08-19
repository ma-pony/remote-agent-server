import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentManager } from "../src/agents/agent-manager.js";
import { EventStore } from "../src/events/event-store.js";
import type {
  AgentRuntime,
  RuntimeEvent,
  RuntimeSession,
  RuntimeTurn,
  RuntimeTurnResult
} from "../src/runtime/agent-runtime.js";
import { BEST_EFFORT_TIMEOUT_MS } from "../src/runtime/bounded-operation.js";
import { RunExecutor } from "../src/runs/run-executor.js";
import { RunRepository } from "../src/runs/run-repository.js";
import { SessionManager } from "../src/sessions/session-manager.js";
import { BtrfsWorkspaceManager } from "../src/workspaces/btrfs-workspace.js";
import { createFakeRuntime, createTestDatabase } from "./helpers.js";

const tempDirectories: string[] = [];
const TEST_SESSION_ID = 1;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const setup = (
  runtime: AgentRuntime,
  prepare = vi.fn(() => "remember this"),
  mcpPrepare = vi.fn(async () => []),
  runRepositoryOptions: Record<string, unknown> = {}
) => {
  const root = mkdtempSync(join(tmpdir(), "remote-agent-executor-"));
  tempDirectories.push(root);
  const { db, seed } = createTestDatabase();
  const dataDir = join(root, "data");
  const workspacePath = join(root, "sessions", String(TEST_SESSION_ID), "workspace");
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(join(dirname(workspacePath), "browser"), { recursive: true });
  const agentManager = new AgentManager({ db, dataDir, runtime });
  const agent = agentManager.create({
    name: "Codex",
    provider: "codex",
    projectEnvironmentId: seed.projectEnvironment.id
  });
  const createdAt = "2026-08-12T00:00:00.000Z";
  db.prepare(
    "INSERT INTO sessions (id, agent_id, title, status, workspace_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(TEST_SESSION_ID, agent.id, "Test session", "idle", workspacePath, createdAt, createdAt);
  const workspaceManager = new BtrfsWorkspaceManager({
    projectEnvironmentsRoot: join(root, "environments"),
    sessionsRoot: join(root, "sessions"),
    commandRunner: { run: async () => ({ stdout: "", stderr: "" }) }
  });
  const sessionManager = new SessionManager({ db, dataDir, agentManager, runtime, workspaceManager });
  const runRepository = new RunRepository({ db, ...runRepositoryOptions });
  const eventStore = new EventStore({ db });
  const run = runRepository.create({ sessionId: TEST_SESSION_ID, input: "修复问题" });
  const skillProjector = { prepare };
  const executor = new RunExecutor({
    runtime,
    skillProjector,
    runRepository,
    eventStore,
    sessionManager,
    mcpPreparer: { prepare: mcpPrepare }
  });
  return { db, eventStore, executor, prepare, run, runRepository, sessionManager, workspacePath };
};

afterEach(() => {
  tempDirectories.splice(0).forEach((directory) => rmSync(directory, { force: true, recursive: true }));
});

describe("RunExecutor", () => {
  it("terminal post-commit notifier 同步异常不改变成功 Run 或 Session", async () => {
    const runtime = createFakeRuntime({ result: { status: "completed" } });
    const onPostCommitError = vi.fn();
    const setupResult = setup(runtime, undefined, undefined, {
      projection: {
        onStarted: () => undefined,
        onFinished: () => undefined,
        afterCommit: (run: { status: string }) => {
          if (run.status === "succeeded") throw new Error("notification secret must stay internal");
          return undefined;
        }
      },
      onPostCommitError
    });

    const result = await setupResult.executor.execute(setupResult.run.id);

    expect(result).toMatchObject({ status: "succeeded" });
    expect(setupResult.runRepository.get(setupResult.run.id)).toMatchObject({ status: "succeeded" });
    expect(setupResult.sessionManager.get(TEST_SESSION_ID)?.status).toBe("idle");
    expect(onPostCommitError).toHaveBeenCalledWith(setupResult.run.id, "finished");
    setupResult.db.close();
  });

  it("既有 Session 的 Agent 被禁用后稳定失败且不启动 Runtime", async () => {
    const runtime = createFakeRuntime();
    runtime.ensureSession = vi.fn(runtime.ensureSession);
    runtime.startTurn = vi.fn(runtime.startTurn);
    const prepare = vi.fn(() => "remember this");
    const mcpPrepare = vi.fn(async () => []);
    const setupResult = setup(runtime, prepare, mcpPrepare);
    setupResult.db.prepare(`
      UPDATE agents SET enabled = 0
      WHERE id = (SELECT agent_id FROM sessions WHERE id = 1)
    `).run();

    await setupResult.executor.execute(setupResult.run.id);

    expect(mcpPrepare).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(runtime.ensureSession).not.toHaveBeenCalled();
    expect(runtime.startTurn).not.toHaveBeenCalled();
    expect(setupResult.runRepository.get(setupResult.run.id)).toMatchObject({
      status: "failed",
      error: "agent_disabled"
    });
    expect(setupResult.eventStore.list(setupResult.run.id, 0).map((event) => JSON.parse(event.contentJson)))
      .toContainEqual({ status: "failed", publicNoticeCode: "agent_disabled" });
    expect(setupResult.sessionManager.get(TEST_SESSION_ID)?.status).toBe("idle");
    setupResult.db.close();
  });

  it("MCP 预检失败时不投影 Skill、不创建 Runtime Session 且安全失败 Run", async () => {
    const runtime = createFakeRuntime();
    runtime.ensureSession = vi.fn(runtime.ensureSession);
    runtime.startTurn = vi.fn(runtime.startTurn);
    const prepare = vi.fn(() => "remember this");
    const mcpPrepare = vi.fn(async () => { throw new Error("MCP private_mcp check failed"); });
    const setupResult = setup(runtime, prepare, mcpPrepare);

    await setupResult.executor.execute(setupResult.run.id);

    expect(mcpPrepare).toHaveBeenCalledWith(expect.objectContaining({
      agentId: expect.any(Number),
      sessionId: TEST_SESSION_ID,
      runId: setupResult.run.id,
      workspacePath: setupResult.workspacePath,
      browserProfilePath: join(dirname(setupResult.workspacePath), "browser")
    }));
    expect(prepare).not.toHaveBeenCalled();
    expect(runtime.ensureSession).not.toHaveBeenCalled();
    expect(runtime.startTurn).not.toHaveBeenCalled();
    expect(setupResult.runRepository.get(setupResult.run.id)).toMatchObject({
      status: "failed", error: "MCP private_mcp check failed"
    });
    expect(setupResult.eventStore.list(setupResult.run.id, 0).map((event) => JSON.parse(event.contentJson)))
      .toContainEqual({ status: "failed", publicNoticeCode: "mcp_preflight_failed" });
    setupResult.db.close();
  });

  it("preparation 期间按 runId 记录取消且不影响同 Session 后续 Run", async () => {
    const ensured = deferred<RuntimeSession>();
    const runtime = createFakeRuntime();
    const originalEnsureSession = runtime.ensureSession.bind(runtime);
    const originalStartTurn = runtime.startTurn.bind(runtime);
    let ensureCalls = 0;
    runtime.ensureSession = vi.fn((input) => {
      ensureCalls += 1;
      return ensureCalls === 1 ? ensured.promise : originalEnsureSession(input);
    });
    runtime.startTurn = vi.fn(originalStartTurn);
    runtime.cancel = vi.fn(async () => undefined);
    const setupResult = setup(runtime);

    const firstExecution = setupResult.executor.execute(setupResult.run.id);
    await vi.waitFor(() => expect(runtime.ensureSession).toHaveBeenCalledTimes(1));
    await setupResult.executor.cancel(setupResult.run.id);
    ensured.resolve({ providerSessionId: "provider-session-1" });
    await firstExecution;

    expect(runtime.cancel).toHaveBeenCalledWith(TEST_SESSION_ID);
    expect(runtime.startTurn).not.toHaveBeenCalled();
    expect(setupResult.runRepository.get(setupResult.run.id)?.status).toBe("cancelled");

    const nextRun = setupResult.runRepository.create({ sessionId: TEST_SESSION_ID, input: "继续执行" });
    await setupResult.executor.execute(nextRun.id);

    expect(runtime.startTurn).toHaveBeenCalledTimes(1);
    expect(runtime.startTurn).toHaveBeenCalledWith({
      sessionId: TEST_SESSION_ID,
      requestId: nextRun.id,
      text: "继续执行"
    });
    expect(setupResult.runRepository.get(nextRun.id)?.status).toBe("succeeded");
    setupResult.db.close();
  });

  it("Event append 失败时有界清理仍在运行的 Turn 和 iterator", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(() => new Promise<void>(() => undefined));
      const closeEvents = vi.fn(() => new Promise<void>(() => undefined));
      const returnIterator = vi.fn(() => new Promise<IteratorResult<RuntimeEvent>>(() => undefined));
      let nextCalls = 0;
      const runtime = createFakeRuntime();
      runtime.startTurn = (): RuntimeTurn => ({
        events: {
          [Symbol.asyncIterator]() {
            return {
              next: () => {
                nextCalls += 1;
                if (nextCalls === 1) {
                  return Promise.resolve({
                    done: false,
                    value: { type: "message", stream: "output", text: "partial" } satisfies RuntimeEvent
                  });
                }
                return new Promise<IteratorResult<RuntimeEvent>>(() => undefined);
              },
              return: returnIterator
            };
          }
        },
        result: new Promise<RuntimeTurnResult>(() => undefined),
        cancel,
        closeEvents
      });
      const setupResult = setup(runtime);
      const append = setupResult.eventStore.append.bind(setupResult.eventStore);
      vi.spyOn(setupResult.eventStore, "append").mockImplementation((runId, type, content) => {
        if (type === "message") throw new Error("event append failed");
        return append(runId, type, content);
      });

      const execution = setupResult.executor.execute(setupResult.run.id);
      await vi.advanceTimersByTimeAsync(BEST_EFFORT_TIMEOUT_MS * 3);
      await execution;

      expect(cancel).toHaveBeenCalledTimes(1);
      expect(closeEvents).toHaveBeenCalledTimes(1);
      expect(returnIterator).toHaveBeenCalledTimes(1);
      expect(setupResult.runRepository.get(setupResult.run.id)).toMatchObject({
        status: "failed",
        error: "event append failed"
      });
      expect(setupResult.sessionManager.get(TEST_SESSION_ID)?.status).toBe("idle");
      expect(vi.getTimerCount()).toBe(0);
      setupResult.db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("canonical result 先结束时停止无限事件迭代并完成 Run", async () => {
    vi.useFakeTimers();
    try {
      const result = deferred<RuntimeTurnResult>();
      const returnIterator = vi.fn(() => new Promise<IteratorResult<RuntimeEvent>>(() => undefined));
      const closeEvents = vi.fn(() => new Promise<void>(() => undefined));
      let nextCalls = 0;
      const runtime = createFakeRuntime();
      runtime.startTurn = (): RuntimeTurn => ({
        events: {
          [Symbol.asyncIterator]() {
            return {
              next: () => {
                nextCalls += 1;
                if (nextCalls === 1) {
                  return Promise.resolve({
                    done: false,
                    value: { type: "message", stream: "output", text: "final answer" } satisfies RuntimeEvent
                  });
                }
                result.resolve({ status: "completed" });
                return new Promise<IteratorResult<RuntimeEvent>>(() => undefined);
              },
              return: returnIterator
            };
          }
        },
        result: result.promise,
        cancel: async () => undefined,
        closeEvents
      });
      const setupResult = setup(runtime);

      const execution = setupResult.executor.execute(setupResult.run.id);
      await vi.advanceTimersByTimeAsync(BEST_EFFORT_TIMEOUT_MS * 2);
      await execution;

      expect(closeEvents).toHaveBeenCalledTimes(1);
      expect(returnIterator).toHaveBeenCalledTimes(1);
      expect(closeEvents.mock.invocationCallOrder[0]).toBeLessThan(returnIterator.mock.invocationCallOrder[0]!);
      expect(setupResult.runRepository.get(setupResult.run.id)).toMatchObject({
        status: "succeeded",
        result: "final answer"
      });
      expect(setupResult.sessionManager.get(TEST_SESSION_ID)?.status).toBe("idle");
      expect(vi.getTimerCount()).toBe(0);
      setupResult.db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("iterator.next 同步抛错时 bounded cancel 和 closeEvents 后失败 Run", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(() => new Promise<void>(() => undefined));
      const closeEvents = vi.fn(() => new Promise<void>(() => undefined));
      const runtime = createFakeRuntime();
      runtime.startTurn = (): RuntimeTurn => ({
        events: {
          [Symbol.asyncIterator]() {
            return {
              next: () => { throw new Error("sync next exploded"); }
            };
          }
        },
        result: new Promise<RuntimeTurnResult>(() => undefined),
        cancel,
        closeEvents
      });
      const setupResult = setup(runtime);

      const execution = setupResult.executor.execute(setupResult.run.id);
      await vi.advanceTimersByTimeAsync(BEST_EFFORT_TIMEOUT_MS);
      await execution;

      expect(cancel).toHaveBeenCalledTimes(1);
      expect(closeEvents).toHaveBeenCalledTimes(1);
      expect(setupResult.runRepository.get(setupResult.run.id)).toMatchObject({
        status: "failed",
        error: "sync next exploded"
      });
      expect(vi.getTimerCount()).toBe(0);
      setupResult.db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("先标记 running，再投影环境并按 canonical completed 保存输出", async () => {
    let setupResult!: ReturnType<typeof setup>;
    const runtime = createFakeRuntime({
      providerSessionId: "provider-session-1",
      events: [
        { type: "status", text: "working" },
        { type: "message", stream: "output", text: "最终回复" },
        { type: "message", stream: "thought", text: "思考过程" },
        { type: "tool", content: { title: "Read", status: "completed" } }
      ],
      result: { status: "completed" }
    });
    const prepare = vi.fn(() => {
      expect(setupResult.runRepository.get(setupResult.run.id)?.status).toBe("running");
      return "remember this";
    });
    setupResult = setup(runtime, prepare);
    const startTurn = runtime.startTurn.bind(runtime);
    runtime.startTurn = (input): RuntimeTurn => {
      expect(setupResult.sessionManager.get(TEST_SESSION_ID)?.providerSessionId).toBe("provider-session-1");
      return startTurn(input);
    };

    await setupResult.executor.execute(setupResult.run.id);

    const events = setupResult.eventStore.list(setupResult.run.id, 0);
    expect(events.map((event) => event.type)).toEqual(["status", "message", "message", "tool", "status"]);
    expect(events.map((event) => JSON.parse(event.contentJson))).toEqual([
      { text: "working" },
      { stream: "output", text: "最终回复" },
      { stream: "thought", text: "思考过程" },
      { title: "Read", status: "completed" },
      { status: "succeeded" }
    ]);
    expect(setupResult.runRepository.get(setupResult.run.id)).toMatchObject({
      status: "succeeded",
      result: "最终回复",
      error: null
    });
    expect(setupResult.sessionManager.get(TEST_SESSION_ID)).toMatchObject({
      providerSessionId: "provider-session-1",
      status: "idle"
    });
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(Number), provider: "codex" }),
      expect.objectContaining({ workspacePath: setupResult.workspacePath })
    );
    setupResult.db.close();
  });

  it("合并多次部分用量更新并只在 Run 终态保存最终快照", async () => {
    const setupResult = setup(createFakeRuntime({
      events: [
        { type: "usage", usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 } },
        {
          type: "usage",
          usage: { inputTokens: 120, cachedReadTokens: 30, contextUsedTokens: 1_000, contextWindowTokens: 8_000 }
        },
        { type: "message", stream: "output", text: "完成" }
      ],
      result: { status: "completed" }
    }));

    await setupResult.executor.execute(setupResult.run.id);

    expect(setupResult.runRepository.get(setupResult.run.id)).toMatchObject({
      status: "succeeded",
      usage: {
        inputTokens: 120,
        outputTokens: 40,
        cachedReadTokens: 30,
        cachedWriteTokens: null,
        thoughtTokens: null,
        totalTokens: 140,
        contextUsedTokens: 1_000,
        contextWindowTokens: 8_000
      }
    });
    expect(setupResult.eventStore.list(setupResult.run.id, 0).map((event) => event.type))
      .toEqual(["message", "status"]);
    setupResult.db.close();
  });

  it("将 Runtime 返回的累计精确用量保存到 Session 而不是 Run", async () => {
    const runtime = createFakeRuntime({
      result: {
        status: "completed",
        sessionUsage: {
          inputTokens: 897,
          outputTokens: 17,
          cachedReadTokens: 15_104,
          thoughtTokens: 0,
          totalTokens: 16_018
        }
      } as RuntimeTurnResult
    });
    const setupResult = setup(runtime);

    await setupResult.executor.execute(setupResult.run.id);

    expect(setupResult.sessionManager.get(TEST_SESSION_ID)).toMatchObject({
      usage: {
        inputTokens: 897,
        outputTokens: 17,
        cachedReadTokens: 15_104,
        cachedWriteTokens: null,
        thoughtTokens: 0,
        totalTokens: 16_018
      }
    });
    expect(setupResult.runRepository.get(setupResult.run.id)?.usage).toBeNull();
    setupResult.db.close();
  });

  it("保存 Runtime error 事件，但仍只用 canonical result 决定终态", async () => {
    const setupResult = setup(createFakeRuntime({
      events: [{ type: "error", code: "transient", message: "reported by provider" }],
      result: { status: "completed" }
    }));

    await setupResult.executor.execute(setupResult.run.id);

    expect(setupResult.eventStore.list(setupResult.run.id, 0)).toMatchObject([
      { type: "error", contentJson: JSON.stringify({ code: "transient", message: "reported by provider" }) },
      { type: "status", contentJson: JSON.stringify({ status: "succeeded" }) }
    ]);
    expect(setupResult.runRepository.get(setupResult.run.id)?.status).toBe("succeeded");
    setupResult.db.close();
  });

  it("canonical result Promise 异常时失败 Run 并释放 Session", async () => {
    const runtime = createFakeRuntime();
    runtime.startTurn = (): RuntimeTurn => ({
      events: { async *[Symbol.asyncIterator]() {} },
      result: Promise.reject(new Error("result exploded")),
      cancel: async () => undefined,
      closeEvents: async () => undefined
    });
    const setupResult = setup(runtime);

    await setupResult.executor.execute(setupResult.run.id);

    expect(setupResult.runRepository.get(setupResult.run.id)).toMatchObject({
      status: "failed",
      error: "result exploded"
    });
    expect(setupResult.eventStore.list(setupResult.run.id, 0).map((event) => ({
      type: event.type,
      content: JSON.parse(event.contentJson)
    }))).toEqual([
      { type: "error", content: { message: "result exploded" } },
      { type: "status", content: { status: "failed" } }
    ]);
    expect(setupResult.sessionManager.get(TEST_SESSION_ID)?.status).toBe("idle");
    setupResult.db.close();
  });

  it.each([
    [{ status: "failed", code: "provider_failed", message: "provider crashed" } as const, "failed", "provider crashed"],
    [{ status: "cancelled" } as const, "cancelled", null]
  ])("按 canonical %s 结束 Run 并释放 Session", async (result, status, error) => {
    const setupResult = setup(createFakeRuntime({ result }));

    await setupResult.executor.execute(setupResult.run.id);

    expect(setupResult.runRepository.get(setupResult.run.id)).toMatchObject({ status, error });
    const terminalEvents = setupResult.eventStore.list(setupResult.run.id, 0).filter((event) => {
      const content = JSON.parse(event.contentJson) as { status?: string };
      return event.type === "status" && content.status !== undefined;
    });
    expect(terminalEvents).toHaveLength(1);
    expect(JSON.parse(terminalEvents[0]!.contentJson)).toEqual({ status });
    expect(setupResult.sessionManager.get(TEST_SESSION_ID)?.status).toBe("idle");
    setupResult.db.close();
  });

  it("事件迭代异常时保存 error 并让 Session 回到 idle", async () => {
    const runtime = createFakeRuntime();
    runtime.startTurn = (): RuntimeTurn => ({
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: "message", stream: "output", text: "partial" } satisfies RuntimeEvent;
          throw new Error("stream exploded");
        }
      },
      result: new Promise<RuntimeTurnResult>(() => undefined),
      cancel: async () => undefined,
      closeEvents: async () => undefined
    });
    const setupResult = setup(runtime);

    await setupResult.executor.execute(setupResult.run.id);

    expect(setupResult.runRepository.get(setupResult.run.id)).toMatchObject({
      status: "failed",
      error: "stream exploded"
    });
    expect(setupResult.eventStore.list(setupResult.run.id, 0).map((item) => ({
      type: item.type,
      content: JSON.parse(item.contentJson)
    })).slice(-2)).toEqual([
      { type: "error", content: { message: "stream exploded" } },
      { type: "status", content: { status: "failed" } }
    ]);
    expect(setupResult.sessionManager.get(TEST_SESSION_ID)?.status).toBe("idle");
    setupResult.db.close();
  });

  it("terminal status Event 写入失败时仍按 canonical result 收尾数据库", async () => {
    const setupResult = setup(createFakeRuntime({ result: { status: "completed" } }));
    const append = setupResult.eventStore.append.bind(setupResult.eventStore);
    const appendSpy = vi.spyOn(setupResult.eventStore, "append").mockImplementation((runId, type, content) => {
      if (type === "status" && (content as { status?: string }).status !== undefined) {
        throw new Error("terminal event write failed");
      }
      return append(runId, type, content);
    });

    await setupResult.executor.execute(setupResult.run.id);

    expect(setupResult.runRepository.get(setupResult.run.id)).toMatchObject({ status: "succeeded", error: null });
    expect(appendSpy.mock.calls.filter(([, type, content]) =>
      type === "status" && (content as { status?: string }).status !== undefined
    )).toHaveLength(1);
    expect(setupResult.sessionManager.get(TEST_SESSION_ID)?.status).toBe("idle");
    setupResult.db.close();
  });

  it("事件迭代异常时 cancel 永不结束也会有界失败 Run", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(() => new Promise<void>(() => undefined));
      const runtime = createFakeRuntime();
      runtime.startTurn = (): RuntimeTurn => ({
        events: {
          async *[Symbol.asyncIterator]() {
            throw new Error("stream exploded");
          }
        },
        result: new Promise<RuntimeTurnResult>(() => undefined),
        cancel,
        closeEvents: async () => undefined
      });
      const setupResult = setup(runtime);

      const execution = setupResult.executor.execute(setupResult.run.id);
      await vi.advanceTimersByTimeAsync(BEST_EFFORT_TIMEOUT_MS);
      await execution;

      expect(cancel).toHaveBeenCalledTimes(1);
      expect(setupResult.runRepository.get(setupResult.run.id)).toMatchObject({
        status: "failed",
        error: "stream exploded"
      });
      expect(setupResult.sessionManager.get(TEST_SESSION_ID)?.status).toBe("idle");
      setupResult.db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("queued 取消与 markRunning 竞态时改为取消 Runtime Turn", async () => {
    const runtime = createFakeRuntime();
    runtime.cancel = vi.fn(async () => undefined);
    const setupResult = setup(runtime);
    const cancelQueued = setupResult.runRepository.cancelQueued.bind(setupResult.runRepository);
    vi.spyOn(setupResult.runRepository, "cancelQueued").mockImplementationOnce((runId) => {
      setupResult.runRepository.markRunning(runId);
      return cancelQueued(runId);
    });

    const run = await setupResult.executor.cancel(setupResult.run.id);

    expect(run.status).toBe("running");
    expect(runtime.cancel).toHaveBeenCalledWith(TEST_SESSION_ID);
    setupResult.runRepository.finish(run.id, { status: "cancelled" });
    setupResult.db.close();
  });

  it("取消 running Run 时请求 Runtime cancel，并由 canonical cancelled 决定终态", async () => {
    const result = deferred<RuntimeTurnResult>();
    const cancel = vi.fn(async () => result.resolve({ status: "cancelled" }));
    const runtime = createFakeRuntime();
    runtime.startTurn = (): RuntimeTurn => ({
      events: {
        async *[Symbol.asyncIterator]() {}
      },
      result: result.promise,
      cancel: async () => undefined,
      closeEvents: async () => undefined
    });
    runtime.cancel = cancel;
    const setupResult = setup(runtime);

    const execution = setupResult.executor.execute(setupResult.run.id);
    await vi.waitFor(() => expect(setupResult.runRepository.get(setupResult.run.id)?.status).toBe("running"));
    await setupResult.executor.cancel(setupResult.run.id);
    await execution;

    expect(cancel).toHaveBeenCalledWith(TEST_SESSION_ID);
    expect(setupResult.runRepository.get(setupResult.run.id)?.status).toBe("cancelled");
    expect(setupResult.sessionManager.get(TEST_SESSION_ID)?.status).toBe("idle");
    setupResult.db.close();
  });
});
