import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase, migrate } from "../src/db.js";
import { EventStore } from "../src/events/event-store.js";
import { createTestDatabase } from "./helpers.js";

const tempDirs: string[] = [];

afterEach(() => {
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
