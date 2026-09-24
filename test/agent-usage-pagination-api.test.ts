import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { ManagedUsageSources } from "../src/agent-usage/managed-sources.js";
import { createFakeRuntime, createTestDatabase } from "./helpers.js";

it("serves bounded source pages through management auth with Agent and Session filters", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-pages-"));
  const { db, seed } = createTestDatabase();
  const session = seed.session();
  const config = loadConfig({ API_TOKEN: "test-token", DATA_DIR: root, DATABASE_PATH: ":memory:",
    PROJECT_ENVIRONMENTS_ROOT: join(root, "environments"), SESSIONS_ROOT: join(root, "sessions"), SESSION_RETENTION_HOURS: "0" });
  const manager = new ManagedUsageSources(db, config);
  const app = buildApp({ db, config, runtime: createFakeRuntime(), usageSources: manager,
    sessionCleanupScheduler: { start() {}, stop() {}, async runCleanup() {} } });
  try {
    await app.ready(); await manager.collector.stopRecovery();
    const binding = manager.collector.binding(session.id);
    for (let index = 0; index < 23; index++) manager.collector.sources.registerSource({ namespace: manager.collector.namespace,
      sourceKey: `source-${String(index).padStart(2, "0")}`, kind: "codex_log", inputRef: { relativePath: "unused" },
      mappings: [{ sourceSessionKey: "provider", agentId: binding.agentId, sessionId: binding.sessionId, providerEpochId: manager.collector.epoch(session.id) }] });
    db.prepare("UPDATE agent_usage_sources SET checkpoint=? WHERE source_key='source-20'").run("large-checkpoint-".repeat(1_000));
    const headers = { authorization: "Bearer test-token" };
    const path = `/api/usage/sources?page=2&pageSize=20&agentId=${binding.agentId}&sessionId=${session.id}`;
    const prepare = vi.spyOn(db, "prepare");
    const response = await app.inject({ url: path, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ page: 2, pageSize: 20, total: 23, totalPages: 2 });
    expect(response.json().items.map((item: { sourceKey: string }) => item.sourceKey)).toEqual(["source-20", "source-21", "source-22"]);
    const defaultPage = await app.inject({ url: "/api/usage/sources", headers });
    expect(defaultPage.json()).toMatchObject({ page: 1, pageSize: 20, total: 23, totalPages: 2 });
    expect(defaultPage.json().items).toHaveLength(20);
    expect((await app.inject({ url: path })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/usage/sources?pageSize=101", headers })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/usage/sources?page=1&pageSize=20&sessionId=999", headers })).json()).toMatchObject({ items: [], total: 0 });
    expect(response.body).not.toContain("inputRef");
    expect(response.body).not.toContain("checkpoint");
    expect(response.body).not.toContain("large-checkpoint");
    const pageSelect = prepare.mock.calls.map(([sql]) => String(sql)).find((sql) => sql.includes("FROM agent_usage_sources s") && sql.includes("LIMIT"));
    expect(pageSelect).toBeDefined();
    expect(pageSelect).not.toContain("s.*");
    expect(pageSelect).not.toContain("s.checkpoint");
  } finally { await app.close(); db.close(); await rm(root, { recursive: true, force: true }); }
});
