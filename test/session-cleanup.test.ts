import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentManager } from "../src/agents/agent-manager.js";
import { AttachmentStore } from "../src/attachments/attachment-store.js";
import { prepareAttachments } from "../src/attachments/prepare-attachments.js";
import { IntegrationStore } from "../src/integrations/integration-store.js";
import { RunRepository } from "../src/runs/run-repository.js";
import { SessionCleanupScheduler } from "../src/sessions/session-cleanup-scheduler.js";
import { SessionManager } from "../src/sessions/session-manager.js";
import { createFakeRuntime, createTestDatabase } from "./helpers.js";

const tempDirectories: string[] = [];

afterEach(() => {
  tempDirectories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

const createHarness = (options: { beforeWorkspaceDelete?: (id: number) => Promise<void> } = {}) => {
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
        await options.beforeWorkspaceDelete?.(id);
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
  it.each([0, 365 * 24])("存储清理失败后阻止复用，保留期改为 %s 小时也继续已开始的清理", async (nextRetentionHours) => {
    let shouldFail = true;
    const { db, manager, root, insertSession } = createHarness({
      beforeWorkspaceDelete: async () => { if (shouldFail) throw new Error("workspace busy"); }
    });
    insertSession(101, "idle", "2026-08-01T00:00:00.000Z");
    let retentionHours = 7 * 24;
    const errors: unknown[] = [];
    const scheduler = new SessionCleanupScheduler({
      sessionManager: manager,
      runtimeSettings: { getRuntime: () => ({ runTimeoutMinutes: 60, sessionStorageRetentionHours: retentionHours }) },
      retentionMs: 0,
      intervalMs: 60 * 60 * 1000,
      now: () => new Date("2026-08-24T00:00:00.000Z"),
      onError: (error) => { errors.push(error); }
    });

    await scheduler.runCleanup();

    expect(errors).toHaveLength(1);
    expect(db.prepare("SELECT * FROM sessions WHERE id = 101").get()).toMatchObject({
      status: "running", pending_operation: "cleanup", updated_at: "2026-08-01T00:00:00.000Z"
    });
    expect(() => new RunRepository({ db }).create({ sessionId: 101, input: "unsafe reuse" }))
      .toThrow(expect.objectContaining({ code: "session_busy" }));
    shouldFail = false;
    retentionHours = nextRetentionHours;

    await scheduler.runCleanup();

    expect(existsSync(join(root, "sessions", "101"))).toBe(false);
    expect(manager.get(101)?.storageCleanedAt).toBe("2026-08-24T00:00:00.000Z");
    expect(db.prepare("SELECT * FROM sessions WHERE id = 101").get()).toMatchObject({
      status: "idle", pending_operation: null, updated_at: "2026-08-01T00:00:00.000Z"
    });
    db.close();
  });

  it("清理前一个 Session 期间完成新 Run 的候选 Session 不再被删除", async () => {
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const deletingFirst = new Promise<void>((resolve) => { started = resolve; });
    const { db, manager, root, insertSession } = createHarness({
      beforeWorkspaceDelete: async (id) => {
        if (id === 101) { started(); await blocked; }
      }
    });
    insertSession(101, "idle", "2026-08-01T00:00:00.000Z");
    insertSession(102, "idle", "2026-08-01T00:00:00.000Z");
    const scheduler = new SessionCleanupScheduler({
      sessionManager: manager,
      retentionMs: 7 * 24 * 60 * 60 * 1000,
      intervalMs: 60 * 60 * 1000
    });
    const cleanup = scheduler.runCleanup();
    await deletingFirst;
    const repository = new RunRepository({ db });
    const run = repository.create({ sessionId: 102, input: "new activity" });
    repository.markRunning(run.id);
    repository.finish(run.id, { status: "succeeded", result: "fresh work" });
    release();
    await cleanup;

    expect(existsSync(join(root, "sessions", "101"))).toBe(false);
    expect(existsSync(join(root, "sessions", "102"))).toBe(true);
    expect(manager.get(102)?.storageCleanedAt).toBeNull();
    expect(repository.get(run.id)?.status).toBe("succeeded");
    db.close();
  });

  it.each(["idle", "running"] as const)("重启后仍清理已过期的 %s Session，不延长存储保留期", async (status) => {
    const { db, manager, root, insertSession } = createHarness();
    insertSession(101, status, "2026-08-01T00:00:00.000Z");
    insertSession(102, "idle", "2026-08-23T00:00:00.000Z");
    insertSession(103, "running", "2026-08-01T00:00:00.000Z");
    insertSession(104, "running", "2026-08-01T00:00:00.000Z");
    db.prepare(`
      INSERT INTO runs (session_id, status, input, created_at)
      VALUES (103, 'queued', 'waiting', '2026-08-01T00:00:00.000Z'),
        (104, 'running', 'interrupted', '2026-08-01T00:00:00.000Z')
    `).run();
    const scheduler = new SessionCleanupScheduler({
      sessionManager: manager,
      retentionMs: 7 * 24 * 60 * 60 * 1000,
      intervalMs: 60 * 60 * 1000,
      now: () => new Date("2026-08-24T00:00:00.000Z")
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-08-24T00:00:00.000Z"));
      // A cleanup interrupted after claiming storage leaves a running Session without an active Run.
      new RunRepository({ db }).recoverAfterRestart();

      await scheduler.runCleanup();

      expect(existsSync(join(root, "sessions", "101"))).toBe(false);
      expect(manager.get(101)).toMatchObject({
        status: "idle",
        updatedAt: "2026-08-01T00:00:00.000Z",
        storageCleanedAt: "2026-08-24T00:00:00.000Z"
      });
      for (const id of [102, 103, 104]) {
        expect(existsSync(join(root, "sessions", String(id)))).toBe(true);
        expect(manager.get(id)?.storageCleanedAt).toBeNull();
      }
    } finally {
      vi.useRealTimers();
      db.close();
    }
  });

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
    const attachments = new AttachmentStore(db);
    const files = [
      { name: "notes.txt", mediaType: "text/plain", data: Buffer.from("attachment contents").toString("base64") },
      { name: "pixel.png", mediaType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/RZkAAAAASUVORK5CYII=" }
    ];
    const sessionAttachments = [];
    for (const sessionId of [101, 102, 103]) {
      const attachmentRunId = sessionId === 101 ? runId : Number(db.prepare(`
        INSERT INTO runs (session_id, status, input, created_at) VALUES (?, ?, '', '2026-08-01T00:00:00.000Z')
      `).run(sessionId, sessionId === 103 ? "running" : "succeeded").lastInsertRowid);
      const owner = { runId: attachmentRunId };
      attachments.insert(sessionId, owner, files);
      const prepared = await prepareAttachments(attachments, attachmentRunId, join(root, "sessions", String(sessionId), "workspace"), "", new AbortController().signal);
      const paths = prepared.text.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line).path as string);
      expect(paths).toHaveLength(2);
      for (const path of paths) expect(existsSync(path)).toBe(true);
      sessionAttachments.push({ sessionId, owner, paths, metadata: attachments.list(owner) });
    }
    const providerSessionPath = join(root, "agents", String(1), "provider-home", "codex", "sessions", "101");
    mkdirSync(providerSessionPath, { recursive: true });
    const acpxSessionPath = join(root, "acpx", "sessions", "remote-agent%3A101.json");
    const acpxEventDirectory = join(root, "acpx", "events");
    const acpxEventPath = join(acpxEventDirectory, "remote-agent%3A101.stream.jsonl");
    const acpxEventRolloverPath = join(acpxEventDirectory, "remote-agent%3A101.stream.1.jsonl");
    mkdirSync(join(root, "acpx", "sessions"), { recursive: true });
    mkdirSync(acpxEventDirectory, { recursive: true });
    writeFileSync(acpxEventPath, "event\n", "utf8");
    writeFileSync(acpxEventRolloverPath, "event\n", "utf8");
    writeFileSync(acpxSessionPath, `${JSON.stringify({ event_log: { active_path: acpxEventPath } })}\n`, "utf8");
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
    expect(existsSync(acpxSessionPath)).toBe(false);
    expect(existsSync(acpxEventPath)).toBe(false);
    expect(existsSync(acpxEventRolloverPath)).toBe(false);
    expect(existsSync(join(root, "sessions", "102"))).toBe(true);
    expect(existsSync(join(root, "sessions", "103"))).toBe(true);
    for (const { sessionId, owner, paths, metadata } of sessionAttachments) {
      const available = sessionId !== 101;
      expect(attachments.list(owner)).toEqual(metadata.map((item) => ({ ...item, available })));
      for (const path of paths) expect(existsSync(path)).toBe(available);
      for (const [index, item] of metadata.entries()) {
        expect(attachments.read(owner, item.id)?.bytes.toString("base64")).toBe(available ? files[index]!.data : undefined);
      }
    }
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

  it("启动时立即清理，并在后续执行读取最新的在线保留时间", async () => {
    vi.useFakeTimers();
    try {
      const { db, manager, root, insertSession } = createHarness();
      insertSession(101, "idle", "2026-08-23T00:00:00.000Z");
      let retentionHours = 24;
      const runtimeSettings = {
        getRuntime: vi.fn(() => ({ runTimeoutMinutes: 60, sessionStorageRetentionHours: retentionHours }))
      };
      const scheduler = new SessionCleanupScheduler({
        sessionManager: manager,
        runtimeSettings,
        retentionMs: 0,
        intervalMs: 60 * 60 * 1000,
        now: () => new Date("2026-08-24T00:00:00.000Z")
      });

      scheduler.start();
      await vi.waitFor(() => expect(runtimeSettings.getRuntime).toHaveBeenCalled());
      expect(existsSync(join(root, "sessions", "101"))).toBe(true);

      retentionHours = 1;
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      await vi.waitFor(() => expect(existsSync(join(root, "sessions", "101"))).toBe(false));

      expect(manager.get(101)?.storageCleanedAt).toBe("2026-08-24T00:00:00.000Z");
      scheduler.stop();
      db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("清理会话存储时删除关联投递，保留外部接入审计和其他会话的投递", async () => {
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
    // A Task cancelled before dispatch still owns uploaded bytes, without a Run or workspace copy.
    const taskId = Number(db.prepare(`
      INSERT INTO integration_tasks
        (endpoint_id, session_id, request_id, request_fingerprint, message, effective_prompt, status, created_at)
      VALUES (?, 101, 'cancelled-upload', 'fingerprint', '', '', 'cancelled', '2026-08-01T00:00:00.000Z')
    `).run(endpointId).lastInsertRowid);
    insertSession(102, "idle", "2026-08-23T00:00:00.000Z");
    const otherTaskId = Number(db.prepare(`
      INSERT INTO integration_tasks
        (endpoint_id, session_id, request_id, request_fingerprint, message, effective_prompt, status, created_at)
      VALUES (?, 102, 'other-session', 'other-fingerprint', '', '', 'succeeded', '2026-08-23T00:00:00.000Z')
    `).run(endpointId).lastInsertRowid);
    const store = new IntegrationStore({ db });
    const subscription = store.createSubscription({
      endpointId, name: "Retention", url: "https://receiver.test/retention", enabled: false,
      eventsJson: "[]", encryptedHeaders: null, encryptedSigningSecret: "test-secret", timeoutSeconds: 10
    });
    const deliveryIds: number[] = [];
    for (const ownerTaskId of [taskId, otherTaskId, null]) {
      for (const status of ["pending", "delivering", "succeeded", "failed"]) {
        const eventId = `${ownerTaskId ?? "test"}-${status}`;
        const delivery = store.createDelivery({
          subscriptionId: subscription.id, taskId: ownerTaskId, eventId, eventKey: eventId,
          sequence: 1, eventType: "task.cancelled", payloadJson: "{}", nextAttemptAt: "2026-08-01T00:00:00.000Z"
        });
        db.prepare("UPDATE webhook_deliveries SET status = ? WHERE id = ?").run(status, delivery.id);
        if (ownerTaskId === taskId) deliveryIds.push(delivery.id);
      }
    }
    const attachments = new AttachmentStore(db);
    attachments.insert(101, { taskId }, [
      { name: "notes.txt", mediaType: "text/plain", data: Buffer.from("cancelled contents").toString("base64") }
    ]);
    const metadata = attachments.list({ taskId });
    expect(attachments.read({ taskId }, metadata[0]!.id)?.bytes.toString()).toBe("cancelled contents");
    const scheduler = new SessionCleanupScheduler({
      sessionManager: manager,
      retentionMs: 7 * 24 * 60 * 60 * 1000,
      intervalMs: 60 * 60 * 1000,
      now: () => new Date("2026-08-24T00:00:00.000Z")
    });

    await scheduler.runCleanup();
    await scheduler.runCleanup();

    expect(manager.get(101)).toMatchObject({ storageCleanedAt: "2026-08-24T00:00:00.000Z" });
    expect(existsSync(join(root, "sessions", "101"))).toBe(false);
    expect(db.prepare("SELECT session_id FROM integration_conversations WHERE conversation_key = 'ticket-1'").get())
      .toEqual({ session_id: 101 });
    expect(attachments.list({ taskId })).toEqual(metadata.map((item) => ({ ...item, available: false })));
    expect(attachments.read({ taskId }, metadata[0]!.id)).toBeUndefined();
    expect(db.prepare("SELECT status, run_id FROM integration_tasks WHERE id = ?").get(taskId))
      .toEqual({ status: "cancelled", run_id: null });
    expect(store.listDeliveries(subscription.id).map(({ taskId }) => taskId))
      .toEqual([otherTaskId, otherTaskId, otherTaskId, otherTaskId, null, null, null, null]);
    // Late HTTP completion and manual retry cannot recreate records removed by retention.
    for (const id of deliveryIds) {
      expect(store.markDeliverySucceeded(id, { statusCode: 204, durationMs: 1 })).toBeUndefined();
      expect(store.releaseDelivery(id)).toBeUndefined();
      expect(store.retryDelivery(id)).toBeUndefined();
    }
    expect(store.getSubscription(subscription.id)).toBeDefined();
    db.close();
  });
});
