import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentManager } from "../src/agents/agent-manager.js";
import { openDatabase } from "../src/db.js";
import type { Run } from "../src/domain.js";
import { EventStore } from "../src/events/event-store.js";
import { IntegrationProjection } from "../src/integrations/integration-projection.js";
import { listIntegrationTaskEvents } from "../src/integrations/integration-routes.js";
import { IntegrationTaskScheduler } from "../src/integrations/integration-scheduler.js";
import { IntegrationStore } from "../src/integrations/integration-store.js";
import { McpManager } from "../src/mcp/mcp-manager.js";
import { SecretStore } from "../src/mcp/secret-store.js";
import { RunRepository } from "../src/runs/run-repository.js";
import { SessionManager } from "../src/sessions/session-manager.js";
import type { WorkspaceManager } from "../src/workspaces/workspace-manager.js";
import { createFakeRuntime, createTestDatabase } from "./helpers.js";

const temporaryDirectories: string[] = [];

const createHarness = (options: {
  databasePath?: string;
  retryDelayMs?: number;
  onSchedulerError?: (failure: { taskId: number; code: string }) => undefined;
} = {}) => {
  const { db, seed } = createTestDatabase(options.databasePath);
  const dataDir = mkdtempSync(join(tmpdir(), "remote-agent-integration-scheduler-"));
  temporaryDirectories.push(dataDir);
  const secrets = SecretStore.open({ dataDir });
  const store = new IntegrationStore({ db });
  const runtime = createFakeRuntime();
  const agentManager = new AgentManager({ db, dataDir, runtime });
  const mcpManager = new McpManager({ db, secrets });
  const workspaceManager: WorkspaceManager = {
    check: async () => undefined,
    createSession: async (id) => ({
      workspacePath: join(dataDir, "sessions", String(id), "workspace"),
      runtimePath: join(dataDir, "sessions", String(id), "runtime"),
      browserProfilePath: join(dataDir, "sessions", String(id), "browser")
    }),
    deleteSession: async () => undefined,
    createRevision: async () => undefined,
    removeRevision: async () => undefined
  };
  const sessionManager = new SessionManager({
    db,
    dataDir,
    agentManager,
    runtime,
    workspaceManager,
    mcpManager
  });
  const endpoint = store.createEndpoint({
    name: "Ticket endpoint",
    slug: "ticket-endpoint",
    agentId: seed.agent.id,
    enabled: true,
    tokenHash: "token-hash",
    promptPrefix: "",
    parameterMappings: [],
    encryptedFixedValues: null
  });
  const runScheduler = { enqueue: vi.fn() };
  const notify = vi.fn(() => {
    expect(db.inTransaction).toBe(false);
  });
  let eventStore!: EventStore;
  const projection = new IntegrationProjection({
    db,
    store,
    listEvents: (runId) => eventStore.list(runId, 0),
    notify
  });
  const runRepository = new RunRepository({ db, projection });
  eventStore = new EventStore({ db, projection });
  const scheduler = new IntegrationTaskScheduler({
    store,
    runRepository,
    runScheduler,
    sessionManager,
    secrets,
    projection,
    retryDelayMs: options.retryDelayMs,
    onSchedulerError: options.onSchedulerError
  });
  let nextTask = 0;
  const createTask = (options: {
    conversationKey?: string;
    sessionId?: number;
    parameters?: Record<string, string | null>;
    encryptedParameters?: string;
  } = {}) => {
    nextTask += 1;
    const sessionId = options.sessionId ?? seed.session().id;
    const conversation = options.conversationKey === undefined
      ? undefined
      : store.getActiveConversation(endpoint.id, options.conversationKey)
        ?? store.createConversation({
          endpointId: endpoint.id,
          conversationKey: options.conversationKey,
          sessionId
        });
    const task = store.createTask({
      endpointId: endpoint.id,
      conversationId: conversation?.id ?? null,
      sessionId: conversation?.sessionId ?? sessionId,
      requestId: `request-${nextTask}`,
      requestFingerprint: `fingerprint-${nextTask}`,
      message: `message-${nextTask}`,
      effectivePrompt: `prompt-${nextTask}`,
      encryptedParameters: options.encryptedParameters
        ?? secrets.encrypt(JSON.stringify(options.parameters ?? {}))
    });
    db.prepare("UPDATE integration_tasks SET created_at = ? WHERE id = ?")
      .run(`2026-08-13T00:00:0${nextTask}.000Z`, task.id);
    return store.getTask(task.id)!;
  };
  return {
    db,
    seed,
    store,
    secrets,
    mcpManager,
    sessionManager,
    eventStore,
    projection,
    runRepository,
    runScheduler,
    notify,
    scheduler,
    endpoint,
    createTask
  };
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("IntegrationTaskScheduler", () => {
  it("同一 Conversation 只创建最早 Task 的 Run", () => {
    const harness = createHarness();
    const session = harness.seed.session();
    const first = harness.createTask({ conversationKey: "ticket-1", sessionId: session.id });
    const second = harness.createTask({ conversationKey: "ticket-1", sessionId: session.id });

    harness.scheduler.start();
    harness.scheduler.notify();

    expect(harness.store.getTask(first.id)?.runId).not.toBeNull();
    expect(harness.store.getTask(second.id)?.runId).toBeNull();
    expect(harness.runScheduler.enqueue).toHaveBeenCalledTimes(1);
    harness.scheduler.stop();
    harness.db.close();
  });

  it("不同 Conversation 可同时交给全局 RunScheduler", () => {
    const harness = createHarness();
    harness.createTask({ conversationKey: "ticket-1" });
    harness.createTask({ conversationKey: "ticket-2" });

    harness.scheduler.start();

    expect(harness.runScheduler.enqueue).toHaveBeenCalledTimes(2);
    harness.scheduler.stop();
    harness.db.close();
  });

  it("不设置轮询 timer，stop 后 notify 不再创建 Run", () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      harness.scheduler.start();
      harness.scheduler.stop();
      harness.createTask();
      harness.scheduler.notify();

      expect(harness.runScheduler.enqueue).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      harness.db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("在 Run 关联事务内完整替换参数快照，并只在 COMMIT 后 enqueue", () => {
    const harness = createHarness();
    const now = new Date().toISOString();
    harness.db.prepare(`
      INSERT INTO agent_session_parameters
        (agent_id, key, label, description, required, secret, created_at, updated_at)
      VALUES (?, 'alpha', 'Alpha', NULL, 0, 0, ?, ?),
             (?, 'beta', 'Beta', NULL, 0, 0, ?, ?)
    `).run(harness.seed.agent.id, now, now, harness.seed.agent.id, now, now);
    const session = harness.seed.session();
    harness.sessionManager.updateMcpParameters(session.id, { alpha: "old-alpha", beta: "old-beta" });
    harness.createTask({ sessionId: session.id, parameters: { alpha: "new-alpha" } });
    harness.runScheduler.enqueue.mockImplementation(() => {
      expect(harness.db.inTransaction).toBe(false);
      expect(harness.db.prepare(`
        SELECT p.key, v.plain_value
        FROM session_mcp_parameter_values v
        JOIN agent_session_parameters p ON p.id = v.parameter_id
        WHERE v.session_id = ?
        ORDER BY p.key
      `).all(session.id)).toEqual([{ key: "alpha", plain_value: "new-alpha" }]);
    });

    harness.scheduler.start();

    expect(harness.runScheduler.enqueue).toHaveBeenCalledTimes(1);
    harness.scheduler.stop();
    harness.db.close();
  });

  it("损坏的参数快照使用稳定脱敏错误且不泄露原文", () => {
    const harness = createHarness();
    const subscription = harness.store.createSubscription({
      endpointId: harness.endpoint.id,
      name: "callback",
      url: "https://example.test/hooks",
      enabled: true,
      eventsJson: JSON.stringify(["task.failed", "message.system.notice"]),
      encryptedHeaders: null,
      encryptedSigningSecret: "secret",
      timeoutSeconds: 10
    });
    const leakedSecret = "snapshot-secret-must-not-leak";
    const task = harness.createTask({
      encryptedParameters: harness.secrets.encrypt(`{\"token\":\"${leakedSecret}\"`)
    });

    harness.scheduler.start();

    expect(harness.store.getTask(task.id)).toMatchObject({
      status: "failed",
      runId: null,
      error: "invalid_parameter_snapshot"
    });
    const deliveries = harness.store.listDeliveries(subscription.id);
    expect(deliveries.map((delivery) => delivery.eventType)).toEqual([
      "task.failed",
      "message.system.notice"
    ]);
    expect(JSON.stringify(deliveries.map((delivery) => JSON.parse(delivery.payloadJson)))).not.toContain(leakedSecret);
    expect(JSON.parse(deliveries[1]!.payloadJson)).toMatchObject({
      notice: {
        code: "invalid_parameter_snapshot",
        message: "Integration Task parameter snapshot is invalid"
      }
    });
    expect(harness.runScheduler.enqueue).not.toHaveBeenCalled();
    harness.scheduler.stop();
    harness.db.close();
  });

  it("SQLite 写锁错误保持 Task queued，并用单个延迟 timer 重试且 stop 清理", async () => {
    vi.useFakeTimers();
    const dataDir = mkdtempSync(join(tmpdir(), "remote-agent-integration-lock-"));
    temporaryDirectories.push(dataDir);
    const databasePath = join(dataDir, "database.sqlite3");
    const harness = createHarness({ databasePath, retryDelayMs: 1_000 });
    harness.db.pragma("busy_timeout = 0");
    const task = harness.createTask();
    const locker = openDatabase(databasePath);
    locker.pragma("busy_timeout = 0");
    locker.exec("BEGIN IMMEDIATE");
    try {
      expect(() => harness.scheduler.start()).not.toThrow();
      expect(harness.store.getTask(task.id)).toMatchObject({ status: "queued", runId: null, error: null });
      expect(harness.runScheduler.enqueue).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);

      harness.scheduler.notify();
      expect(vi.getTimerCount()).toBe(1);

      locker.exec("ROLLBACK");
      await vi.advanceTimersByTimeAsync(1_000);

      expect(harness.store.getTask(task.id)?.runId).not.toBeNull();
      expect(harness.runScheduler.enqueue).toHaveBeenCalledTimes(1);
      harness.scheduler.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      if (locker.inTransaction) locker.exec("ROLLBACK");
      locker.close();
      harness.scheduler.stop();
      harness.db.close();
      vi.useRealTimers();
    }
  });

  it("public notify 吞掉一次 drain 异常并在受控 timer 后重新唤醒", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({ retryDelayMs: 1_000 });
      const task = harness.createTask();
      const listDispatchableTasks = harness.store.listDispatchableTasks.bind(harness.store);
      vi.spyOn(harness.store, "listDispatchableTasks")
        .mockImplementationOnce(() => { throw new Error("temporary scheduler drain failure"); })
        .mockImplementation(listDispatchableTasks);

      expect(() => harness.scheduler.start()).not.toThrow();
      expect(harness.store.getTask(task.id)).toMatchObject({ status: "queued", runId: null });
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(1_000);

      expect(harness.store.getTask(task.id)?.runId).not.toBeNull();
      harness.scheduler.stop();
      expect(vi.getTimerCount()).toBe(0);
      harness.db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("每个 queued Task 最多自动重试 3 次，exhausted 后跳过且不阻塞其他 Task", async () => {
    vi.useFakeTimers();
    const dataDir = mkdtempSync(join(tmpdir(), "remote-agent-integration-exhausted-"));
    temporaryDirectories.push(dataDir);
    const databasePath = join(dataDir, "database.sqlite3");
    const onSchedulerError = vi.fn(() => undefined);
    const harness = createHarness({ databasePath, retryDelayMs: 1_000, onSchedulerError });
    harness.db.pragma("busy_timeout = 0");
    const exhaustedTask = harness.createTask({ conversationKey: "exhausted" });
    const createRun = vi.spyOn(harness.runRepository, "create");
    const locker = openDatabase(databasePath);
    locker.pragma("busy_timeout = 0");
    locker.exec("BEGIN IMMEDIATE");
    try {
      harness.scheduler.start();
      await vi.advanceTimersByTimeAsync(3_000);

      expect(createRun).toHaveBeenCalledTimes(4);
      expect(harness.store.getTask(exhaustedTask.id)).toMatchObject({ status: "queued", runId: null });
      expect(vi.getTimerCount()).toBe(1);
      expect(onSchedulerError).toHaveBeenCalledTimes(1);
      expect(onSchedulerError).toHaveBeenCalledWith({
        taskId: exhaustedTask.id,
        code: "integration_retry_exhausted"
      });

      locker.exec("ROLLBACK");
      const nextTask = harness.createTask({ conversationKey: "next" });
      harness.scheduler.notify();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(createRun).toHaveBeenCalledTimes(5);
      expect(harness.store.getTask(exhaustedTask.id)).toMatchObject({
        status: "failed", runId: null, error: "integration_dispatch_failed"
      });
      expect(harness.store.getTask(nextTask.id)?.runId).not.toBeNull();
      expect(onSchedulerError).toHaveBeenCalledTimes(1);
      harness.scheduler.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      if (locker.inTransaction) locker.exec("ROLLBACK");
      locker.close();
      harness.scheduler.stop();
      harness.db.close();
      vi.useRealTimers();
    }
  });

  it("生产默认在单进程耗尽时只输出一条脱敏报告，重启后重新计数", async () => {
    vi.useFakeTimers();
    const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const dataDir = mkdtempSync(join(tmpdir(), "remote-agent-integration-default-report-"));
    temporaryDirectories.push(dataDir);
    const databasePath = join(dataDir, "database.sqlite3");
    const harness = createHarness({ databasePath, retryDelayMs: 1_000 });
    harness.db.pragma("busy_timeout = 0");
    const task = harness.createTask();
    harness.db.prepare("UPDATE integration_tasks SET message = ?, effective_prompt = ? WHERE id = ?")
      .run("private-input-must-not-leak", "private-token-must-not-leak", task.id);
    const locker = openDatabase(databasePath);
    locker.pragma("busy_timeout = 0");
    locker.exec("BEGIN IMMEDIATE");
    let restarted: IntegrationTaskScheduler | undefined;
    try {
      harness.scheduler.start();
      await vi.advanceTimersByTimeAsync(3_000);
      harness.scheduler.notify();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(report).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenLastCalledWith(`integration_retry_exhausted taskId=${task.id}`);
      expect(JSON.stringify(report.mock.calls)).not.toContain("private-input-must-not-leak");
      expect(JSON.stringify(report.mock.calls)).not.toContain("private-token-must-not-leak");

      harness.scheduler.stop();
      restarted = new IntegrationTaskScheduler({
        store: harness.store,
        runRepository: harness.runRepository,
        runScheduler: harness.runScheduler,
        sessionManager: harness.sessionManager,
        secrets: harness.secrets,
        projection: harness.projection,
        retryDelayMs: 1_000
      });
      restarted.start();
      await vi.advanceTimersByTimeAsync(3_000);

      expect(report).toHaveBeenCalledTimes(2);
      expect(report).toHaveBeenLastCalledWith(`integration_retry_exhausted taskId=${task.id}`);
    } finally {
      restarted?.stop();
      harness.scheduler.stop();
      if (locker.inTransaction) locker.exec("ROLLBACK");
      locker.close();
      harness.db.close();
      report.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("IntegrationProjection", () => {
  it("tool Delivery 仅包含公开白名单且不泄露 acpx 原始输入输出", () => {
    const harness = createHarness();
    const subscription = harness.store.createSubscription({
      endpointId: harness.endpoint.id,
      name: "callback",
      url: "https://example.test/hooks",
      enabled: true,
      eventsJson: JSON.stringify(["tool.completed"]),
      encryptedHeaders: null,
      encryptedSigningSecret: "secret",
      timeoutSeconds: 10
    });
    const task = harness.createTask();
    const run = harness.runRepository.create(
      { sessionId: task.sessionId, input: task.effectivePrompt },
      { afterInsert: (created) => { harness.store.linkTaskRunInTransaction(task.id, created.id); return undefined; } }
    );
    harness.runRepository.markRunning(run.id);
    const leakedSecret = "provider-secret-must-not-leak";

    harness.eventStore.append(run.id, "tool", {
      text: `Read: ${leakedSecret}`,
      tag: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      title: "Read",
      kind: "read",
      locations: [{ path: "/workspace/README.md", line: 12, _meta: { token: leakedSecret } }],
      rawInput: { token: leakedSecret },
      rawOutput: leakedSecret,
      content: [{ type: "content", text: leakedSecret }],
      providerExtension: leakedSecret
    });

    const payload = JSON.parse(harness.store.listDeliveries(subscription.id)[0]!.payloadJson) as {
      tool: Record<string, unknown>;
    };
    expect(payload.tool).toEqual({
      toolCallId: "tool-1",
      kind: "read",
      status: "completed"
    });
    expect(JSON.stringify(payload)).not.toContain(leakedSecret);
    harness.db.close();
  });

  it("同步投影 Run 状态、输出消息和明确 tool 状态，并在 COMMIT 后仅通知一次", async () => {
    const harness = createHarness();
    const subscription = harness.store.createSubscription({
      endpointId: harness.endpoint.id,
      name: "callback",
      url: "https://example.test/hooks",
      enabled: true,
      eventsJson: JSON.stringify([
        "task.started",
        "tool.started",
        "tool.completed",
        "tool.failed",
        "task.succeeded",
        "message.agent.reply"
      ]),
      encryptedHeaders: null,
      encryptedSigningSecret: "secret",
      timeoutSeconds: 10
    });
    const task = harness.createTask();
    const run = harness.runRepository.create(
      { sessionId: task.sessionId, input: task.effectivePrompt },
      { afterInsert: (created) => { harness.store.linkTaskRunInTransaction(task.id, created.id); return undefined; } }
    );

    harness.runRepository.markRunning(run.id);
    expect(harness.store.getTaskByRun(run.id)).toMatchObject({ status: "running" });
    harness.eventStore.append(run.id, "message", { stream: "output", text: "Hello " });
    harness.eventStore.append(run.id, "message", { stream: "thought", text: "hidden" });
    harness.eventStore.append(run.id, "message", { stream: "output", text: "world" });
    harness.eventStore.append(run.id, "tool", { toolCallId: "tool-1", status: "pending", title: "Read" });
    harness.eventStore.append(run.id, "tool", { toolCallId: "tool-1", status: "completed", title: "Read" });
    harness.eventStore.append(run.id, "tool", { toolCallId: "tool-2", title: "No state" });
    harness.eventStore.append(run.id, "tool", { toolCallId: "tool-3", status: "cancelled", title: "Cancelled" });
    harness.runRepository.finish(run.id, { status: "succeeded", result: "done" });

    expect(harness.notify).toHaveBeenCalledTimes(1);
    expect(harness.store.getTaskByRun(run.id)).toMatchObject({
      status: "succeeded",
      result: "done",
      error: null
    });
    const deliveries = harness.store.listDeliveries(subscription.id);
    expect(deliveries.map(({ eventType, sequence, eventKey }) => ({ eventType, sequence, eventKey }))).toEqual([
      { eventType: "task.started", sequence: 1, eventKey: `${task.id}:task.started` },
      { eventType: "tool.started", sequence: 2, eventKey: `${task.id}:tool:tool-1:started` },
      { eventType: "tool.completed", sequence: 3, eventKey: `${task.id}:tool:tool-1:completed` },
      { eventType: "tool.started", sequence: 4, eventKey: `${task.id}:tool:tool-2:started` },
      { eventType: "tool.started", sequence: 5, eventKey: `${task.id}:tool:tool-3:started` },
      { eventType: "task.succeeded", sequence: 6, eventKey: `${task.id}:task.succeeded` },
      { eventType: "message.agent.reply", sequence: 7, eventKey: `${task.id}:message.agent.reply` }
    ]);
    expect(JSON.parse(deliveries.at(-1)!.payloadJson)).toMatchObject({
      message: { role: "agent", content: "Hello world", runStatus: "succeeded" }
    });
    await Promise.resolve();
    expect(harness.notify).toHaveBeenCalledTimes(1);
    harness.db.close();
  });

  it("普通 Run finish 和 cancel 在释放 Session 的 COMMIT 后也通知 Integration scheduler", () => {
    const harness = createHarness();
    const runningSession = harness.seed.session();
    const running = harness.runRepository.create({ sessionId: runningSession.id, input: "ordinary running" });
    harness.runRepository.markRunning(running.id);

    harness.runRepository.finish(running.id, { status: "succeeded", result: "done" });

    expect(harness.notify).toHaveBeenCalledTimes(1);

    const queuedSession = harness.seed.session();
    const queued = harness.runRepository.create({ sessionId: queuedSession.id, input: "ordinary queued" });
    harness.runRepository.cancelQueued(queued.id);

    expect(harness.notify).toHaveBeenCalledTimes(2);
    harness.db.close();
  });

  it("terminal transaction 的 deferred FK 在 COMMIT 失败时不通知 scheduler", async () => {
    const harness = createHarness();
    harness.db.exec(`
      CREATE TABLE deferred_projection_guard (
        run_id TEXT NOT NULL REFERENCES runs(id) DEFERRABLE INITIALLY DEFERRED
      )
    `);
    const projection = {
      onStarted: (run: Run) => harness.projection.onStarted(run),
      onFinished: (run: Run) => {
        harness.projection.onFinished(run);
        harness.db.prepare("INSERT INTO deferred_projection_guard (run_id) VALUES ('missing-run')").run();
        return undefined;
      },
      afterCommit: (run: Run) => (harness.projection as unknown as { afterCommit(value: Run): undefined }).afterCommit(run)
    };
    const repository = new RunRepository({ db: harness.db, projection });
    const task = harness.createTask();
    const run = repository.create(
      { sessionId: task.sessionId, input: task.effectivePrompt },
      { afterInsert: (created) => { harness.store.linkTaskRunInTransaction(task.id, created.id); return undefined; } }
    );
    repository.markRunning(run.id);

    expect(() => repository.finish(run.id, { status: "succeeded", result: "done" })).toThrow();
    await Promise.resolve();

    expect(harness.notify).not.toHaveBeenCalled();
    expect(repository.get(run.id)?.status).toBe("running");
    expect(harness.store.getTask(task.id)?.status).toBe("running");
    harness.db.close();
  });

  it("重启 Run recovery 后补投影 linked Task 终态", async () => {
    const harness = createHarness();
    const task = harness.createTask();
    const run = harness.runRepository.create(
      { sessionId: task.sessionId, input: task.effectivePrompt },
      { afterInsert: (created) => { harness.store.linkTaskRunInTransaction(task.id, created.id); return undefined; } }
    );
    harness.runRepository.markRunning(run.id);
    harness.runRepository.recoverAfterRestart();
    expect(harness.store.getTask(task.id)?.status).toBe("running");

    harness.scheduler.recover();

    expect(harness.store.getTask(task.id)).toMatchObject({
      status: "failed",
      error: "server_restarted"
    });
    await Promise.resolve();
    expect(harness.notify).toHaveBeenCalledTimes(1);
    harness.db.close();
  });

  it("可分类的 Run 失败持久化脱敏 notice，按订阅过滤并在重复 recovery 时幂等", () => {
    const harness = createHarness();
    const noticeSubscription = harness.store.createSubscription({
      endpointId: harness.endpoint.id,
      name: "notices",
      url: "https://example.test/notices",
      enabled: true,
      eventsJson: JSON.stringify(["message.system.notice"]),
      encryptedHeaders: null,
      encryptedSigningSecret: "secret",
      timeoutSeconds: 10
    });
    const taskOnlySubscription = harness.store.createSubscription({
      endpointId: harness.endpoint.id,
      name: "tasks-only",
      url: "https://example.test/tasks",
      enabled: true,
      eventsJson: JSON.stringify(["task.failed"]),
      encryptedHeaders: null,
      encryptedSigningSecret: "secret",
      timeoutSeconds: 10
    });
    const finishFailedTask = (
      task: ReturnType<typeof harness.createTask>,
      error: string,
      publicNoticeCode?: string
    ) => {
      const run = harness.runRepository.create(
        { sessionId: task.sessionId, input: task.effectivePrompt },
        { afterInsert: (created) => { harness.store.linkTaskRunInTransaction(task.id, created.id); return undefined; } }
      );
      harness.runRepository.markRunning(run.id);
      if (publicNoticeCode !== undefined) {
        harness.eventStore.append(run.id, "status", { status: "failed", publicNoticeCode });
      }
      harness.eventStore.append(run.id, "error", { message: error });
      harness.runRepository.finish(run.id, { status: "failed", error });
    };

    const agentTask = harness.createTask();
    finishFailedTask(agentTask, "agent_disabled");
    const mcpSecret = "mcp-private-error-must-not-leak";
    const mcpTask = harness.createTask();
    finishFailedTask(mcpTask, mcpSecret, "mcp_preflight_failed");
    const restartedTask = harness.createTask();
    const restartedRun = harness.runRepository.create(
      { sessionId: restartedTask.sessionId, input: restartedTask.effectivePrompt },
      { afterInsert: (created) => {
        harness.store.linkTaskRunInTransaction(restartedTask.id, created.id);
        return undefined;
      } }
    );
    harness.runRepository.markRunning(restartedRun.id);
    harness.runRepository.recoverAfterRestart();

    harness.projection.recover();
    const firstRecovery = harness.store.listDeliveries(noticeSubscription.id).map((delivery) => ({
      id: delivery.id,
      eventKey: delivery.eventKey,
      sequence: delivery.sequence,
      dispatchOrder: delivery.dispatchOrder
    }));
    harness.projection.recover();

    const notices = harness.store.listDeliveries(noticeSubscription.id).map((delivery) => ({
      eventKey: delivery.eventKey,
      sequence: delivery.sequence,
      payload: JSON.parse(delivery.payloadJson) as Record<string, unknown>
    }));
    expect(notices).toHaveLength(3);
    expect(notices.map(({ payload }) => payload.notice)).toEqual([
      { code: "agent_disabled", message: "Agent is disabled" },
      { code: "mcp_preflight_failed", message: "MCP preflight failed" },
      { code: "server_restarted", message: "Agent Run was interrupted by a server restart" }
    ]);
    expect(new Set(notices.map(({ eventKey }) => eventKey)).size).toBe(3);
    expect(notices.every(({ sequence }) => sequence === 3)).toBe(true);
    expect(harness.store.listDeliveries(noticeSubscription.id).map((delivery) => ({
      id: delivery.id,
      eventKey: delivery.eventKey,
      sequence: delivery.sequence,
      dispatchOrder: delivery.dispatchOrder
    }))).toEqual(firstRecovery);
    expect(JSON.stringify(notices)).not.toContain(mcpSecret);
    expect(harness.store.listDeliveries(taskOnlySubscription.id).map(({ eventType }) => eventType))
      .toEqual(["task.failed", "task.failed", "task.failed"]);
    for (const task of [agentTask, mcpTask, restartedTask]) {
      const publicNotices = listIntegrationTaskEvents(
        harness.store,
        harness.eventStore,
        task.id,
        harness.endpoint.id,
        0
      ).filter(({ type }) => type === "message.system.notice");
      expect(publicNotices).toHaveLength(1);
    }
    harness.db.close();
  });

  it("按 normalized tool phase 投影 started/terminal，并在业务去重后生成连续 sequence", () => {
    const harness = createHarness();
    const subscription = harness.store.createSubscription({
      endpointId: harness.endpoint.id,
      name: "callback",
      url: "https://example.test/hooks",
      enabled: true,
      eventsJson: JSON.stringify(["tool.started", "tool.completed", "tool.failed"]),
      encryptedHeaders: null,
      encryptedSigningSecret: "secret",
      timeoutSeconds: 10
    });
    const task = harness.createTask();
    const run = harness.runRepository.create(
      { sessionId: task.sessionId, input: task.effectivePrompt },
      { afterInsert: (created) => { harness.store.linkTaskRunInTransaction(task.id, created.id); return undefined; } }
    );
    harness.runRepository.markRunning(run.id);

    expect(() => {
      harness.eventStore.append(run.id, "tool", { toolCallId: "tool-1", status: "completed" });
      harness.eventStore.append(run.id, "tool", { toolCallId: "tool-1", status: "completed" });
      harness.eventStore.append(run.id, "tool", { toolCallId: "tool-2", status: "failed" });
      harness.eventStore.append(run.id, "tool", { toolCallId: "tool-2", status: "failed" });
      harness.eventStore.append(run.id, "tool", { toolCallId: "tool-3", title: "No status yet" });
      harness.eventStore.append(run.id, "tool", { toolCallId: "tool-3", status: "pending" });
      harness.eventStore.append(run.id, "tool", { toolCallId: "tool-3", status: "in_progress" });
      harness.eventStore.append(run.id, "tool", { toolCallId: "tool-4", status: "cancelled" });
      harness.eventStore.append(run.id, "tool", { toolCallId: "tool-4", status: "provider_unknown" });
    }).not.toThrow();

    expect(harness.eventStore.list(run.id, 0)).toHaveLength(9);
    expect(harness.store.listDeliveries(subscription.id).map(({ eventKey, eventType, sequence }) => ({
      eventKey,
      eventType,
      sequence
    }))).toEqual([
      { eventKey: `${task.id}:tool:tool-1:started`, eventType: "tool.started", sequence: 2 },
      { eventKey: `${task.id}:tool:tool-1:completed`, eventType: "tool.completed", sequence: 3 },
      { eventKey: `${task.id}:tool:tool-2:started`, eventType: "tool.started", sequence: 4 },
      { eventKey: `${task.id}:tool:tool-2:failed`, eventType: "tool.failed", sequence: 5 },
      { eventKey: `${task.id}:tool:tool-3:started`, eventType: "tool.started", sequence: 6 },
      { eventKey: `${task.id}:tool:tool-4:started`, eventType: "tool.started", sequence: 7 }
    ]);
    expect(harness.store.getTask(task.id)?.eventSequence).toBe(7);
    harness.db.close();
  });

  it("没有 webhook subscription 时也按 source tool phase 去重 event sequence", () => {
    const harness = createHarness();
    const task = harness.createTask();
    const run = harness.runRepository.create(
      { sessionId: task.sessionId, input: task.effectivePrompt },
      { afterInsert: (created) => { harness.store.linkTaskRunInTransaction(task.id, created.id); return undefined; } }
    );
    harness.runRepository.markRunning(run.id);

    harness.eventStore.append(run.id, "tool", { toolCallId: "tool-no-subscription", status: "pending" });
    harness.eventStore.append(run.id, "tool", { toolCallId: "tool-no-subscription", status: "in_progress" });

    expect(harness.store.getTask(task.id)?.eventSequence).toBe(2);
    harness.db.close();
  });
});
