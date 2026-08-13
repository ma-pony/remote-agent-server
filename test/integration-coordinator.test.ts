import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentManager } from "../src/agents/agent-manager.js";
import {
  IntegrationCoordinator,
  IntegrationCoordinatorError
} from "../src/integrations/integration-coordinator.js";
import { IntegrationEndpointManager } from "../src/integrations/integration-endpoint-manager.js";
import { IntegrationStore } from "../src/integrations/integration-store.js";
import { McpManager } from "../src/mcp/mcp-manager.js";
import { SecretStore } from "../src/mcp/secret-store.js";
import { SessionManager } from "../src/sessions/session-manager.js";
import type { WorkspaceManager } from "../src/workspaces/workspace-manager.js";
import { createFakeRuntime, createTestDatabase } from "./helpers.js";

const temporaryDirectories: string[] = [];

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const createHarness = (options: { beforeWorkspaceCreate?: () => Promise<void> } = {}) => {
  const { db, seed } = createTestDatabase();
  const dataDir = mkdtempSync(join(tmpdir(), "remote-agent-integration-coordinator-"));
  temporaryDirectories.push(dataDir);
  const secrets = SecretStore.open({ dataDir });
  const store = new IntegrationStore({ db });
  const runtime = createFakeRuntime();
  const agentManager = new AgentManager({ db, dataDir, runtime });
  const mcpManager = new McpManager({ db, secrets });
  const createSession = vi.fn(async (id: string) => {
    expect(db.inTransaction).toBe(false);
    await options.beforeWorkspaceCreate?.();
    return {
      workspacePath: join(dataDir, "sessions", id, "workspace"),
      runtimePath: join(dataDir, "sessions", id, "runtime"),
      browserProfilePath: join(dataDir, "sessions", id, "browser")
    };
  });
  const deleteSession = vi.fn(async () => {
    expect(db.inTransaction).toBe(false);
  });
  const workspaceManager: WorkspaceManager = {
    check: async () => undefined,
    createSession,
    deleteSession,
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
  const endpointManager = new IntegrationEndpointManager({ db, store, secrets });
  mkdirSync(join(dataDir, "agents", seed.agent.id), { recursive: true });
  writeFileSync(join(dataDir, "agents", seed.agent.id, "MEMORY.md"), "# Test memory\n");
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO agent_session_parameters
      (id, agent_id, key, label, description, required, secret, created_at, updated_at)
    VALUES ('alpha-param', ?, 'alpha', 'Alpha', NULL, 0, 0, ?, ?),
           ('beta-param', ?, 'beta', 'Beta', NULL, 0, 0, ?, ?)
  `).run(seed.agent.id, now, now, seed.agent.id, now, now);
  const endpoint = endpointManager.create({
    name: "Ticket agent",
    slug: "ticket-agent",
    agentId: seed.agent.id,
    enabled: true,
    promptPrefix: "  Process this ticket.  ",
    parameterMappings: [
      { parameterKey: "alpha", source: "request", requestKey: "alpha" },
      { parameterKey: "beta", source: "request", requestKey: "beta" }
    ]
  }).endpoint;
  const coordinator = new IntegrationCoordinator({
    db,
    store,
    endpointManager,
    sessionManager,
    secrets
  });
  return { db, endpoint, coordinator, sessionManager, store, workspaceManager, mcpManager };
};

const request = (
  requestId: string,
  conversationKey: string | undefined,
  message: string,
  parameters: Record<string, string> = {}
) => ({
  requestId,
  conversationKey,
  message,
  parameters
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("IntegrationCoordinator", () => {
  it("相同 requestId 和 fingerprint 返回原 Task", async () => {
    const { db, endpoint, coordinator, sessionManager } = createHarness();

    const first = await coordinator.submit(endpoint, request("req-1", "ticket-1332", "处理工单"));
    const second = await coordinator.submit(endpoint, request("req-1", "ticket-1332", "处理工单"));

    expect(second.id).toBe(first.id);
    expect(first.effectivePrompt).toBe("Process this ticket.\n\n处理工单");
    expect(sessionManager.list()).toHaveLength(1);
    expect(db.prepare("SELECT count(*) AS count FROM runs").get()).toEqual({ count: 0 });
    db.close();
  });

  it("相同 requestId 和 conversationKey 并发提交只创建一个 Session workspace", async () => {
    const workspaceCreateEntered = deferred<void>();
    const releaseWorkspaceCreate = deferred<void>();
    const harness = createHarness({
      beforeWorkspaceCreate: async () => {
        workspaceCreateEntered.resolve();
        await releaseWorkspaceCreate.promise;
      }
    });
    const { db, endpoint, coordinator, workspaceManager } = harness;

    const firstPromise = coordinator.submit(endpoint, request("req-race", "ticket-race", "并发消息"));
    await workspaceCreateEntered.promise;
    const secondPromise = coordinator.submit(endpoint, request("req-race", "ticket-race", "并发消息"));
    releaseWorkspaceCreate.resolve();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(second.id).toBe(first.id);
    expect(workspaceManager.createSession).toHaveBeenCalledTimes(1);
    expect(workspaceManager.deleteSession).not.toHaveBeenCalled();
    expect(db.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 1 });
    db.close();
  });

  it("同一 conversationKey 的不同 requestId 并发提交复用一个 Session", async () => {
    const workspaceCreateEntered = deferred<void>();
    const releaseWorkspaceCreate = deferred<void>();
    const harness = createHarness({
      beforeWorkspaceCreate: async () => {
        workspaceCreateEntered.resolve();
        await releaseWorkspaceCreate.promise;
      }
    });
    const { db, endpoint, coordinator, workspaceManager } = harness;

    const firstPromise = coordinator.submit(endpoint, request("req-race-1", "ticket-race", "第一条"));
    await workspaceCreateEntered.promise;
    const secondPromise = coordinator.submit(endpoint, request("req-race-2", "ticket-race", "第二条"));
    releaseWorkspaceCreate.resolve();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(second.sessionId).toBe(first.sessionId);
    expect(workspaceManager.createSession).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT count(*) AS count FROM integration_tasks").get()).toEqual({ count: 2 });
    db.close();
  });

  it("fingerprint 仅按参数 key 排序并保留原始值", async () => {
    const { db, endpoint, coordinator, sessionManager } = createHarness();
    const first = await coordinator.submit(endpoint, request("req-1", undefined, "原始消息", {
      beta: " 2 ",
      alpha: "1"
    }));
    const repeated = await coordinator.submit(endpoint, request("req-1", undefined, "原始消息", {
      alpha: "1",
      beta: " 2 "
    }));

    expect(repeated.id).toBe(first.id);
    expect(sessionManager.list()).toHaveLength(1);
    db.close();
  });

  it("相同 requestId 内容不同返回冲突", async () => {
    const { db, endpoint, coordinator } = createHarness();
    await coordinator.submit(endpoint, request("req-1", "ticket-1332", "第一条"));

    await expect(coordinator.submit(endpoint, request("req-1", "ticket-1332", "第二条")))
      .rejects.toEqual(new IntegrationCoordinatorError("idempotency_conflict"));
    db.close();
  });

  it("同一 conversationKey 复用 Session，结束后新建 Session", async () => {
    const { db, endpoint, coordinator } = createHarness();
    const first = await coordinator.submit(endpoint, request("r1", "ticket-1332", "一"));
    const second = await coordinator.submit(endpoint, request("r2", "ticket-1332", "二"));
    expect(second.sessionId).toBe(first.sessionId);

    db.prepare("UPDATE integration_tasks SET status = 'succeeded', finished_at = ?").run(new Date().toISOString());
    const ended = await coordinator.endConversation(endpoint.id, "ticket-1332");
    expect(ended.status).toBe("ended");

    const third = await coordinator.submit(endpoint, request("r3", "ticket-1332", "三"));
    expect(third.sessionId).not.toBe(first.sessionId);
    expect(db.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 2 });
    db.close();
  });

  it("没有 conversationKey 时每个 Task 新建 Session", async () => {
    const { db, endpoint, coordinator } = createHarness();

    const first = await coordinator.submit(endpoint, request("r1", undefined, "一"));
    const second = await coordinator.submit(endpoint, request("r2", undefined, "二"));

    expect(second.sessionId).not.toBe(first.sessionId);
    expect(db.prepare("SELECT count(*) AS count FROM integration_conversations").get()).toEqual({ count: 0 });
    db.close();
  });

  it("Task 事务失败时仅删除本次新建的 Session workspace", async () => {
    const { db, endpoint, coordinator, workspaceManager } = createHarness();
    db.exec(`
      CREATE TRIGGER fail_integration_task_insert
      BEFORE INSERT ON integration_tasks
      BEGIN
        SELECT RAISE(ABORT, 'forced task insert failure');
      END;
    `);

    await expect(coordinator.submit(endpoint, request("r1", undefined, "失败")))
      .rejects.toThrow("forced task insert failure");

    expect(workspaceManager.deleteSession).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 0 });
    db.close();
  });

  it("有 active Task 时拒绝结束 Conversation", async () => {
    const { db, endpoint, coordinator } = createHarness();
    await coordinator.submit(endpoint, request("r1", "ticket-1332", "处理中"));

    await expect(coordinator.endConversation(endpoint.id, "ticket-1332"))
      .rejects.toEqual(new IntegrationCoordinatorError("conversation_busy"));
    expect(coordinator.getConversation(endpoint.id, "ticket-1332")?.status).toBe("active");
    db.close();
  });

  it("提交时为已订阅事件在同一事务创建两条 Delivery", async () => {
    const { db, endpoint, coordinator, store } = createHarness();
    const subscription = store.createSubscription({
      endpointId: endpoint.id,
      name: "ticket callback",
      url: "https://example.test/hooks/tickets",
      enabled: true,
      eventsJson: JSON.stringify(["task.queued", "message.user.received"]),
      encryptedHeaders: null,
      encryptedSigningSecret: "encrypted-secret",
      timeoutSeconds: 10
    });

    const task = await coordinator.submit(endpoint, request("r1", undefined, "处理"));
    const deliveries = store.listDeliveries(subscription.id);

    expect(deliveries.map(({ eventType, sequence }) => ({ eventType, sequence }))).toEqual([
      { eventType: "task.queued", sequence: 1 },
      { eventType: "message.user.received", sequence: 2 }
    ]);
    expect(store.getTask(task.id)?.eventSequence).toBe(2);
    db.close();
  });

  it("caller-owned transaction 未 claim idle Session 时拒绝替换 MCP 参数", async () => {
    const { db, endpoint, sessionManager } = createHarness();
    const session = await sessionManager.create({
      agentId: endpoint.agentId,
      title: "Ticket",
      mcpParameters: {}
    });

    db.exec("BEGIN IMMEDIATE");
    expect(() => sessionManager.replaceMcpParametersInTransaction(session.id, {}))
      .toThrowError(expect.objectContaining({ code: "session_busy" }));
    db.exec("ROLLBACK");
    db.close();
  });

  it("queued Run 插入后可替换已 claim Session 参数且 caller rollback 恢复旧值", async () => {
    const { db, endpoint, sessionManager } = createHarness();
    db.prepare(`
      INSERT INTO agent_session_parameters
        (id, agent_id, key, label, description, required, secret, created_at, updated_at)
      VALUES ('ticket-param', ?, 'ticket', 'Ticket', NULL, 1, 0, ?, ?)
    `).run(endpoint.agentId, new Date().toISOString(), new Date().toISOString());
    const session = await sessionManager.create({
      agentId: endpoint.agentId,
      title: "Ticket",
      mcpParameters: { ticket: "old" }
    });

    db.exec("BEGIN IMMEDIATE");
    db.prepare("UPDATE sessions SET status = 'running' WHERE id = ? AND status = 'idle'").run(session.id);
    db.prepare(`
      INSERT INTO runs (id, session_id, status, input, created_at)
      VALUES ('queued-run', ?, 'queued', 'new run', ?)
    `).run(session.id, new Date().toISOString());
    sessionManager.replaceMcpParametersInTransaction(session.id, { ticket: "new" });
    expect(db.prepare(`
      SELECT plain_value FROM session_mcp_parameter_values WHERE session_id = ?
    `).get(session.id)).toEqual({ plain_value: "new" });
    db.exec("ROLLBACK");

    expect(db.prepare(`
      SELECT plain_value FROM session_mcp_parameter_values WHERE session_id = ?
    `).get(session.id)).toEqual({ plain_value: "old" });
    expect(db.prepare("SELECT status FROM sessions WHERE id = ?").get(session.id)).toEqual({ status: "idle" });
    expect(db.prepare("SELECT count(*) AS count FROM runs WHERE id = 'queued-run'").get()).toEqual({ count: 0 });
    db.close();
  });
});
