import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type Database from "better-sqlite3";

import type { AgentManager } from "../agents/agent-manager.js";
import type { Agent, Session, SessionStatus } from "../domain.js";
import { ProjectEnvironmentStore } from "../project-environments/project-environment-store.js";
import type { AgentRuntime } from "../runtime/agent-runtime.js";
import { WorkspaceCreateError, type WorkspaceManager } from "../workspaces/workspace-manager.js";

type SessionRow = {
  id: string;
  agent_id: string;
  title: string;
  status: SessionStatus;
  provider_session_id: string | null;
  workspace_path: string;
  project_environment_revision_id: string | null;
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
  projectEnvironmentRevisionId: row.project_environment_revision_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

export type CreateSessionInput = { agentId: string; title: string };
export type SessionRuntimeContext = { agent: Agent; session: Session };

export class SessionManagerError extends Error {
  constructor(
    readonly code: "agent_not_found" | "agent_disabled" | "project_environment_unavailable" | "session_not_found" | "session_busy" | "session_create_failed" | "runtime_reset_failed",
    options?: ErrorOptions
  ) {
    super(code, options);
  }
}

export type SessionManagerDependencies = {
  db: Database.Database;
  dataDir: string;
  agentManager: AgentManager;
  runtime: AgentRuntime;
  workspaceManager: WorkspaceManager;
  projectEnvironmentStore?: ProjectEnvironmentStore;
};

/**
 * Persists Session records and coordinates their workspace and runtime lifecycle.
 */
export class SessionManager {
  private readonly db: Database.Database;
  private readonly dataDir: string;
  private readonly agentManager: AgentManager;
  private readonly runtime: AgentRuntime;
  private readonly workspaceManager: WorkspaceManager;
  private readonly projectEnvironmentStore: ProjectEnvironmentStore;

  constructor({ db, dataDir, agentManager, runtime, workspaceManager, projectEnvironmentStore }: SessionManagerDependencies) {
    this.db = db;
    this.dataDir = dataDir;
    this.agentManager = agentManager;
    this.runtime = runtime;
    this.workspaceManager = workspaceManager;
    this.projectEnvironmentStore = projectEnvironmentStore ?? new ProjectEnvironmentStore({ db });
  }

  /**
   * Creates the workspace before storing the Session record.
   */
  async create(input: CreateSessionInput): Promise<Session> {
    const agent = this.agentManager.get(input.agentId);
    if (agent === undefined) throw new SessionManagerError("agent_not_found");
    if (!agent.enabled) throw new SessionManagerError("agent_disabled");
    if (agent.projectEnvironmentId === null) throw new SessionManagerError("project_environment_unavailable");
    const revision = this.projectEnvironmentStore.getCurrentRevision(agent.projectEnvironmentId);
    if (revision?.status !== "ready" || revision.workspacePath === null) {
      throw new SessionManagerError("project_environment_unavailable");
    }

    const id = randomUUID();
    let workspace;
    try {
      workspace = await this.workspaceManager.createSession(id, revision.workspacePath);
    } catch (error) {
      if (error instanceof WorkspaceCreateError) throw error;
      throw new WorkspaceCreateError();
    }

    const createdAt = new Date().toISOString();
    try {
      this.db
        .prepare(
          "INSERT INTO sessions (id, agent_id, title, status, provider_session_id, workspace_path, project_environment_revision_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(id, agent.id, input.title, "idle", null, workspace.workspacePath, revision.id, createdAt, createdAt);
    } catch (_error) {
      try {
        await this.workspaceManager.rollbackSession(id);
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
      projectEnvironmentRevisionId: revision.id,
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
   * Loads the persisted Session and its Agent for one Runtime turn.
   */
  getRuntimeContext(id: string): SessionRuntimeContext {
    const session = this.get(id);
    if (session === undefined) throw new SessionManagerError("session_not_found");
    const agent = this.agentManager.get(session.agentId);
    if (agent === undefined) throw new SessionManagerError("agent_not_found");
    return { agent, session };
  }

  /**
   * Saves the Provider's durable Session identifier before a Turn starts.
   */
  saveProviderSessionId(id: string, providerSessionId: string | null): Session {
    const session = this.get(id);
    if (session === undefined) throw new SessionManagerError("session_not_found");

    const updatedAt = new Date().toISOString();
    this.db
      .prepare("UPDATE sessions SET provider_session_id = ?, updated_at = ? WHERE id = ?")
      .run(providerSessionId, updatedAt, id);
    return { ...session, providerSessionId, updatedAt };
  }

  /**
   * Resets the Provider's persisted runtime state, then clears the recorded ID.
   */
  async resetProviderSession(id: string): Promise<Session> {
    const session = this.get(id);
    if (session === undefined) throw new SessionManagerError("session_not_found");

    const agent = this.agentManager.get(session.agentId);
    if (agent === undefined) throw new SessionManagerError("agent_not_found");
    this.claimForReset(session.id);

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
    } catch (error) {
      try {
        this.releaseResetClaim(session.id, false);
      } catch (releaseError) {
        throw new SessionManagerError("runtime_reset_failed", {
          cause: new AggregateError([error, releaseError], "Runtime reset and Session claim release failed")
        });
      }
      throw new SessionManagerError("runtime_reset_failed", { cause: error });
    }

    try {
      return this.releaseResetClaim(session.id, true);
    } catch (error) {
      throw new SessionManagerError("runtime_reset_failed", { cause: error });
    }
  }

  private claimForReset(id: string): void {
    this.inImmediateTransaction(() => {
      const updatedAt = new Date().toISOString();
      const result = this.db
        .prepare("UPDATE sessions SET status = 'running', updated_at = ? WHERE id = ? AND status = 'idle'")
        .run(updatedAt, id);
      if (result.changes !== 1) throw new SessionManagerError("session_busy");
    });
  }

  private releaseResetClaim(id: string, clearProviderSessionId: boolean): Session {
    return this.inImmediateTransaction(() => {
      const updatedAt = new Date().toISOString();
      const providerAssignment = clearProviderSessionId ? "provider_session_id = NULL," : "";
      const result = this.db.prepare(`
        UPDATE sessions
        SET ${providerAssignment} status = 'idle', updated_at = ?
        WHERE id = ?
          AND status = 'running'
          AND NOT EXISTS (
            SELECT 1 FROM runs
            WHERE session_id = sessions.id AND status IN ('queued', 'running')
          )
      `).run(updatedAt, id);
      if (result.changes !== 1) throw new Error("session_reset_claim_release_failed");

      const released = this.get(id);
      if (released === undefined) throw new SessionManagerError("session_not_found");
      return released;
    });
  }

  private inImmediateTransaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
