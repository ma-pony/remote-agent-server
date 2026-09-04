import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { ProviderExtensionManager } from "../src/provider-extensions/provider-extension-manager.js";
import { ProviderExtensionProjector } from "../src/runtime/provider-extension-projector.js";
import { createFakeRuntime, createTestDatabase } from "./helpers.js";

const apiToken = "test-token";
const authHeaders = { authorization: `Bearer ${apiToken}` };
const cleanup: Array<() => Promise<void>> = [];

const fixture = async (): Promise<{
  app: FastifyInstance;
  codexAgentId: number;
  claudeAgentId: number;
  root: string;
  codexHome: string;
  claudeHome: string;
  db: ReturnType<typeof createTestDatabase>["db"];
}> => {
  const root = mkdtempSync(join(tmpdir(), "remote-agent-extensions-"));
  const codexHome = join(root, "codex");
  const claudeHome = join(root, "claude");
  mkdirSync(join(codexHome, "plugins", "cache", "example-market", "browser", "1.2.3", ".codex-plugin"), {
    recursive: true
  });
  writeFileSync(join(codexHome, "config.toml"), [
    "[plugins.\"browser@example-market\"]",
    "enabled = true",
    "[mcp_servers.local-tools]",
    "command = \"npx\"",
    "args = [\"-y\", \"local-mcp@latest\"]",
    "[mcp_servers.local-tools.env]",
    "API_TOKEN = \"provider-secret\"",
    "DATABASE_URL = \"postgres://provider-secret\"",
    ""
  ].join("\n"));
  writeFileSync(
    join(codexHome, "plugins", "cache", "example-market", "browser", "1.2.3", ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "browser", version: "1.2.3", description: "Browser automation" })
  );
  writeFileSync(join(codexHome, "hooks.json"), JSON.stringify({
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "/opt/tools/codex-audit" }] }]
    }
  }));

  mkdirSync(join(claudeHome, "plugins", "cache", "official", "review", "2.0.0", ".claude-plugin"), {
    recursive: true
  });
  mkdirSync(join(claudeHome, "plugins", "cache", "official", "pyright-lsp", "1.0.0"), {
    recursive: true
  });
  writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({
    enabledPlugins: { "review@official": true },
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/opt/tools/claude-audit" }] }]
    }
  }));
  writeFileSync(`${claudeHome}.json`, JSON.stringify({
    mcpServers: {
      browser: { type: "http", url: "https://mcp.example.test", headers: { Authorization: "Bearer secret" } }
    }
  }));
  writeFileSync(
    join(claudeHome, "plugins", "cache", "official", "review", "2.0.0", ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "review", version: "2.0.0", description: "Review changes" })
  );
  writeFileSync(join(claudeHome, "plugins", "installed_plugins.json"), JSON.stringify({
    version: 2,
    plugins: {
      "pyright-lsp@official": [{
        scope: "user",
        installPath: join(claudeHome, "plugins", "cache", "official", "pyright-lsp", "1.0.0"),
        version: "1.0.0"
      }]
    }
  }));

  vi.stubEnv("CODEX_HOME", codexHome);
  vi.stubEnv("CLAUDE_CONFIG_DIR", claudeHome);
  const { db, seed } = createTestDatabase();
  const claudeAgentId = Number(db.prepare(`
    INSERT INTO agents (name, provider, project_environment_id, created_at, updated_at)
    VALUES ('Claude', 'claude_code', ?, '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z')
  `).run(seed.projectEnvironment.id).lastInsertRowid);
  const dataDir = join(root, "data");
  const app = buildApp({
    config: {
      host: "127.0.0.1",
      port: 3000,
      apiToken,
      dataDir,
      databasePath: ":memory:",
      projectEnvironmentsRoot: join(root, "environments"),
      sessionsRoot: join(root, "sessions"),
      maxConcurrentRuns: 1,
      maxConcurrentWebhookDeliveries: 4,
      maxConcurrentEnvironmentBuilds: 1,
      projectEnvironmentCheckIntervalMs: 60_000,
      projectPrepareTimeoutMs: 60_000,
      sessionRetentionMs: 0
    },
    db,
    runtime: createFakeRuntime()
  });
  await app.ready();
  cleanup.push(async () => {
    await app.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  return { app, codexAgentId: seed.agent.id, claudeAgentId, root, codexHome, claudeHome, db };
};

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
});

describe("Provider extensions", () => {
  it("按 Agent Provider 发现插件和 Hook，并由当前 Agent 显式启用", async () => {
    const { app, codexAgentId, claudeAgentId } = await fixture();

    const codex = await app.inject({
      method: "GET",
      url: `/api/agents/${codexAgentId}/extensions`,
      headers: authHeaders
    });
    expect(codex.statusCode).toBe(200);
    expect(codex.json()).toEqual([
      expect.objectContaining({
        provider: "codex",
        kind: "plugin",
        name: "browser",
        description: "Browser automation",
        version: "1.2.3",
        enabled: false,
        available: true
      }),
      expect.objectContaining({
        provider: "codex",
        kind: "hook",
        name: "UserPromptSubmit #1",
        enabled: false,
        available: true
      })
    ]);

    const claude = await app.inject({
      method: "GET",
      url: `/api/agents/${claudeAgentId}/extensions`,
      headers: authHeaders
    });
    expect(claude.statusCode).toBe(200);
    expect(claude.json()).toEqual([
      expect.objectContaining({
        provider: "claude_code",
        kind: "plugin",
        name: "pyright-lsp",
        version: "1.0.0",
        enabled: false
      }),
      expect.objectContaining({ provider: "claude_code", kind: "plugin", name: "review", enabled: false }),
      expect.objectContaining({ provider: "claude_code", kind: "hook", name: "PreToolUse #1", enabled: false })
    ]);

    const pluginId = (codex.json() as Array<{ id: string; kind: string }>).find(({ kind }) => kind === "plugin")!.id;
    const enabled = await app.inject({
      method: "PUT",
      url: `/api/agents/${codexAgentId}/extensions/${encodeURIComponent(pluginId)}`,
      headers: authHeaders,
      payload: { enabled: true }
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({ id: pluginId, enabled: true });

    const codexAfterEnable = await app.inject({
      method: "GET",
      url: `/api/agents/${codexAgentId}/extensions`,
      headers: authHeaders
    });
    expect(codexAfterEnable.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: pluginId, enabled: true })
    ]));
    expect(claude.json()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: pluginId, enabled: true })
    ]));

    const cloned = await app.inject({
      method: "POST",
      url: `/api/agents/${codexAgentId}/clone`,
      headers: authHeaders,
      payload: { name: "Codex copy" }
    });
    expect(cloned.statusCode).toBe(201);
    const clonedCatalog = await app.inject({
      method: "GET",
      url: `/api/agents/${cloned.json().id}/extensions`,
      headers: authHeaders
    });
    expect(clonedCatalog.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: pluginId, enabled: true })
    ]));
  });

  it("多 Core Agent 可以按 Provider 独立选择扩展", async () => {
    const { app, codexAgentId, db, codexHome, claudeHome } = await fixture();
    db.prepare(`
      INSERT INTO agent_core_profiles
        (agent_id, name, provider, enabled, created_at, updated_at)
      VALUES (?, 'Claude', 'claude_code', 1, ?, ?)
    `).run(codexAgentId, "2026-08-26T00:00:00.000Z", "2026-08-26T00:00:00.000Z");

    const catalog = await app.inject({
      method: "GET",
      url: `/api/agents/${codexAgentId}/extensions?provider=claude_code`,
      headers: authHeaders
    });
    expect(catalog.statusCode).toBe(200);
    const plugin = (catalog.json() as Array<{ id: string; kind: string }>).find(({ kind }) => kind === "plugin")!;

    const enabled = await app.inject({
      method: "PUT",
      url: `/api/agents/${codexAgentId}/extensions/${encodeURIComponent(plugin.id)}`,
      headers: authHeaders,
      payload: { enabled: true, provider: "claude_code" }
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({ id: plugin.id, provider: "claude_code", enabled: true });

    const manager = new ProviderExtensionManager({ db, codexHome, claudeHome, cacheTtlMs: 0 });
    expect(manager.enabled(codexAgentId, "claude_code")).toEqual([
      expect.objectContaining({ id: plugin.id, provider: "claude_code" })
    ]);
    expect(manager.enabled(codexAgentId, "codex")).toHaveLength(0);
  });

  it("只把 Agent 选中的 Provider 插件和 Hook 投影到运行目录", async () => {
    const { app, codexAgentId, root, codexHome, claudeHome, db } = await fixture();
    const manager = new ProviderExtensionManager({ db, codexHome, claudeHome, cacheTtlMs: 0 });
    const catalog = manager.list(codexAgentId);
    const plugin = catalog.find(({ kind }) => kind === "plugin")!;
    const hook = catalog.find(({ kind }) => kind === "hook")!;
    manager.setEnabled(codexAgentId, plugin.id, true);
    manager.setEnabled(codexAgentId, hook.id, true);

    const runtimeHome = join(root, "runtime-codex");
    mkdirSync(join(runtimeHome, "plugins", "cache", "unused", "other", "9.0.0"), { recursive: true });
    writeFileSync(join(runtimeHome, "config.toml"), [
      "model = \"test\"",
      "[plugins.\"other@unused\"]",
      "enabled = true",
      "[mcp_servers.host-only]",
      "command = \"host-mcp\"",
      ""
    ].join("\n"));
    writeFileSync(join(runtimeHome, "hooks.json"), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "host-only" }] }] }
    }));

    await new ProviderExtensionProjector(manager).prepare({
      agentId: codexAgentId,
      provider: "codex",
      home: runtimeHome
    });

    const projectedConfig = readFileSync(join(runtimeHome, "config.toml"), "utf8");
    expect(projectedConfig).toContain("model = \"test\"");
    expect(projectedConfig).toContain(`[plugins.\"browser@example-market\"]`);
    expect(projectedConfig).not.toContain("other@unused");
    expect(projectedConfig).not.toContain("mcp_servers");
    expect(JSON.parse(readFileSync(join(runtimeHome, "hooks.json"), "utf8"))).toEqual({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "/opt/tools/codex-audit" }] }]
      }
    });
    expect(existsSync(join(
      runtimeHome,
      "plugins",
      "cache",
      "example-market",
      "browser",
      "1.2.3",
      ".codex-plugin",
      "plugin.json"
    ))).toBe(true);
    expect(existsSync(join(runtimeHome, "plugins", "cache", "unused"))).toBe(false);

  });

  it("Claude Code 只加载 Agent 选中的扩展，并隔离宿主机全局 MCP", async () => {
    const { claudeAgentId, root, codexHome, claudeHome, db } = await fixture();
    const manager = new ProviderExtensionManager({ db, codexHome, claudeHome, cacheTtlMs: 0 });
    for (const item of manager.list(claudeAgentId)) manager.setEnabled(claudeAgentId, item.id, true);

    const runtimeHome = join(root, "runtime-claude");
    mkdirSync(join(runtimeHome, "plugins", "cache", "unused", "other", "9.0.0"), { recursive: true });
    writeFileSync(join(runtimeHome, "plugins", "known_marketplaces.json"), "{}\n");
    writeFileSync(join(runtimeHome, "settings.json"), JSON.stringify({
      theme: "dark",
      enabledPlugins: { "other@unused": true },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "host-only" }] }] },
      mcpServers: { inherited: { command: "host-mcp" } }
    }));
    writeFileSync(`${runtimeHome}.json`, JSON.stringify({
      mcpServers: { inheritedGlobal: { command: "host-global-mcp" } }
    }));

    await new ProviderExtensionProjector(manager).prepare({
      agentId: claudeAgentId,
      provider: "claude_code",
      home: runtimeHome
    });

    const settings = JSON.parse(readFileSync(join(runtimeHome, "settings.json"), "utf8"));
    expect(settings).toMatchObject({
      theme: "dark",
      enabledPlugins: { "review@official": true },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/opt/tools/claude-audit" }] }]
      }
    });
    expect(settings).not.toHaveProperty("mcpServers");
    expect(JSON.parse(readFileSync(`${runtimeHome}.json`, "utf8"))).not.toHaveProperty("mcpServers");
    expect(existsSync(join(runtimeHome, "plugins", "known_marketplaces.json"))).toBe(true);
    expect(existsSync(join(runtimeHome, "plugins", "cache", "unused"))).toBe(false);
    expect(existsSync(join(
      runtimeHome,
      "plugins",
      "cache",
      "official",
      "review",
      "2.0.0",
      ".claude-plugin",
      "plugin.json"
    ))).toBe(true);
  });

  it("发现 Provider 全局 MCP，并显式导入到当前 Agent", async () => {
    const { app, codexAgentId, claudeAgentId } = await fixture();

    const codexCatalog = await app.inject({
      method: "GET",
      url: `/api/agents/${codexAgentId}/system-mcp-catalog`,
      headers: authHeaders
    });
    expect(codexCatalog.statusCode).toBe(200);
    expect(codexCatalog.json()).toEqual([
      expect.objectContaining({ provider: "codex", name: "local-tools", transport: "stdio", installed: false })
    ]);
    expect(JSON.stringify(codexCatalog.json())).not.toContain("provider-secret");

    const sourceId = codexCatalog.json()[0].id as string;
    const installed = await app.inject({
      method: "POST",
      url: `/api/agents/${codexAgentId}/system-mcp-catalog/${encodeURIComponent(sourceId)}/install`,
      headers: authHeaders
    });
    expect(installed.statusCode).toBe(201);
    expect(installed.json()).toMatchObject({
      name: "local-tools",
      transport: "stdio",
      command: "npx",
      arguments: [
        expect.objectContaining({ source: "fixed", value: "-y" }),
        expect.objectContaining({ source: "fixed", value: "local-mcp@latest" })
      ],
      environment: [
        expect.objectContaining({ name: "API_TOKEN", source: "fixed", secret: true, configured: true }),
        expect.objectContaining({ name: "DATABASE_URL", source: "fixed", secret: true, configured: true })
      ]
    });
    expect(JSON.stringify(installed.json())).not.toContain("provider-secret");
    expect(JSON.stringify(installed.json())).not.toContain("postgres://provider-secret");

    const claudeCatalog = await app.inject({
      method: "GET",
      url: `/api/agents/${claudeAgentId}/system-mcp-catalog`,
      headers: authHeaders
    });
    expect(claudeCatalog.statusCode).toBe(200);
    expect(claudeCatalog.json()).toEqual([
      expect.objectContaining({ provider: "claude_code", name: "browser", transport: "http", installed: false })
    ]);
    expect(JSON.stringify(claudeCatalog.json())).not.toContain("Bearer secret");
  });
});
