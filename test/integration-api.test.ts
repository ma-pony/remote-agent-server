import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
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
const validEndpointInput = (agentId: string, slug = "support-bot") => ({
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

const createTestApp = async (runtime: AgentRuntime = createFakeRuntime()): Promise<{
  app: FastifyInstance;
  agentId: string;
  db: ReturnType<typeof createTestDatabase>["db"];
}> => {
  const { db, seed } = createTestDatabase();
  const dataDir = mkdtempSync(join(tmpdir(), "remote-agent-integration-api-"));
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
  const app = buildApp({
    config: {
      host: "127.0.0.1",
      port: 3000,
      apiToken,
      dataDir,
      databasePath: ":memory:",
      workspaceTemplate: "/unused/template",
      sessionsRoot: "/unused/sessions",
      maxConcurrentRuns: 1
    },
    db,
    runtime,
    workspaceManager
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
  return { app, agentId: seed.agent.id, db };
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
    const createdBody = created.json() as { endpoint: { id: string; slug: string }; token: string };
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
    const endpoint = created.json() as { endpoint: { id: string; slug: string }; token: string };
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
      taskId: string;
      requestId: string;
      conversationKey: string | null;
      sessionId: string;
      runId: string | null;
      status: string;
    };
    const queried = await app.inject({
      method: "GET",
      url: `/integration/v1/tasks/${firstTask.taskId}`,
      headers: endpointHeaders(endpoint.token)
    });
    const continued = await app.inject({
      method: "POST",
      url: `/integration/v1/endpoints/${endpoint.endpoint.slug}/tasks`,
      headers: endpointHeaders(endpoint.token),
      payload: { ...payload, requestId: "request-2", message: "Continue the investigation" }
    });
    await vi.waitFor(() => expect(
      (db.prepare("SELECT count(*) AS count FROM integration_tasks WHERE status = 'succeeded'").get() as { count: number }).count
    ).toBe(2));

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
    const firstTask = first.json() as { taskId: string };
    await vi.waitFor(() => expect(
      db.prepare("SELECT status FROM integration_tasks WHERE id = ?").get(firstTask.taskId)
    ).toEqual({ status: "succeeded" }));
    db.prepare("UPDATE agents SET enabled = 0 WHERE id = ?").run(agentId);

    const second = await submit("request-after-disable");
    const secondTask = second.json() as { taskId: string };
    await vi.waitFor(() => expect(
      db.prepare("SELECT status, error FROM integration_tasks WHERE id = ?").get(secondTask.taskId)
    ).toEqual({ status: "failed", error: "agent_disabled" }));

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(runtime.startTurn).toHaveBeenCalledTimes(1);
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
    const endpoint = created.json() as { endpoint: { id: string; slug: string }; token: string };
    const taskUrl = `/integration/v1/endpoints/${endpoint.endpoint.slug}/tasks`;
    const first = await app.inject({
      method: "POST",
      url: taskUrl,
      headers: endpointHeaders(endpoint.token),
      payload: { requestId: "request-1", conversationKey: "ticket-1332", message: "first", parameters: {} }
    });
    const firstTask = first.json() as { sessionId: string };
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
    const task = createdTask.json() as { taskId: string };

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
    const secondId = (second.json() as { endpoint: { id: string } }).endpoint.id;
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
    const endpoint = created.json() as { endpoint: { id: string; slug: string }; token: string };
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
        workspaceTemplate: "/unused/template",
        sessionsRoot: "/unused/sessions",
        maxConcurrentRuns: 1
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
        workspaceTemplate: "/unused/template",
        sessionsRoot: "/unused/sessions",
        maxConcurrentRuns: 1
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
