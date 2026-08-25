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
      name: "grab-manager",
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
      name: "grab-manager",
      url: "https://example.test/mcp",
      headers: [{ name: "Authorization", value: "Bearer runtime-secret" }]
    }, 7000);
    expect(server).toMatchObject({
      type: "stdio",
      name: "grab-manager",
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
        name: "grab-manager",
        url: "https://example.test/mcp",
        headers: [{ name: "Authorization", value: "Bearer runtime-secret" }]
      }
    });
    fixture.db.close();
  });

  it("任一启用 MCP 检查失败时阻止 Run 且不暴露配置明文", async () => {
    const fixture = setup({
      check: async () => ({ status: "failed", code: "mcp_check_failed", message: "MCP grab-manager check failed" })
    });
    const created = fixture.manager.createServer(fixture.agentId, {
      name: "grab-manager",
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

    expect(error).toEqual(new RunMcpPreparationError("MCP grab-manager check failed"));
    expect(JSON.stringify(error)).not.toMatch(/url-secret|header-secret|Authorization/i);
    fixture.db.close();
  });
});
