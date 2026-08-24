import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentManager } from "../src/agents/agent-manager.js";
import { SessionCleanupScheduler } from "../src/sessions/session-cleanup-scheduler.js";
import { SessionManager } from "../src/sessions/session-manager.js";
import { createFakeRuntime, createTestDatabase } from "./helpers.js";

const tempDirectories: string[] = [];

afterEach(() => {
  tempDirectories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

const createHarness = () => {
  const { db, seed } = createTestDatabase();
  const root = mkdtempSync(join(tmpdir(), "session-cleanup-"));
  tempDirectories.push(root);
  const runtime = createFakeRuntime();
  const manager = new SessionManager({
    db,
    dataDir: root,
    agentManager: new AgentManager({ db, dataDir: root, runtime }),
    runtime,
    workspaceManager: {
      check: async () => undefined,
      createSession: async () => { throw new Error("unused"); },
      deleteSession: async (id) => {
        rmSync(join(root, "sessions", String(id)), { recursive: true, force: true });
      },
      createRevision: async () => undefined,
      removeRevision: async () => undefined
    }
  });
  const insertSession = (id: number, status: "idle" | "running", updatedAt: string) => {
    const workspacePath = join(root, "sessions", String(id), "workspace");
    mkdirSync(workspacePath, { recursive: true });
    db.prepare(`
      INSERT INTO sessions (id, agent_id, title, status, workspace_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, seed.agent.id, `Session ${id}`, status, workspacePath, updatedAt, updatedAt);
    return workspacePath;
  };
  return { db, manager, root, insertSession };
};

describe("SessionCleanupScheduler", () => {
  it("按最后活动时间删除过期空闲会话并保留近期或运行中的会话", async () => {
    const { db, manager, root, insertSession } = createHarness();
    insertSession(101, "idle", "2026-08-01T00:00:00.000Z");
    insertSession(102, "idle", "2026-08-23T00:00:00.000Z");
    insertSession(103, "running", "2026-08-01T00:00:00.000Z");
    const scheduler = new SessionCleanupScheduler({
      sessionManager: manager,
      retentionMs: 7 * 24 * 60 * 60 * 1000,
      intervalMs: 60 * 60 * 1000,
      now: () => new Date("2026-08-24T00:00:00.000Z")
    });

    await scheduler.runCleanup();

    expect(manager.get(101)).toBeUndefined();
    expect(manager.get(102)?.status).toBe("idle");
    expect(manager.get(103)?.status).toBe("running");
    expect(existsSync(join(root, "sessions", "101"))).toBe(false);
    expect(existsSync(join(root, "sessions", "102"))).toBe(true);
    expect(existsSync(join(root, "sessions", "103"))).toBe(true);
    db.close();
  });

  it("保留时间为零时关闭自动清理", async () => {
    const { db, manager, insertSession } = createHarness();
    insertSession(101, "idle", "2026-08-01T00:00:00.000Z");
    const scheduler = new SessionCleanupScheduler({
      sessionManager: manager,
      retentionMs: 0,
      intervalMs: 60 * 60 * 1000,
      now: () => new Date("2026-08-24T00:00:00.000Z")
    });

    await scheduler.runCleanup();

    expect(manager.get(101)).toBeDefined();
    db.close();
  });

  it("保留仍被外部接入审计记录引用的会话", async () => {
    const { db, manager, root, insertSession } = createHarness();
    insertSession(101, "idle", "2026-08-01T00:00:00.000Z");
    const agent = db.prepare("SELECT id FROM agents ORDER BY id LIMIT 1").get() as { id: number };
    const endpointId = Number(db.prepare(`
      INSERT INTO integration_endpoints
        (name, slug, agent_id, enabled, token_hash, created_at, updated_at)
      VALUES ('测试接入', 'session-retention', ?, 1, 'token-hash', ?, ?)
    `).run(agent.id, "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z").lastInsertRowid);
    db.prepare(`
      INSERT INTO integration_conversations
        (endpoint_id, conversation_key, session_id, status, created_at, ended_at)
      VALUES (?, 'ticket-1', 101, 'ended', ?, ?)
    `).run(endpointId, "2026-08-01T00:00:00.000Z", "2026-08-01T01:00:00.000Z");
    const scheduler = new SessionCleanupScheduler({
      sessionManager: manager,
      retentionMs: 7 * 24 * 60 * 60 * 1000,
      intervalMs: 60 * 60 * 1000,
      now: () => new Date("2026-08-24T00:00:00.000Z")
    });

    await scheduler.runCleanup();

    expect(manager.get(101)).toBeDefined();
    expect(existsSync(join(root, "sessions", "101"))).toBe(true);
    db.close();
  });
});
