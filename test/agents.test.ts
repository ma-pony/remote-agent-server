import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { constantTimeTokenEqual } from "../src/auth.js";
import type { AgentRuntime, RuntimeDoctor, RuntimeSession, RuntimeSessionInput, RuntimeTurn, RuntimeTurnInput } from "../src/runtime/agent-runtime.js";
import { createTestDatabase } from "./helpers.js";

const apiToken = "test-token";

const authHeaders = (): Record<string, string> => ({ authorization: `Bearer ${apiToken}` });

const createFakeRuntime = (): AgentRuntime => ({
  ensureSession: async (_input: RuntimeSessionInput): Promise<RuntimeSession> => ({ providerSessionId: null }),
  startTurn: (_input: RuntimeTurnInput): RuntimeTurn => {
    throw new Error("Fake Runtime does not start turns in Agent API tests");
  },
  cancel: async (_sessionId: string): Promise<void> => undefined,
  reset: async (_input: RuntimeSessionInput): Promise<void> => undefined,
  forgetSession: async (_sessionId: number): Promise<void> => undefined,
  doctor: async (provider: "claude_code" | "codex" | "hermes", _agentId: string): Promise<RuntimeDoctor> => ({
    ok: true,
    message: `${provider} ready`,
    details: ["Fake Runtime"]
  }),
  shutdown: async (): Promise<void> => undefined
});

const apps: Array<{ app: FastifyInstance; close: () => Promise<void> }> = [];

const createTestApp = async (): Promise<{
  app: FastifyInstance;
  dataDir: string;
  db: ReturnType<typeof createTestDatabase>["db"];
  projectEnvironmentId: string;
}> => {
  const { db, seed } = createTestDatabase();
  const dataDir = mkdtempSync(join(tmpdir(), "remote-agent-server-"));
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
  return { app, dataDir, db, projectEnvironmentId: seed.projectEnvironment.id };
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map(({ close }) => close()));
});

describe("Agent API", () => {
  it("按 ID 返回 Agent 详情，并对不存在的 Agent 返回 404", async () => {
    const { app, projectEnvironmentId } = await createTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeaders(),
      payload: { name: "Codex Detail", provider: "codex", projectEnvironmentId }
    });
    const agent = created.json() as { id: number };

    const detail = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}`,
      headers: authHeaders()
    });
    const missing = await app.inject({
      method: "GET",
      url: "/api/agents/999999",
      headers: authHeaders()
    });

    expect(detail.statusCode).toBe(200);
    expect(agent.id).toEqual(expect.any(Number));
    expect(detail.json()).toMatchObject({ id: agent.id, name: "Codex Detail", provider: "codex" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: { code: "not_found", message: "Agent not found" } });
  });

  it("只接受经过鉴权的明确 Provider Agent", async () => {
    const { app, dataDir, projectEnvironmentId } = await createTestApp();

    const unauthorized = await app.inject({ method: "GET", url: "/api/agents" });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json()).toEqual({ error: { code: "unauthorized", message: "Invalid API token" } });

    const wrongLengthToken = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer short" }
    });
    expect(wrongLengthToken.statusCode).toBe(401);
    expect(wrongLengthToken.json()).toEqual({ error: { code: "unauthorized", message: "Invalid API token" } });

    const response = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeaders(),
      payload: { name: "Codex 开发", provider: "codex", projectEnvironmentId }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      name: "Codex 开发", provider: "codex", enabled: true, projectEnvironmentId
    });

    const missingEnvironment = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeaders(),
      payload: { name: "Missing environment", provider: "codex" }
    });
    expect(missingEnvironment.statusCode).toBe(400);

    const agent = response.json() as { id: number };
    const agentDir = join(dataDir, "agents", String(agent.id));
    expect(existsSync(join(agentDir, "skills"))).toBe(true);
    expect(readFileSync(join(agentDir, "MEMORY.md"), "utf8")).toBe("");
    for (const providerHome of ["claude", "codex", "hermes"]) {
      expect(existsSync(join(agentDir, "provider-home", providerHome))).toBe(true);
    }
  });

  it("对不同长度 Token 使用固定长度的安全比较", () => {
    expect(constantTimeTokenEqual(apiToken, apiToken)).toBe(true);
    expect(constantTimeTokenEqual(apiToken, "short")).toBe(false);
    expect(constantTimeTokenEqual(apiToken, "a token much longer than the configured token")).toBe(false);
  });

  it("拒绝未知 Provider 和空白名称", async () => {
    const { app, projectEnvironmentId } = await createTestApp();

    const invalidProvider = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeaders(),
      payload: { name: "Unknown", provider: "other", projectEnvironmentId }
    });
    const emptyName = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeaders(),
      payload: { name: "   ", provider: "codex", projectEnvironmentId }
    });

    expect(invalidProvider.statusCode).toBe(400);
    expect(emptyName.statusCode).toBe(400);
  });

  it("可以启用和停用 Agent", async () => {
    const { app, projectEnvironmentId } = await createTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeaders(),
      payload: { name: "Hermes", provider: "hermes", projectEnvironmentId }
    });
    const { id } = created.json() as { id: number };

    const disabled = await app.inject({
      method: "PATCH",
      url: `/api/agents/${id}`,
      headers: authHeaders(),
      payload: { enabled: false }
    });
    const enabled = await app.inject({
      method: "PATCH",
      url: `/api/agents/${id}`,
      headers: authHeaders(),
      payload: { enabled: true }
    });

    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ id, enabled: false });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({ id, enabled: true });
  });

  it("可以修改名称和项目环境，但不能修改 Provider", async () => {
    const { app, db, projectEnvironmentId } = await createTestApp();
    const timestamp = "2026-08-13T00:00:00.000Z";
    const secondEnvironmentId = Number(db.prepare(
      "INSERT INTO project_environments (name, created_at, updated_at) VALUES (?, ?, ?)"
    ).run("Second environment", timestamp, timestamp).lastInsertRowid);
    const secondRevisionId = Number(db.prepare(`
      INSERT INTO project_environment_revisions
        (project_environment_id, status, workspace_path, input_fingerprint, created_at, finished_at)
      VALUES (?, 'ready', ?, ?, ?, ?)
    `).run(secondEnvironmentId, "/tmp/second/workspace", "second-input", timestamp, timestamp).lastInsertRowid);
    db.prepare("UPDATE project_environments SET current_revision_id = ? WHERE id = ?")
      .run(secondRevisionId, secondEnvironmentId);
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeaders(),
      payload: { name: "Codex", provider: "codex", projectEnvironmentId }
    });
    const { id } = created.json() as { id: number };

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/agents/${id}`,
      headers: authHeaders(),
      payload: { name: "Codex Review", projectEnvironmentId: secondEnvironmentId }
    });
    const providerChange = await app.inject({
      method: "PATCH",
      url: `/api/agents/${id}`,
      headers: authHeaders(),
      payload: { provider: "hermes" }
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      id,
      name: "Codex Review",
      provider: "codex",
      projectEnvironmentId: secondEnvironmentId
    });
    expect(providerChange.statusCode).toBe(400);
  });

  it("创建和修改支持的 Agent 指令，并拒绝 Hermes 的无效指令", async () => {
    const { app, db, projectEnvironmentId } = await createTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeaders(),
      payload: {
        name: "Codex Reviewer",
        provider: "codex",
        projectEnvironmentId,
        instructions: "只报告有证据的问题。"
      }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ instructions: "只报告有证据的问题。" });
    const { id } = created.json() as { id: number };

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/agents/${id}`,
      headers: authHeaders(),
      payload: { instructions: "先验证，再给出结论。" }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ instructions: "先验证，再给出结论。" });
    expect(db.prepare("SELECT instructions FROM agents WHERE id = ?").get(id)).toEqual({
      instructions: "先验证，再给出结论。"
    });

    const hermes = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeaders(),
      payload: {
        name: "Hermes",
        provider: "hermes",
        projectEnvironmentId,
        instructions: "该内容不会被 Hermes ACP 执行"
      }
    });
    expect(hermes.statusCode).toBe(400);
    expect(hermes.json()).toEqual({
      error: {
        code: "agent_instructions_unsupported",
        message: "Hermes 当前不支持智能体指令"
      }
    });
    expect(db.prepare("SELECT count(*) AS count FROM agents WHERE provider = 'hermes'").get()).toEqual({ count: 0 });
  });

  it("只删除没有 Session 的 Agent，并清理其专属目录", async () => {
    const { app, dataDir, projectEnvironmentId } = await createTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeaders(),
      payload: { name: "Disposable", provider: "codex", projectEnvironmentId }
    });
    const { id } = created.json() as { id: number };
    const agentDirectory = join(dataDir, "agents", String(id));

    const deleted = await app.inject({ method: "DELETE", url: `/api/agents/${id}`, headers: authHeaders() });
    const missing = await app.inject({ method: "DELETE", url: `/api/agents/${id}`, headers: authHeaders() });

    expect(deleted.statusCode).toBe(204);
    expect(missing.statusCode).toBe(404);
    expect(existsSync(agentDirectory)).toBe(false);
  });

  it("已有 Session 的 Agent 删除时返回明确冲突且保留数据", async () => {
    const { app, db, projectEnvironmentId } = await createTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeaders(),
      payload: { name: "In use", provider: "hermes", projectEnvironmentId }
    });
    const { id } = created.json() as { id: number };
    const timestamp = "2026-08-13T00:00:00.000Z";
    db.prepare(`
      INSERT INTO sessions (agent_id, title, status, workspace_path, created_at, updated_at)
      VALUES (?, ?, 'idle', ?, ?, ?)
    `).run(id, "History", "/tmp/session-with-agent", timestamp, timestamp);

    const response = await app.inject({ method: "DELETE", url: `/api/agents/${id}`, headers: authHeaders() });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: "agent_has_sessions",
        message: "Agent has Sessions and cannot be deleted; disable it instead"
      }
    });
    expect(db.prepare("SELECT id FROM agents WHERE id = ?").get(id)).toEqual({ id });
  });

  it("已有 Integration Endpoint 的 Agent 删除时返回明确冲突且保留数据", async () => {
    const { app, db, projectEnvironmentId } = await createTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeaders(),
      payload: { name: "Integration owner", provider: "codex", projectEnvironmentId }
    });
    const { id } = created.json() as { id: number };
    const timestamp = "2026-08-13T00:00:00.000Z";
    db.prepare(`
      INSERT INTO integration_endpoints
        (name, slug, agent_id, enabled, token_hash, prompt_prefix, parameter_mappings_json, encrypted_fixed_values, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, '', '[]', NULL, ?, ?)
    `).run("Integration", "integration-owner", id, "a".repeat(64), timestamp, timestamp);

    const response = await app.inject({ method: "DELETE", url: `/api/agents/${id}`, headers: authHeaders() });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: "agent_has_integration_endpoints",
        message: "Agent has Integration Endpoints and cannot be deleted; delete or reassign them first"
      }
    });
    expect(db.prepare("SELECT id FROM agents WHERE id = ?").get(id)).toEqual({ id });
  });

  it("通过注入 Runtime 返回 Agent doctor 结果", async () => {
    const { app, projectEnvironmentId } = await createTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeaders(),
      payload: { name: "Claude", provider: "claude_code", projectEnvironmentId }
    });
    const { id } = created.json() as { id: number };

    const response = await app.inject({
      method: "GET",
      url: `/api/agents/${id}/doctor`,
      headers: authHeaders()
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      provider: { ok: true, message: "claude_code ready", details: ["Fake Runtime"] },
      projectEnvironment: {
        ok: true,
        message: "Project environment is ready",
        revisionId: expect.any(Number)
      }
    });
  });

  it("返回 Agent 所有 Session 的累计 Token 汇总", async () => {
    const { app, db, projectEnvironmentId } = await createTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeaders(),
      payload: { name: "Usage Agent", provider: "codex", projectEnvironmentId }
    });
    const { id: agentId } = created.json() as { id: number };
    const recent = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO sessions (
        agent_id, title, status, workspace_path, input_tokens, output_tokens,
        cached_read_tokens, thought_tokens, total_tokens, created_at, updated_at
      ) VALUES (?, ?, 'idle', ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(agentId, "Usage", "/tmp/usage-session", 100, 20, 30, 5, 120, recent, recent);
    insert.run(agentId, "Unknown", "/tmp/unknown-session", null, null, null, null, null, recent, recent);

    const response = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}/usage`,
      headers: authHeaders()
    });
    const missing = await app.inject({
      method: "GET",
      url: "/api/agents/999999/usage",
      headers: authHeaders()
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      sessionCount: 2,
      measuredSessionCount: 1,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cachedReadTokens: 30,
        cachedWriteTokens: null,
        thoughtTokens: 5,
        totalTokens: 120
      }
    });
    expect(missing.statusCode).toBe(404);
  });

  it("健康检查不需要鉴权", async () => {
    const { app } = await createTestApp();

    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });
});
