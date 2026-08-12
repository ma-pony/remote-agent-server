import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentManager } from "../src/agents/agent-manager.js";
import { EventStore } from "../src/events/event-store.js";
import type {
  AgentRuntime,
  RuntimeEvent,
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

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const setup = (runtime: AgentRuntime, prepare = vi.fn(() => "remember this")) => {
  const root = mkdtempSync(join(tmpdir(), "remote-agent-executor-"));
  tempDirectories.push(root);
  const { db } = createTestDatabase();
  const dataDir = join(root, "data");
  const workspacePath = join(root, "sessions", "session-1", "workspace");
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(join(dirname(workspacePath), "browser"), { recursive: true });
  const agentManager = new AgentManager({ db, dataDir, runtime });
  const agent = agentManager.create({ name: "Codex", provider: "codex" });
  const createdAt = "2026-08-12T00:00:00.000Z";
  db.prepare(
    "INSERT INTO sessions (id, agent_id, title, status, workspace_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run("session-1", agent.id, "Test session", "idle", workspacePath, createdAt, createdAt);
  const workspaceManager = new BtrfsWorkspaceManager({
    workspaceTemplate: join(root, "template"),
    sessionsRoot: join(root, "sessions"),
    commandRunner: { run: async () => ({ stdout: "", stderr: "" }) }
  });
  const sessionManager = new SessionManager({ db, dataDir, agentManager, runtime, workspaceManager });
  const runRepository = new RunRepository({ db });
  const eventStore = new EventStore({ db });
  const run = runRepository.create({ sessionId: "session-1", input: "修复问题" });
  const skillProjector = { prepare };
  const executor = new RunExecutor({ runtime, skillProjector, runRepository, eventStore, sessionManager });
  return { db, eventStore, executor, prepare, run, runRepository, sessionManager, workspacePath };
};

afterEach(() => {
  tempDirectories.splice(0).forEach((directory) => rmSync(directory, { force: true, recursive: true }));
});

describe("RunExecutor", () => {
  it("canonical result 先结束时停止无限事件迭代并完成 Run", async () => {
    vi.useFakeTimers();
    try {
      const result = deferred<RuntimeTurnResult>();
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
        cancel: async () => undefined
      });
      const setupResult = setup(runtime);

      const execution = setupResult.executor.execute(setupResult.run.id);
      await vi.advanceTimersByTimeAsync(BEST_EFFORT_TIMEOUT_MS);
      await execution;

      expect(returnIterator).toHaveBeenCalledTimes(1);
      expect(setupResult.runRepository.get(setupResult.run.id)).toMatchObject({
        status: "succeeded",
        result: "final answer"
      });
      expect(setupResult.sessionManager.get("session-1")?.status).toBe("idle");
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
      expect(setupResult.sessionManager.get("session-1")?.providerSessionId).toBe("provider-session-1");
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
    expect(setupResult.sessionManager.get("session-1")).toMatchObject({
      providerSessionId: "provider-session-1",
      status: "idle"
    });
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String), provider: "codex" }),
      expect.objectContaining({ workspacePath: setupResult.workspacePath })
    );
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
      cancel: async () => undefined
    });
    const setupResult = setup(runtime);

    await setupResult.executor.execute(setupResult.run.id);

    expect(setupResult.runRepository.get(setupResult.run.id)).toMatchObject({
      status: "failed",
      error: "result exploded"
    });
    expect(setupResult.sessionManager.get("session-1")?.status).toBe("idle");
    setupResult.db.close();
  });

  it.each([
    [{ status: "failed", code: "provider_failed", message: "provider crashed" } as const, "failed", "provider crashed"],
    [{ status: "cancelled" } as const, "cancelled", null]
  ])("按 canonical %s 结束 Run 并释放 Session", async (result, status, error) => {
    const setupResult = setup(createFakeRuntime({ result }));

    await setupResult.executor.execute(setupResult.run.id);

    expect(setupResult.runRepository.get(setupResult.run.id)).toMatchObject({ status, error });
    expect(setupResult.sessionManager.get("session-1")?.status).toBe("idle");
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
      cancel: async () => undefined
    });
    const setupResult = setup(runtime);

    await setupResult.executor.execute(setupResult.run.id);

    expect(setupResult.runRepository.get(setupResult.run.id)).toMatchObject({
      status: "failed",
      error: "stream exploded"
    });
    expect(setupResult.eventStore.list(setupResult.run.id, 0).at(-1)).toMatchObject({ type: "error" });
    expect(setupResult.sessionManager.get("session-1")?.status).toBe("idle");
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
        cancel
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
      expect(setupResult.sessionManager.get("session-1")?.status).toBe("idle");
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
    expect(runtime.cancel).toHaveBeenCalledWith("session-1");
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
      cancel: async () => undefined
    });
    runtime.cancel = cancel;
    const setupResult = setup(runtime);

    const execution = setupResult.executor.execute(setupResult.run.id);
    await vi.waitFor(() => expect(setupResult.runRepository.get(setupResult.run.id)?.status).toBe("running"));
    await setupResult.executor.cancel(setupResult.run.id);
    await execution;

    expect(cancel).toHaveBeenCalledWith("session-1");
    expect(setupResult.runRepository.get(setupResult.run.id)?.status).toBe("cancelled");
    expect(setupResult.sessionManager.get("session-1")?.status).toBe("idle");
    setupResult.db.close();
  });
});
