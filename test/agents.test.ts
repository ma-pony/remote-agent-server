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
  doctor: async (provider: "claude_code" | "codex" | "hermes", _agentId: string): Promise<RuntimeDoctor> => ({
    ok: true,
    message: `${provider} ready`,
    details: ["Fake Runtime"]
  }),
  shutdown: async (): Promise<void> => undefined
});

const apps: Array<{ app: FastifyInstance; close: () => Promise<void> }> = [];

const createTestApp = async (): Promise<{ app: FastifyInstance; dataDir: string }> => {
  const { db } = createTestDatabase();
  const dataDir = mkdtempSync(join(tmpdir(), "remote-agent-server-"));
  const app = buildApp({
    config: {
      host: "127.0.0.1",
      port: 3000,
      apiToken,
      dataDir,
      databasePath: ":memory:",
      workspaceTemplate: "/unused/template",
      sessionsRoot: "/unused/sessions",
      maxConcurrentRuns: 4
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
  return { app, dataDir };
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map(({ close }) => close()));
});

describe("Agent API", () => {
  it("只接受经过鉴权的明确 Provider Agent", async () => {
    const { app, dataDir } = await createTestApp();

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
      payload: { name: "Codex 开发", provider: "codex" }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ name: "Codex 开发", provider: "codex", enabled: true });

    const agent = response.json() as { id: string };
    const agentDir = join(dataDir, "agents", agent.id);
    expect(existsSync(join(agentDir, "skills"))).toBe(true);
    expect(readFileSync(join(agentDir, "MEMORY.md"), "utf8")).toBe("");
    expect(existsSync(join(agentDir, "provider-home", "hermes"))).toBe(true);
  });

  it("对不同长度 Token 使用固定长度的安全比较", () => {
    expect(constantTimeTokenEqual(apiToken, apiToken)).toBe(true);
    expect(constantTimeTokenEqual(apiToken, "short")).toBe(false);
    expect(constantTimeTokenEqual(apiToken, "a token much longer than the configured token")).toBe(false);
  });

  it("拒绝未知 Provider 和空白名称", async () => {
    const { app } = await createTestApp();

    const invalidProvider = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeaders(),
      payload: { name: "Unknown", provider: "other" }
    });
    const emptyName = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeaders(),
      payload: { name: "   ", provider: "codex" }
    });

    expect(invalidProvider.statusCode).toBe(400);
    expect(emptyName.statusCode).toBe(400);
  });

  it("可以启用和停用 Agent", async () => {
    const { app } = await createTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeaders(),
      payload: { name: "Hermes", provider: "hermes" }
    });
    const { id } = created.json() as { id: string };

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

  it("通过注入 Runtime 返回 Agent doctor 结果", async () => {
    const { app } = await createTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeaders(),
      payload: { name: "Claude", provider: "claude_code" }
    });
    const { id } = created.json() as { id: string };

    const response = await app.inject({
      method: "GET",
      url: `/api/agents/${id}/doctor`,
      headers: authHeaders()
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, message: "claude_code ready", details: ["Fake Runtime"] });
  });

  it("健康检查不需要鉴权", async () => {
    const { app } = await createTestApp();

    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });
});
