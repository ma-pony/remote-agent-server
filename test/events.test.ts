import { mkdtempSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { Event } from "../src/domain.js";
import { openDatabase, migrate } from "../src/db.js";
import { EventStore } from "../src/events/event-store.js";
import {
  SSE_HISTORY_BATCH_SIZE,
  SSE_LIVE_BUFFER_LIMIT,
  streamRunEvents,
  type SseWriter
} from "../src/runs/run-routes.js";
import { createFakeRuntime, createTestDatabase } from "./helpers.js";

const tempDirs: string[] = [];
const applications: Array<{ app: FastifyInstance; db: ReturnType<typeof createTestDatabase>["db"] }> = [];
const apiToken = "test-token";
const authHeaders = (): Record<string, string> => ({ authorization: `Bearer ${apiToken}` });

class FakeSseWriter extends EventEmitter implements SseWriter {
  readonly chunks: string[] = [];
  destroyed = false;
  writableEnded = false;
  readonly write = vi.fn((chunk: string): boolean => {
    this.chunks.push(chunk);
    return true;
  });
  readonly end = vi.fn((): void => {
    this.writableEnded = true;
    this.emit("close");
  });
}

const createEventApp = async () => {
  const { db, seed } = createTestDatabase();
  const session = seed.session();
  seed.run(session.id, "succeeded");
  const run = db.prepare("SELECT id FROM runs").get() as { id: string };
  const dataDir = mkdtempSync(join(tmpdir(), "remote-agent-event-api-"));
  tempDirs.push(dataDir);
  const eventStore = new EventStore({ db });
  const app = buildApp({
    config: {
      host: "127.0.0.1",
      port: 3000,
      apiToken,
      dataDir,
      databasePath: ":memory:",
      workspaceTemplate: join(dataDir, "template"),
      sessionsRoot: join(dataDir, "sessions"),
      maxConcurrentRuns: 2
    },
    db,
    runtime: createFakeRuntime(),
    eventStore,
    commandRunner: { run: async () => ({ stdout: "", stderr: "" }) }
  });
  applications.push({ app, db });
  await app.ready();
  return { app, eventStore, runId: run.id };
};

const readSseEvents = async (reader: ReadableStreamDefaultReader<Uint8Array>, count: number): Promise<Event[]> => {
  const decoder = new TextDecoder();
  let buffer = "";
  const events: Event[] = [];
  while (events.length < count) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame.split("\n").find((line) => line.startsWith("data: "));
      if (data !== undefined) events.push(JSON.parse(data.slice("data: ".length)) as Event);
    }
  }
  return events;
};

afterEach(async () => {
  await Promise.all(applications.splice(0).map(async ({ app, db }) => {
    await app.close();
    db.close();
  }));
  tempDirs.splice(0).forEach((directory) => rmSync(directory, { force: true, recursive: true }));
});

describe("EventStore", () => {
  it("并发追加时为单个 Run 生成连续 seq", async () => {
    const { db, seed } = createTestDatabase();
    const session = seed.session();
    seed.run(session.id, "queued");
    const run = db.prepare("SELECT id FROM runs").get() as { id: string };
    const store = new EventStore({ db });

    await Promise.all([
      store.append(run.id, "status", { text: "a" }),
      store.append(run.id, "message", { text: "b" })
    ]);

    expect(store.list(run.id, 0).map((event) => event.seq)).toEqual([1, 2]);
    expect(store.list(run.id, 1)).toMatchObject([{ seq: 2, type: "message" }]);
    db.close();
  });

  it("订阅者同步或异步异常不会反抛 append，也不影响其他订阅者", async () => {
    const { db, seed } = createTestDatabase();
    const session = seed.session();
    seed.run(session.id, "queued");
    const run = db.prepare("SELECT id FROM runs").get() as { id: string };
    const store = new EventStore({ db });
    const observed: number[] = [];
    store.subscribe(run.id, () => { throw new Error("broken sync listener"); });
    store.subscribe(run.id, async () => { throw new Error("broken async listener"); });
    store.subscribe(run.id, (event) => { observed.push(event.seq); });

    expect(() => store.append(run.id, "status", { text: "persisted" })).not.toThrow();
    await Promise.resolve();

    expect(observed).toEqual([1]);
    expect(store.list(run.id, 0)).toHaveLength(1);
    db.close();
  });

  it("只在事务提交后通知订阅者", () => {
    const directory = mkdtempSync(join(tmpdir(), "remote-agent-events-"));
    tempDirs.push(directory);
    const databasePath = join(directory, "events.sqlite3");
    const db = openDatabase(databasePath);
    migrate(db);
    db.prepare("INSERT INTO agents (id, name, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("agent-1", "Test agent", "codex", "2026-08-12T00:00:00.000Z", "2026-08-12T00:00:00.000Z");
    db.prepare("INSERT INTO sessions (id, agent_id, title, status, workspace_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("session-1", "agent-1", "Test session", "idle", "/tmp/session-1", "2026-08-12T00:00:00.000Z", "2026-08-12T00:00:00.000Z");
    db.prepare("INSERT INTO runs (id, session_id, status, input, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("run-1", "session-1", "queued", "test input", "2026-08-12T00:00:00.000Z");
    const observerDb = openDatabase(databasePath);
    const store = new EventStore({ db });
    let observedCount: number | undefined;

    const unsubscribe = store.subscribe("run-1", () => {
      observedCount = (observerDb.prepare("SELECT count(*) AS count FROM events WHERE run_id = ?").get("run-1") as { count: number }).count;
    });
    store.append("run-1", "status", { text: "persisted" });

    expect(observedCount).toBe(1);
    unsubscribe();
    observerDb.close();
    db.close();
  });
});

describe("Event API", () => {
  it("afterSeq 只返回游标后的持久化事件", async () => {
    const { app, eventStore, runId } = await createEventApp();
    eventStore.append(runId, "status", { text: "one" });
    eventStore.append(runId, "message", { text: "two" });
    eventStore.append(runId, "tool", { title: "three" });

    const response = await app.inject({
      method: "GET",
      url: `/api/runs/${runId}/events?afterSeq=2`,
      headers: authHeaders()
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject([{ seq: 3, type: "tool" }]);
  });

  it("SSE history 按固定批次读取而不是一次加载全部", async () => {
    const { eventStore, runId } = await createEventApp();
    for (let index = 0; index < SSE_HISTORY_BATCH_SIZE + 1; index += 1) {
      eventStore.append(runId, "message", { index });
    }
    const listBatch = vi.spyOn(eventStore, "listBatch");
    const writer = new FakeSseWriter();

    const streaming = streamRunEvents(eventStore, runId, 0, writer);
    await vi.waitFor(() => expect(writer.write).toHaveBeenCalledTimes(SSE_HISTORY_BATCH_SIZE + 1));
    writer.emit("close");
    await streaming;

    expect(listBatch).toHaveBeenCalledTimes(2);
    expect(listBatch.mock.calls.every((call) => call[3] === SSE_HISTORY_BATCH_SIZE)).toBe(true);
  });

  it("SSE write false 时等待 drain 后才继续写下一条", async () => {
    const { eventStore, runId } = await createEventApp();
    eventStore.append(runId, "status", { text: "one" });
    eventStore.append(runId, "status", { text: "two" });
    const writer = new FakeSseWriter();
    writer.write.mockImplementation((chunk: string) => {
      writer.chunks.push(chunk);
      return writer.write.mock.calls.length > 1;
    });

    const streaming = streamRunEvents(eventStore, runId, 0, writer);
    await vi.waitFor(() => expect(writer.write).toHaveBeenCalledTimes(1));
    expect(writer.chunks[0]).toContain("id: 1");

    writer.emit("drain");
    await vi.waitFor(() => expect(writer.write).toHaveBeenCalledTimes(2));
    expect(writer.chunks[1]).toContain("id: 2");
    writer.emit("close");
    await streaming;
  });

  it("SSE live write 抛错时安全断开并退订，不影响 Run 或后续 append", async () => {
    const { eventStore, runId } = await createEventApp();
    const writer = new FakeSseWriter();
    writer.write.mockImplementation(() => { throw new Error("socket write failed"); });
    const originalSubscribe = eventStore.subscribe.bind(eventStore);
    const unsubscribed = vi.fn();
    vi.spyOn(eventStore, "subscribe").mockImplementation((id, listener) => {
      const unsubscribe = originalSubscribe(id, listener);
      return () => {
        unsubscribed();
        unsubscribe();
      };
    });

    const streaming = streamRunEvents(eventStore, runId, 0, writer);
    await vi.waitFor(() => expect(eventStore.subscribe).toHaveBeenCalledTimes(1));
    eventStore.append(runId, "message", { text: "break writer" });
    await streaming;

    expect(unsubscribed).toHaveBeenCalledTimes(1);
    expect(() => eventStore.append(runId, "status", { text: "run continues" })).not.toThrow();
    expect(eventStore.list(runId, 0)).toHaveLength(2);
  });

  it.each(["close", "error"] as const)("SSE writer %s 时立即退订且不影响 EventStore", async (signal) => {
    const { eventStore, runId } = await createEventApp();
    const writer = new FakeSseWriter();
    const originalSubscribe = eventStore.subscribe.bind(eventStore);
    const unsubscribed = vi.fn();
    vi.spyOn(eventStore, "subscribe").mockImplementation((id, listener) => {
      const unsubscribe = originalSubscribe(id, listener);
      return () => {
        unsubscribed();
        unsubscribe();
      };
    });
    const streaming = streamRunEvents(eventStore, runId, 0, writer);
    await vi.waitFor(() => expect(eventStore.subscribe).toHaveBeenCalledTimes(1));

    if (signal === "error") writer.emit(signal, new Error("socket failed"));
    else writer.emit(signal);
    await streaming;

    expect(unsubscribed).toHaveBeenCalledTimes(1);
    expect(() => eventStore.append(runId, "message", { text: "still running" })).not.toThrow();
  });

  it("SSE live buffer 超限时断开，由客户端按最后 seq 重连", async () => {
    const { eventStore, runId } = await createEventApp();
    const writer = new FakeSseWriter();
    writer.write.mockReturnValue(false);
    vi.spyOn(eventStore, "subscribe");
    const streaming = streamRunEvents(eventStore, runId, 0, writer);
    await vi.waitFor(() => expect(eventStore.subscribe).toHaveBeenCalledTimes(1));

    for (let index = 0; index <= SSE_LIVE_BUFFER_LIMIT + 1; index += 1) {
      eventStore.append(runId, "message", { index });
    }
    await streaming;

    expect(writer.end).toHaveBeenCalledTimes(1);
    expect(eventStore.list(runId, 0)).toHaveLength(SSE_LIVE_BUFFER_LIMIT + 2);
  });

  it("SSE reconnect 按游标回放、订阅后二次补洞、推送 live，并在关闭时退订", async () => {
    const { app, eventStore, runId } = await createEventApp();
    eventStore.append(runId, "status", { text: "already-seen" });
    eventStore.append(runId, "status", { text: "replayed" });
    const originalSubscribe = eventStore.subscribe.bind(eventStore);
    const unsubscribed = vi.fn();
    vi.spyOn(eventStore, "subscribe").mockImplementation((subscribedRunId, listener) => {
      const unsubscribe = originalSubscribe(subscribedRunId, listener);
      eventStore.append(runId, "message", { text: "gap" });
      return () => {
        unsubscribed();
        unsubscribe();
      };
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP server address");
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/runs/${runId}/events/stream?afterSeq=1`, {
      headers: authHeaders(),
      signal: controller.signal
    });
    if (response.body === null) throw new Error("Expected SSE response body");
    const reader = response.body.getReader();
    eventStore.append(runId, "tool", { title: "live" });

    const events = await readSseEvents(reader, 3);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("connection")).toBe("keep-alive");
    expect(events.map((event) => event.seq)).toEqual([2, 3, 4]);
    expect(events.map((event) => JSON.parse(event.contentJson))).toEqual([
      { text: "replayed" },
      { text: "gap" },
      { title: "live" }
    ]);

    controller.abort();
    await reader.cancel().catch(() => undefined);
    await vi.waitFor(() => expect(unsubscribed).toHaveBeenCalledTimes(1));
  });
});
