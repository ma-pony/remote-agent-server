import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { IntegrationStore } from "../src/integrations/integration-store.js";
import type { AgentRuntime, RuntimeTurnResult } from "../src/runtime/agent-runtime.js";
import type { WorkspaceManager } from "../src/workspaces/workspace-manager.js";
import { createFakeRuntime, createTestDatabase } from "./helpers.js";

const apiToken = "integration-admin-token";

const authHeaders = (): Record<string, string> => ({ authorization: `Bearer ${apiToken}` });
const endpointHeaders = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
const queuedTaskResponseKeys = [
  "conversationKey",
  "requestId",
  "runId",
  "sessionId",
  "status",
  "taskId"
].sort();
const validEndpointInput = (agentId: number, slug = "support-bot") => ({
  name: "Support Bot",
  slug,
  agentId,
  enabled: true,
  promptPrefix: "Resolve the support request.",
  parameterMappings: []
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const apps: Array<{ app: FastifyInstance; close: () => Promise<void> }> = [];

const createTestApp = async (
  runtime: AgentRuntime = createFakeRuntime(),
  configureIntegrationStore?: (store: IntegrationStore) => void
): Promise<{
  app: FastifyInstance;
  agentId: number;
  db: ReturnType<typeof createTestDatabase>["db"];
  integrationStore: IntegrationStore;
}> => {
  const { db, seed } = createTestDatabase();
  const integrationStore = new IntegrationStore({ db });
  configureIntegrationStore?.(integrationStore);
  const dataDir = mkdtempSync(join(tmpdir(), "remote-agent-integration-api-"));
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
  const app = buildApp({
    config: {
      host: "127.0.0.1",
      port: 3000,
      apiToken,
      dataDir,
      databasePath: ":memory:",
      projectEnvironmentsRoot: "/unused/environments",
      sessionsRoot: "/unused/sessions",
      maxConcurrentRuns: 1,
      projectEnvironmentCheckIntervalMs: 3 * 60 * 60 * 1000,
      projectPrepareTimeoutMs: 30 * 60 * 1000
    },
    db,
    runtime,
    workspaceManager,
    integrationStore
  });
  apps.push({
    app,
    close: async () => {
      await app.close();
      db.close();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });
  await app.ready();
  return { app, agentId: seed.agent.id, db, integrationStore };
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map(({ close }) => close()));
});

describe("Integration endpoint API", () => {
  it("管理端创建 Endpoint 且 Token 只返回一次", async () => {
    const { app, agentId } = await createTestApp();
    const unauthenticated = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      payload: validEndpointInput(agentId)
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId)
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).toEqual({ error: { code: "unauthorized", message: "Invalid API token" } });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json() as { endpoint: { id: number; slug: string }; token: string };
    expect(createdBody.token).toMatch(/^ras_/);

    const list = await app.inject({ method: "GET", url: "/api/integration-endpoints", headers: authHeaders() });
    const detail = await app.inject({
      method: "GET",
      url: `/api/integration-endpoints/${createdBody.endpoint.id}`,
      headers: authHeaders()
    });
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/integration-endpoints/${createdBody.endpoint.id}`,
      headers: authHeaders(),
      payload: { name: "Updated Support Bot" }
    });

    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject([{ id: createdBody.endpoint.id, slug: "support-bot" }]);
    expect(detail.statusCode).toBe(200);
    expect(updated.statusCode).toBe(200);
    expect(JSON.stringify({ list: list.json(), detail: detail.json(), updated: updated.json() })).not.toContain(createdBody.token);

    const rotated = await app.inject({
      method: "POST",
      url: `/api/integration-endpoints/${createdBody.endpoint.id}/rotate-token`,
      headers: authHeaders()
    });
    expect(rotated.statusCode).toBe(200);
    expect((rotated.json() as { token: string }).token).toMatch(/^ras_/);
    expect((rotated.json() as { token: string }).token).not.toBe(createdBody.token);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/integration-endpoints/${createdBody.endpoint.id}`,
      headers: authHeaders()
    });
    expect(deleted.statusCode).toBe(204);
  });

  it("管理端修改映射时可保留未回显的固定敏感值", async () => {
    const { app, agentId, db } = await createTestApp();
    db.prepare(`
      INSERT INTO agent_session_parameters
        (agent_id, key, label, description, required, secret, created_at, updated_at)
      VALUES (?, 'callback_token', 'Callback Token', NULL, 0, 1, ?, ?)
    `).run(agentId, "2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z");
    const created = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: {
        ...validEndpointInput(agentId),
        parameterMappings: [{ parameterKey: "callback_token", source: "fixed", value: "private-callback-token" }]
      }
    });
    const endpointId = (created.json() as { endpoint: { id: number } }).endpoint.id;

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/integration-endpoints/${endpointId}`,
      headers: authHeaders(),
      payload: { parameterMappings: [{ parameterKey: "callback_token", source: "fixed" }] }
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      parameterMappings: [{ parameterKey: "callback_token", source: "fixed", configured: true }]
    });
    expect(JSON.stringify(updated.json())).not.toContain("private-callback-token");
  });

  it("基础设置修改不被后来新增的必填参数映射阻断", async () => {
    const { app, agentId, db } = await createTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId, "legacy-endpoint")
    });
    const endpointId = (created.json() as { endpoint: { id: number } }).endpoint.id;
    db.prepare(`
      INSERT INTO agent_session_parameters
        (agent_id, key, label, description, required, secret, created_at, updated_at)
      VALUES (?, 'ticket_id', '工单 ID', NULL, 1, 0, ?, ?)
    `).run(agentId, "2026-08-21T00:00:00.000Z", "2026-08-21T00:00:00.000Z");

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/integration-endpoints/${endpointId}`,
      headers: authHeaders(),
      payload: {
        name: "grab-manager-spider-dev",
        slug: "grab-impl",
        agentId,
        enabled: true,
        promptPrefix: ""
      }
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      id: endpointId,
      name: "grab-manager-spider-dev",
      slug: "grab-impl",
      agentId,
      enabled: true,
      parameterMappings: []
    });
  });

  it("拒绝管理 Token 调用外部接口和端点 Token 跨 slug", async () => {
    const { app, agentId } = await createTestApp();
    const first = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId, "endpoint-a")
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId, "endpoint-b")
    });
    const endpointA = first.json() as { token: string };
    const endpointB = second.json() as { token: string };

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const managementToken = await app.inject({
      method: "POST",
      url: "/integration/v1/endpoints/endpoint-a/tasks",
      headers: authHeaders()
    });
    const crossEndpointToken = await app.inject({
      method: "POST",
      url: "/integration/v1/endpoints/endpoint-b/tasks",
      headers: endpointHeaders(endpointA.token)
    });
    const validEndpointToken = await app.inject({
      method: "POST",
      url: "/integration/v1/endpoints/endpoint-a/tasks",
      headers: endpointHeaders(endpointA.token)
    });
    const validSecondEndpointToken = await app.inject({
      method: "POST",
      url: "/integration/v1/endpoints/endpoint-b/tasks",
      headers: endpointHeaders(endpointB.token)
    });

    expect(managementToken.statusCode).toBe(401);
    expect(managementToken.json()).toEqual({
      error: { code: "invalid_endpoint_token", message: "Invalid integration endpoint token" }
    });
    expect(crossEndpointToken.statusCode).toBe(401);
    expect(crossEndpointToken.json()).toEqual({
      error: { code: "invalid_endpoint_token", message: "Invalid integration endpoint token" }
    });
    expect(validEndpointToken.statusCode).toBe(400);
    expect(validEndpointToken.json()).toEqual({
      error: { code: "invalid_request", message: "Invalid Integration Task input" }
    });
    expect(validSecondEndpointToken.statusCode).toBe(400);
    expect(validSecondEndpointToken.json()).toEqual({
      error: { code: "invalid_request", message: "Invalid Integration Task input" }
    });
  });

  it("外部提交幂等 Task、查询状态并续接 Conversation", async () => {
    const { app, agentId, db } = await createTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId)
    });
    const endpoint = created.json() as { endpoint: { id: number; slug: string }; token: string };
    const payload = {
      requestId: "request-1",
      conversationKey: "ticket/1332",
      message: "Investigate the failing transfer",
      parameters: {}
    };

    const first = await app.inject({
      method: "POST",
      url: `/integration/v1/endpoints/${endpoint.endpoint.slug}/tasks`,
      headers: endpointHeaders(endpoint.token),
      payload
    });
    const repeated = await app.inject({
      method: "POST",
      url: `/integration/v1/endpoints/${endpoint.endpoint.slug}/tasks`,
      headers: endpointHeaders(endpoint.token),
      payload
    });
    const firstTask = first.json() as {
      taskId: number;
      requestId: string;
      conversationKey: string | null;
      sessionId: number;
      runId: number | null;
      status: string;
    };
    const continued = await app.inject({
      method: "POST",
      url: `/integration/v1/endpoints/${endpoint.endpoint.slug}/tasks`,
      headers: endpointHeaders(endpoint.token),
      payload: { ...payload, requestId: "request-2", message: "Continue the investigation" }
    });
    await vi.waitFor(() => expect(
      (db.prepare("SELECT count(*) AS count FROM integration_tasks WHERE status = 'succeeded'").get() as { count: number }).count
    ).toBe(2));
    const queried = await app.inject({
      method: "GET",
      url: `/integration/v1/tasks/${firstTask.taskId}`,
      headers: endpointHeaders(endpoint.token)
    });

    expect(first.statusCode).toBe(202);
    expect(repeated.statusCode).toBe(202);
    expect(repeated.json()).toMatchObject({ taskId: firstTask.taskId });
    expect(queried.statusCode).toBe(200);
    expect(queried.json()).toMatchObject({ taskId: firstTask.taskId, status: "succeeded" });
    expect(continued.statusCode).toBe(202);
    expect(continued.json()).toMatchObject({ sessionId: firstTask.sessionId });
    for (const response of [first, repeated, queried, continued]) {
      expect(Object.keys(response.json() as Record<string, unknown>).sort()).toEqual(queuedTaskResponseKeys);
    }
    expect(firstTask).toEqual({
      taskId: firstTask.taskId,
      requestId: "request-1",
      conversationKey: "ticket/1332",
      sessionId: firstTask.sessionId,
      runId: null,
      status: "queued"
    });
    expect(firstTask.runId).toBeNull();
    expect(db.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT count(*) AS count FROM runs").get()).toEqual({ count: 2 });
  });

  it("管理端浏览 Endpoint 汇总、Conversation、Task 和安全详情", async () => {
    const { app, agentId } = await createTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId)
    });
    const endpoint = created.json() as { endpoint: { id: number; slug: string }; token: string };
    const submitted = await app.inject({
      method: "POST",
      url: `/integration/v1/endpoints/${endpoint.endpoint.slug}/tasks`,
      headers: endpointHeaders(endpoint.token),
      payload: {
        requestId: "admin-browser-request",
        conversationKey: "customer-42",
        message: "Show this Task in the console",
        parameters: {}
      }
    });
    const taskId = (submitted.json() as { taskId: number }).taskId;

    const summaries = await app.inject({ method: "GET", url: "/api/integration-endpoints", headers: authHeaders() });
    const conversations = await app.inject({
      method: "GET", url: `/api/integration-endpoints/${endpoint.endpoint.id}/conversations`, headers: authHeaders()
    });
    const tasks = await app.inject({
      method: "GET", url: `/api/integration-endpoints/${endpoint.endpoint.id}/tasks`, headers: authHeaders()
    });
    const detail = await app.inject({
      method: "GET", url: `/api/integration-tasks/${taskId}`, headers: authHeaders()
    });

    expect(summaries.statusCode).toBe(200);
    expect(summaries.json()).toMatchObject([{
      id: endpoint.endpoint.id,
      activeConversationCount: 1,
      activeTaskCount: expect.any(Number),
      latestTask: { id: taskId, requestId: "admin-browser-request" }
    }]);
    expect(conversations.statusCode).toBe(200);
    expect(conversations.json()).toMatchObject([{ conversationKey: "customer-42" }]);
    expect(tasks.statusCode).toBe(200);
    expect(tasks.json()).toMatchObject([{ id: taskId, requestId: "admin-browser-request" }]);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ id: taskId, message: "Show this Task in the console" });
    expect(detail.json()).not.toHaveProperty("encryptedParameters");
    expect(detail.json()).not.toHaveProperty("requestFingerprint");
  });

  it("管理端测试调用复用端点参数映射并创建真实 Task", async () => {
    const { app, agentId, db } = await createTestApp();
    db.prepare(`
      INSERT INTO agent_session_parameters
        (agent_id, key, label, description, required, secret, created_at, updated_at)
      VALUES (?, 'project_code', '项目编号', '外部系统中的项目编号', 1, 0, ?, ?)
    `).run(agentId, "2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z");
    const created = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: {
        ...validEndpointInput(agentId),
        parameterMappings: [{ parameterKey: "project_code", source: "request", requestKey: "project" }]
      }
    });
    const endpointId = (created.json() as { endpoint: { id: number } }).endpoint.id;

    const tested = await app.inject({
      method: "POST",
      url: `/api/integration-endpoints/${endpointId}/test-tasks`,
      headers: authHeaders(),
      payload: {
        conversationKey: "project-42",
        message: "检查项目当前状态",
        parameters: { project: "P-42" }
      }
    });

    expect(tested.statusCode).toBe(202);
    expect(tested.json()).toMatchObject({
      endpointId,
      conversationId: expect.any(Number),
      sessionId: expect.any(Number),
      requestId: expect.stringMatching(/^test-/),
      message: "检查项目当前状态",
      status: "queued"
    });
    expect(tested.json()).not.toHaveProperty("encryptedParameters");
    expect(db.prepare(`
      SELECT count(*) AS count
      FROM integration_tasks
      WHERE endpoint_id = ? AND message = ? AND encrypted_parameters IS NOT NULL
    `).get(endpointId, "检查项目当前状态")).toEqual({ count: 1 });
  });

  it("管理端测试调用拒绝未启用的接入端点", async () => {
    const { app, agentId, db } = await createTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: { ...validEndpointInput(agentId), enabled: false }
    });
    const endpointId = (created.json() as { endpoint: { id: number } }).endpoint.id;

    const tested = await app.inject({
      method: "POST",
      url: `/api/integration-endpoints/${endpointId}/test-tasks`,
      headers: authHeaders(),
      payload: { message: "检查项目当前状态", parameters: {} }
    });

    expect(tested.statusCode).toBe(409);
    expect(tested.json()).toEqual({
      error: { code: "endpoint_disabled", message: "请先启用接入端点再发送测试任务" }
    });
    expect(db.prepare("SELECT count(*) AS count FROM integration_tasks").get()).toEqual({ count: 0 });
  });

  it("管理端测试调用用中文指出缺少的动态参数", async () => {
    const { app, agentId, db } = await createTestApp();
    db.prepare(`
      INSERT INTO agent_session_parameters
        (agent_id, key, label, description, required, secret, created_at, updated_at)
      VALUES (?, 'project_code', '项目编号', NULL, 1, 0, ?, ?)
    `).run(agentId, "2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z");
    const created = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: {
        ...validEndpointInput(agentId),
        parameterMappings: [{ parameterKey: "project_code", source: "request", requestKey: "project" }]
      }
    });
    const endpointId = (created.json() as { endpoint: { id: number } }).endpoint.id;

    const tested = await app.inject({
      method: "POST",
      url: `/api/integration-endpoints/${endpointId}/test-tasks`,
      headers: authHeaders(),
      payload: { message: "检查项目当前状态", parameters: {} }
    });

    expect(tested.statusCode).toBe(400);
    expect(tested.json()).toEqual({
      error: { code: "missing_request_parameter", message: "缺少必填的动态参数" }
    });
    expect(db.prepare("SELECT count(*) AS count FROM integration_tasks").get()).toEqual({ count: 0 });
  });

  it("Endpoint 列表使用 Store 聚合且不逐 Endpoint 加载 Conversation 和 Task 历史", async () => {
    const { app, agentId, integrationStore } = await createTestApp();
    await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId)
    });
    vi.spyOn(integrationStore, "listConversations").mockImplementation(() => {
      throw new Error("Endpoint list must not load Conversation history");
    });
    vi.spyOn(integrationStore, "listTasks").mockImplementation(() => {
      throw new Error("Endpoint list must not load Task history");
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/integration-endpoints",
      headers: authHeaders()
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject([{
      activeConversationCount: 0,
      activeTaskCount: 0,
      latestTask: null
    }]);
  });

  it("Conversation 建立后禁用 Agent，后续 Task 稳定失败且不启动新 Turn", async () => {
    const runtime = createFakeRuntime();
    runtime.startTurn = vi.fn(runtime.startTurn);
    const { app, agentId, db } = await createTestApp(runtime);
    const created = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId)
    });
    const endpoint = created.json() as { endpoint: { slug: string }; token: string };
    const submit = (requestId: string) => app.inject({
      method: "POST",
      url: `/integration/v1/endpoints/${endpoint.endpoint.slug}/tasks`,
      headers: endpointHeaders(endpoint.token),
      payload: { requestId, conversationKey: "ticket-disabled-agent", message: requestId, parameters: {} }
    });

    const first = await submit("request-before-disable");
    const firstTask = first.json() as { taskId: number };
    await vi.waitFor(() => expect(
      db.prepare("SELECT status FROM integration_tasks WHERE id = ?").get(firstTask.taskId)
    ).toEqual({ status: "succeeded" }));
    db.prepare("UPDATE agents SET enabled = 0 WHERE id = ?").run(agentId);

    const second = await submit("request-after-disable");
    const secondTask = second.json() as { taskId: number };
    await vi.waitFor(() => expect(
      db.prepare("SELECT status, error FROM integration_tasks WHERE id = ?").get(secondTask.taskId)
    ).toEqual({ status: "failed", error: "agent_disabled" }));
    const publicEvents = await app.inject({
      method: "GET",
      url: `/integration/v1/tasks/${secondTask.taskId}/events`,
      headers: endpointHeaders(endpoint.token)
    });
    const notices = (publicEvents.json() as Array<{ type: string; contentJson: string }>).filter(
      (event) => event.type === "message.system.notice"
    );

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(runtime.startTurn).toHaveBeenCalledTimes(1);
    expect(notices).toHaveLength(1);
    expect(JSON.parse(notices[0]!.contentJson)).toEqual({
      code: "agent_disabled",
      message: "Agent is disabled"
    });
  });

  it("外部提交冲突返回 409，繁忙 Conversation 不能结束", async () => {
    const result = deferred<RuntimeTurnResult>();
    const runtime = createFakeRuntime();
    runtime.startTurn = () => ({
      events: { async *[Symbol.asyncIterator]() {} },
      result: result.promise,
      cancel: async () => undefined,
      closeEvents: async () => undefined
    });
    runtime.cancel = async () => result.resolve({ status: "cancelled" });
    const { app, agentId } = await createTestApp(runtime);
    const created = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId)
    });
    const endpoint = created.json() as { endpoint: { slug: string }; token: string };
    const taskUrl = `/integration/v1/endpoints/${endpoint.endpoint.slug}/tasks`;
    await app.inject({
      method: "POST",
      url: taskUrl,
      headers: endpointHeaders(endpoint.token),
      payload: { requestId: "request-1", conversationKey: "ticket-1332", message: "first", parameters: {} }
    });

    const conflict = await app.inject({
      method: "POST",
      url: taskUrl,
      headers: endpointHeaders(endpoint.token),
      payload: { requestId: "request-1", conversationKey: "ticket-1332", message: "changed", parameters: {} }
    });
    const busy = await app.inject({
      method: "POST",
      url: `/integration/v1/endpoints/${endpoint.endpoint.slug}/conversations/ticket-1332/end`,
      headers: endpointHeaders(endpoint.token)
    });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: { code: "idempotency_conflict", message: "requestId was already used with different input" }
    });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toEqual({
      error: { code: "conversation_busy", message: "Conversation has an active Task" }
    });
  });

  it("结束 Conversation 后保留历史并为同 key 创建新 Session", async () => {
    const { app, agentId, db } = await createTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId)
    });
    const endpoint = created.json() as { endpoint: { id: number; slug: string }; token: string };
    const taskUrl = `/integration/v1/endpoints/${endpoint.endpoint.slug}/tasks`;
    const first = await app.inject({
      method: "POST",
      url: taskUrl,
      headers: endpointHeaders(endpoint.token),
      payload: { requestId: "request-1", conversationKey: "ticket-1332", message: "first", parameters: {} }
    });
    const firstTask = first.json() as { sessionId: number };
    db.prepare("UPDATE integration_tasks SET status = 'succeeded', finished_at = ?").run(new Date().toISOString());

    const ended = await app.inject({
      method: "POST",
      url: `/integration/v1/endpoints/${endpoint.endpoint.slug}/conversations/ticket-1332/end`,
      headers: endpointHeaders(endpoint.token)
    });
    const next = await app.inject({
      method: "POST",
      url: taskUrl,
      headers: endpointHeaders(endpoint.token),
      payload: { requestId: "request-2", conversationKey: "ticket-1332", message: "next", parameters: {} }
    });

    expect(ended.statusCode).toBe(200);
    expect(ended.json()).toMatchObject({ status: "ended", sessionId: firstTask.sessionId });
    expect(next.statusCode).toBe(202);
    expect(next.json()).not.toMatchObject({ sessionId: firstTask.sessionId });
    expect(db.prepare("SELECT count(*) AS count FROM integration_conversations").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 2 });
  });

  it("Task 查询先校验 Token，并让跨 Endpoint 与随机 ID 返回相同 404", async () => {
    const { app, agentId } = await createTestApp();
    const firstEndpointResponse = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId, "first-endpoint")
    });
    const secondEndpointResponse = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId, "second-endpoint")
    });
    const firstEndpoint = firstEndpointResponse.json() as { endpoint: { slug: string }; token: string };
    const secondEndpoint = secondEndpointResponse.json() as { token: string };
    const createdTask = await app.inject({
      method: "POST",
      url: `/integration/v1/endpoints/${firstEndpoint.endpoint.slug}/tasks`,
      headers: endpointHeaders(firstEndpoint.token),
      payload: { requestId: "request-1", message: "work", parameters: {} }
    });
    const task = createdTask.json() as { taskId: number };

    const invalidTokenRead = await app.inject({
      method: "GET",
      url: `/integration/v1/tasks/${task.taskId}`,
      headers: endpointHeaders("invalid-token")
    });

    const crossEndpointRead = await app.inject({
      method: "GET",
      url: `/integration/v1/tasks/${task.taskId}`,
      headers: endpointHeaders(secondEndpoint.token)
    });
    const randomIdRead = await app.inject({
      method: "GET",
      url: "/integration/v1/tasks/does-not-exist",
      headers: endpointHeaders(secondEndpoint.token)
    });
    const invalidSubmit = await app.inject({
      method: "POST",
      url: `/integration/v1/endpoints/${firstEndpoint.endpoint.slug}/tasks`,
      headers: endpointHeaders(firstEndpoint.token),
      payload: { requestId: "request-2", message: "work", parameters: {}, unexpected: true }
    });

    expect(invalidTokenRead.statusCode).toBe(401);
    expect(invalidTokenRead.json()).toEqual({
      error: { code: "invalid_endpoint_token", message: "Invalid integration endpoint token" }
    });
    expect(crossEndpointRead.statusCode).toBe(404);
    expect(randomIdRead.statusCode).toBe(404);
    expect(crossEndpointRead.json()).toEqual({
      error: { code: "task_not_found", message: "Integration Task not found" }
    });
    expect(randomIdRead.json()).toEqual(crossEndpointRead.json());
    expect(invalidSubmit.statusCode).toBe(400);
    expect(invalidSubmit.json()).toEqual({
      error: { code: "invalid_request", message: "Invalid Integration Task input" }
    });
  });

  it("Task Event 历史复用 Run seq、支持 afterSeq 并隔离 Endpoint", async () => {
    const runtime = createFakeRuntime({
      events: [
        { type: "message", stream: "output", text: "done" },
        { type: "tool", content: { toolCallId: "tool-1", title: "Inspect", status: "completed" } }
      ]
    });
    const { app, agentId, db } = await createTestApp(runtime);
    const firstEndpointResponse = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId, "events-a")
    });
    const secondEndpointResponse = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId, "events-b")
    });
    const firstEndpoint = firstEndpointResponse.json() as { endpoint: { slug: string }; token: string };
    const secondEndpoint = secondEndpointResponse.json() as { token: string };
    const submitted = await app.inject({
      method: "POST",
      url: `/integration/v1/endpoints/${firstEndpoint.endpoint.slug}/tasks`,
      headers: endpointHeaders(firstEndpoint.token),
      payload: { requestId: "event-request", message: "work", parameters: {} }
    });
    const task = submitted.json() as { taskId: number };
    await vi.waitFor(() => expect(
      db.prepare("SELECT status FROM integration_tasks WHERE id = ?").get(task.taskId)
    ).toEqual({ status: "succeeded" }));

    const events = await app.inject({
      method: "GET",
      url: `/integration/v1/tasks/${task.taskId}/events?afterSeq=1`,
      headers: endpointHeaders(firstEndpoint.token)
    });
    const crossEndpoint = await app.inject({
      method: "GET",
      url: `/integration/v1/tasks/${task.taskId}/events`,
      headers: endpointHeaders(secondEndpoint.token)
    });
    const invalidCursor = await app.inject({
      method: "GET",
      url: `/integration/v1/tasks/${task.taskId}/events?afterSeq=-1`,
      headers: endpointHeaders(firstEndpoint.token)
    });

    expect(events.statusCode).toBe(200);
    expect((events.json() as Array<{ seq: number; type: string }>).map(({ seq, type }) => ({ seq, type })))
      .toEqual([{ seq: 2, type: "tool" }, { seq: 3, type: "status" }]);
    expect(crossEndpoint.statusCode).toBe(404);
    expect(crossEndpoint.json()).toEqual({
      error: { code: "task_not_found", message: "Integration Task not found" }
    });
    expect(invalidCursor.statusCode).toBe(400);
    expect(invalidCursor.json()).toEqual({
      error: { code: "invalid_request", message: "Invalid Event cursor" }
    });
  });

  it("外部 Task Event 只返回公开投影且保留 Agent 消息和 afterSeq", async () => {
    const leakedSecret = "run-event-secret-must-not-leak";
    const runtime = createFakeRuntime({
      events: [
        { type: "message", stream: "output", text: "safe agent reply" },
        {
          type: "tool",
          content: {
            toolCallId: "tool-secret-boundary",
            title: `Inspect ${leakedSecret}`,
            locations: [{ path: `/workspace/${leakedSecret}.txt`, line: 9 }],
            status: "completed",
            rawInput: { token: leakedSecret },
            rawOutput: { result: leakedSecret },
            content: { nested: leakedSecret },
            providerPrivate: { deeply: { nested: leakedSecret } }
          }
        },
        { type: "status", text: leakedSecret },
        { type: "error", code: "provider_warning", message: leakedSecret }
      ]
    });
    const { app, agentId, db } = await createTestApp(runtime);
    const created = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId, "public-events")
    });
    const endpoint = created.json() as { endpoint: { slug: string }; token: string };
    const submitted = await app.inject({
      method: "POST",
      url: `/integration/v1/endpoints/${endpoint.endpoint.slug}/tasks`,
      headers: endpointHeaders(endpoint.token),
      payload: { requestId: "public-event-request", message: "work", parameters: {} }
    });
    const taskId = (submitted.json() as { taskId: number }).taskId;
    await vi.waitFor(() => expect(
      db.prepare("SELECT status FROM integration_tasks WHERE id = ?").get(taskId)
    ).toEqual({ status: "succeeded" }));

    const all = await app.inject({
      method: "GET",
      url: `/integration/v1/tasks/${taskId}/events`,
      headers: endpointHeaders(endpoint.token)
    });
    const afterMessage = await app.inject({
      method: "GET",
      url: `/integration/v1/tasks/${taskId}/events?afterSeq=1`,
      headers: endpointHeaders(endpoint.token)
    });
    const events = all.json() as Array<{ seq: number; type: string; contentJson: string }>;

    expect(all.statusCode).toBe(200);
    expect(events.map(({ seq, type }) => ({ seq, type }))).toEqual([
      { seq: 1, type: "message" },
      { seq: 2, type: "tool" },
      { seq: 3, type: "status" },
      { seq: 4, type: "error" },
      { seq: 5, type: "status" }
    ]);
    expect(JSON.parse(events[0]!.contentJson)).toEqual({ stream: "output", text: "safe agent reply" });
    expect(JSON.parse(events[1]!.contentJson)).toEqual({
      toolCallId: "tool-secret-boundary",
      status: "completed"
    });
    expect(JSON.parse(events[2]!.contentJson)).toEqual({});
    expect(JSON.parse(events[3]!.contentJson)).toEqual({ code: "agent_run_error" });
    expect(JSON.stringify(events)).not.toContain(leakedSecret);
    expect(JSON.stringify(events)).not.toContain("rawInput");
    expect(JSON.stringify(events)).not.toContain("rawOutput");
    expect(JSON.stringify(events)).not.toContain('"content"');
    expect((afterMessage.json() as Array<{ seq: number }>).map(({ seq }) => seq)).toEqual([2, 3, 4, 5]);
  });

  it("running Task 取消委托 Runtime，终态幂等并继续调度同 Conversation 下一 Task", async () => {
    const result = deferred<RuntimeTurnResult>();
    const runtime = createFakeRuntime();
    const succeedingTurn = runtime.startTurn;
    let turnCount = 0;
    runtime.startTurn = (input) => {
      turnCount += 1;
      return turnCount === 1 ? {
        events: { async *[Symbol.asyncIterator]() {} },
        result: result.promise,
        cancel: async () => undefined,
        closeEvents: async () => undefined
      } : succeedingTurn(input);
    };
    runtime.cancel = vi.fn(async () => result.resolve({ status: "cancelled" }));
    const { app, agentId, db } = await createTestApp(runtime);
    const created = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId, "cancel-endpoint")
    });
    const endpoint = created.json() as { endpoint: { slug: string }; token: string };
    const submitted = await app.inject({
      method: "POST",
      url: `/integration/v1/endpoints/${endpoint.endpoint.slug}/tasks`,
      headers: endpointHeaders(endpoint.token),
      payload: {
        requestId: "cancel-request",
        conversationKey: "cancel-conversation",
        message: "long work",
        parameters: {}
      }
    });
    const task = submitted.json() as { taskId: number; sessionId: number };
    await vi.waitFor(() => expect(
      db.prepare("SELECT status FROM integration_tasks WHERE id = ?").get(task.taskId)
    ).toEqual({ status: "running" }));
    const nextSubmitted = await app.inject({
      method: "POST",
      url: `/integration/v1/endpoints/${endpoint.endpoint.slug}/tasks`,
      headers: endpointHeaders(endpoint.token),
      payload: {
        requestId: "next-request",
        conversationKey: "cancel-conversation",
        message: "next work",
        parameters: {}
      }
    });
    const nextTask = nextSubmitted.json() as { taskId: number; sessionId: number };
    expect(nextTask.sessionId).toBe(task.sessionId);
    expect(db.prepare("SELECT status, run_id FROM integration_tasks WHERE id = ?").get(nextTask.taskId))
      .toEqual({ status: "queued", run_id: null });

    const cancelled = await app.inject({
      method: "POST",
      url: `/integration/v1/tasks/${task.taskId}/cancel`,
      headers: endpointHeaders(endpoint.token)
    });
    await vi.waitFor(() => expect(
      db.prepare("SELECT status FROM integration_tasks WHERE id = ?").get(task.taskId)
    ).toEqual({ status: "cancelled" }));
    await vi.waitFor(() => expect(
      db.prepare("SELECT status FROM integration_tasks WHERE id = ?").get(nextTask.taskId)
    ).toEqual({ status: "succeeded" }), { timeout: 5_000 });
    const repeated = await app.inject({
      method: "POST",
      url: `/integration/v1/tasks/${task.taskId}/cancel`,
      headers: endpointHeaders(endpoint.token)
    });

    expect(cancelled.statusCode).toBe(200);
    expect(runtime.cancel).toHaveBeenCalledWith(task.sessionId);
    expect(turnCount).toBe(2);
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toMatchObject({ taskId: task.taskId, status: "cancelled" });
  });

  it("未关联 Run 的 queued Task 直接取消且不会调用 Runtime", async () => {
    const runtime = createFakeRuntime();
    runtime.cancel = vi.fn(runtime.cancel);
    const { app, agentId, db } = await createTestApp(runtime, (store) => {
      vi.spyOn(store, "listDispatchableTasks").mockReturnValue([]);
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId, "queued-cancel")
    });
    const endpoint = created.json() as { endpoint: { slug: string }; token: string };
    const submitted = await app.inject({
      method: "POST",
      url: `/integration/v1/endpoints/${endpoint.endpoint.slug}/tasks`,
      headers: endpointHeaders(endpoint.token),
      payload: { requestId: "queued-cancel-request", message: "cancel me", parameters: {} }
    });
    const task = submitted.json() as { taskId: number };

    const cancelled = await app.inject({
      method: "POST",
      url: `/integration/v1/tasks/${task.taskId}/cancel`,
      headers: endpointHeaders(endpoint.token)
    });

    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ taskId: task.taskId, status: "cancelled", runId: null });
    expect(db.prepare("SELECT status, run_id FROM integration_tasks WHERE id = ?").get(task.taskId))
      .toEqual({ status: "cancelled", run_id: null });
    expect(db.prepare("SELECT count(*) AS count FROM runs").get()).toEqual({ count: 0 });
    expect(runtime.cancel).not.toHaveBeenCalled();
  });

  it("重复 slug 的创建和更新返回稳定冲突错误", async () => {
    const { app, agentId } = await createTestApp();
    const first = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId, "first-endpoint")
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId, "second-endpoint")
    });
    const duplicateCreate = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId, "first-endpoint")
    });
    const secondId = (second.json() as { endpoint: { id: number } }).endpoint.id;
    const duplicateUpdate = await app.inject({
      method: "PATCH",
      url: `/api/integration-endpoints/${secondId}`,
      headers: authHeaders(),
      payload: { slug: "first-endpoint" }
    });
    const secondDetail = await app.inject({
      method: "GET",
      url: `/api/integration-endpoints/${secondId}`,
      headers: authHeaders()
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(duplicateCreate.statusCode).toBe(409);
    expect(duplicateCreate.json()).toEqual({
      error: { code: "slug_conflict", message: "Integration endpoint slug already exists" }
    });
    expect(JSON.stringify(duplicateCreate.json())).not.toContain("integration_endpoints");
    expect(duplicateUpdate.statusCode).toBe(409);
    expect(duplicateUpdate.json()).toEqual({
      error: { code: "slug_conflict", message: "Integration endpoint slug already exists" }
    });
    expect(secondDetail.json()).toMatchObject({ slug: "second-endpoint" });
  });

  it("rotate-token 拒绝多余请求体且保留旧 token", async () => {
    const { app, agentId } = await createTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId)
    });
    const endpoint = created.json() as { endpoint: { id: number; slug: string }; token: string };
    const invalidRotation = await app.inject({
      method: "POST",
      url: `/api/integration-endpoints/${endpoint.endpoint.id}/rotate-token`,
      headers: authHeaders(),
      payload: { unexpected: true }
    });
    const stillAuthorized = await app.inject({
      method: "POST",
      url: `/integration/v1/endpoints/${endpoint.endpoint.slug}/tasks`,
      headers: endpointHeaders(endpoint.token)
    });

    expect(invalidRotation.statusCode).toBe(400);
    expect(invalidRotation.json()).toEqual({
      error: { code: "invalid_request", message: "Invalid Integration Endpoint token rotation" }
    });
    expect(stillAuthorized.statusCode).toBe(400);
    expect(stillAuthorized.json()).toEqual({
      error: { code: "invalid_request", message: "Invalid Integration Task input" }
    });
  });

  it("管理端拒绝多余字段和不合法 slug", async () => {
    const { app, agentId } = await createTestApp();
    const extraField = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: { ...validEndpointInput(agentId), unexpected: true }
    });
    const invalidSlug = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId, "Support_Bot")
    });

    expect(extraField.statusCode).toBe(400);
    expect(extraField.json()).toEqual({ error: { code: "invalid_request", message: "Invalid Integration Endpoint input" } });
    expect(invalidSlug.statusCode).toBe(400);
    expect(invalidSlug.json()).toEqual({ error: { code: "invalid_request", message: "Invalid Integration Endpoint input" } });
  });

  it("SPA fallback 将未知 integration 路径保持为 JSON API 404", async () => {
    const webRoot = mkdtempSync(join(tmpdir(), "remote-agent-integration-web-"));
    mkdirSync(join(webRoot, "assets"));
    writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>Remote Agent UI</title>");
    const { db } = createTestDatabase();
    const app = buildApp({
      config: {
        host: "127.0.0.1",
        port: 3000,
        apiToken,
        dataDir: webRoot,
        databasePath: ":memory:",
        projectEnvironmentsRoot: "/unused/environments",
        sessionsRoot: "/unused/sessions",
        maxConcurrentRuns: 1,
        projectEnvironmentCheckIntervalMs: 3 * 60 * 60 * 1000,
        projectPrepareTimeoutMs: 30 * 60 * 1000
      },
      db,
      runtime: createFakeRuntime(),
      webRoot
    });

    try {
      await app.ready();
      const response = await app.inject({
        method: "GET",
        url: "/integration/not-a-route",
        headers: { accept: "text/html" }
      });

      expect(response.statusCode).toBe(404);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.json()).toEqual({ error: { code: "not_found", message: "API route not found" } });
    } finally {
      await app.close();
      db.close();
      rmSync(webRoot, { force: true, recursive: true });
    }
  });

  it("无 webRoot 时也为 API、Integration 和普通未知路径返回固定 JSON 404", async () => {
    const { db } = createTestDatabase();
    const dataDir = mkdtempSync(join(tmpdir(), "remote-agent-no-web-root-"));
    const app = buildApp({
      config: {
        host: "127.0.0.1",
        port: 3000,
        apiToken,
        dataDir,
        databasePath: ":memory:",
        projectEnvironmentsRoot: "/unused/environments",
        sessionsRoot: "/unused/sessions",
        maxConcurrentRuns: 1,
        projectEnvironmentCheckIntervalMs: 3 * 60 * 60 * 1000,
        projectPrepareTimeoutMs: 30 * 60 * 1000
      },
      db,
      runtime: createFakeRuntime(),
      webRoot: join(dataDir, "does-not-exist")
    });

    try {
      await app.ready();
      const missingApi = await app.inject({
        method: "GET",
        url: "/api?probe=1",
        headers: { authorization: `Bearer ${apiToken}` }
      });
      const missingIntegration = await app.inject({ method: "GET", url: "/integration?probe=1" });
      const missingRoute = await app.inject({ method: "GET", url: "/not-a-route?probe=1" });

      expect(missingApi.statusCode).toBe(404);
      expect(missingApi.json()).toEqual({ error: { code: "not_found", message: "API route not found" } });
      expect(missingIntegration.statusCode).toBe(404);
      expect(missingIntegration.json()).toEqual({ error: { code: "not_found", message: "API route not found" } });
      expect(missingRoute.statusCode).toBe(404);
      expect(missingRoute.json()).toEqual({ error: { code: "not_found", message: "Route not found" } });
    } finally {
      await app.close();
      db.close();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });
});
