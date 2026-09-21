import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { AgentManager } from "../src/agents/agent-manager.js";
import { accountingRequests } from "./fixtures/agent-usage/accounting.js";
import { HostUsageCollector } from "../src/agent-usage/host-collector.js";
import type { UsageSourceAdapter } from "../src/agent-usage/source-coordinator.js";
import { AttachmentStore } from "../src/attachments/attachment-store.js";
import { prepareAttachments } from "../src/attachments/prepare-attachments.js";
import { migrate } from "../src/db.js";
import { IntegrationStore } from "../src/integrations/integration-store.js";
import { RunRepository } from "../src/runs/run-repository.js";
import { SystemProviderSessionCleaner } from "../src/runtime/provider-session-cleaner.js";
import { recoverSessionMaintenance, type SessionMaintenanceOperation } from "../src/sessions/session-maintenance.js";
import { SessionManager } from "../src/sessions/session-manager.js";
import { createFakeRuntime, createTestDatabase } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); });

const harness = (options: { beforeDelete?: () => Promise<void>; usageAdapters?: Record<string, UsageSourceAdapter> } = {}) => {
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
    usageCollector: new HostUsageCollector(db, options.usageAdapters),
    agentManager: new AgentManager({ db, dataDir: root, runtime })
  });
  return { db, root, session, workspace, manager, runtime, seed, workspaceManager, providerSessionCleaner };
};

describe("durable Session maintenance", () => {
  it("collects the final unread source tail before cleanup destroys provider files", async () => {
    let stopped = false;
    const h: ReturnType<typeof harness> = harness({ usageAdapters: { "test-tail": {
      describe: () => ({ usage: "model_request", context: "none", identity: "explicit", version: "1" }),
      freeze: async () => { expect(stopped).toBe(true); expect(existsSync(h.workspace)).toBe(true); return "end"; },
      async *collect() { yield { sourceSessionKey: "capture", observation: accountingRequests()[0]!, checkpoint: "end" }; }
    } } });
    h.runtime.releaseSession = async () => { stopped = true; };
    h.manager.usageCollector.sources.registerSource({ namespace: h.manager.usageCollector.namespace, sourceKey: "tail", kind: "test-tail", inputRef: {},
      mappings: [{ sourceSessionKey: "capture", agentId: String(h.seed.agent.id), sessionId: String(h.session.id), providerEpochId: h.manager.usageCollector.epoch(h.session.id) }] });
    await h.manager.cleanupStorage(h.session.id, "2099-01-01T00:00:00Z");
    expect(existsSync(h.workspace)).toBe(false);
    expect(h.manager.usageCollector.store.summary({ namespace: h.manager.usageCollector.namespace }).usage.totalTokens).toBe(1100);
  });

  it("keeps the reset claim and source files when usage collection fails", async () => {
    const h = harness({ usageAdapters: { "unavailable-tail": {
      describe: () => ({ usage: "model_request", context: "none", identity: "explicit", version: "1" }),
      freeze: async () => { throw new Error("source unavailable"); }, async *collect() { /* no completed records */ }
    } } });
    h.manager.usageCollector.sources.registerSource({ namespace: h.manager.usageCollector.namespace, sourceKey: "tail", kind: "unavailable-tail", inputRef: {},
      mappings: [{ sourceSessionKey: "capture", agentId: String(h.seed.agent.id), sessionId: String(h.session.id), providerEpochId: h.manager.usageCollector.epoch(h.session.id) }] });
    await expect(h.manager.resetProviderSession(h.session.id)).rejects.toMatchObject({ code: "usage_collection_pending" });
    expect(existsSync(h.workspace)).toBe(true);
    expect(h.db.prepare("SELECT status, pending_operation FROM sessions WHERE id = ?").get(h.session.id)).toEqual({ status: "running", pending_operation: "reset" });
  });
  it("Hermes 存储清理只删除目标 Session Home，并清理匹配的旧历史", async () => {
    const root = mkdtempSync(join(tmpdir(), "hermes-session-cleanup-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, "agents", "1", "provider-home", "hermes");
    const targetHome = join(home, "sessions", "1");
    const nullIdTargetHome = join(home, "sessions", "3");
    const otherSessionHome = join(home, "sessions", "2");
    mkdirSync(join(targetHome, "sessions", "provider-1"), { recursive: true });
    mkdirSync(nullIdTargetHome, { recursive: true });
    mkdirSync(otherSessionHome, { recursive: true });
    mkdirSync(join(home, "sessions", "provider-1"), { recursive: true });
    mkdirSync(join(home, "sessions", "provider-2"), { recursive: true });
    writeFileSync(join(targetHome, "sessions", "provider-1", "history.jsonl"), "target");
    writeFileSync(join(nullIdTargetHome, "pending.txt"), "target without provider id");
    writeFileSync(join(otherSessionHome, "keep.txt"), "other Session");
    writeFileSync(join(home, "sessions", "provider-1", "history.jsonl"), "legacy target");
    writeFileSync(join(home, "sessions", "provider-2", "history.jsonl"), "legacy other");
    const legacyState = new Database(join(home, "state.db"));
    legacyState.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT);
      CREATE TABLE compression_locks (session_id TEXT PRIMARY KEY);
    `);
    legacyState.prepare("INSERT INTO sessions (id) VALUES (?)").run("provider-1");
    legacyState.prepare("INSERT INTO sessions (id) VALUES (?)").run("provider-2");
    legacyState.prepare("INSERT INTO messages (id, session_id) VALUES (?, ?)").run(1, "provider-1");
    legacyState.prepare("INSERT INTO messages (id, session_id) VALUES (?, ?)").run(2, "provider-2");
    legacyState.close();
    const cleaner = new SystemProviderSessionCleaner(root);

    await cleaner.purge({ agentId: 1, provider: "hermes", sessionId: 1, providerSessionId: "provider-1" });
    await cleaner.purge({ agentId: 1, provider: "hermes", sessionId: 3, providerSessionId: null });

    expect(existsSync(targetHome)).toBe(false);
    expect(existsSync(nullIdTargetHome)).toBe(false);
    expect(existsSync(join(home, "sessions", "provider-1"))).toBe(false);
    expect(readFileSync(join(otherSessionHome, "keep.txt"), "utf8")).toBe("other Session");
    expect(readFileSync(join(home, "sessions", "provider-2", "history.jsonl"), "utf8")).toBe("legacy other");
    const remainingState = new Database(join(home, "state.db"), { readonly: true });
    expect(remainingState.prepare("SELECT id FROM sessions ORDER BY id").all()).toEqual([{ id: "provider-2" }]);
    remainingState.close();
  });

  it.each(["cleanup", "delete", "reset"] as const)("%s 的存储操作完成后数据库收尾失败，重启恢复仍完成原操作", async (operation) => {
    const h = harness();
    const { db, session, manager, workspace } = h;
    const run = db.prepare("SELECT id FROM runs WHERE session_id = ?").get(session.id) as { id: number };
    const store = new IntegrationStore({ db });
    const endpointId = Number(db.prepare(`
      INSERT INTO integration_endpoints (name, slug, agent_id, enabled, token_hash, created_at, updated_at)
      VALUES ('Maintenance', 'maintenance', ?, 0, 'maintenance-token', '2026-08-12', '2026-08-12')
    `).run(h.seed.agent.id).lastInsertRowid);
    const task = store.createTask({
      endpointId, conversationId: null, sessionId: session.id, requestId: "maintenance",
      requestFingerprint: "maintenance", message: "test", effectivePrompt: "test", encryptedParameters: null
    });
    const subscription = store.createSubscription({
      endpointId, name: "Maintenance", url: "https://receiver.test/maintenance", enabled: false,
      eventsJson: "[]", encryptedHeaders: null, encryptedSigningSecret: "test-secret", timeoutSeconds: 10
    });
    const delivery = store.createDelivery({
      subscriptionId: subscription.id, taskId: task.id, eventId: "maintenance", eventKey: "maintenance",
      sequence: 1, eventType: "task.succeeded", payloadJson: "{}", nextAttemptAt: "2026-08-12"
    });
    const owner = { runId: run.id };
    const attachments = new AttachmentStore(db);
    attachments.insert(session.id, owner, [
      { name: "notes.txt", mediaType: "text/plain", data: Buffer.from("attachment contents").toString("base64") }
    ]);
    const metadata = attachments.list(owner);
    const prepared = await prepareAttachments(attachments, run.id, workspace, "", new AbortController().signal);
    const attachmentPath = JSON.parse(prepared.text.split("\n").find((line) => line.startsWith("{"))!).path as string;
    expect(readFileSync(attachmentPath, "utf8")).toBe("attachment contents");
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
    expect(existsSync(attachmentPath)).toBe(operation === "reset");
    // The failed terminal transaction must roll back clearing or deleting the attachment payload.
    expect(attachments.read(owner, metadata[0]!.id)?.bytes.toString()).toBe("attachment contents");
    expect(store.getDelivery(delivery.id)).toBeDefined();
    expect(db.prepare("SELECT count(*) AS count FROM runs WHERE session_id = ?").get(session.id)).toEqual({ count: 1 });
    db.exec("DROP TRIGGER reject_terminal");
    const repository = new RunRepository({ db });
    repository.recoverAfterRestart();
    expect(() => repository.create({ sessionId: session.id, input: "unsafe reuse" }))
      .toThrow(expect.objectContaining({ code: "session_busy" }));

    await recoverSessionMaintenance(h);
    await recoverSessionMaintenance(h);

    expect(store.getDelivery(delivery.id) !== undefined).toBe(operation === "reset");

    if (operation === "delete") {
      expect(manager.get(session.id)).toBeUndefined();
      expect(repository.listBySession(session.id)).toEqual([]);
      expect(attachments.list(owner)).toEqual([]);
      expect(existsSync(attachmentPath)).toBe(false);
    } else {
      expect(db.prepare("SELECT * FROM sessions WHERE id = ?").get(session.id)).toMatchObject({
        status: "idle", pending_operation: null, provider_session_id: null,
        total_tokens: operation === "cleanup" ? 42 : null
      });
      expect(repository.listBySession(session.id)).toHaveLength(1);
      if (operation === "cleanup") {
        expect(manager.get(session.id)?.updatedAt).toBe("2026-08-12T00:00:00.000Z");
        expect(manager.get(session.id)?.storageCleanedAt).not.toBeNull();
        expect(attachments.list(owner)).toEqual(metadata.map((item) => ({ ...item, available: false })));
        expect(attachments.read(owner, metadata[0]!.id)).toBeUndefined();
        expect(existsSync(attachmentPath)).toBe(false);
      } else {
        expect(existsSync(join(workspace, "work.txt"))).toBe(true);
        expect(attachments.list(owner)).toEqual(metadata);
        expect(attachments.read(owner, metadata[0]!.id)?.bytes.toString()).toBe("attachment contents");
        expect(readFileSync(attachmentPath, "utf8")).toBe("attachment contents");
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
