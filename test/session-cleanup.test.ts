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
  it("按最后活动时间清理过期会话的大体积存储并保留记录和统计", async () => {
    const { db, manager, root, insertSession } = createHarness();
    insertSession(101, "idle", "2026-08-01T00:00:00.000Z");
    insertSession(102, "idle", "2026-08-23T00:00:00.000Z");
    insertSession(103, "running", "2026-08-01T00:00:00.000Z");
    db.prepare(`
      UPDATE sessions SET provider_session_id = 'provider-101', input_tokens = 100, output_tokens = 23, total_tokens = 123
      WHERE id = 101
    `).run();
    const runId = Number(db.prepare(`
      INSERT INTO runs (session_id, status, input, result, created_at, input_tokens, output_tokens, total_tokens)
      VALUES (101, 'succeeded', 'hello', 'world', '2026-08-01T00:00:00.000Z', 100, 23, 123)
    `).run().lastInsertRowid);
    db.prepare(`
      INSERT INTO events (run_id, seq, type, content_json, created_at)
      VALUES (?, 1, 'message', '{"text":"world"}', '2026-08-01T00:00:00.000Z')
    `).run(runId);
    const providerSessionPath = join(root, "agents", String(1), "provider-home", "codex", "sessions", "101");
    mkdirSync(providerSessionPath, { recursive: true });
    const scheduler = new SessionCleanupScheduler({
      sessionManager: manager,
      retentionMs: 7 * 24 * 60 * 60 * 1000,
      intervalMs: 60 * 60 * 1000,
      now: () => new Date("2026-08-24T00:00:00.000Z")
    });

    await scheduler.runCleanup();

    expect(manager.get(101)).toMatchObject({
      id: 101,
      providerSessionId: null,
      storageCleanedAt: "2026-08-24T00:00:00.000Z",
      usage: { inputTokens: 100, outputTokens: 23, totalTokens: 123 }
    });
    expect(manager.get(102)?.status).toBe("idle");
    expect(manager.get(103)?.status).toBe("running");
    expect(existsSync(join(root, "sessions", "101"))).toBe(false);
    expect(existsSync(providerSessionPath)).toBe(false);
    expect(existsSync(join(root, "sessions", "102"))).toBe(true);
    expect(existsSync(join(root, "sessions", "103"))).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS count FROM runs WHERE session_id = 101").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM events WHERE run_id = ?").get(runId)).toEqual({ count: 1 });
    expect(manager.listExpiredIds("2026-08-24T00:00:00.000Z")).not.toContain(101);
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

  it("清理被外部接入审计记录引用的会话存储但保留关联记录", async () => {
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

    expect(manager.get(101)).toMatchObject({ storageCleanedAt: "2026-08-24T00:00:00.000Z" });
    expect(existsSync(join(root, "sessions", "101"))).toBe(false);
    expect(db.prepare("SELECT session_id FROM integration_conversations WHERE conversation_key = 'ticket-1'").get())
      .toEqual({ session_id: 101 });
    db.close();
  });
});
