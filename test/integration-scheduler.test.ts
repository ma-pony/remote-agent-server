import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentManager } from "../src/agents/agent-manager.js";
import { EventStore } from "../src/events/event-store.js";
import { IntegrationProjection } from "../src/integrations/integration-projection.js";
import { IntegrationTaskScheduler } from "../src/integrations/integration-scheduler.js";
import { IntegrationStore } from "../src/integrations/integration-store.js";
import { McpManager } from "../src/mcp/mcp-manager.js";
import { SecretStore } from "../src/mcp/secret-store.js";
import { RunRepository } from "../src/runs/run-repository.js";
import { SessionManager } from "../src/sessions/session-manager.js";
import type { WorkspaceManager } from "../src/workspaces/workspace-manager.js";
import { createFakeRuntime, createTestDatabase } from "./helpers.js";

const temporaryDirectories: string[] = [];

const createHarness = () => {
  const { db, seed } = createTestDatabase();
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
      workspacePath: join(dataDir, "sessions", id, "workspace"),
      runtimePath: join(dataDir, "sessions", id, "runtime"),
      browserProfilePath: join(dataDir, "sessions", id, "browser")
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
    id: "endpoint-1",
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
    projection
  });
  let nextTask = 0;
  const createTask = (options: {
    conversationKey?: string;
    sessionId?: string;
    parameters?: Record<string, string | null>;
    encryptedParameters?: string;
  } = {}) => {
    nextTask += 1;
    const sessionId = options.sessionId ?? seed.session().id;
    const conversation = options.conversationKey === undefined
      ? undefined
      : store.getActiveConversation(endpoint.id, options.conversationKey)
        ?? store.createConversation({
          id: `conversation-${options.conversationKey}`,
          endpointId: endpoint.id,
          conversationKey: options.conversationKey,
          sessionId
        });
    const task = store.createTask({
      id: `task-${nextTask}`,
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
        (id, agent_id, key, label, description, required, secret, created_at, updated_at)
      VALUES ('alpha-param', ?, 'alpha', 'Alpha', NULL, 0, 0, ?, ?),
             ('beta-param', ?, 'beta', 'Beta', NULL, 0, 0, ?, ?)
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

  it("损坏的参数快照直接失败 Task 并创建 system notice", () => {
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
    const task = harness.createTask({ encryptedParameters: "invalid" });

    harness.scheduler.start();

    expect(harness.store.getTask(task.id)).toMatchObject({
      status: "failed",
      runId: null,
      error: "secret_decryption_failed"
    });
    expect(harness.store.listDeliveries(subscription.id).map((delivery) => delivery.eventType)).toEqual([
      "task.failed",
      "message.system.notice"
    ]);
    expect(harness.runScheduler.enqueue).not.toHaveBeenCalled();
    harness.scheduler.stop();
    harness.db.close();
  });
});

describe("IntegrationProjection", () => {
  it("同步投影 Run 状态、输出消息和明确 tool 状态，并在 COMMIT 后通知", async () => {
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
      { afterInsert: (created) => harness.store.linkTaskRunInTransaction(task.id, created.id) }
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

    expect(harness.notify).not.toHaveBeenCalled();
    expect(harness.store.getTaskByRun(run.id)).toMatchObject({
      status: "succeeded",
      result: "done",
      error: null
    });
    const deliveries = harness.store.listDeliveries(subscription.id);
    expect(deliveries.map(({ eventType, sequence, eventKey }) => ({ eventType, sequence, eventKey }))).toEqual([
      { eventType: "task.started", sequence: 1, eventKey: `${task.id}:task.started` },
      { eventType: "tool.started", sequence: 2, eventKey: `${task.id}:tool:tool-1:pending` },
      { eventType: "tool.completed", sequence: 3, eventKey: `${task.id}:tool:tool-1:completed` },
      { eventType: "task.succeeded", sequence: 4, eventKey: `${task.id}:task.succeeded` },
      { eventType: "message.agent.reply", sequence: 5, eventKey: `${task.id}:message.agent.reply` }
    ]);
    expect(JSON.parse(deliveries.at(-1)!.payloadJson)).toMatchObject({
      data: { message: "Hello world" }
    });
    await Promise.resolve();
    expect(harness.notify).toHaveBeenCalledTimes(1);
    harness.db.close();
  });

  it("重启 Run recovery 后补投影 linked Task 终态", async () => {
    const harness = createHarness();
    const task = harness.createTask();
    const run = harness.runRepository.create(
      { sessionId: task.sessionId, input: task.effectivePrompt },
      { afterInsert: (created) => harness.store.linkTaskRunInTransaction(task.id, created.id) }
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

  it("重复 tool 状态保留源 Event，并由稳定 eventKey 去重 Delivery", () => {
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
      { afterInsert: (created) => harness.store.linkTaskRunInTransaction(task.id, created.id) }
    );
    harness.runRepository.markRunning(run.id);

    expect(() => {
      harness.eventStore.append(run.id, "tool", { toolCallId: "tool-1", status: "completed" });
      harness.eventStore.append(run.id, "tool", { toolCallId: "tool-1", status: "completed" });
    }).not.toThrow();

    expect(harness.eventStore.list(run.id, 0)).toHaveLength(2);
    expect(harness.store.listDeliveries(subscription.id)).toMatchObject([{
      eventKey: `${task.id}:tool:tool-1:completed`,
      eventType: "tool.completed"
    }]);
    harness.db.close();
  });
});
