import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { McpManager, McpManagerError } from "../src/mcp/mcp-manager.js";
import { SecretStore } from "../src/mcp/secret-store.js";
import { createTestDatabase } from "./helpers.js";

const temporaryDirectories: string[] = [];

const createHarness = () => {
  const { db, seed } = createTestDatabase();
  const dataDir = mkdtempSync(join(tmpdir(), "remote-agent-mcp-"));
  temporaryDirectories.push(dataDir);
  const manager = new McpManager({ db, secrets: SecretStore.open({ dataDir }) });
  const agent = db.prepare("SELECT id FROM agents LIMIT 1").get() as { id: string };
  return { db, seed, dataDir, manager, agentId: agent.id };
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("MCP secrets and resolution", () => {
  it("creates a 0600 key and round-trips encrypted values", () => {
    const { db, dataDir } = createHarness();
    const secrets = SecretStore.open({ dataDir });
    const encrypted = secrets.encrypt("token-123");

    expect(encrypted).not.toContain("token-123");
    expect(secrets.decrypt(encrypted)).toBe("token-123");
    expect(statSync(join(dataDir, "secret.key")).mode & 0o077).toBe(0);
    expect(readFileSync(join(dataDir, "secret.key"))).toHaveLength(32);
    db.close();
  });

  it("encrypts sensitive values and resolves each Session with its own parameters", () => {
    const { db, seed, manager, agentId } = createHarness();
    manager.createParameterDefinition(agentId, {
      key: "tenant_id",
      label: "租户",
      description: null,
      required: true,
      secret: false
    });
    manager.createParameterDefinition(agentId, {
      key: "access_token",
      label: "Token",
      description: null,
      required: true,
      secret: true
    });
    const sessionA = seed.session();
    const sessionB = seed.session();
    manager.insertSessionValuesInTransaction(sessionA.id, manager.normalizeSessionValues(agentId, {
      tenant_id: "team-a",
      access_token: "session-secret-a"
    }, true));
    manager.insertSessionValuesInTransaction(sessionB.id, manager.normalizeSessionValues(agentId, {
      tenant_id: "team-b",
      access_token: "session-secret-b"
    }, true));

    const created = manager.createServer(agentId, {
      name: "example-mcp",
      transport: "http",
      enabled: true,
      url: "https://example.test/mcp",
      checkTimeoutSeconds: 30,
      headers: [
        { name: "Authorization", source: "fixed", value: "Bearer fixed-secret", secret: true },
        { name: "X-Tenant", source: "session_parameter", parameterKey: "tenant_id" },
        { name: "X-Token", source: "session_parameter", parameterKey: "access_token" },
        { name: "X-Run", source: "runtime", runtimeKey: "run_id" }
      ]
    });

    expect(JSON.stringify(created)).not.toContain("fixed-secret");
    expect(created.headers[0]).toMatchObject({ secret: true, configured: true });
    const encryptedRows = db.prepare(
      "SELECT plain_value, encrypted_value FROM agent_mcp_values WHERE secret = 1"
    ).all() as Array<{ plain_value: string | null; encrypted_value: string | null }>;
    expect(encryptedRows).toHaveLength(1);
    expect(encryptedRows[0]?.plain_value).toBeNull();
    expect(encryptedRows[0]?.encrypted_value).not.toContain("fixed-secret");
    const sessionSecretRows = db.prepare(
      "SELECT plain_value, encrypted_value FROM session_mcp_parameter_values WHERE encrypted_value IS NOT NULL"
    ).all() as Array<{ plain_value: string | null; encrypted_value: string }>;
    expect(sessionSecretRows).toHaveLength(2);
    expect(sessionSecretRows.every(({ plain_value }) => plain_value === null)).toBe(true);

    const [resolvedA] = manager.resolveEnabledForRun({
      agentId,
      sessionId: sessionA.id,
      runId: "run-a",
      workspacePath: "/sessions/a/workspace",
      browserProfilePath: "/sessions/a/browser"
    });
    const [resolvedB] = manager.resolveEnabledForRun({
      agentId,
      sessionId: sessionB.id,
      runId: "run-b",
      workspacePath: "/sessions/b/workspace",
      browserProfilePath: "/sessions/b/browser"
    });

    expect(resolvedA?.server).toMatchObject({
      type: "http",
      headers: expect.arrayContaining([
        { name: "X-Tenant", value: "team-a" },
        { name: "X-Token", value: "session-secret-a" },
        { name: "X-Run", value: "run-a" }
      ])
    });
    expect(resolvedB?.server).toMatchObject({
      type: "http",
      headers: expect.arrayContaining([
        { name: "X-Tenant", value: "team-b" },
        { name: "X-Token", value: "session-secret-b" },
        { name: "X-Run", value: "run-b" }
      ])
    });
    db.close();
  });

  it("rejects shell commands, managed headers, and sensitive Arguments", () => {
    const { db, manager, agentId } = createHarness();
    manager.createParameterDefinition(agentId, {
      key: "access_token",
      label: "Token",
      description: null,
      required: true,
      secret: true
    });

    expect(() => manager.createServer(agentId, {
      name: "bad-command",
      transport: "stdio",
      enabled: true,
      command: "npx && bad",
      checkTimeoutSeconds: 30,
      arguments: [],
      environment: []
    })).toThrowError(new McpManagerError("invalid_mcp_server"));

    expect(() => manager.createServer(agentId, {
      name: "bad-header",
      transport: "http",
      enabled: true,
      url: "https://example.test/mcp",
      checkTimeoutSeconds: 30,
      headers: [{ name: "Content-Length", source: "fixed", value: "3", secret: false }]
    })).toThrowError(new McpManagerError("invalid_mcp_value"));

    expect(() => manager.createServer(agentId, {
      name: "bad-argument",
      transport: "stdio",
      enabled: true,
      command: "npx",
      checkTimeoutSeconds: 30,
      arguments: [{ source: "session_parameter", parameterKey: "access_token" }],
      environment: []
    })).toThrowError(new McpManagerError("invalid_mcp_value"));
    db.close();
  });
});
