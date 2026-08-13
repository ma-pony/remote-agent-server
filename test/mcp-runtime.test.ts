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
      name: "grab_manager",
      transport: "http",
      enabled: true,
      url: "https://example.test/mcp",
      checkTimeoutSeconds: 7,
      headers: [{ name: "Authorization", source: "fixed", value: "Bearer runtime-secret", secret: true }]
    });

    const servers = await fixture.preparer.prepare({
      agentId: fixture.agentId,
      sessionId: fixture.sessionId,
      runId: "run-1",
      workspacePath: "/workspace",
      browserProfilePath: "/browser"
    });

    expect(check).toHaveBeenCalledWith({
      type: "http",
      name: "grab_manager",
      url: "https://example.test/mcp",
      headers: [{ name: "Authorization", value: "Bearer runtime-secret" }]
    }, 7000);
    expect(servers).toEqual([expect.objectContaining({ type: "http", name: "grab_manager" })]);
    expect(fixture.manager.listServers(fixture.agentId)[0]).toMatchObject({
      lastCheckStatus: "passed", lastToolCount: 2
    });
    fixture.db.close();
  });

  it("任一检查失败即脱敏失败，不返回 MCP 明文", async () => {
    const fixture = setup({
      check: async () => ({ status: "failed", code: "mcp_check_failed", message: "MCP private_mcp check failed" })
    });
    fixture.manager.createServer(fixture.agentId, {
      name: "private_mcp",
      transport: "http",
      enabled: true,
      url: "https://example.test/mcp?token=url-secret",
      checkTimeoutSeconds: 3,
      headers: [{ name: "Authorization", source: "fixed", value: "Bearer header-secret", secret: true }]
    });

    const error = await fixture.preparer.prepare({
      agentId: fixture.agentId,
      sessionId: fixture.sessionId,
      runId: "run-1",
      workspacePath: "/workspace",
      browserProfilePath: "/browser"
    }).catch((caught: unknown) => caught);

    expect(error).toEqual(new RunMcpPreparationError("MCP private_mcp check failed"));
    expect(JSON.stringify(error)).not.toMatch(/url-secret|header-secret|Authorization/i);
    fixture.db.close();
  });
});
