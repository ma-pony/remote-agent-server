import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { ProviderExtensionManager } from "../src/provider-extensions/provider-extension-manager.js";
import { ProviderExtensionProjector } from "../src/runtime/provider-extension-projector.js";
import { SystemProviderSessionCleaner } from "../src/runtime/provider-session-cleaner.js";
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
  it("pages and searches cached Provider catalogs", async () => {
    const {app, codexAgentId} = await fixture();
    const result = await app.inject({url: `/api/agents/${codexAgentId}/extensions?page=2&pageSize=1`, headers: authHeaders});
    expect(result.json()).toMatchObject({page: 2, pageSize: 1, total: 2, totalPages: 2, items: [expect.objectContaining({kind: "hook"})]});
    const filtered = await app.inject({url: `/api/agents/${codexAgentId}/extensions?page=1&pageSize=1&query=browser`, headers: authHeaders});
    expect(filtered.json()).toMatchObject({total: 1, items: [expect.objectContaining({name: "browser"})]});
  });

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
    mkdirSync(join(runtimeHome, ".tmp", "plugins", "old-market"), { recursive: true });
    writeFileSync(join(runtimeHome, "config.toml"), [
      "model = \"test\"",
      "[plugins.\"other@unused\"]",
      "enabled = true",
      "[mcp_servers.host-only]",
      "command = \"host-mcp\"",
      "[marketplaces.host-market]",
      "source_type = \"git\"",
      "source = \"https://example.test/host-market.git\"",
      ""
    ].join("\n"));
    writeFileSync(join(runtimeHome, "hooks.json"), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "host-only" }] }] }
    }));

    await new ProviderExtensionProjector(manager, join(root, "data")).prepare({
      agentId: codexAgentId,
      provider: "codex",
      home: runtimeHome
    });

    const projectedConfig = readFileSync(join(runtimeHome, "config.toml"), "utf8");
    expect(projectedConfig).toContain("model = \"test\"");
    expect(projectedConfig).toContain(`[plugins.\"browser@example-market\"]`);
    expect(projectedConfig).not.toContain("other@unused");
    expect(projectedConfig).not.toContain("mcp_servers");
    expect(projectedConfig).not.toContain("host-market");
    expect(projectedConfig).toContain(`[marketplaces.\"example-market\"]`);
    expect(projectedConfig).toContain('source_type = "local"');
    expect(JSON.parse(readFileSync(join(runtimeHome, "hooks.json"), "utf8"))).toEqual({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "/opt/tools/codex-audit" }] }]
      }
    });
    const sharedRoot = join(root, "data", "agents", String(codexAgentId), "provider-home", "codex");
    const cacheRoot = readlinkSync(join(runtimeHome, "plugins", "cache"));
    expect(cacheRoot.startsWith(`${join(sharedRoot, "plugin-caches")}${sep}`)).toBe(true);
    expect(basename(cacheRoot)).toMatch(/^[0-9a-f]{20}$/);
    expect(readlinkSync(join(runtimeHome, ".tmp"))).toBe(join(sharedRoot, ".tmp"));
    expect(existsSync(join(runtimeHome, "plugins", "cache", "unused"))).toBe(false);
    expect(existsSync(join(runtimeHome, ".tmp", "plugins"))).toBe(false);
    const marketplaceRoot = join(sharedRoot, "shared-plugins", "example-market",
      readdirSync(join(sharedRoot, "shared-plugins", "example-market"))[0]!);
    const installed = join(cacheRoot, "example-market", "browser");
    const versions = readdirSync(installed);
    expect(versions).toHaveLength(1);
    expect(lstatSync(join(installed, versions[0]!)).isDirectory()).toBe(true);
    expect(readFileSync(join(installed, versions[0]!, ".codex-plugin", "plugin.json"), "utf8"))
      .toContain("Browser automation");
    expect(JSON.parse(readFileSync(join(marketplaceRoot, ".agents", "plugins", "marketplace.json"), "utf8")))
      .toMatchObject({
        name: "example-market",
        plugins: [{ name: "browser", source: { source: "local", path: "./plugins/browser" } }]
      });

  });

  it("同一 Agent 的 Codex 会话共用插件包，清理一个会话不删除共享包", async () => {
    const { codexAgentId, root, codexHome, claudeHome, db } = await fixture();
    const manager = new ProviderExtensionManager({ db, codexHome, claudeHome, cacheTtlMs: 0 });
    const plugin = manager.list(codexAgentId).find(({ kind }) => kind === "plugin")!;
    manager.setEnabled(codexAgentId, plugin.id, true);
    const dataDir = join(root, "data");
    const projector = new ProviderExtensionProjector(manager, dataDir);
    const sessionHome = (id: number) => join(dataDir, "agents", String(codexAgentId),
      "provider-home", "codex", "sessions", String(id));
    const cache = (id: number) => join(sessionHome(id), "plugins", "cache");
    const temporary = (id: number) => join(sessionHome(id), ".tmp");

    await Promise.all([31, 32].map((id) => projector.prepare({
      agentId: codexAgentId, provider: "codex", home: sessionHome(id)
    })));
    const shared = readlinkSync(cache(31));
    expect(readlinkSync(cache(32))).toBe(shared);
    expect(readlinkSync(temporary(31))).toBe(readlinkSync(temporary(32)));
    expect(readdirSync(join(dataDir, "agents", String(codexAgentId), "provider-home", "codex",
      "shared-plugins", "example-market"))).toHaveLength(1);
    const marketplaceRoot = join(dataDir, "agents", String(codexAgentId), "provider-home", "codex",
      "shared-plugins", "example-market",
      readdirSync(join(dataDir, "agents", String(codexAgentId), "provider-home", "codex",
        "shared-plugins", "example-market"))[0]!);
    expect(readFileSync(join(marketplaceRoot, "plugins", "browser", ".codex-plugin", "plugin.json"), "utf8"))
      .toContain("Browser automation");
    expect(readFileSync(join(sessionHome(31), "config.toml"), "utf8"))
      .toContain(`source = ${JSON.stringify(marketplaceRoot)}`);

    const installed = join(shared, "example-market", "browser",
      readdirSync(join(shared, "example-market", "browser"))[0]!);
    writeFileSync(join(installed, "marker"), "installed once");
    mkdirSync(join(readlinkSync(temporary(31)), "plugins", ".git"), { recursive: true });
    writeFileSync(join(readlinkSync(temporary(31)), "plugins.sha"), "test-sha");

    await new SystemProviderSessionCleaner(dataDir).purge({
      agentId: codexAgentId, provider: "codex", sessionId: 31, providerSessionId: null
    });
    expect(existsSync(cache(31))).toBe(false);
    expect(readFileSync(join(cache(32), "example-market", "browser", basename(installed), "marker"), "utf8"))
      .toBe("installed once");
    expect(readFileSync(join(temporary(32), "plugins.sha"), "utf8")).toBe("test-sha");

    manager.setEnabled(codexAgentId, plugin.id, false);
    await projector.prepare({ agentId: codexAgentId, provider: "codex", home: sessionHome(32) });
    expect(readlinkSync(cache(32))).not.toBe(shared);
    expect(existsSync(join(cache(32), "example-market", "browser"))).toBe(false);
    expect(existsSync(shared)).toBe(true);
  });

  it("启用 Codex rollout 压缩时保留各 Session 的临时目录", async () => {
    const { codexAgentId, root, codexHome, claudeHome, db } = await fixture();
    const manager = new ProviderExtensionManager({ db, codexHome, claudeHome, cacheTtlMs: 0 });
    const plugin = manager.list(codexAgentId).find(({ kind }) => kind === "plugin")!;
    manager.setEnabled(codexAgentId, plugin.id, true);
    const projector = new ProviderExtensionProjector(manager, join(root, "data"));
    const sessionHome = (id: number) => join(root, "data", "agents", String(codexAgentId),
      "provider-home", "codex", "sessions", String(id));
    for (const id of [51, 52]) {
      mkdirSync(sessionHome(id), { recursive: true });
      writeFileSync(join(sessionHome(id), "config.toml"), "[features]\nlocal_thread_store_compression = true\n");
      await projector.prepare({ agentId: codexAgentId, provider: "codex", home: sessionHome(id) });
    }
    expect(readlinkSync(join(sessionHome(51), "plugins", "cache")))
      .toBe(readlinkSync(join(sessionHome(52), "plugins", "cache")));
    expect(lstatSync(join(sessionHome(51), ".tmp")).isDirectory()).toBe(true);
    expect(lstatSync(join(sessionHome(52), ".tmp")).isDirectory()).toBe(true);
    writeFileSync(join(sessionHome(51), ".tmp", "rollout-compression.lock"), "session 51");
    expect(existsSync(join(sessionHome(52), ".tmp", "rollout-compression.lock"))).toBe(false);
    await projector.prepare({ agentId: codexAgentId, provider: "codex", home: sessionHome(51) });
    expect(readFileSync(join(sessionHome(51), ".tmp", "rollout-compression.lock"), "utf8"))
      .toBe("session 51");
  });

  it("Codex 插件正文在版本号不变时更新到新快照与缓存版本", async () => {
    const { codexAgentId, root, codexHome, claudeHome, db } = await fixture();
    const manager = new ProviderExtensionManager({ db, codexHome, claudeHome, cacheTtlMs: 0 });
    const plugin = manager.list(codexAgentId).find(({ kind }) => kind === "plugin")!;
    manager.setEnabled(codexAgentId, plugin.id, true);
    const dataDir = join(root, "data");
    const agentHome = join(dataDir, "agents", String(codexAgentId), "provider-home", "codex");
    const home = join(agentHome, "sessions", "41");
    const oldSessionHome = join(agentHome, "sessions", "42");
    mkdirSync(join(agentHome, "sessions", "43", "plugins", "cache"), { recursive: true });
    const projector = new ProviderExtensionProjector(manager, dataDir);
    const source = join(codexHome, "plugins", "cache", "example-market", "browser", "1.2.3", "SKILL.md");
    writeFileSync(source, "first revision");
    await projector.prepare({ agentId: codexAgentId, provider: "codex", home });
    await projector.prepare({ agentId: codexAgentId, provider: "codex", home: oldSessionHome });
    await projector.prepare({ agentId: codexAgentId, provider: "codex", home: join(agentHome, "sessions", "0") });
    const revision = await manager.revision(codexAgentId);
    const market = join(agentHome, "shared-plugins", "example-market");
    const first = join(market, readdirSync(market)[0]!);
    const firstVersion = JSON.parse(readFileSync(join(first, "plugins", "browser", ".codex-plugin", "plugin.json"), "utf8")).version;

    writeFileSync(source, "second revision with more content");
    expect(await manager.revision(codexAgentId)).not.toBe(revision);
    await projector.prepare({ agentId: codexAgentId, provider: "codex", home });
    const second = readdirSync(market).map((entry) => join(market, entry)).find((path) => path !== first)!;
    const secondVersion = JSON.parse(readFileSync(join(second, "plugins", "browser", ".codex-plugin", "plugin.json"), "utf8")).version;
    expect(secondVersion).not.toBe(firstVersion);
    expect(readFileSync(join(second, "plugins", "browser", "SKILL.md"), "utf8"))
      .toBe("second revision with more content");
    expect(readFileSync(join(home, "config.toml"), "utf8"))
      .toContain(`source = ${JSON.stringify(second)}`);
    expect(existsSync(first)).toBe(true);
    const currentCache = readlinkSync(join(home, "plugins", "cache"));
    const installedVersion = readdirSync(join(currentCache, "example-market", "browser"))[0]!;
    expect(installedVersion).toBe(secondVersion);
    expect(readFileSync(join(currentCache, "example-market", "browser", installedVersion, "SKILL.md"), "utf8"))
      .toBe("second revision with more content");

    const now = Date.now();
    utimesSync(first, new Date(now - 2 * 60 * 60_000), new Date(now - 2 * 60 * 60_000));
    const oldCache = readlinkSync(join(oldSessionHome, "plugins", "cache"));
    utimesSync(oldCache, new Date(now - 2 * 60 * 60_000), new Date(now - 2 * 60 * 60_000));
    try {
      vi.setSystemTime(new Date(now + 11 * 60_000));
      await projector.prepare({ agentId: codexAgentId, provider: "codex", home });
      expect(existsSync(first)).toBe(true);
      expect(existsSync(oldCache)).toBe(true);
      await new SystemProviderSessionCleaner(dataDir).purge({
        agentId: codexAgentId, provider: "codex", sessionId: 42, providerSessionId: null
      });
      vi.setSystemTime(new Date(now + 22 * 60_000));
      await projector.prepare({ agentId: codexAgentId, provider: "codex", home });
      await vi.waitFor(() => {
        expect(existsSync(first)).toBe(false);
        expect(existsSync(oldCache)).toBe(false);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("清理中断发布留下的旧临时目录", async () => {
    const { codexAgentId, root, codexHome, claudeHome, db } = await fixture();
    const manager = new ProviderExtensionManager({ db, codexHome, claudeHome, cacheTtlMs: 0 });
    const agentHome = join(root, "data", "agents", String(codexAgentId), "provider-home", "codex");
    const home = join(agentHome, "sessions", "61");
    const projector = new ProviderExtensionProjector(manager, join(root, "data"));
    const temporaryName = "0123456789abcdefabcd.tmp-00000000-0000-4000-8000-000000000000";
    const snapshotTemporary = join(agentHome, "shared-plugins", "example-market", temporaryName);
    const cacheTemporary = join(agentHome, "plugin-caches", temporaryName);
    mkdirSync(snapshotTemporary, { recursive: true });
    mkdirSync(cacheTemporary, { recursive: true });
    const now = Date.now();
    for (const path of [snapshotTemporary, cacheTemporary]) {
      utimesSync(path, new Date(now - 2 * 60 * 60_000), new Date(now - 2 * 60 * 60_000));
    }
    await projector.prepare({ agentId: codexAgentId, provider: "codex", home });
    await vi.waitFor(() => {
      expect(existsSync(snapshotTemporary)).toBe(false);
      expect(existsSync(cacheTemporary)).toBe(false);
    });
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

    await new ProviderExtensionProjector(manager, join(root, "data")).prepare({
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
