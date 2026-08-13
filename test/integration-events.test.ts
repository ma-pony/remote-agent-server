import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Event } from "../src/domain.js";
import { EventStore } from "../src/events/event-store.js";
import {
  listIntegrationTaskEvents,
  streamIntegrationTaskEvents
} from "../src/integrations/integration-routes.js";
import { IntegrationStore } from "../src/integrations/integration-store.js";
import type { SseWriter } from "../src/runs/run-routes.js";
import { createTestDatabase } from "./helpers.js";

class FakeSseWriter extends EventEmitter implements SseWriter {
  readonly chunks: string[] = [];
  destroyed = false;
  writableEnded = false;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  end(): void {
    this.writableEnded = true;
    this.emit("close");
  }
}

const resources: Array<{ close(): void }> = [];

afterEach(() => {
  vi.useRealTimers();
  resources.splice(0).forEach((resource) => resource.close());
});

const setup = () => {
  const { db, seed } = createTestDatabase();
  resources.push(db);
  const session = seed.session();
  const store = new IntegrationStore({ db });
  const endpoint = store.createEndpoint({
    id: "endpoint-1",
    name: "Endpoint",
    slug: "endpoint",
    agentId: seed.agent.id,
    enabled: true,
    tokenHash: "token-hash",
    promptPrefix: "",
    parameterMappings: [],
    encryptedFixedValues: null
  });
  const task = store.createTask({
    id: "task-1",
    endpointId: endpoint.id,
    conversationId: null,
    sessionId: session.id,
    requestId: "request-1",
    requestFingerprint: "fingerprint",
    message: "hello",
    effectivePrompt: "hello",
    encryptedParameters: null
  });
  const eventStore = new EventStore({ db });
  return { db, endpoint, eventStore, session, store, task };
};

const linkRun = (context: ReturnType<typeof setup>): string => {
  const runId = "run-1";
  context.db.exec("BEGIN IMMEDIATE");
  try {
    context.db.prepare(
      "INSERT INTO runs (id, session_id, status, input, created_at) VALUES (?, ?, 'queued', ?, ?)"
    ).run(runId, context.session.id, "hello", new Date().toISOString());
    context.store.linkTaskRunInTransaction(context.task.id, runId);
    context.db.exec("COMMIT");
  } catch (error) {
    context.db.exec("ROLLBACK");
    throw error;
  }
  context.store.notifyTaskChanged(context.task.id);
  return runId;
};

const parsedEvents = (writer: FakeSseWriter): Event[] => writer.chunks.flatMap((chunk) => {
  const data = chunk.split("\n").find((line) => line.startsWith("data: "));
  return data === undefined ? [] : [JSON.parse(data.slice("data: ".length)) as Event];
});

describe("Integration Task events", () => {
  it("Task 尚未关联 Run 时历史为空，关联后按 afterSeq 补读", () => {
    const context = setup();

    expect(listIntegrationTaskEvents(context.store, context.eventStore, context.task.id, context.endpoint.id, 0)).toEqual([]);
    const runId = linkRun(context);
    context.eventStore.append(runId, "message", { text: "one" });
    context.eventStore.append(runId, "tool", { title: "two" });

    expect(listIntegrationTaskEvents(context.store, context.eventStore, context.task.id, context.endpoint.id, 1))
      .toMatchObject([{ seq: 2, type: "tool" }]);
  });

  it("SSE 等待 Run、每 20 秒 heartbeat、补齐事件并在 Task 终态关闭", async () => {
    vi.useFakeTimers();
    const context = setup();
    const writer = new FakeSseWriter();
    const originalSubscribe = context.store.subscribeTask.bind(context.store);
    const unsubscribed = vi.fn();
    vi.spyOn(context.store, "subscribeTask").mockImplementation((taskId, listener) => {
      const unsubscribe = originalSubscribe(taskId, listener);
      return () => {
        unsubscribed();
        unsubscribe();
      };
    });
    const streaming = streamIntegrationTaskEvents({
      store: context.store,
      eventStore: context.eventStore,
      taskId: context.task.id,
      endpointId: context.endpoint.id,
      afterSeq: 0,
      writer
    });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(writer.chunks).toContain(": heartbeat\n\n");

    const runId = linkRun(context);
    context.eventStore.append(runId, "message", { text: "one" });
    context.eventStore.append(runId, "tool", { title: "two" });
    context.eventStore.append(runId, "status", { status: "succeeded" });
    context.db.prepare(
      "UPDATE integration_tasks SET status = 'succeeded', result = 'done', finished_at = ? WHERE id = ?"
    ).run(new Date().toISOString(), context.task.id);
    context.store.notifyTaskChanged(context.task.id);

    await vi.runAllTimersAsync();
    await streaming;

    expect(parsedEvents(writer).map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(writer.writableEnded).toBe(true);
    expect(unsubscribed).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("queued 取消原子写终态并只在提交后通知", () => {
    const context = setup();
    const observed = vi.fn(() => {
      expect(context.store.getTask(context.task.id)?.status).toBe("cancelled");
    });
    context.store.subscribeTask(context.task.id, observed);

    const cancelled = context.store.cancelUnlinkedQueuedTask(context.task.id, context.endpoint.id);

    expect(cancelled).toMatchObject({ status: "cancelled", runId: null });
    expect(observed).toHaveBeenCalledTimes(1);
  });
});
