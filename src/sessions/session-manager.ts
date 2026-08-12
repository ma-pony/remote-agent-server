import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type Database from "better-sqlite3";

import type { AgentManager } from "../agents/agent-manager.js";
import type { Session, SessionStatus } from "../domain.js";
import type { AgentRuntime } from "../runtime/agent-runtime.js";
import { BtrfsWorkspaceManager, WorkspaceCreateError } from "../workspaces/btrfs-workspace.js";

type SessionRow = {
  id: string;
  agent_id: string;
  title: string;
  status: SessionStatus;
  provider_session_id: string | null;
  workspace_path: string;
  created_at: string;
  updated_at: string;
};

const toSession = (row: SessionRow): Session => ({
  id: row.id,
  agentId: row.agent_id,
  title: row.title,
  status: row.status,
  providerSessionId: row.provider_session_id,
  workspacePath: row.workspace_path,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

export type CreateSessionInput = { agentId: string; title: string };

export class SessionManagerError extends Error {
  constructor(readonly code: "agent_not_found" | "agent_disabled" | "session_not_found" | "session_busy" | "session_create_failed" | "runtime_reset_failed") {
    super(code);
  }
}

export type SessionManagerDependencies = {
  db: Database.Database;
  dataDir: string;
  agentManager: AgentManager;
  runtime: AgentRuntime;
  workspaceManager: BtrfsWorkspaceManager;
};

/**
 * Persists Session records and coordinates their workspace and runtime lifecycle.
 */
export class SessionManager {
  private readonly db: Database.Database;
  private readonly dataDir: string;
  private readonly agentManager: AgentManager;
  private readonly runtime: AgentRuntime;
  private readonly workspaceManager: BtrfsWorkspaceManager;

  constructor({ db, dataDir, agentManager, runtime, workspaceManager }: SessionManagerDependencies) {
    this.db = db;
    this.dataDir = dataDir;
    this.agentManager = agentManager;
    this.runtime = runtime;
    this.workspaceManager = workspaceManager;
  }

  /**
   * Creates the workspace before storing the Session record.
   */
  async create(input: CreateSessionInput): Promise<Session> {
    const agent = this.agentManager.get(input.agentId);
    if (agent === undefined) throw new SessionManagerError("agent_not_found");
    if (!agent.enabled) throw new SessionManagerError("agent_disabled");

    const id = randomUUID();
    let workspace;
    try {
      workspace = await this.workspaceManager.create(id);
    } catch (error) {
      if (error instanceof WorkspaceCreateError) throw error;
      throw new WorkspaceCreateError();
    }

    const createdAt = new Date().toISOString();
    try {
      this.db
        .prepare(
          "INSERT INTO sessions (id, agent_id, title, status, provider_session_id, workspace_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(id, agent.id, input.title, "idle", null, workspace.workspacePath, createdAt, createdAt);
    } catch (_error) {
      try {
        await this.workspaceManager.rollback(id);
      } catch (_rollbackError) {
        // The database failure remains the primary error; rollback was still attempted.
      }
      throw new SessionManagerError("session_create_failed");
    }

    return {
      id,
      agentId: agent.id,
      title: input.title,
      status: "idle",
      providerSessionId: null,
      workspacePath: workspace.workspacePath,
      createdAt,
      updatedAt: createdAt
    };
  }

  /**
   * Lists persisted Sessions in creation order.
   */
  list(): Session[] {
    const rows = this.db.prepare("SELECT * FROM sessions ORDER BY created_at ASC, id ASC").all() as SessionRow[];
    return rows.map(toSession);
  }

  /**
   * Looks up a Session by its identifier.
   */
  get(id: string): Session | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return row === undefined ? undefined : toSession(row);
  }

  /**
   * Resets the Provider's persisted runtime state, then clears the recorded ID.
   */
  async resetProviderSession(id: string): Promise<Session> {
    const session = this.get(id);
    if (session === undefined) throw new SessionManagerError("session_not_found");
    if (session.status === "running") throw new SessionManagerError("session_busy");

    const agent = this.agentManager.get(session.agentId);
    if (agent === undefined) throw new SessionManagerError("agent_not_found");

    try {
      await this.runtime.reset({
        sessionId: session.id,
        agentId: agent.id,
        provider: agent.provider,
        workspacePath: session.workspacePath,
        browserProfilePath: join(dirname(session.workspacePath), "browser"),
        providerSessionId: session.providerSessionId,
        memory: readFileSync(join(this.dataDir, "agents", agent.id, "MEMORY.md"), "utf8")
      });
    } catch (_error) {
      throw new SessionManagerError("runtime_reset_failed");
    }

    const updatedAt = new Date().toISOString();
    this.db
      .prepare("UPDATE sessions SET provider_session_id = NULL, updated_at = ? WHERE id = ?")
      .run(updatedAt, session.id);

    return { ...session, providerSessionId: null, updatedAt };
  }
}
