import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { IntegrationEndpointManager, IntegrationEndpointManagerError } from "../src/integrations/integration-endpoint-manager.js";
import { IntegrationStore } from "../src/integrations/integration-store.js";
import { SecretStore } from "../src/mcp/secret-store.js";
import { createTestDatabase } from "./helpers.js";

const temporaryDirectories: string[] = [];

const createHarness = () => {
  const { db, seed } = createTestDatabase();
  const dataDir = mkdtempSync(join(tmpdir(), "remote-agent-integration-"));
  temporaryDirectories.push(dataDir);
  const store = new IntegrationStore({ db });
  const manager = new IntegrationEndpointManager({ db, store, secrets: SecretStore.open({ dataDir }) });
  return { db, seed, dataDir, manager, store };
};

const validEndpointInput = (agentId: string) => ({
  name: "Grab Manager",
  slug: "grab-manager-ticket",
  agentId,
  enabled: false,
  promptPrefix: "处理外部工单",
  parameterMappings: []
});

const endpointInputWithFixedSecret = (agentId: string, value: string) => ({
  ...validEndpointInput(agentId),
  parameterMappings: [{ parameterKey: "api_token", source: "fixed" as const, value }]
});

const databaseDump = (db: ReturnType<typeof createTestDatabase>["db"]): string => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  return tables.map(({ name }) => JSON.stringify(db.prepare(`SELECT * FROM ${name}`).all())).join("\n");
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Integration endpoint domain", () => {
  it("只在创建和轮换时返回端点 Token", () => {
    const { db, seed, manager } = createHarness();
    const created = manager.create(validEndpointInput(seed.agent.id));

    expect(created.token).toMatch(/^ras_/);
    expect(JSON.stringify(manager.get(created.endpoint.id))).not.toContain(created.token);
    expect(manager.authenticate(created.endpoint.slug, created.token)).toMatchObject({ id: created.endpoint.id });

    const rotated = manager.rotateToken(created.endpoint.id);
    expect(manager.authenticate(created.endpoint.slug, created.token)).toBeUndefined();
    expect(manager.authenticate(created.endpoint.slug, rotated.token)).toMatchObject({ id: created.endpoint.id });
    db.close();
  });

  it("固定敏感值加密且 API 领域对象只返回 configured", () => {
    const { db, seed, manager } = createHarness();
    db.prepare(`
      INSERT INTO agent_session_parameters (id, agent_id, key, label, description, required, secret, created_at, updated_at)
      VALUES ('parameter-api', ?, 'api_token', 'Token', NULL, 0, 1, ?, ?)
    `).run(seed.agent.id, "2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z");
    const created = manager.create(endpointInputWithFixedSecret(seed.agent.id, "secret-value"));

    expect(JSON.stringify(created.endpoint)).not.toContain("secret-value");
    expect(created.endpoint.parameterMappings[0]).toMatchObject({ source: "fixed", configured: true });
    expect(databaseDump(db)).not.toContain("secret-value");
    db.close();
  });

  it("required 固定参数拒绝空白值，详情仅将真实固定值标为 configured", () => {
    const { db, seed, dataDir, manager } = createHarness();
    db.prepare(`
      INSERT INTO agent_session_parameters (id, agent_id, key, label, description, required, secret, created_at, updated_at)
      VALUES ('parameter-api', ?, 'api_token', 'Token', NULL, 1, 1, ?, ?)
    `).run(seed.agent.id, "2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z");

    expect(() => manager.create({
      ...endpointInputWithFixedSecret(seed.agent.id, "   "),
      enabled: true
    })).toThrowError(new IntegrationEndpointManagerError("invalid_endpoint"));

    const created = manager.create({
      ...endpointInputWithFixedSecret(seed.agent.id, "configured-secret"),
      enabled: true
    });
    expect(() => manager.update(created.endpoint.id, {
      parameterMappings: [{ parameterKey: "api_token", source: "fixed", value: "" }]
    })).toThrowError(new IntegrationEndpointManagerError("invalid_endpoint"));

    db.prepare("UPDATE integration_endpoints SET encrypted_fixed_values = ? WHERE id = ?")
      .run(SecretStore.open({ dataDir }).encrypt(JSON.stringify({ api_token: "" })), created.endpoint.id);
    expect(manager.get(created.endpoint.id)?.parameterMappings).toEqual([
      { parameterKey: "api_token", source: "fixed", configured: false }
    ]);
    db.prepare("UPDATE integration_endpoints SET encrypted_fixed_values = ? WHERE id = ?")
      .run(SecretStore.open({ dataDir }).encrypt(JSON.stringify({})), created.endpoint.id);
    expect(manager.get(created.endpoint.id)?.parameterMappings).toEqual([
      { parameterKey: "api_token", source: "fixed", configured: false }
    ]);
    db.close();
  });

  it("启用端点要求覆盖 Agent 的必填参数，并解析请求和固定值", () => {
    const { db, seed, manager } = createHarness();
    db.prepare(`
      INSERT INTO agent_session_parameters (id, agent_id, key, label, description, required, secret, created_at, updated_at)
      VALUES ('parameter-ticket', ?, 'ticket_id', 'Ticket', NULL, 1, 0, ?, ?),
             ('parameter-token', ?, 'api_token', 'Token', NULL, 1, 1, ?, ?)
    `).run(seed.agent.id, "2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z", seed.agent.id, "2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z");

    expect(() => manager.create({
      ...validEndpointInput(seed.agent.id),
      enabled: true,
      parameterMappings: [{ parameterKey: "ticket_id", source: "request", requestKey: "ticket" }]
    })).toThrowError(new IntegrationEndpointManagerError("invalid_endpoint"));

    const created = manager.create({
      ...validEndpointInput(seed.agent.id),
      enabled: true,
      parameterMappings: [
        { parameterKey: "ticket_id", source: "request", requestKey: "ticket" },
        { parameterKey: "api_token", source: "fixed", value: "secret-token" }
      ]
    });

    expect(manager.resolveRequest(created.endpoint.id, { ticket: "1332" })).toEqual({
      ticket_id: "1332",
      api_token: "secret-token"
    });
    expect(() => manager.resolveRequest(created.endpoint.id, { ticket: "1332", ignored: "x" }))
      .toThrowError(new IntegrationEndpointManagerError("unknown_request_parameter"));
    db.close();
  });

  it("required 请求参数将空白视为缺失", () => {
    const { db, seed, manager } = createHarness();
    db.prepare(`
      INSERT INTO agent_session_parameters (id, agent_id, key, label, description, required, secret, created_at, updated_at)
      VALUES ('parameter-ticket', ?, 'ticket_id', 'Ticket', NULL, 1, 0, ?, ?)
    `).run(seed.agent.id, "2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z");
    const created = manager.create({
      ...validEndpointInput(seed.agent.id),
      enabled: true,
      parameterMappings: [{ parameterKey: "ticket_id", source: "request", requestKey: "ticket" }]
    });

    expect(() => manager.resolveRequest(created.endpoint.id, { ticket: "  \t" }))
      .toThrowError(new IntegrationEndpointManagerError("missing_request_parameter"));
    db.close();
  });

  it("拒绝重复请求 Key 和不存在的目标参数", () => {
    const { db, seed, manager } = createHarness();
    db.prepare(`
      INSERT INTO agent_session_parameters (id, agent_id, key, label, description, required, secret, created_at, updated_at)
      VALUES ('parameter-ticket', ?, 'ticket_id', 'Ticket', NULL, 0, 0, ?, ?),
             ('parameter-api', ?, 'api_token', 'Token', NULL, 0, 1, ?, ?)
    `).run(
      seed.agent.id,
      "2026-08-13T00:00:00.000Z",
      "2026-08-13T00:00:00.000Z",
      seed.agent.id,
      "2026-08-13T00:00:00.000Z",
      "2026-08-13T00:00:00.000Z"
    );

    expect(() => manager.create({
      ...validEndpointInput(seed.agent.id),
      parameterMappings: [
        { parameterKey: "ticket_id", source: "request", requestKey: "ticket" },
        { parameterKey: "api_token", source: "request", requestKey: "ticket" }
      ]
    })).toThrowError(new IntegrationEndpointManagerError("invalid_endpoint"));
    expect(() => manager.create({
      ...validEndpointInput(seed.agent.id),
      parameterMappings: [{ parameterKey: "missing", source: "request", requestKey: "ticket" }]
    })).toThrowError(new IntegrationEndpointManagerError("invalid_endpoint"));
    db.close();
  });

  it("存在任意 Conversation 或 Task 时拒绝删除，且繁忙时不能更换 Agent", () => {
    const { db, seed, manager, store } = createHarness();
    const created = manager.create(validEndpointInput(seed.agent.id));
    const session = seed.session();
    store.createConversation({
      endpointId: created.endpoint.id,
      conversationKey: "ticket-1332",
      sessionId: session.id
    });

    expect(() => manager.delete(created.endpoint.id)).toThrowError(new IntegrationEndpointManagerError("endpoint_in_use"));

    const secondAgentId = "agent-second";
    db.prepare(`
      INSERT INTO agents (id, name, provider, project_environment_id, created_at, updated_at)
      VALUES (?, 'Second agent', 'codex', ?, ?, ?)
    `).run(secondAgentId, seed.projectEnvironment.id, "2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z");
    expect(() => manager.update(created.endpoint.id, { agentId: secondAgentId }))
      .toThrowError(new IntegrationEndpointManagerError("conversation_busy"));
    db.close();
  });

  it("Endpoint 有 Webhook Subscription 时拒绝删除", () => {
    const { db, seed, manager, store } = createHarness();
    const endpoint = manager.create(validEndpointInput(seed.agent.id)).endpoint;
    store.createSubscription({
      endpointId: endpoint.id,
      name: "callback",
      url: "https://example.test/webhook",
      enabled: true,
      eventsJson: "[]",
      encryptedHeaders: null,
      encryptedSigningSecret: "encrypted-secret",
      timeoutSeconds: 10
    });

    expect(() => manager.delete(endpoint.id)).toThrowError(new IntegrationEndpointManagerError("endpoint_in_use"));
    db.close();
  });

  it("每次解析都拒绝失效映射和新增未覆盖的 required 参数", () => {
    const { db, seed, manager } = createHarness();
    db.prepare(`
      INSERT INTO agent_session_parameters (id, agent_id, key, label, description, required, secret, created_at, updated_at)
      VALUES ('parameter-ticket', ?, 'ticket_id', 'Ticket', NULL, 1, 0, ?, ?)
    `).run(seed.agent.id, "2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z");
    const created = manager.create({
      ...validEndpointInput(seed.agent.id),
      enabled: true,
      parameterMappings: [{ parameterKey: "ticket_id", source: "request", requestKey: "ticket" }]
    });

    db.prepare(`
      INSERT INTO agent_session_parameters (id, agent_id, key, label, description, required, secret, created_at, updated_at)
      VALUES ('parameter-new', ?, 'new_required', 'New', NULL, 1, 0, ?, ?)
    `).run(seed.agent.id, "2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z");
    expect(() => manager.resolveRequest(created.endpoint.id, { ticket: "1332" }))
      .toThrowError("invalid_parameter_mapping");

    db.prepare("DELETE FROM agent_session_parameters WHERE id = 'parameter-new'").run();
    db.prepare("DELETE FROM agent_session_parameters WHERE id = 'parameter-ticket'").run();
    expect(() => manager.resolveRequest(created.endpoint.id, { ticket: "1332" }))
      .toThrowError("invalid_parameter_mapping");
    db.close();
  });

  it("仅保存 SHA-256 hex Token hash", () => {
    const { db, seed, manager } = createHarness();
    const created = manager.create(validEndpointInput(seed.agent.id));
    const row = db.prepare("SELECT token_hash FROM integration_endpoints WHERE id = ?")
      .get(created.endpoint.id) as { token_hash: string };

    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token_hash).not.toContain(created.token);
    db.close();
  });

  it("在调用方事务内写入 Task，不自行开启嵌套事务", () => {
    const { db, seed, manager, store } = createHarness();
    const endpoint = manager.create(validEndpointInput(seed.agent.id)).endpoint;
    const session = seed.session();

    db.exec("BEGIN IMMEDIATE");
    try {
      store.createTaskInTransaction({
        endpointId: endpoint.id,
        conversationId: null,
        sessionId: session.id,
        requestId: "event-1",
        requestFingerprint: createHash("sha256").update("event-1").digest("hex"),
        message: "处理工单",
        effectivePrompt: "处理工单",
        encryptedParameters: null
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    expect(store.listTasks(endpoint.id)).toHaveLength(1);
    db.close();
  });
});
