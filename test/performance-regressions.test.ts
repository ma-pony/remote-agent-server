import { describe, expect, it, vi } from "vitest";

import { migrate } from "../src/db.js";
import { EventStore } from "../src/events/event-store.js";
import { IntegrationProjection } from "../src/integrations/integration-projection.js";
import { IntegrationStore } from "../src/integrations/integration-store.js";
import { RunRepository } from "../src/runs/run-repository.js";
import { finishSessionMaintenance } from "../src/sessions/session-maintenance.js";
import { createTestDatabase } from "./helpers.js";

const now = "2026-08-21T00:00:00.000Z";

const createHarness = () => {
  const { db, seed } = createTestDatabase();
  const store = new IntegrationStore({ db });
  const endpointId = Number(db.prepare(`
    INSERT INTO integration_endpoints
      (name, slug, agent_id, enabled, token_hash, created_at, updated_at)
    VALUES ('Performance', 'performance', ?, 1, 'performance-token', ?, ?)
  `).run(seed.agent.id, now, now).lastInsertRowid);
  const session = seed.session();
  const task = store.createTask({
    endpointId,
    conversationId: null,
    sessionId: session.id,
    requestId: "performance-request",
    requestFingerprint: "performance-fingerprint",
    message: "performance",
    effectivePrompt: "performance",
    encryptedParameters: null
  });
  const listEvents = vi.fn(() => []);
  const projection = new IntegrationProjection({ db, store, listEvents });
  const runRepository = new RunRepository({ db, projection });
  const run = runRepository.create(
    { sessionId: session.id, input: "performance" },
    { afterInsert: (created) => { store.linkTaskRunInTransaction(task.id, created.id); } }
  );
  return { db, store, task, run, runRepository, projection, listEvents };
};

describe("performance regressions", () => {
  it.each(["projected", "interrupted"])("projection recovery and repair preserve cleaned deliveries (%s Task)", (taskState) => {
    const { db, store, task, run, runRepository, projection } = createHarness();
    const subscription = store.createSubscription({
      endpointId: task.endpointId, name: "Retention", url: "https://receiver.test/retention", enabled: true,
      eventsJson: '["task.succeeded"]', encryptedHeaders: null, encryptedSigningSecret: "test-secret", timeoutSeconds: 10
    });
    try {
      runRepository.markRunning(run.id);
      runRepository.finish(run.id, { status: "succeeded", result: "done" });
      expect(store.listDeliveries(subscription.id)).toHaveLength(1);
      if (taskState === "interrupted") {
        // Recovery supports old persisted states where the terminal Task projection is missing.
        db.prepare("UPDATE integration_tasks SET status = 'running', finished_at = NULL WHERE id = ?").run(task.id);
      }
      db.prepare("UPDATE sessions SET status = 'running', pending_operation = 'cleanup' WHERE id = ?")
        .run(task.sessionId);
      finishSessionMaintenance(db, task.sessionId, "cleanup");
      expect(store.listDeliveries(subscription.id)).toEqual([]);
      projection.recover();
      projection.repairAll();
      expect(store.listDeliveries(subscription.id)).toEqual([]);
      expect(store.getTask(task.id)).toMatchObject({ status: "succeeded" });
    } finally {
      db.close();
    }
  });

  it.each(["fresh", "upgraded"])("latest Webhook deliveries use one indexed lookup per subscription (%s database)", (schema) => {
    const { db, store, task } = createHarness();
    const subscription = store.createSubscription({
      endpointId: task.endpointId,
      name: "History",
      url: "https://receiver.test/history",
      enabled: false,
      eventsJson: "[]",
      encryptedHeaders: null,
      encryptedSigningSecret: "test-secret",
      timeoutSeconds: 10
    });
    db.transaction(() => {
      for (let index = 0; index < 100; index += 1) {
        store.createDeliveryInTransaction({
          eventId: `history-${index}`,
          eventKey: `history-${index}`,
          sequence: index + 1,
          dispatchOrder: index + 1,
          subscriptionId: subscription.id,
          taskId: task.id,
          eventType: "task.succeeded",
          payloadJson: "{}",
          nextAttemptAt: now
        });
      }
    })();
    if (schema === "upgraded") {
      db.exec("DROP INDEX IF EXISTS webhook_deliveries_subscription_recent");
      migrate(db);
      migrate(db);
    }

    // Inspect the SQL actually executed by the store, so changing that query is covered.
    const prepare = vi.spyOn(db, "prepare");
    let latestSql: string | undefined;
    try {
      const page = store.listDeliveriesForEndpoint(task.endpointId, { page: 1, pageSize: 20 });
      expect(page.total).toBe(100);
      expect(page.items).toHaveLength(20);
      expect(page.latest).toHaveLength(1);
      expect(page.latest[0]?.id).toBe(page.items[0]?.id);
      latestSql = prepare.mock.calls.find(([sql]) => sql.includes("SELECT recent.id"))?.[0];
    } finally {
      prepare.mockRestore();
    }

    try {
      expect(latestSql).toBeDefined();
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${latestSql}`).all(task.endpointId) as Array<{ detail: string }>;
      const details = plan.map(({ detail }) => detail).join("\n");
      expect(details).toContain("SEARCH delivery USING INTEGER PRIMARY KEY");
      expect(details).toContain("SEARCH recent USING COVERING INDEX webhook_deliveries_subscription_recent");
      // Only the final, one-row-per-subscription result may need sorting.
      expect(plan.filter(({ detail }) => detail.includes("USE TEMP B-TREE"))).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("startup recovery ignores already projected historical Runs", () => {
    const harness = createHarness();
    harness.runRepository.markRunning(harness.run.id);
    harness.runRepository.finish(harness.run.id, { status: "succeeded", result: "done" });
    harness.listEvents.mockClear();

    harness.projection.recover();

    expect(harness.listEvents).not.toHaveBeenCalled();
    harness.db.close();
  });

  it("tool projection uses deterministic keys without scanning Run history", () => {
    const harness = createHarness();
    harness.db.prepare("UPDATE runs SET status = 'running', started_at = ? WHERE id = ?")
      .run(now, harness.run.id);
    harness.db.prepare("UPDATE integration_tasks SET status = 'running', started_at = ? WHERE id = ?")
      .run(now, harness.task.id);
    const eventStore = new EventStore({ db: harness.db, projection: harness.projection });

    eventStore.append(harness.run.id, "tool", { toolCallId: "tool-1", status: "completed" });

    expect(harness.listEvents).not.toHaveBeenCalled();
    harness.db.close();
  });

  it("Run 完成时只读取消息和状态，不遍历工具事件历史", () => {
    const harness = createHarness();
    harness.runRepository.markRunning(harness.run.id);
    const eventStore = new EventStore({ db: harness.db });
    eventStore.append(harness.run.id, "message", { stream: "output", text: "done" });
    for (let index = 0; index < 20; index += 1) {
      eventStore.append(harness.run.id, "tool", { toolCallId: `tool-${index}`, status: "completed" });
    }
    harness.listEvents.mockImplementation(() => { throw new Error("full history scan"); });

    expect(() => harness.runRepository.finish(harness.run.id, { status: "succeeded", result: "done" })).not.toThrow();
    const reply = harness.db.prepare(`
      SELECT payload_json FROM integration_task_events
      WHERE task_id = ? AND event_type = 'message.agent.reply'
    `).get(harness.task.id) as { payload_json: string };
    expect(JSON.parse(reply.payload_json)).toMatchObject({ message: { content: "done" } });
    expect(harness.listEvents).not.toHaveBeenCalled();
    harness.db.close();
  });

  it("persists Task event identities without growing legacy JSON maps", () => {
    const harness = createHarness();

    harness.db.transaction(() => {
      harness.store.appendTaskEventInTransaction({
        taskId: harness.task.id,
        eventType: "task.started",
        eventKey: `${harness.task.id}:task.started`,
        occurredAt: now,
        payload: { status: "running" }
      });
      harness.store.appendTaskEventInTransaction({
        taskId: harness.task.id,
        eventType: "task.succeeded",
        eventKey: `${harness.task.id}:task.succeeded`,
        occurredAt: now,
        payload: { status: "succeeded" }
      });
    })();

    const task = harness.db.prepare(`
      SELECT event_sequences_json, event_dispatch_orders_json
      FROM integration_tasks WHERE id = ?
    `).get(harness.task.id) as { event_sequences_json: string; event_dispatch_orders_json: string };
    const count = harness.db.prepare(`
      SELECT COUNT(*) AS count FROM integration_task_events WHERE task_id = ?
    `).get(harness.task.id) as { count: number };
    expect(task).toEqual({ event_sequences_json: "{}", event_dispatch_orders_json: "{}" });
    expect(count.count).toBe(2);
    harness.db.close();
  });

  it("creates indexes for hot Session, Run, and Webhook queries", () => {
    const { db } = createTestDatabase();
    const plans = [
      db.prepare(`EXPLAIN QUERY PLAN
        SELECT * FROM runs WHERE session_id = 1 ORDER BY created_at ASC, id ASC`).all(),
      db.prepare(`EXPLAIN QUERY PLAN
        SELECT * FROM sessions ORDER BY created_at DESC, id DESC`).all(),
      db.prepare(`EXPLAIN QUERY PLAN
        SELECT * FROM webhook_deliveries
        WHERE task_id = 1 AND event_key = 'event' ORDER BY id ASC`).all(),
      db.prepare(`EXPLAIN QUERY PLAN
        SELECT id FROM webhook_deliveries
        WHERE subscription_id = 1 AND status IN ('pending', 'delivering')
        ORDER BY dispatch_order ASC, id ASC LIMIT 1`).all(),
      db.prepare(`EXPLAIN QUERY PLAN
        SELECT seq, type, content_json FROM events
        WHERE run_id = 1 AND type IN ('message', 'status', 'error') ORDER BY seq ASC`).all(),
      db.prepare(`EXPLAIN QUERY PLAN
        SELECT COUNT(*) FROM integration_conversations
        WHERE endpoint_id = 1 AND status = 'active'`).all(),
      db.prepare(`EXPLAIN QUERY PLAN
        SELECT COUNT(*) FROM integration_tasks
        WHERE endpoint_id = 1 AND status IN ('queued', 'running')`).all(),
      db.prepare(`EXPLAIN QUERY PLAN
        SELECT id FROM integration_tasks WHERE endpoint_id = 1
        ORDER BY created_at DESC, id DESC LIMIT 1`).all(),
      db.prepare(`EXPLAIN QUERY PLAN
        SELECT id FROM integration_conversations WHERE session_id = 1
        ORDER BY created_at DESC, id DESC LIMIT 1`).all(),
      db.prepare(`EXPLAIN QUERY PLAN
        SELECT id FROM integration_tasks WHERE session_id = 1
        ORDER BY created_at DESC, id DESC LIMIT 1`).all()
    ].flat() as Array<{ detail: string }>;

    const details = plans.map(({ detail }) => detail).join("\n");
    expect(details).toContain("runs_session_history");
    expect(details).toContain("sessions_recent");
    expect(details).toContain("webhook_deliveries_task_event");
    expect(details).toContain("webhook_deliveries_subscription_queue");
    expect(details).toContain("events_run_completion");
    expect(details).toContain("integration_conversations_endpoint_status");
    expect(details).toContain("integration_tasks_endpoint_status");
    expect(details).toContain("integration_tasks_endpoint_recent");
    expect(details).toContain("integration_conversations_session_recent");
    expect(details).toContain("integration_tasks_session_recent");
    expect(details).not.toContain("USE TEMP B-TREE");
    db.close();
  });
});
