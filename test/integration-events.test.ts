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
  if (!chunk.includes("id: ")) return [];
  const data = chunk.split("\n").find((line) => line.startsWith("data: "));
  return data === undefined ? [] : [JSON.parse(data.slice("data: ".length)) as Event];
});

const taskStatusFrames = (writer: FakeSseWriter): Array<{ status: string }> => writer.chunks.flatMap((chunk) => {
  if (!chunk.includes("event: task.status")) return [];
  const data = chunk.split("\n").find((line) => line.startsWith("data: "));
  return data === undefined ? [] : [JSON.parse(data.slice("data: ".length)) as { status: string }];
});

const finishTask = (
  context: ReturnType<typeof setup>,
  status: "succeeded" | "failed" | "cancelled"
): void => {
  context.db.prepare(
    "UPDATE integration_tasks SET status = ?, finished_at = ? WHERE id = ?"
  ).run(status, new Date().toISOString(), context.task.id);
  context.store.notifyTaskChanged(context.task.id);
};

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
    finishTask(context, "succeeded");

    await vi.runAllTimersAsync();
    await streaming;

    expect(parsedEvents(writer).map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(taskStatusFrames(writer)).toEqual([{ status: "succeeded" }]);
    expect(writer.writableEnded).toBe(true);
    expect(unsubscribed).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("外部 SSE 与查询使用同一公开投影且不传输工具原始内容", async () => {
    const context = setup();
    const runId = linkRun(context);
    const secret = "sse-tool-secret-must-not-leak";
    context.eventStore.append(runId, "message", { stream: "output", text: "safe reply" });
    context.eventStore.append(runId, "tool", {
      toolCallId: "tool-sse",
      status: "completed",
      rawInput: { token: secret },
      rawOutput: { value: secret },
      content: { nested: secret }
    });
    const writer = new FakeSseWriter();
    finishTask(context, "succeeded");

    await streamIntegrationTaskEvents({
      store: context.store,
      eventStore: context.eventStore,
      taskId: context.task.id,
      endpointId: context.endpoint.id,
      afterSeq: 0,
      writer
    });

    const events = parsedEvents(writer);
    expect(events.map(({ seq, type }) => ({ seq, type }))).toEqual([
      { seq: 1, type: "message" },
      { seq: 2, type: "tool" }
    ]);
    expect(JSON.parse(events[1]!.contentJson)).toEqual({ toolCallId: "tool-sse", status: "completed" });
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain("rawInput");
    expect(JSON.stringify(events)).not.toContain("rawOutput");
    expect(JSON.stringify(events)).not.toContain('"content"');
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

  it("连接后 queued 取消会发送一次不占 Run seq 的 canonical terminal frame", async () => {
    const context = setup();
    const writer = new FakeSseWriter();
    const streaming = streamIntegrationTaskEvents({
      store: context.store,
      eventStore: context.eventStore,
      taskId: context.task.id,
      endpointId: context.endpoint.id,
      afterSeq: 99,
      writer
    });

    context.store.cancelUnlinkedQueuedTask(context.task.id, context.endpoint.id);
    await streaming;

    expect(taskStatusFrames(writer)).toEqual([{ status: "cancelled" }]);
    expect(writer.chunks).toContain('event: task.status\ndata: {"status":"cancelled"}\n\n');
    expect(writer.chunks.join("")).not.toContain("id:");
    expect(writer.writableEnded).toBe(true);
  });

  it("Task 在 SSE 连接前已终态也发送 canonical terminal frame 后关闭", async () => {
    const context = setup();
    context.store.cancelUnlinkedQueuedTask(context.task.id, context.endpoint.id);
    const writer = new FakeSseWriter();

    await streamIntegrationTaskEvents({
      store: context.store,
      eventStore: context.eventStore,
      taskId: context.task.id,
      endpointId: context.endpoint.id,
      afterSeq: 0,
      writer
    });

    expect(taskStatusFrames(writer)).toEqual([{ status: "cancelled" }]);
    expect(writer.writableEnded).toBe(true);
  });

  it("已关联 queued Run 没有 status Event 时仍发送 canonical terminal frame", async () => {
    const context = setup();
    linkRun(context);
    const writer = new FakeSseWriter();
    const streaming = streamIntegrationTaskEvents({
      store: context.store,
      eventStore: context.eventStore,
      taskId: context.task.id,
      endpointId: context.endpoint.id,
      afterSeq: 0,
      writer
    });

    finishTask(context, "cancelled");
    await streaming;

    expect(parsedEvents(writer)).toEqual([]);
    expect(taskStatusFrames(writer)).toEqual([{ status: "cancelled" }]);
  });

  it("等待 Run 的 heartbeat 遇到背压会等待 drain 后继续且不并发写", async () => {
    vi.useFakeTimers();
    const context = setup();
    const writer = new FakeSseWriter();
    let writes = 0;
    const write = vi.spyOn(writer, "write").mockImplementation((chunk) => {
      writer.chunks.push(chunk);
      writes += 1;
      return writes > 1;
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
    expect(write).toHaveBeenCalledTimes(1);
    expect(writer.writableEnded).toBe(false);
    writer.emit("drain");
    await vi.advanceTimersByTimeAsync(0);
    context.store.cancelUnlinkedQueuedTask(context.task.id, context.endpoint.id);
    await streaming;

    expect(write).toHaveBeenCalledTimes(2);
    expect(taskStatusFrames(writer)).toEqual([{ status: "cancelled" }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("等待 Run 的 heartbeat 永不 drain 时在 timeout 后结束并清理 listener/timer", async () => {
    vi.useFakeTimers();
    const context = setup();
    const writer = new FakeSseWriter();
    vi.spyOn(writer, "write").mockReturnValue(false);
    const streaming = streamIntegrationTaskEvents({
      store: context.store,
      eventStore: context.eventStore,
      taskId: context.task.id,
      endpointId: context.endpoint.id,
      afterSeq: 0,
      writer
    });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(writer.writableEnded).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await streaming;

    expect(writer.writableEnded).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("Run live heartbeat 背压期间缓存 Event，drain 后按单一管线继续", async () => {
    vi.useFakeTimers();
    const context = setup();
    const runId = linkRun(context);
    const writer = new FakeSseWriter();
    let writes = 0;
    const write = vi.spyOn(writer, "write").mockImplementation((chunk) => {
      writer.chunks.push(chunk);
      writes += 1;
      return writes > 1;
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
    expect(write).toHaveBeenCalledTimes(1);
    context.eventStore.append(runId, "message", { text: "buffered" });
    expect(write).toHaveBeenCalledTimes(1);

    writer.emit("drain");
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    finishTask(context, "cancelled");
    await streaming;

    expect(writer.chunks[0]).toBe(": heartbeat\n\n");
    expect(writer.chunks[1]).toContain("id: 1");
    expect(taskStatusFrames(writer)).toEqual([{ status: "cancelled" }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("Task listener 异常互相隔离，事务回滚时不通知", async () => {
    const context = setup();
    const observed = vi.fn();
    context.store.subscribeTask(context.task.id, () => { throw new Error("sync listener failed"); });
    context.store.subscribeTask(context.task.id, async () => { throw new Error("async listener failed"); });
    context.store.subscribeTask(context.task.id, observed);

    expect(() => context.store.cancelUnlinkedQueuedTask(context.task.id, context.endpoint.id)).not.toThrow();
    await Promise.resolve();
    expect(observed).toHaveBeenCalledTimes(1);

    const rollback = setup();
    const rollbackObserved = vi.fn();
    rollback.store.subscribeTask(rollback.task.id, rollbackObserved);
    rollback.db.exec(`
      CREATE TRIGGER reject_task_cancel
      BEFORE UPDATE ON integration_tasks
      WHEN NEW.id = 'task-1' AND NEW.status = 'cancelled'
      BEGIN
        SELECT RAISE(ABORT, 'cancel rejected');
      END;
    `);

    expect(() => rollback.store.cancelUnlinkedQueuedTask(rollback.task.id, rollback.endpoint.id))
      .toThrow("cancel rejected");
    expect(rollback.store.getTask(rollback.task.id)?.status).toBe("queued");
    expect(rollbackObserved).not.toHaveBeenCalled();
  });
});
