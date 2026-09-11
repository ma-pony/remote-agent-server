import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentManager } from "../src/agents/agent-manager.js";
import { migrate } from "../src/db.js";
import { RunRepository } from "../src/runs/run-repository.js";
import { SystemProviderSessionCleaner } from "../src/runtime/provider-session-cleaner.js";
import { recoverSessionMaintenance, type SessionMaintenanceOperation } from "../src/sessions/session-maintenance.js";
import { SessionManager } from "../src/sessions/session-manager.js";
import { createFakeRuntime, createTestDatabase } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); });

const harness = (options: { beforeDelete?: () => Promise<void> } = {}) => {
  const { db, seed } = createTestDatabase();
  const root = mkdtempSync(join(tmpdir(), "session-maintenance-"));
  cleanups.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const session = seed.session();
  const workspace = join(root, "sessions", String(session.id), "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "work.txt"), "user work");
  const providerHome = join(root, "agents", String(seed.agent.id));
  mkdirSync(providerHome, { recursive: true });
  writeFileSync(join(providerHome, "MEMORY.md"), "memory");
  db.prepare("UPDATE sessions SET workspace_path = ?, provider_session_id = 'native-session', total_tokens = 42 WHERE id = ?")
    .run(workspace, session.id);
  seed.run(session.id, "succeeded");
  const runtime = createFakeRuntime();
  const workspaceManager = {
    check: async () => undefined,
    createSession: async () => { throw new Error("unused"); },
    deleteSession: async (id: number) => {
      await options.beforeDelete?.();
      rmSync(join(root, "sessions", String(id)), { recursive: true, force: true });
    },
    createRevision: async () => undefined,
    removeRevision: async () => undefined
  };
  const providerSessionCleaner = new SystemProviderSessionCleaner(root);
  const manager = new SessionManager({
    db, dataDir: root, runtime, workspaceManager, providerSessionCleaner,
    agentManager: new AgentManager({ db, dataDir: root, runtime })
  });
  return { db, root, session, workspace, manager, runtime, seed, workspaceManager, providerSessionCleaner };
};

describe("durable Session maintenance", () => {
  it.each(["cleanup", "delete", "reset"] as const)("%s 的存储操作完成后数据库收尾失败，重启恢复仍完成原操作", async (operation) => {
    const h = harness();
    const { db, session, manager, workspace } = h;
    db.exec(operation === "delete" ? `
      CREATE TRIGGER reject_terminal BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'commit failed'); END;
    ` : `
      CREATE TRIGGER reject_terminal BEFORE UPDATE OF status ON sessions
      WHEN NEW.status = 'idle' BEGIN SELECT RAISE(ABORT, 'commit failed'); END;
    `);
    const operationPromise = operation === "cleanup"
      ? manager.cleanupStorage(session.id, "2026-08-24T00:00:00.000Z")
      : operation === "delete" ? manager.delete(session.id) : manager.resetProviderSession(session.id);
    await expect(operationPromise).rejects.toThrow();

    expect(db.prepare("SELECT * FROM sessions WHERE id = ?").get(session.id)).toMatchObject({
      status: "running", pending_operation: operation
    });
    expect(existsSync(workspace)).toBe(operation === "reset");
    expect(db.prepare("SELECT count(*) AS count FROM runs WHERE session_id = ?").get(session.id)).toEqual({ count: 1 });
    db.exec("DROP TRIGGER reject_terminal");
    const repository = new RunRepository({ db });
    repository.recoverAfterRestart();
    expect(() => repository.create({ sessionId: session.id, input: "unsafe reuse" }))
      .toThrow(expect.objectContaining({ code: "session_busy" }));

    await recoverSessionMaintenance(h);
    await recoverSessionMaintenance(h);

    if (operation === "delete") {
      expect(manager.get(session.id)).toBeUndefined();
      expect(repository.listBySession(session.id)).toEqual([]);
    } else {
      expect(db.prepare("SELECT * FROM sessions WHERE id = ?").get(session.id)).toMatchObject({
        status: "idle", pending_operation: null, provider_session_id: null,
        total_tokens: operation === "cleanup" ? 42 : null
      });
      expect(repository.listBySession(session.id)).toHaveLength(1);
      if (operation === "cleanup") {
        expect(manager.get(session.id)?.updatedAt).toBe("2026-08-12T00:00:00.000Z");
        expect(manager.get(session.id)?.storageCleanedAt).not.toBeNull();
      } else {
        expect(existsSync(join(workspace, "work.txt"))).toBe(true);
        expect(repository.create({ sessionId: session.id, input: "new context" }).status).toBe("queued");
      }
    }
  });

  it.each(["codex", "claude_code"] as const)("%s 的中断重置清除旧会话文件但保留 Workspace", async (provider) => {
    const h = harness();
    h.db.prepare("UPDATE agents SET provider = ? WHERE id = ?").run(provider, h.seed.agent.id);
    h.db.prepare("UPDATE sessions SET status = 'running', pending_operation = 'reset' WHERE id = ?").run(h.session.id);
    const providerRoot = join(h.root, "agents", String(h.seed.agent.id), "provider-home");
    const oldContext = provider === "codex"
      ? join(providerRoot, "codex", "sessions", String(h.session.id), "rollout.jsonl")
      : join(providerRoot, "claude", "projects", "project", "native-session.jsonl");
    mkdirSync(join(oldContext, ".."), { recursive: true });
    writeFileSync(oldContext, "old conversation");

    await recoverSessionMaintenance(h);

    expect(existsSync(oldContext)).toBe(false);
    expect(existsSync(join(h.workspace, "work.txt"))).toBe(true);
    expect(h.manager.get(h.session.id)?.providerSessionId).toBeNull();
    expect(h.manager.get(h.session.id)?.storageCleanedAt).toBeNull();
  });

  it("恢复失败保留占用，后续恢复成功前拒绝 Run", async () => {
    let fail = true;
    const h = harness({ beforeDelete: async () => { if (fail) throw new Error("busy"); } });
    h.db.prepare("UPDATE sessions SET status = 'running', pending_operation = 'delete' WHERE id = ?").run(h.session.id);
    const failures: Array<{ id: number; operation: SessionMaintenanceOperation }> = [];

    await recoverSessionMaintenance(h, (id, operation) => { failures.push({ id, operation }); });
    new RunRepository({ db: h.db }).recoverAfterRestart();

    expect(failures).toEqual([{ id: h.session.id, operation: "delete" }]);
    expect(h.manager.get(h.session.id)?.status).toBe("running");
    expect(existsSync(h.workspace)).toBe(true);
    fail = false;
    await recoverSessionMaintenance(h);
    expect(h.manager.get(h.session.id)).toBeUndefined();
    expect(existsSync(h.workspace)).toBe(false);
  });

  it("同一个维护操作未结束时拒绝并发重试", async () => {
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const deleting = new Promise<void>((resolve) => { started = resolve; });
    const h = harness({ beforeDelete: async () => { started(); await blocked; } });
    const first = h.manager.delete(h.session.id);
    await deleting;

    await expect(h.manager.delete(h.session.id)).rejects.toMatchObject({ code: "session_busy" });
    await expect(h.manager.resetProviderSession(h.session.id)).rejects.toMatchObject({ code: "session_busy" });
    release();
    await first;
    expect(h.manager.get(h.session.id)).toBeUndefined();
  });

  it("旧数据库迁移只新增操作标记，不改活动时间且重复迁移保留已有标记", () => {
    const h = harness();
    h.db.exec("ALTER TABLE sessions DROP COLUMN pending_operation");
    const before = h.manager.get(h.session.id);

    migrate(h.db);

    expect(h.manager.get(h.session.id)).toEqual(before);
    expect(h.db.prepare("SELECT pending_operation FROM sessions WHERE id = ?").get(h.session.id)).toEqual({ pending_operation: null });
    h.db.prepare("UPDATE sessions SET status = 'running', pending_operation = 'delete' WHERE id = ?").run(h.session.id);
    migrate(h.db);
    expect(h.db.prepare("SELECT pending_operation FROM sessions WHERE id = ?").get(h.session.id)).toEqual({ pending_operation: "delete" });
  });
});
