import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { SdkMcpChecker } from "../src/mcp/mcp-checker.js";
import type { RuntimeMcpServer } from "../src/mcp/mcp-types.js";
import { createFakeRuntime, createTestDatabase } from "./helpers.js";

const apiToken = "test-token";
const authHeaders = (): Record<string, string> => ({ authorization: `Bearer ${apiToken}` });

const apps: Array<() => Promise<void>> = [];

const createTestApp = async () => {
  const { db } = createTestDatabase();
  const agentId = (db.prepare("SELECT id FROM agents LIMIT 1").get() as { id: string }).id;
  const dataDir = mkdtempSync(join(tmpdir(), "remote-agent-mcp-api-"));
  const check = vi.fn(async () => ({
    status: "passed" as const,
    toolCount: 2,
    message: "2 tools available",
    tools: [{ name: "ticket_get", description: "读取工单" }, { name: "ticket_pause", description: null }]
  }));
  const app = buildApp({
    config: {
      host: "127.0.0.1",
      port: 3000,
      apiToken,
      dataDir,
      databasePath: ":memory:",
      projectEnvironmentsRoot: "/unused/environments",
      sessionsRoot: "/unused/sessions",
      maxConcurrentRuns: 4,
      projectEnvironmentCheckIntervalMs: 3 * 60 * 60 * 1000,
      projectPrepareTimeoutMs: 30 * 60 * 1000
    },
    db,
    runtime: createFakeRuntime(),
    mcpChecker: { check }
  });
  apps.push(async () => {
    await app.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  await app.ready();
  return { app, agentId, db, check };
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((close) => close()));
});

describe("Agent MCP API", () => {
  it("支持只删除当前 Agent 的 MCP 副本或删除整个共享组", async () => {
    const { app, agentId } = await createTestApp();
    const target = await app.inject({
      method: "POST", url: "/api/agents", headers: authHeaders(),
      payload: { name: "Target", provider: "codex", projectEnvironmentId: 1 }
    });
    const targetAgentId = (target.json() as { id: number }).id;
    const created = await app.inject({
      method: "POST", url: `/api/agents/${agentId}/mcp-servers`, headers: authHeaders(),
      payload: {
        name: "shared_mcp", transport: "http", enabled: true,
        url: "https://example.test/mcp", checkTimeoutSeconds: 20, headers: []
      }
    });
    const sourceId = (created.json() as { id: number }).id;
    const installed = await app.inject({
      method: "POST", url: `/api/agents/${targetAgentId}/mcp-catalog/${sourceId}/install`, headers: authHeaders()
    });
    const installedId = (installed.json() as { id: number }).id;

    const currentOnly = await app.inject({
      method: "DELETE",
      url: `/api/agents/${targetAgentId}/mcp-servers/${installedId}?scope=current`,
      headers: authHeaders()
    });
    expect(currentOnly.statusCode).toBe(204);
    expect((await app.inject({
      method: "GET", url: `/api/agents/${agentId}/mcp-servers`, headers: authHeaders()
    })).json()).toEqual([expect.objectContaining({ id: sourceId })]);

    const reinstalled = await app.inject({
      method: "POST", url: `/api/agents/${targetAgentId}/mcp-catalog/${sourceId}/install`, headers: authHeaders()
    });
    const deleteAll = await app.inject({
      method: "DELETE",
      url: `/api/agents/${targetAgentId}/mcp-servers/${(reinstalled.json() as { id: number }).id}?scope=all`,
      headers: authHeaders()
    });
    expect(deleteAll.statusCode).toBe(204);
    expect((await app.inject({
      method: "GET", url: `/api/agents/${agentId}/mcp-servers`, headers: authHeaders()
    })).json()).toEqual([]);
    expect((await app.inject({
      method: "GET", url: `/api/agents/${targetAgentId}/mcp-servers`, headers: authHeaders()
    })).json()).toEqual([]);
  });

  it("列出其他 Agent 共享的 MCP，并复制配置、敏感值和会话参数定义", async () => {
    const { app, agentId, db } = await createTestApp();
    const target = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeaders(),
      payload: { name: "Target", provider: "codex", projectEnvironmentId: 1 }
    });
    const targetAgentId = (target.json() as { id: number }).id;
    await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/session-parameters`,
      headers: authHeaders(),
      payload: {
        key: "tenant_token", label: "租户令牌", description: "每个会话单独填写",
        required: true, secret: true
      }
    });
    const created = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/mcp-servers`,
      headers: authHeaders(),
      payload: {
        name: "shared_mcp", transport: "http", enabled: true,
        url: "https://example.test/mcp", checkTimeoutSeconds: 20,
        headers: [
          { name: "Authorization", source: "fixed", value: "Bearer shared-secret", secret: true },
          { name: "X-Tenant", source: "session_parameter", parameterKey: "tenant_token" }
        ]
      }
    });
    const sourceServerId = (created.json() as { id: number }).id;

    const catalog = await app.inject({
      method: "GET",
      url: `/api/agents/${targetAgentId}/mcp-catalog`,
      headers: authHeaders()
    });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json()).toEqual([
      expect.objectContaining({ id: sourceServerId, name: "shared_mcp", sourceAgentName: "Test agent" })
    ]);
    expect(JSON.stringify(catalog.json())).not.toContain("shared-secret");

    const installed = await app.inject({
      method: "POST",
      url: `/api/agents/${targetAgentId}/mcp-catalog/${sourceServerId}/install`,
      headers: authHeaders()
    });
    expect(installed.statusCode).toBe(201);
    expect(installed.json()).toMatchObject({ agentId: targetAgentId, name: "shared_mcp", enabled: true });
    expect(JSON.stringify(installed.json())).not.toContain("shared-secret");

    const disabled = await app.inject({
      method: "PATCH",
      url: `/api/agents/${targetAgentId}/mcp-servers/${(installed.json() as { id: number }).id}/enabled`,
      headers: authHeaders(),
      payload: { enabled: false }
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ enabled: false });

    const targetParameters = await app.inject({
      method: "GET",
      url: `/api/agents/${targetAgentId}/session-parameters`,
      headers: authHeaders()
    });
    expect(targetParameters.json()).toEqual([
      expect.objectContaining({ key: "tenant_token", label: "租户令牌", required: true, secret: true })
    ]);
    const copiedSecret = db.prepare(`
      SELECT encrypted_value FROM agent_mcp_values
      WHERE mcp_server_id = ? AND encrypted_value IS NOT NULL
    `).get((installed.json() as { id: number }).id) as { encrypted_value: string };
    expect(copiedSecret.encrypted_value).not.toContain("shared-secret");

    const catalogAfterInstall = await app.inject({
      method: "GET",
      url: `/api/agents/${targetAgentId}/mcp-catalog`,
      headers: authHeaders()
    });
    expect(catalogAfterInstall.json()).toEqual([]);
  });

  it("鉴权后完成参数与 HTTP MCP 管理，敏感值不出现在响应", async () => {
    const { app, agentId } = await createTestApp();

    const unauthorized = await app.inject({ method: "GET", url: `/api/agents/${agentId}/mcp-servers` });
    expect(unauthorized.statusCode).toBe(401);

    const parameter = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/session-parameters`,
      headers: authHeaders(),
      payload: {
        key: "tenant_token",
        label: "租户令牌",
        description: "每个 Session 的访问令牌",
        required: true,
        secret: true
      }
    });
    expect(parameter.statusCode).toBe(201);

    const created = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/mcp-servers`,
      headers: authHeaders(),
      payload: {
        name: "example_mcp",
        transport: "http",
        enabled: true,
        url: "https://example.test/mcp",
        checkTimeoutSeconds: 20,
        headers: [
          { name: "Authorization", source: "fixed", value: "Bearer secret-token", secret: true },
          { name: "X-Tenant", source: "session_parameter", parameterKey: "tenant_token" }
        ]
      }
    });
    expect(created.statusCode).toBe(201);
    expect(JSON.stringify(created.json())).not.toContain("secret-token");
    expect(created.json()).toMatchObject({
      name: "example_mcp",
      transport: "http",
      headers: [
        { name: "Authorization", source: "fixed", secret: true, configured: true },
        { name: "X-Tenant", source: "session_parameter", parameterKey: "tenant_token" }
      ]
    });

    const serverId = (created.json() as { id: string }).id;
    const listed = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}/mcp-servers`,
      headers: authHeaders()
    });
    const detail = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}/mcp-servers/${serverId}`,
      headers: authHeaders()
    });
    expect(listed.json()).toHaveLength(1);
    expect(detail.statusCode).toBe(200);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/agents/${agentId}/mcp-servers/${serverId}`,
      headers: authHeaders()
    });
    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBe("");
    expect(deleted.headers["content-type"]).toBeUndefined();
  });

  it("检查 MCP 后保存最近检查结果，并拒绝缺少 Session 的动态值", async () => {
    const { app, agentId, check } = await createTestApp();
    await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/session-parameters`,
      headers: authHeaders(),
      payload: { key: "tenant", label: "租户", description: null, required: true, secret: false }
    });
    const created = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/mcp-servers`,
      headers: authHeaders(),
      payload: {
        name: "tenant_mcp",
        transport: "http",
        enabled: true,
        url: "https://example.test/mcp",
        checkTimeoutSeconds: 3,
        headers: [{ name: "X-Tenant", source: "session_parameter", parameterKey: "tenant" }]
      }
    });
    const serverId = (created.json() as { id: string }).id;

    const missingSession = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/mcp-servers/${serverId}/check`,
      headers: authHeaders()
    });
    expect(missingSession.statusCode).toBe(400);
    expect(check).not.toHaveBeenCalled();

    const fixed = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/mcp-servers`,
      headers: authHeaders(),
      payload: {
        name: "fixed_mcp",
        transport: "http",
        enabled: true,
        url: "https://example.test/fixed",
        checkTimeoutSeconds: 3,
        headers: []
      }
    });
    const fixedId = (fixed.json() as { id: string }).id;
    const checked = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/mcp-servers/${fixedId}/check`,
      headers: authHeaders()
    });
    expect(checked.statusCode).toBe(200);
    expect(checked.json()).toEqual({
      status: "passed", toolCount: 2, message: "2 tools available",
      tools: [{ name: "ticket_get", description: "读取工单" }, { name: "ticket_pause", description: null }]
    });
    expect(check).toHaveBeenCalledOnce();
    expect(check.mock.calls[0]?.[1]).toBe(3000);

    const detail = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}/mcp-servers/${fixedId}`,
      headers: authHeaders()
    });
    expect(detail.json()).toMatchObject({ lastCheckStatus: "passed", lastToolCount: 2 });
  });

  it("拒绝重复参数并阻止删除正在被 MCP 使用的参数", async () => {
    const { app, agentId } = await createTestApp();
    const input = { key: "tenant", label: "租户", description: null, required: false, secret: false };
    const first = await app.inject({
      method: "POST", url: `/api/agents/${agentId}/session-parameters`, headers: authHeaders(), payload: input
    });
    const duplicate = await app.inject({
      method: "POST", url: `/api/agents/${agentId}/session-parameters`, headers: authHeaders(), payload: input
    });
    expect(first.statusCode).toBe(201);
    expect(duplicate.statusCode).toBe(409);

    await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/mcp-servers`,
      headers: authHeaders(),
      payload: {
        name: "tenant_mcp",
        transport: "http",
        enabled: true,
        url: "https://example.test/mcp",
        checkTimeoutSeconds: 30,
        headers: [{ name: "X-Tenant", source: "session_parameter", parameterKey: "tenant" }]
      }
    });
    const parameterId = (first.json() as { id: string }).id;
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/agents/${agentId}/session-parameters/${parameterId}`,
      headers: authHeaders()
    });
    expect(deleted.statusCode).toBe(409);
    expect(deleted.json()).toMatchObject({ error: { code: "mcp_parameter_in_use" } });
  });
});

describe("SdkMcpChecker", () => {
  it.each([
    { type: "http", name: "http", url: "https://example.test/mcp", headers: [] },
    { type: "stdio", name: "stdio", command: "/usr/bin/true", args: [], env: [] }
  ] satisfies RuntimeMcpServer[])("检查 $type MCP 并始终关闭 Client", async (server) => {
    const connect = vi.fn(async () => undefined);
    const listTools = vi.fn(async () => ({
      tools: [{ name: "a", description: "Tool A" }, { name: "b" }]
    }));
    const close = vi.fn(async () => undefined);
    const createTransport = vi.fn(() => ({ marker: server.type }));
    const checker = new SdkMcpChecker({
      createClient: () => ({ connect, listTools, close }),
      createTransport
    });

    await expect(checker.check(server, 3000)).resolves.toEqual({
      status: "passed", toolCount: 2, message: "2 tools available",
      tools: [{ name: "a", description: "Tool A" }, { name: "b", description: null }]
    });
    expect(connect).toHaveBeenCalledOnce();
    expect(listTools).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(createTransport).toHaveBeenCalledWith(server);
  });

  it("检查失败只返回固定脱敏错误并关闭 Client", async () => {
    const close = vi.fn(async () => undefined);
    const checker = new SdkMcpChecker({
      createClient: () => ({
        connect: vi.fn(async () => { throw new Error("Authorization: Bearer secret-token"); }),
        listTools: vi.fn(async () => ({ tools: [] })),
        close
      }),
      createTransport: () => ({})
    });
    const server: RuntimeMcpServer = {
      type: "http",
      name: "private_mcp",
      url: "https://example.test/mcp?token=secret-token",
      headers: [{ name: "Authorization", value: "Bearer secret-token" }]
    };

    const result = await checker.check(server, 10);
    expect(result).toEqual({
      status: "failed", code: "mcp_check_failed", message: "MCP private_mcp check failed"
    });
    expect(JSON.stringify(result)).not.toMatch(/secret-token|Authorization/i);
    expect(close).toHaveBeenCalledOnce();
  });
});
