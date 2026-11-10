import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type McpChecker } from "../src/mcp/mcp-checker.js";
import { McpManager } from "../src/mcp/mcp-manager.js";
import { RunMcpPreparer, RunMcpPreparationError } from "../src/mcp/run-mcp-preparer.js";
import { SecretStore } from "../src/mcp/secret-store.js";
import { createTestDatabase } from "./helpers.js";

const tempDirs: string[] = [];

const setup = (checker: McpChecker) => {
  const { db, seed } = createTestDatabase();
  const dataDir = mkdtempSync(join(tmpdir(), "remote-agent-mcp-runtime-"));
  tempDirs.push(dataDir);
  const manager = new McpManager({ db, secrets: SecretStore.open({ dataDir }) });
  const agentId = (db.prepare("SELECT id FROM agents LIMIT 1").get() as { id: string }).id;
  const session = seed.session();
  return {
    db,
    manager,
    agentId,
    sessionId: session.id,
    preparer: new RunMcpPreparer({ manager, checker })
  };
};

afterEach(() => {
  tempDirs.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

describe("RunMcpPreparer", () => {
  const cores = ["codex", "claude_code", "hermes", "deepseek_harness"] as const;
  it.each(cores.flatMap(source => cores.filter(target => target !== source).map(target => ({ source, target }))))(
    "keeps encrypted MCP settings and tool filtering across $source → $target", async ({ source, target }) => {
    const check = vi.fn(async () => ({ status: "passed" as const, toolCount: 2, message: "ready", tools: [
      { name: "ticket_get", description: "read" }, { name: "ticket_write", description: "write" }
    ] }));
    const fixture = setup({ check });
    fixture.db.prepare("UPDATE agents SET provider = ? WHERE id = ?").run(source, fixture.agentId);
    fixture.manager.createParameterDefinition(fixture.agentId, { key: "tenant", label: "Tenant", description: null, required: true, secret: false });
    fixture.manager.insertSessionValuesInTransaction(fixture.sessionId,
      fixture.manager.normalizeSessionValues(fixture.agentId, { tenant: "team-a" }, true));
    const created = fixture.manager.createServer(fixture.agentId, {
      name: "portable-mcp", transport: "http", enabled: true, url: "https://example.test/mcp", checkTimeoutSeconds: 5,
      headers: [
        { name: "Authorization", source: "fixed", value: "Bearer encrypted-secret", secret: true },
        { name: "X-Tenant", source: "session_parameter", parameterKey: "tenant" }
      ]
    });
    fixture.manager.setAllowedTools(fixture.agentId, created.id, ["ticket_get"]);
    const before = await fixture.preparer.prepare({ agentId: fixture.agentId, sessionId: fixture.sessionId, runId: 1, workspacePath: "/workspace", browserProfilePath: "/browser" });
    // A Provider switch creates/uses another runtime context but deliberately leaves Agent MCP rows untouched.
    fixture.db.prepare("UPDATE agents SET provider = ? WHERE id = ?").run(target, fixture.agentId);
    fixture.db.prepare("INSERT INTO execution_contexts (session_id, provider, created_at) VALUES (?, ?, 'now')").run(fixture.sessionId, target);
    const after = await fixture.preparer.prepare({ agentId: fixture.agentId, sessionId: fixture.sessionId, runId: 2, workspacePath: "/workspace", browserProfilePath: "/browser" });
    expect(after).toEqual(before);
    expect(check).toHaveBeenLastCalledWith(expect.objectContaining({ headers: [
      { name: "Authorization", value: "Bearer encrypted-secret" }, { name: "X-Tenant", value: "team-a" }
    ] }), 5000);
    const management = fixture.manager.listServers(fixture.agentId)[0]!;
    expect(management).not.toHaveProperty("headers.0.value", "Bearer encrypted-secret");
    fixture.db.close();
  });

  it("解析并检查所有 enabled MCP 后返回 ACP 配置", async () => {
    const check = vi.fn(async () => ({ status: "passed" as const, toolCount: 2, message: "2 tools available" }));
    const fixture = setup({ check });
    fixture.manager.createServer(fixture.agentId, {
      name: "example_mcp",
      transport: "http",
      enabled: true,
      url: "https://example.test/mcp",
      checkTimeoutSeconds: 7,
      headers: [{ name: "Authorization", source: "fixed", value: "Bearer runtime-secret", secret: true }]
    });

    const servers = await fixture.preparer.prepare({
      agentId: fixture.agentId,
      sessionId: fixture.sessionId,
      runId: 1,
      workspacePath: "/workspace",
      browserProfilePath: "/browser"
    });

    expect(check).toHaveBeenCalledWith({
      type: "http",
      name: "example_mcp",
      url: "https://example.test/mcp",
      headers: [{ name: "Authorization", value: "Bearer runtime-secret" }]
    }, 7000);
    expect(servers).toEqual([expect.objectContaining({
      type: "http",
      name: "example_mcp",
      startupTimeoutSeconds: 7
    })]);
    expect(fixture.manager.listServers(fixture.agentId)[0]).toMatchObject({
      lastCheckStatus: "passed", lastToolCount: 2
    });
    fixture.db.close();
  });

  it("仅所选工具模式在检查原 MCP 后注入透明 stdio 过滤代理", async () => {
    const check = vi.fn(async () => ({ status: "passed" as const, toolCount: 2, message: "2 tools available" }));
    const fixture = setup({ check });
    const created = fixture.manager.createServer(fixture.agentId, {
      name: "project-tools",
      transport: "http",
      enabled: true,
      url: "https://example.test/mcp",
      checkTimeoutSeconds: 7,
      headers: [{ name: "Authorization", source: "fixed", value: "Bearer runtime-secret", secret: true }]
    });
    fixture.manager.setAllowedTools(fixture.agentId, created.id, ["ticket_get"]);

    const [server] = await fixture.preparer.prepare({
      agentId: fixture.agentId,
      sessionId: fixture.sessionId,
      runId: 1,
      workspacePath: "/workspace",
      browserProfilePath: "/browser"
    });

    expect(check).toHaveBeenCalledWith({
      type: "http",
      name: "project-tools",
      url: "https://example.test/mcp",
      headers: [{ name: "Authorization", value: "Bearer runtime-secret" }]
    }, 7000);
    expect(server).toMatchObject({
      type: "stdio",
      name: "project-tools",
      command: process.execPath,
      startupTimeoutSeconds: 7
    });
    expect(server?.type).toBe("stdio");
    const encoded = server?.type === "stdio"
      ? server.env.find(({ name }) => name === "REMOTE_AGENT_MCP_FILTER_CONFIG")?.value
      : undefined;
    expect(JSON.parse(encoded ?? "null")).toEqual({
      allowedTools: ["ticket_get"],
      upstream: {
        type: "http",
        name: "project-tools",
        url: "https://example.test/mcp",
        headers: [{ name: "Authorization", value: "Bearer runtime-secret" }]
      }
    });
    fixture.db.close();
  });

  it("任一启用 MCP 检查失败时阻止 Run 且不暴露配置明文", async () => {
    const fixture = setup({
      check: async () => ({ status: "failed", code: "mcp_check_failed", message: "MCP project-tools check failed" })
    });
    const created = fixture.manager.createServer(fixture.agentId, {
      name: "project-tools",
      transport: "http",
      enabled: true,
      url: "https://example.test/mcp?token=url-secret",
      checkTimeoutSeconds: 3,
      headers: [{ name: "Authorization", source: "fixed", value: "Bearer header-secret", secret: true }]
    });
    const error = await fixture.preparer.prepare({
      agentId: fixture.agentId,
      sessionId: fixture.sessionId,
      runId: 1,
      workspacePath: "/workspace",
      browserProfilePath: "/browser"
    }).catch((caught: unknown) => caught);

    expect(error).toEqual(new RunMcpPreparationError("MCP project-tools check failed"));
    expect(JSON.stringify(error)).not.toMatch(/url-secret|header-secret|Authorization/i);
    fixture.db.close();
  });
});
