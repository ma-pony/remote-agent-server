import type Database from "better-sqlite3";

import { migrate, openDatabase } from "../src/db.js";

let nextId = 0;

const id = (prefix: string): string => `${prefix}-${++nextId}`;
const now = (): string => "2026-08-12T00:00:00.000Z";

export const createTestDatabase = (): {
  db: Database.Database;
  seed: {
    session: () => { id: string };
    run: (sessionId: string, status: "queued" | "running" | "succeeded" | "failed" | "cancelled") => void;
  };
} => {
  const db = openDatabase(":memory:");
  migrate(db);

  const agentId = id("agent");
  db.prepare(
    "INSERT INTO agents (id, name, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  ).run(agentId, "Test agent", "codex", now(), now());

  return {
    db,
    seed: {
      session: () => {
        const sessionId = id("session");
        db.prepare(
          "INSERT INTO sessions (id, agent_id, title, status, workspace_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).run(sessionId, agentId, "Test session", "idle", `/tmp/${sessionId}`, now(), now());
        return { id: sessionId };
      },
      run: (sessionId, status) => {
        db.prepare(
          "INSERT INTO runs (id, session_id, status, input, created_at) VALUES (?, ?, ?, ?, ?)"
        ).run(id("run"), sessionId, status, "test input", now());
      }
    }
  };
};
