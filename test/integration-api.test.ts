import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createFakeRuntime, createTestDatabase } from "./helpers.js";

const apiToken = "integration-admin-token";

const authHeaders = (): Record<string, string> => ({ authorization: `Bearer ${apiToken}` });
const endpointHeaders = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
const validEndpointInput = (agentId: string, slug = "support-bot") => ({
  name: "Support Bot",
  slug,
  agentId,
  enabled: true,
  promptPrefix: "Resolve the support request.",
  parameterMappings: []
});

const apps: Array<{ app: FastifyInstance; close: () => Promise<void> }> = [];

const createTestApp = async (): Promise<{ app: FastifyInstance; agentId: string }> => {
  const { db, seed } = createTestDatabase();
  const dataDir = mkdtempSync(join(tmpdir(), "remote-agent-integration-api-"));
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
    runtime: createFakeRuntime()
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
  return { app, agentId: seed.agent.id };
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
    expect(validEndpointToken.statusCode).toBe(404);
    expect(validEndpointToken.json()).toEqual({
      error: { code: "not_found", message: "Integration route not found" }
    });
    expect(validSecondEndpointToken.statusCode).toBe(404);
    expect(validSecondEndpointToken.json()).toEqual({
      error: { code: "not_found", message: "Integration route not found" }
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
    expect(stillAuthorized.statusCode).toBe(404);
    expect(stillAuthorized.json()).toEqual({
      error: { code: "not_found", message: "Integration route not found" }
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
