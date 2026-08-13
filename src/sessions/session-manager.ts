import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type Database from "better-sqlite3";

import type { AgentManager } from "../agents/agent-manager.js";
import type { Agent, Session, SessionStatus } from "../domain.js";
import { McpManager } from "../mcp/mcp-manager.js";
import { SecretStore } from "../mcp/secret-store.js";
import type { SessionMcpStatus } from "../mcp/mcp-types.js";
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

export type CreateSessionInput = {
  agentId: string;
  title: string;
  mcpParameters: Record<string, string | null>;
};
export type SessionWithMcpStatus = Session & SessionMcpStatus;
export type SessionRuntimeContext = { agent: Agent; session: Session };

export class SessionManagerError extends Error {
  constructor(
    readonly code: "agent_not_found" | "agent_disabled" | "project_environment_unavailable" | "session_not_found" | "session_busy" | "session_create_failed" | "runtime_reset_failed" | "session_delete_failed",
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
  mcpManager?: McpManager;
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
  private readonly mcpManager: McpManager;

  constructor({
    db,
    dataDir,
    agentManager,
    runtime,
    workspaceManager,
    projectEnvironmentStore,
    mcpManager
  }: SessionManagerDependencies) {
    this.db = db;
    this.dataDir = dataDir;
    this.agentManager = agentManager;
    this.runtime = runtime;
    this.workspaceManager = workspaceManager;
    this.projectEnvironmentStore = projectEnvironmentStore ?? new ProjectEnvironmentStore({ db });
    this.mcpManager = mcpManager ?? new McpManager({ db, secrets: SecretStore.open({ dataDir }) });
  }

  /**
   * Creates the workspace before storing the Session record.
   */
  async create(input: CreateSessionInput): Promise<SessionWithMcpStatus> {
    const agent = this.agentManager.get(input.agentId);
    if (agent === undefined) throw new SessionManagerError("agent_not_found");
    if (!agent.enabled) throw new SessionManagerError("agent_disabled");
    if (agent.projectEnvironmentId === null) throw new SessionManagerError("project_environment_unavailable");
    const revision = this.projectEnvironmentStore.getCurrentRevision(agent.projectEnvironmentId);
    if (revision?.status !== "ready" || revision.workspacePath === null) {
      throw new SessionManagerError("project_environment_unavailable");
    }
    const mcpValues = this.mcpManager.normalizeSessionValues(agent.id, input.mcpParameters, true);

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
      this.inImmediateTransaction(() => {
        this.db
          .prepare(
            "INSERT INTO sessions (id, agent_id, title, status, provider_session_id, workspace_path, project_environment_revision_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .run(id, agent.id, input.title, "idle", null, workspace.workspacePath, revision.id, createdAt, createdAt);
        this.mcpManager.insertSessionValuesInTransaction(id, mcpValues);
      });
    } catch (_error) {
      try {
        await this.workspaceManager.deleteSession(id);
      } catch (_rollbackError) {
        // The database failure remains the primary error; rollback was still attempted.
      }
      throw new SessionManagerError("session_create_failed");
    }

    return this.withMcpStatus({
      id,
      agentId: agent.id,
      title: input.title,
      status: "idle",
      providerSessionId: null,
      workspacePath: workspace.workspacePath,
      projectEnvironmentRevisionId: revision.id,
      createdAt,
      updatedAt: createdAt
    });
  }

  /**
   * Lists persisted Sessions in creation order.
   */
  list(): SessionWithMcpStatus[] {
    const rows = this.db.prepare("SELECT * FROM sessions ORDER BY created_at ASC, id ASC").all() as SessionRow[];
    return rows.map((row) => this.withMcpStatus(toSession(row)));
  }

  /**
   * Looks up a Session by its identifier.
   */
  get(id: string): SessionWithMcpStatus | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return row === undefined ? undefined : this.withMcpStatus(toSession(row));
  }

  /** Replaces all MCP values after a caller claims a Session in its own transaction. */
  replaceMcpParametersInTransaction(id: string, values: Record<string, string | null>): void {
    if (!this.db.inTransaction) throw new Error("session_mcp_transaction_required");
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    if (row === undefined) throw new SessionManagerError("session_not_found");
    if (row.status !== "running") throw new SessionManagerError("session_busy");

    const normalized = this.mcpManager.normalizeSessionValues(row.agent_id, values, true);
    this.db.prepare("DELETE FROM session_mcp_parameter_values WHERE session_id = ?").run(id);
    this.mcpManager.insertSessionValuesInTransaction(id, normalized);
  }

  /** Updates only the supplied MCP parameter values while the Session is idle. */
  updateMcpParameters(id: string, values: Record<string, string | null>): SessionWithMcpStatus {
    return this.inImmediateTransaction(() => {
      const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
      if (row === undefined) throw new SessionManagerError("session_not_found");
      const active = this.db.prepare(
        "SELECT 1 FROM runs WHERE session_id = ? AND status IN ('queued', 'running') LIMIT 1"
      ).get(id);
      if (row.status !== "idle" || active !== undefined) throw new SessionManagerError("session_busy");
      const normalized = this.mcpManager.normalizeSessionValues(row.agent_id, values, false);
      this.mcpManager.applySessionValuePatchInTransaction(id, normalized);
      return this.withMcpStatus(toSession(row));
    });
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
        memory: readFileSync(join(this.dataDir, "agents", agent.id, "MEMORY.md"), "utf8"),
        mcpServers: []
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

  /** Permanently removes an idle Session and every resource it owns. */
  async delete(id: string): Promise<void> {
    const session = this.get(id);
    if (session === undefined) throw new SessionManagerError("session_not_found");
    const agent = this.agentManager.get(session.agentId);
    if (agent === undefined) throw new SessionManagerError("agent_not_found");
    this.claimForDelete(id);

    const runtimeInput = {
      sessionId: session.id,
      agentId: agent.id,
      provider: agent.provider,
      workspacePath: session.workspacePath,
      browserProfilePath: join(dirname(session.workspacePath), "browser"),
      providerSessionId: session.providerSessionId,
      memory: readFileSync(join(this.dataDir, "agents", agent.id, "MEMORY.md"), "utf8"),
      mcpServers: []
    };

    try {
      await this.runtime.reset(runtimeInput);
    } catch (error) {
      this.releaseDeleteClaim(id, false, error);
    }

    try {
      await this.workspaceManager.deleteSession(id);
    } catch (error) {
      this.releaseDeleteClaim(id, true, error);
    }

    try {
      this.inImmediateTransaction(() => {
        this.db.prepare("DELETE FROM events WHERE run_id IN (SELECT id FROM runs WHERE session_id = ?)").run(id);
        this.db.prepare("DELETE FROM runs WHERE session_id = ?").run(id);
        const deleted = this.db.prepare("DELETE FROM sessions WHERE id = ? AND status = 'running'").run(id);
        if (deleted.changes !== 1) throw new Error("session_delete_claim_lost");
      });
    } catch (error) {
      try {
        this.releaseDeleteClaim(id, true, error);
      } catch (releaseError) {
        if (releaseError instanceof SessionManagerError) throw releaseError;
        throw new SessionManagerError("session_delete_failed", { cause: releaseError });
      }
    }
  }

  private claimForDelete(id: string): void {
    this.inImmediateTransaction(() => {
      const updatedAt = new Date().toISOString();
      const result = this.db.prepare(`
        UPDATE sessions SET status = 'running', updated_at = ?
        WHERE id = ? AND status = 'idle'
          AND NOT EXISTS (
            SELECT 1 FROM runs
            WHERE session_id = sessions.id AND status IN ('queued', 'running')
          )
      `).run(updatedAt, id);
      if (result.changes === 1) return;
      if (this.get(id) === undefined) throw new SessionManagerError("session_not_found");
      throw new SessionManagerError("session_busy");
    });
  }

  private releaseDeleteClaim(id: string, clearProviderSessionId: boolean, cause: unknown): never {
    try {
      this.inImmediateTransaction(() => {
        const providerAssignment = clearProviderSessionId ? "provider_session_id = NULL," : "";
        const result = this.db.prepare(`
          UPDATE sessions SET ${providerAssignment} status = 'idle', updated_at = ?
          WHERE id = ? AND status = 'running'
            AND NOT EXISTS (
              SELECT 1 FROM runs
              WHERE session_id = sessions.id AND status IN ('queued', 'running')
            )
        `).run(new Date().toISOString(), id);
        if (result.changes !== 1) throw new Error("session_delete_claim_release_failed");
      });
    } catch (releaseError) {
      throw new SessionManagerError("session_delete_failed", {
        cause: new AggregateError([cause, releaseError], "Session deletion and claim release failed")
      });
    }
    throw new SessionManagerError("session_delete_failed", { cause });
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

  private withMcpStatus(session: Session): SessionWithMcpStatus {
    return { ...session, ...this.mcpManager.getSessionStatus(session.id) };
  }
}
