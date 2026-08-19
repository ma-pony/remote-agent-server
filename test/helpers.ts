import type Database from "better-sqlite3";

import { migrate, openDatabase } from "../src/db.js";
import type {
  AgentRuntime,
  RuntimeDoctor,
  RuntimeEvent,
  RuntimeSession,
  RuntimeSessionInput,
  RuntimeTurn,
  RuntimeTurnInput,
  RuntimeTurnResult
} from "../src/runtime/agent-runtime.js";

const now = (): string => "2026-08-12T00:00:00.000Z";

export const createTestDatabase = (databasePath = ":memory:"): {
  db: Database.Database;
  seed: {
    projectEnvironment: { id: number; revisionId: number; workspacePath: string };
    agent: { id: number };
    session: () => { id: number };
    run: (sessionId: number, status: "queued" | "running" | "succeeded" | "failed" | "cancelled") => void;
  };
} => {
  const db = openDatabase(databasePath);
  migrate(db);
  let sessionSequence = 0;

  const projectEnvironmentId = Number(db.prepare(
    "INSERT INTO project_environments (name, created_at, updated_at) VALUES (?, ?, ?)"
  ).run("Test environment", now(), now()).lastInsertRowid);
  const projectEnvironmentRevisionId = Number(db.prepare(`
    INSERT INTO project_environment_revisions
      (project_environment_id, status, workspace_path, input_fingerprint, created_at, finished_at)
    VALUES (?, 'ready', ?, ?, ?, ?)
  `).run(
    projectEnvironmentId,
    `/tmp/${projectEnvironmentId}/workspace`,
    "test-input",
    now(),
    now()
  ).lastInsertRowid);
  const projectEnvironmentWorkspacePath = `/tmp/${projectEnvironmentId}/workspace`;
  db.prepare("UPDATE project_environments SET current_revision_id = ? WHERE id = ?")
    .run(projectEnvironmentRevisionId, projectEnvironmentId);
  const agentId = Number(db.prepare(
    "INSERT INTO agents (name, provider, project_environment_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  ).run("Test agent", "codex", projectEnvironmentId, now(), now()).lastInsertRowid);

  return {
    db,
    seed: {
      projectEnvironment: {
        id: projectEnvironmentId,
        revisionId: projectEnvironmentRevisionId,
        workspacePath: projectEnvironmentWorkspacePath
      },
      agent: { id: agentId },
      session: () => {
        const sessionId = Number(db.prepare(
          "INSERT INTO sessions (agent_id, title, status, workspace_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(agentId, "Test session", "idle", `/tmp/session-${++sessionSequence}`, now(), now()).lastInsertRowid);
        return { id: sessionId };
      },
      run: (sessionId, status) => {
        db.prepare(
          "INSERT INTO runs (session_id, status, input, created_at) VALUES (?, ?, ?, ?)"
        ).run(sessionId, status, "test input", now());
      }
    }
  };
};

export type FakeRuntimeOptions = {
  events?: RuntimeEvent[];
  result?: RuntimeTurnResult;
  providerSessionId?: string | null;
  doctor?: RuntimeDoctor;
};

/**
 * Creates a deterministic in-memory AgentRuntime for API and executor tests.
 */
export const createFakeRuntime = (options: FakeRuntimeOptions = {}): AgentRuntime => ({
  ensureSession: async (_input: RuntimeSessionInput): Promise<RuntimeSession> => ({
    providerSessionId: options.providerSessionId ?? null
  }),
  startTurn: (_input: RuntimeTurnInput): RuntimeTurn => {
    const events = options.events ?? [];
    let finishEvents!: () => void;
    const eventsFinished = new Promise<void>((resolve) => { finishEvents = resolve; });
    return {
      events: {
        async *[Symbol.asyncIterator]() {
          try {
            yield* events;
          } finally {
            finishEvents();
          }
        }
      },
      result: eventsFinished.then(() => options.result ?? { status: "completed" }),
      cancel: async (): Promise<void> => undefined,
      closeEvents: async (): Promise<void> => undefined
    };
  },
  cancel: async (_sessionId: number): Promise<void> => undefined,
  reset: async (_input: RuntimeSessionInput): Promise<void> => undefined,
  forgetSession: async (_sessionId: number): Promise<void> => undefined,
  doctor: async (): Promise<RuntimeDoctor> => options.doctor ?? ({ ok: true, message: "ready", details: [] }),
  shutdown: async (): Promise<void> => undefined
});
