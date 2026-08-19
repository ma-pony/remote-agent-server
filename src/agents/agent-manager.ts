import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type Database from "better-sqlite3";

import type { Agent, Provider } from "../domain.js";
import { insertedId } from "../db.js";
import { ProjectEnvironmentStore } from "../project-environments/project-environment-store.js";
import type { AgentRuntime, RuntimeDoctor } from "../runtime/agent-runtime.js";

type AgentRow = {
  id: number;
  name: string;
  provider: Provider;
  enabled: number;
  instructions: string;
  project_environment_id: number | null;
  created_at: string;
  updated_at: string;
};

export type CreateAgentInput = {
  name: string;
  provider: Provider;
  projectEnvironmentId: number;
  instructions?: string;
};

export type UpdateAgentInput = {
  name?: string;
  enabled?: boolean;
  projectEnvironmentId?: number;
  instructions?: string;
};

export type CloneAgentInput = {
  name: string;
};

export type AgentManagerDependencies = {
  db: Database.Database;
  dataDir: string;
  runtime: AgentRuntime;
  projectEnvironmentStore?: ProjectEnvironmentStore;
};

const toAgent = (row: AgentRow): Agent => ({
  id: row.id,
  name: row.name,
  provider: row.provider,
  enabled: row.enabled === 1,
  instructions: row.instructions,
  projectEnvironmentId: row.project_environment_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

/**
 * Stores Agent profiles and prepares their provider-specific home directories.
 */
export class AgentManager {
  private readonly db: Database.Database;
  private readonly dataDir: string;
  private readonly runtime: AgentRuntime;
  private readonly projectEnvironmentStore: ProjectEnvironmentStore;

  constructor({ db, dataDir, runtime, projectEnvironmentStore }: AgentManagerDependencies) {
    this.db = db;
    this.dataDir = dataDir;
    this.runtime = runtime;
    this.projectEnvironmentStore = projectEnvironmentStore ?? new ProjectEnvironmentStore({ db });
  }

  create(input: CreateAgentInput): Agent {
    const instructions = input.instructions ?? "";
    this.requireSupportedInstructions(input.provider, instructions);
    this.requireReadyEnvironment(input.projectEnvironmentId);
    const createdAt = new Date().toISOString();
    const id = insertedId(this.db
      .prepare(
        "INSERT INTO agents (name, provider, enabled, instructions, project_environment_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(input.name, input.provider, 1, instructions, input.projectEnvironmentId, createdAt, createdAt));
    const agentDir = this.agentDirectory(id);
    try {
      this.initializeAgentDirectory(id);
    } catch (error) {
      this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
      throw error;
    }

    return {
      id,
      name: input.name,
      provider: input.provider,
      enabled: true,
      instructions,
      projectEnvironmentId: input.projectEnvironmentId,
      createdAt,
      updatedAt: createdAt
    };
  }

  clone(id: number, input: CloneAgentInput): Agent | undefined {
    const source = this.get(id);
    if (source === undefined) return undefined;
    if (source.projectEnvironmentId === null) throw new AgentManagerError("project_environment_unavailable");
    this.requireReadyEnvironment(source.projectEnvironmentId);

    const createdAt = new Date().toISOString();
    let clonedId = 0;
    try {
      this.db.transaction(() => {
        clonedId = insertedId(this.db.prepare(`
          INSERT INTO agents
            (name, provider, enabled, instructions, project_environment_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.name,
          source.provider,
          source.enabled ? 1 : 0,
          source.instructions,
          source.projectEnvironmentId,
          createdAt,
          createdAt
        ));

        const parameterIds = new Map<number, number>();
        const parameters = this.db.prepare(`
          SELECT id, key, label, description, required, secret
          FROM agent_session_parameters WHERE agent_id = ? ORDER BY created_at ASC, id ASC
        `).all(id) as Array<{
          id: number; key: string; label: string; description: string | null; required: number; secret: number;
        }>;
        for (const parameter of parameters) {
          const newId = insertedId(this.db.prepare(`
            INSERT INTO agent_session_parameters
              (agent_id, key, label, description, required, secret, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            clonedId,
            parameter.key,
            parameter.label,
            parameter.description,
            parameter.required,
            parameter.secret,
            createdAt,
            createdAt
          ));
          parameterIds.set(parameter.id, newId);
        }

        const servers = this.db.prepare(`
          SELECT id, name, transport, enabled, url, command, check_timeout_seconds
          FROM agent_mcp_servers WHERE agent_id = ? ORDER BY created_at ASC, id ASC
        `).all(id) as Array<{
          id: number; name: string; transport: string; enabled: number; url: string | null;
          command: string | null; check_timeout_seconds: number;
        }>;
        for (const server of servers) {
          const newServerId = insertedId(this.db.prepare(`
            INSERT INTO agent_mcp_servers
              (agent_id, name, transport, enabled, url, command, check_timeout_seconds, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            clonedId,
            server.name,
            server.transport,
            server.enabled,
            server.url,
            server.command,
            server.check_timeout_seconds,
            createdAt,
            createdAt
          ));
          const values = this.db.prepare(`
            SELECT kind, position, target_name, source_type, plain_value, encrypted_value,
                   secret, session_parameter_id, runtime_key
            FROM agent_mcp_values WHERE mcp_server_id = ? ORDER BY kind ASC, position ASC
          `).all(server.id) as Array<{
            kind: string; position: number; target_name: string | null; source_type: string;
            plain_value: string | null; encrypted_value: string | null; secret: number;
            session_parameter_id: number | null; runtime_key: string | null;
          }>;
          for (const value of values) {
            this.db.prepare(`
              INSERT INTO agent_mcp_values
                (mcp_server_id, kind, position, target_name, source_type, plain_value,
                 encrypted_value, secret, session_parameter_id, runtime_key)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              newServerId,
              value.kind,
              value.position,
              value.target_name,
              value.source_type,
              value.plain_value,
              value.encrypted_value,
              value.secret,
              value.session_parameter_id === null ? null : parameterIds.get(value.session_parameter_id),
              value.runtime_key
            );
          }
        }

        this.initializeAgentDirectory(clonedId);
        this.copySkillConfiguration(id, clonedId);
      }).immediate();
    } catch (error) {
      if (clonedId !== 0) rmSync(this.agentDirectory(clonedId), { recursive: true, force: true });
      throw error;
    }

    return {
      id: clonedId,
      name: input.name,
      provider: source.provider,
      enabled: source.enabled,
      instructions: source.instructions,
      projectEnvironmentId: source.projectEnvironmentId,
      createdAt,
      updatedAt: createdAt
    };
  }

  list(): Agent[] {
    const rows = this.db.prepare("SELECT * FROM agents ORDER BY created_at ASC, id ASC").all() as AgentRow[];
    return rows.map(toAgent);
  }

  get(id: number): Agent | undefined {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
    return row === undefined ? undefined : toAgent(row);
  }

  update(id: number, input: UpdateAgentInput): Agent | undefined {
    const agent = this.get(id);
    if (agent === undefined) return undefined;

    const name = input.name ?? agent.name;
    const enabled = input.enabled ?? agent.enabled;
    const instructions = input.instructions ?? agent.instructions;
    this.requireSupportedInstructions(agent.provider, instructions);
    const projectEnvironmentId = input.projectEnvironmentId ?? agent.projectEnvironmentId;
    if (projectEnvironmentId === null) throw new AgentManagerError("project_environment_unavailable");
    this.requireReadyEnvironment(projectEnvironmentId);
    const updatedAt = new Date().toISOString();
    this.db
      .prepare("UPDATE agents SET name = ?, enabled = ?, instructions = ?, project_environment_id = ?, updated_at = ? WHERE id = ?")
      .run(name, enabled ? 1 : 0, instructions, projectEnvironmentId, updatedAt, id);

    return { ...agent, name, enabled, instructions, projectEnvironmentId, updatedAt };
  }

  delete(id: number): "deleted" | "not_found" {
    if (this.get(id) === undefined) return "not_found";
    const session = this.db.prepare("SELECT 1 FROM sessions WHERE agent_id = ? LIMIT 1").get(id);
    if (session !== undefined) throw new AgentManagerError("agent_has_sessions");
    const endpoint = this.db.prepare("SELECT 1 FROM integration_endpoints WHERE agent_id = ? LIMIT 1").get(id);
    if (endpoint !== undefined) throw new AgentManagerError("agent_has_integration_endpoints");

    this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
    rmSync(join(this.dataDir, "agents", String(id)), { recursive: true, force: true });
    return "deleted";
  }

  async doctor(id: number): Promise<{
    provider: RuntimeDoctor;
    projectEnvironment: { ok: boolean; message: string; revisionId: number | null };
  } | undefined> {
    const agent = this.get(id);
    if (agent === undefined) return undefined;
    const revision = agent.projectEnvironmentId === null
      ? undefined
      : this.projectEnvironmentStore.getCurrentRevision(agent.projectEnvironmentId);
    return {
      provider: await this.runtime.doctor(agent.provider, agent.id),
      projectEnvironment: revision?.status === "ready" && revision.workspacePath !== null
        ? { ok: true, message: "Project environment is ready", revisionId: revision.id }
        : { ok: false, message: "Project environment has no ready revision", revisionId: null }
    };
  }

  private requireReadyEnvironment(id: number): void {
    const revision = this.projectEnvironmentStore.getCurrentRevision(id);
    if (revision?.status !== "ready" || revision.workspacePath === null) {
      throw new AgentManagerError("project_environment_unavailable");
    }
  }

  private agentDirectory(id: number): string {
    return join(this.dataDir, "agents", String(id));
  }

  private initializeAgentDirectory(id: number): void {
    const agentDir = this.agentDirectory(id);
    mkdirSync(join(agentDir, "skills"), { recursive: true });
    for (const providerHome of ["claude", "codex", "hermes"]) {
      mkdirSync(join(agentDir, "provider-home", providerHome), { recursive: true });
    }
    writeFileSync(join(agentDir, "MEMORY.md"), "", { flag: "a" });
  }

  private copySkillConfiguration(sourceId: number, destinationId: number): void {
    for (const directory of ["skills", "skill-library"]) {
      const source = join(this.agentDirectory(sourceId), directory);
      if (!existsSync(source)) continue;
      const destination = join(this.agentDirectory(destinationId), directory);
      rmSync(destination, { recursive: true, force: true });
      cpSync(source, destination, { recursive: true });
    }
  }

  private requireSupportedInstructions(provider: Provider, instructions: string): void {
    if (provider === "hermes" && instructions.trim() !== "") {
      throw new AgentManagerError("agent_instructions_unsupported");
    }
  }
}

export class AgentManagerError extends Error {
  constructor(readonly code: "project_environment_unavailable" | "agent_has_sessions" | "agent_has_integration_endpoints" | "agent_instructions_unsupported") {
    super(code);
  }
}
