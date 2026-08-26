import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type Database from "better-sqlite3";

import type { AgentManager } from "../agents/agent-manager.js";
import { insertedId } from "../db.js";
import type { Agent, Page, Provider, Session, SessionListItem, SessionStatus, TokenUsageTotals } from "../domain.js";
import { McpManager } from "../mcp/mcp-manager.js";
import { SecretStore } from "../mcp/secret-store.js";
import type { SessionMcpStatus } from "../mcp/mcp-types.js";
import {
  SystemProjectEnvironmentCommands,
  type ProjectEnvironmentCommands
} from "../project-environments/project-environment-commands.js";
import { ProjectEnvironmentStore } from "../project-environments/project-environment-store.js";
import type { AgentRuntime } from "../runtime/agent-runtime.js";
import {
  SystemProviderSessionCleaner,
  type ProviderSessionCleaner
} from "../runtime/provider-session-cleaner.js";
import { WorkspaceCreateError, type WorkspaceManager } from "../workspaces/workspace-manager.js";

type SessionRow = {
  id: number;
  agent_id: number;
  title: string;
  status: SessionStatus;
  provider_session_id: string | null;
  storage_cleaned_at: string | null;
  workspace_path: string;
  project_environment_revision_id: number | null;
  instructions_snapshot: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_read_tokens: number | null;
  cached_write_tokens: number | null;
  thought_tokens: number | null;
  total_tokens: number | null;
  created_at: string;
  updated_at: string;
};

type SessionListRow = SessionRow & {
  agent_name: string;
  agent_provider: Provider;
  project_environment_name: string | null;
  integration_endpoint_id: number | null;
  integration_endpoint_name: string | null;
  integration_endpoint_slug: string | null;
  integration_conversation_key: string | null;
  integration_latest_request_id: string | null;
};

const toSession = (row: SessionRow): Session => ({
  id: row.id,
  agentId: row.agent_id,
  title: row.title,
  status: row.status,
  providerSessionId: row.provider_session_id,
  storageCleanedAt: row.storage_cleaned_at,
  workspacePath: row.workspace_path,
  projectEnvironmentRevisionId: row.project_environment_revision_id,
  instructionsSnapshot: row.instructions_snapshot,
  usage: [
    row.input_tokens,
    row.output_tokens,
    row.cached_read_tokens,
    row.cached_write_tokens,
    row.thought_tokens,
    row.total_tokens
  ].every((value) => value === null) ? null : {
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cachedReadTokens: row.cached_read_tokens,
    cachedWriteTokens: row.cached_write_tokens,
    thoughtTokens: row.thought_tokens,
    totalTokens: row.total_tokens
  },
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const toSessionListItem = (row: SessionListRow): SessionListItem => ({
  ...toSession(row),
  agentName: row.agent_name,
  agentProvider: row.agent_provider,
  projectEnvironmentName: row.project_environment_name,
  integration: row.integration_endpoint_id === null ? null : {
    endpointId: row.integration_endpoint_id,
    endpointName: row.integration_endpoint_name!,
    endpointSlug: row.integration_endpoint_slug!,
    conversationKey: row.integration_conversation_key,
    latestRequestId: row.integration_latest_request_id
  }
});

export type CreateSessionInput = {
  agentId: number;
  title: string;
  mcpParameters: Record<string, string | null>;
};
export type SessionWithMcpStatus = Session & SessionMcpStatus;
export type SessionListItemWithMcpStatus = SessionListItem & SessionMcpStatus;
export type SessionRuntimeContext = { agent: Agent; session: Session };
export type ListSessionsInput = { page: number; pageSize: number; query?: string; agentId?: number };

export class SessionManagerError extends Error {
  constructor(
    readonly code: "agent_not_found" | "agent_disabled" | "project_environment_unavailable" | "session_not_found" | "session_busy" | "session_storage_cleaned" | "session_create_failed" | "runtime_reset_failed" | "session_delete_failed" | "session_cleanup_failed",
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
  projectEnvironmentRevisionCleaner?: { cleanupOldRevisions(environmentId: number): Promise<void> };
  projectEnvironmentCommands?: ProjectEnvironmentCommands;
  projectPrepareTimeoutMs?: number;
  mcpManager?: McpManager;
  providerSessionCleaner?: ProviderSessionCleaner;
};

const ENVIRONMENT_PREPARED_MARKER = ".project-environment-prepared-v1";
const ENVIRONMENT_SNAPSHOT_MARKER = ".project-environment-snapshot-v2";
const DEFAULT_PROJECT_PREPARE_TIMEOUT_MS = 30 * 60 * 1000;

/** Removes Session creations interrupted before their Workspace became ready. */
export const recoverIncompleteSessions = async (
  db: Database.Database,
  workspaceManager: WorkspaceManager
): Promise<void> => {
  const incomplete = db.prepare(
    "SELECT id FROM sessions WHERE workspace_path LIKE 'pending:%' ORDER BY id"
  ).all() as Array<{ id: number }>;
  for (const { id } of incomplete) {
    try {
      await workspaceManager.deleteSession(id);
    } catch (_error) {
      // The incomplete database record must not become runnable; leftover files are harmless.
    }
    db.prepare("DELETE FROM sessions WHERE id = ? AND workspace_path LIKE 'pending:%'").run(id);
  }
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
  private readonly projectEnvironmentRevisionCleaner:
    | { cleanupOldRevisions(environmentId: number): Promise<void> }
    | undefined;
  private readonly projectEnvironmentCommands: ProjectEnvironmentCommands;
  private readonly projectPrepareTimeoutMs: number;
  private readonly mcpManager: McpManager;
  private readonly providerSessionCleaner: ProviderSessionCleaner;

  constructor({
    db,
    dataDir,
    agentManager,
    runtime,
    workspaceManager,
    projectEnvironmentStore,
    projectEnvironmentRevisionCleaner,
    projectEnvironmentCommands,
    projectPrepareTimeoutMs,
    mcpManager,
    providerSessionCleaner
  }: SessionManagerDependencies) {
    this.db = db;
    this.dataDir = dataDir;
    this.agentManager = agentManager;
    this.runtime = runtime;
    this.workspaceManager = workspaceManager;
    this.projectEnvironmentStore = projectEnvironmentStore ?? new ProjectEnvironmentStore({ db });
    this.projectEnvironmentRevisionCleaner = projectEnvironmentRevisionCleaner;
    this.projectEnvironmentCommands = projectEnvironmentCommands ?? new SystemProjectEnvironmentCommands();
    this.projectPrepareTimeoutMs = projectPrepareTimeoutMs ?? DEFAULT_PROJECT_PREPARE_TIMEOUT_MS;
    this.mcpManager = mcpManager ?? new McpManager({ db, secrets: SecretStore.open({ dataDir }) });
    this.providerSessionCleaner = providerSessionCleaner ?? new SystemProviderSessionCleaner(dataDir);
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

    const createdAt = new Date().toISOString();
    const id = insertedId(this.db.prepare(
      "INSERT INTO sessions (agent_id, title, status, provider_session_id, workspace_path, project_environment_revision_id, instructions_snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      agent.id,
      input.title,
      "running",
      null,
      `pending:${randomUUID()}`,
      revision.id,
      agent.instructions,
      createdAt,
      createdAt
    ));
    let workspace;
    try {
      workspace = await this.workspaceManager.createSession(id, revision.workspacePath);
    } catch (error) {
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
      await this.cleanupEnvironmentRevisions(revision.projectEnvironmentId);
      if (error instanceof WorkspaceCreateError) throw error;
      throw new WorkspaceCreateError();
    }

    try {
      await mkdir(workspace.runtimePath, { recursive: true });
      await writeFile(join(workspace.runtimePath, ENVIRONMENT_SNAPSHOT_MARKER), "ready\n", "utf8");
    } catch (_error) {
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
      try {
        await this.workspaceManager.deleteSession(id);
      } catch (_cleanupError) {
        // The preparation failure remains authoritative.
      }
      await this.cleanupEnvironmentRevisions(revision.projectEnvironmentId);
      throw new WorkspaceCreateError();
    }

    try {
      this.inImmediateTransaction(() => {
        const updated = this.db.prepare("UPDATE sessions SET workspace_path = ?, status = 'idle', updated_at = ? WHERE id = ? AND status = 'running'")
          .run(workspace.workspacePath, new Date().toISOString(), id);
        if (updated.changes !== 1) throw new Error("session_create_claim_lost");
        this.mcpManager.insertSessionValuesInTransaction(id, mcpValues);
      });
    } catch (_error) {
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
      try {
        await this.workspaceManager.deleteSession(id);
      } catch (_rollbackError) {
        // The database failure remains the primary error; rollback was still attempted.
      }
      await this.cleanupEnvironmentRevisions(revision.projectEnvironmentId);
      throw new SessionManagerError("session_create_failed");
    }

    await this.cleanupEnvironmentRevisions(revision.projectEnvironmentId);

    return this.withMcpStatus({
      id,
      agentId: agent.id,
      title: input.title,
      status: "idle",
      providerSessionId: null,
      storageCleanedAt: null,
      workspacePath: workspace.workspacePath,
      projectEnvironmentRevisionId: revision.id,
      instructionsSnapshot: agent.instructions,
      usage: null,
      createdAt,
      updatedAt: createdAt
    });
  }

  /** Lists one page of persisted Sessions with the newest first. */
  list(input: ListSessionsInput): Page<SessionListItemWithMcpStatus> {
    const joins = `
      FROM sessions session
      JOIN agents agent ON agent.id = session.agent_id
      LEFT JOIN project_environment_revisions revision
        ON revision.id = session.project_environment_revision_id
      LEFT JOIN project_environments environment
        ON environment.id = revision.project_environment_id
      LEFT JOIN integration_conversations conversation ON conversation.id = (
        SELECT recent_conversation.id FROM integration_conversations recent_conversation
        WHERE recent_conversation.session_id = session.id
        ORDER BY recent_conversation.created_at DESC, recent_conversation.id DESC
        LIMIT 1
      )
      LEFT JOIN integration_tasks latest_task ON latest_task.id = (
        SELECT recent_task.id FROM integration_tasks recent_task
        WHERE recent_task.session_id = session.id
        ORDER BY recent_task.created_at DESC, recent_task.id DESC
        LIMIT 1
      )
      LEFT JOIN integration_endpoints endpoint
        ON endpoint.id = COALESCE(latest_task.endpoint_id, conversation.endpoint_id)
    `;
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (input.agentId !== undefined) {
      clauses.push("session.agent_id = ?");
      parameters.push(input.agentId);
    }
    const query = input.query?.trim().toLowerCase();
    if (query !== undefined && query !== "") {
      clauses.push(`
        LOWER(
          session.title || ' ' || CAST(session.id AS TEXT) || ' ' || agent.name || ' ' || agent.provider || ' ' ||
          COALESCE(environment.name, '') || ' ' || COALESCE(endpoint.name, '') || ' ' || COALESCE(endpoint.slug, '') || ' ' ||
          COALESCE(conversation.conversation_key, '') || ' ' || COALESCE(latest_task.request_id, '')
        ) LIKE ?
      `);
      parameters.push(`%${query}%`);
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    const total = (this.db.prepare(`SELECT COUNT(*) AS count ${joins} ${where}`).get(...parameters) as { count: number }).count;
    const rows = this.db.prepare(`
      SELECT session.*,
        agent.name AS agent_name,
        agent.provider AS agent_provider,
        environment.name AS project_environment_name,
        endpoint.id AS integration_endpoint_id,
        endpoint.name AS integration_endpoint_name,
        endpoint.slug AS integration_endpoint_slug,
        conversation.conversation_key AS integration_conversation_key,
        latest_task.request_id AS integration_latest_request_id
      ${joins}
      ${where}
      ORDER BY session.created_at DESC, session.id DESC
      LIMIT ? OFFSET ?
    `).all(...parameters, input.pageSize, (input.page - 1) * input.pageSize) as SessionListRow[];
    const sessions = rows.map(toSessionListItem);
    const statuses = this.mcpManager.getSessionsStatus(sessions.map(({ id, agentId }) => ({ id, agentId })));
    return {
      items: sessions.map((session) => ({ ...session, ...statuses.get(session.id)! })),
      page: input.page,
      pageSize: input.pageSize,
      total,
      totalPages: Math.ceil(total / input.pageSize)
    };
  }

  /**
   * Looks up a Session by its identifier.
   */
  get(id: number): SessionWithMcpStatus | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return row === undefined ? undefined : this.withMcpStatus(toSession(row));
  }

  /** Replaces all MCP values after a caller claims a Session in its own transaction. */
  replaceMcpParametersInTransaction(id: number, values: Record<string, string | null>): void {
    if (!this.db.inTransaction) throw new Error("session_mcp_transaction_required");
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    if (row === undefined) throw new SessionManagerError("session_not_found");
    if (row.storage_cleaned_at !== null) throw new SessionManagerError("session_storage_cleaned");
    if (row.status !== "running") throw new SessionManagerError("session_busy");

    const normalized = this.mcpManager.normalizeSessionValues(row.agent_id, values, true);
    this.db.prepare("DELETE FROM session_mcp_parameter_values WHERE session_id = ?").run(id);
    this.mcpManager.insertSessionValuesInTransaction(id, normalized);
  }

  /** Updates only the supplied MCP parameter values while the Session is idle. */
  updateMcpParameters(id: number, values: Record<string, string | null>): SessionWithMcpStatus {
    return this.inImmediateTransaction(() => {
      const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
      if (row === undefined) throw new SessionManagerError("session_not_found");
      if (row.storage_cleaned_at !== null) throw new SessionManagerError("session_storage_cleaned");
      const active = this.db.prepare(
        "SELECT 1 FROM runs WHERE session_id = ? AND status IN ('queued', 'running') LIMIT 1"
      ).get(id);
      if (row.status !== "idle" || active !== undefined) throw new SessionManagerError("session_busy");
      const normalized = this.mcpManager.normalizeSessionValues(row.agent_id, values, false);
      this.mcpManager.applySessionValuePatchInTransaction(id, normalized);
      return this.withMcpStatus(toSession(row));
    });
  }

  /** Repairs ignored generated files once when an older Session is first reused. */
  async ensureWorkspacePrepared(id: number): Promise<void> {
    const session = this.get(id);
    if (session === undefined) throw new SessionManagerError("session_not_found");
    if (session.projectEnvironmentRevisionId === null) return;
    const runtimePath = join(dirname(session.workspacePath), "runtime");
    for (const marker of [ENVIRONMENT_SNAPSHOT_MARKER, ENVIRONMENT_PREPARED_MARKER]) {
      try {
        if (await readFile(join(runtimePath, marker), "utf8") === "ready\n") return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (await this.prepareWorkspaceRevision(session.workspacePath, session.projectEnvironmentRevisionId)) {
      await writeFile(join(runtimePath, ENVIRONMENT_PREPARED_MARKER), "ready\n", "utf8");
    }
  }

  /** Lists idle Sessions whose last activity is older than one exact cutoff. */
  listExpiredIds(cutoff: string): number[] {
    const rows = this.db.prepare(`
      SELECT id FROM sessions
      WHERE status = 'idle' AND storage_cleaned_at IS NULL AND updated_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM runs
          WHERE session_id = sessions.id AND status IN ('queued', 'running')
        )
      ORDER BY updated_at ASC, id ASC
    `).all(cutoff) as Array<{ id: number }>;
    return rows.map(({ id }) => id);
  }

  /**
   * Loads the persisted Session and its Agent for one Runtime turn.
   */
  getRuntimeContext(id: number): SessionRuntimeContext {
    const session = this.get(id);
    if (session === undefined) throw new SessionManagerError("session_not_found");
    if (session.storageCleanedAt !== null) throw new SessionManagerError("session_storage_cleaned");
    const agent = this.agentManager.get(session.agentId);
    if (agent === undefined) throw new SessionManagerError("agent_not_found");
    if (!agent.enabled) throw new SessionManagerError("agent_disabled");
    return { agent, session };
  }

  /**
   * Saves the Provider's durable Session identifier before a Turn starts.
   */
  saveProviderSessionId(id: number, providerSessionId: string | null): Session {
    const session = this.get(id);
    if (session === undefined) throw new SessionManagerError("session_not_found");

    const updatedAt = new Date().toISOString();
    this.db
      .prepare("UPDATE sessions SET provider_session_id = ?, updated_at = ? WHERE id = ?")
      .run(providerSessionId, updatedAt, id);
    return { ...session, providerSessionId, updatedAt };
  }

  /** Replaces the exact cumulative usage reported for the Provider Session. */
  saveTokenUsage(id: number, usage: Partial<TokenUsageTotals>): Session {
    const updatedAt = new Date().toISOString();
    const updated = this.db.prepare(`
      UPDATE sessions SET
        input_tokens = ?, output_tokens = ?, cached_read_tokens = ?, cached_write_tokens = ?,
        thought_tokens = ?, total_tokens = ?, updated_at = ?
      WHERE id = ?
    `).run(
      usage.inputTokens ?? null,
      usage.outputTokens ?? null,
      usage.cachedReadTokens ?? null,
      usage.cachedWriteTokens ?? null,
      usage.thoughtTokens ?? null,
      usage.totalTokens ?? null,
      updatedAt,
      id
    );
    if (updated.changes !== 1) throw new SessionManagerError("session_not_found");
    const session = this.get(id);
    if (session === undefined) throw new SessionManagerError("session_not_found");
    return session;
  }

  /**
   * Resets the Provider's persisted runtime state, then clears the recorded ID.
   */
  async resetProviderSession(id: number): Promise<Session> {
    const session = this.get(id);
    if (session === undefined) throw new SessionManagerError("session_not_found");
    if (session.storageCleanedAt !== null) throw new SessionManagerError("session_storage_cleaned");

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
        instructions: session.instructionsSnapshot,
        memory: readFileSync(join(this.dataDir, "agents", String(agent.id), "MEMORY.md"), "utf8"),
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
  async delete(id: number): Promise<void> {
    const session = this.get(id);
    if (session === undefined) throw new SessionManagerError("session_not_found");
    const revision = session.projectEnvironmentRevisionId === null
      ? undefined
      : this.projectEnvironmentStore.getRevision(session.projectEnvironmentRevisionId);
    this.claimForDelete(id);

    try {
      await this.runtime.forgetSession(id);
    } catch {
      // Provider cleanup is best-effort and must not block deletion of local resources.
    }

    try {
      const agent = this.agentManager.get(session.agentId);
      if (agent !== undefined) {
        await this.providerSessionCleaner.purge({
          agentId: agent.id,
          provider: agent.provider,
          sessionId: session.id,
          providerSessionId: session.providerSessionId
        });
      }
    } catch {
      // Provider cleanup is best-effort and must not block deletion of local resources.
    }

    try {
      await this.workspaceManager.deleteSession(id);
    } catch (error) {
      this.releaseDeleteClaim(id, true, error);
    }

    try {
      this.inImmediateTransaction(() => {
        this.db.prepare(`
          DELETE FROM webhook_deliveries
          WHERE task_id IN (SELECT id FROM integration_tasks WHERE session_id = ?)
        `).run(id);
        this.db.prepare(`
          DELETE FROM integration_task_events
          WHERE task_id IN (SELECT id FROM integration_tasks WHERE session_id = ?)
        `).run(id);
        this.db.prepare("DELETE FROM integration_tasks WHERE session_id = ?").run(id);
        this.db.prepare("DELETE FROM integration_conversations WHERE session_id = ?").run(id);
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

    if (revision !== undefined && this.projectEnvironmentRevisionCleaner !== undefined) {
      try {
        await this.projectEnvironmentRevisionCleaner.cleanupOldRevisions(revision.projectEnvironmentId);
      } catch (error) {
        console.error(error);
      }
    }
  }

  /** Releases Workspace and Provider conversation storage while retaining the Session and its statistics. */
  async cleanupStorage(id: number, cleanedAt = new Date().toISOString()): Promise<void> {
    const session = this.get(id);
    if (session === undefined) throw new SessionManagerError("session_not_found");
    if (session.storageCleanedAt !== null) return;
    const agent = this.agentManager.get(session.agentId);
    if (agent === undefined) throw new SessionManagerError("agent_not_found");
    this.claimForStorageCleanup(id);

    try {
      await this.runtime.forgetSession(id);
      await this.providerSessionCleaner.purge({
        agentId: agent.id,
        provider: agent.provider,
        sessionId: session.id,
        providerSessionId: session.providerSessionId
      });
      await this.workspaceManager.deleteSession(id);
      const updated = this.db.prepare(`
        UPDATE sessions
        SET status = 'idle', provider_session_id = NULL, storage_cleaned_at = ?
        WHERE id = ? AND status = 'running' AND storage_cleaned_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM runs
            WHERE session_id = sessions.id AND status IN ('queued', 'running')
          )
      `).run(cleanedAt, id);
      if (updated.changes !== 1) throw new Error("session_cleanup_claim_lost");
    } catch (error) {
      try {
        this.db.prepare(`
          UPDATE sessions SET status = 'idle'
          WHERE id = ? AND status = 'running' AND storage_cleaned_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM runs
              WHERE session_id = sessions.id AND status IN ('queued', 'running')
            )
        `).run(id);
      } catch (releaseError) {
        throw new SessionManagerError("session_cleanup_failed", {
          cause: new AggregateError([error, releaseError], "Session storage cleanup and claim release failed")
        });
      }
      throw new SessionManagerError("session_cleanup_failed", { cause: error });
    }
  }

  private claimForStorageCleanup(id: number): void {
    this.inImmediateTransaction(() => {
      const result = this.db.prepare(`
        UPDATE sessions SET status = 'running'
        WHERE id = ? AND status = 'idle' AND storage_cleaned_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM runs
            WHERE session_id = sessions.id AND status IN ('queued', 'running')
          )
      `).run(id);
      if (result.changes === 1) return;
      const session = this.get(id);
      if (session === undefined) throw new SessionManagerError("session_not_found");
      if (session.storageCleanedAt !== null) return;
      throw new SessionManagerError("session_busy");
    });
  }

  private claimForDelete(id: number): void {
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

  private async prepareWorkspaceRevision(workspacePath: string, revisionId: number | null): Promise<boolean> {
    if (revisionId === null) return false;
    const revision = this.projectEnvironmentStore.getRevision(revisionId);
    if (revision === undefined) throw new SessionManagerError("project_environment_unavailable");
    const repositories = this.projectEnvironmentStore.listRepositories(revision.projectEnvironmentId);
    if (repositories.length === 0) return false;
    const signal = new AbortController().signal;
    for (const repository of repositories) {
      const destination = join(workspacePath, repository.name);
      await this.projectEnvironmentCommands.cleanIgnored(repository, destination, signal);
      await this.projectEnvironmentCommands.prepare(
        repository,
        destination,
        this.projectPrepareTimeoutMs,
        signal
      );
    }
    return true;
  }

  private async cleanupEnvironmentRevisions(environmentId: number): Promise<void> {
    if (this.projectEnvironmentRevisionCleaner === undefined) return;
    try {
      await this.projectEnvironmentRevisionCleaner.cleanupOldRevisions(environmentId);
    } catch (error) {
      console.error(error);
    }
  }

  private releaseDeleteClaim(id: number, clearProviderSessionId: boolean, cause: unknown): never {
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

  private claimForReset(id: number): void {
    this.inImmediateTransaction(() => {
      const updatedAt = new Date().toISOString();
      const result = this.db
        .prepare("UPDATE sessions SET status = 'running', updated_at = ? WHERE id = ? AND status = 'idle'")
        .run(updatedAt, id);
      if (result.changes !== 1) throw new SessionManagerError("session_busy");
    });
  }

  private releaseResetClaim(id: number, clearProviderSessionId: boolean): Session {
    return this.inImmediateTransaction(() => {
      const updatedAt = new Date().toISOString();
      const providerAssignment = clearProviderSessionId
        ? "provider_session_id = NULL, input_tokens = NULL, output_tokens = NULL, cached_read_tokens = NULL, cached_write_tokens = NULL, thought_tokens = NULL, total_tokens = NULL,"
        : "";
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
