import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createTestDatabase } from "./helpers.js";

const validEnv = {
  API_TOKEN: "test-token",
  DATA_DIR: "/var/lib/remote-agent",
  DATABASE_PATH: "/var/lib/remote-agent/remote-agent.sqlite3",
  WORKSPACE_TEMPLATE: "/var/lib/remote-agent/template/workspace",
  SESSIONS_ROOT: "/var/lib/remote-agent/sessions"
};

describe("configuration", () => {
  it("拒绝缺少 API_TOKEN 的配置", () => {
    const { API_TOKEN: _apiToken, ...envWithoutToken } = validEnv;

    expect(() => loadConfig(envWithoutToken)).toThrow(/API_TOKEN/);
  });

  it("默认最大并发为 4", () => {
    expect(loadConfig(validEnv).maxConcurrentRuns).toBe(4);
  });
});

describe("database migration", () => {
  it("只创建四张业务表", () => {
    const { db } = createTestDatabase();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(tables).toEqual(["agents", "events", "runs", "sessions"]);
  });

  it("拒绝同一 Session 的第二个活动 Run", () => {
    const { db, seed } = createTestDatabase();
    const session = seed.session();
    seed.run(session.id, "queued");

    expect(() => seed.run(session.id, "running")).toThrow(/UNIQUE/);

    db.close();
  });
});
