import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type Database from "better-sqlite3";

import type { Agent, Provider } from "../domain.js";
import { ProjectEnvironmentStore } from "../project-environments/project-environment-store.js";
import type { AgentRuntime, RuntimeDoctor } from "../runtime/agent-runtime.js";

type AgentRow = {
  id: string;
  name: string;
  provider: Provider;
  enabled: number;
  instructions: string;
  project_environment_id: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateAgentInput = {
  name: string;
  provider: Provider;
  projectEnvironmentId: string;
  instructions?: string;
};

export type UpdateAgentInput = {
  name?: string;
  enabled?: boolean;
  projectEnvironmentId?: string;
  instructions?: string;
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
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const agentDir = join(this.dataDir, "agents", id);

    mkdirSync(join(agentDir, "skills"), { recursive: true });
    for (const providerHome of ["claude", "codex", "hermes"]) {
      mkdirSync(join(agentDir, "provider-home", providerHome), { recursive: true });
    }
    writeFileSync(join(agentDir, "MEMORY.md"), "", { flag: "a" });
    this.db
      .prepare(
        "INSERT INTO agents (id, name, provider, enabled, instructions, project_environment_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(id, input.name, input.provider, 1, instructions, input.projectEnvironmentId, createdAt, createdAt);

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

  list(): Agent[] {
    const rows = this.db.prepare("SELECT * FROM agents ORDER BY created_at ASC, id ASC").all() as AgentRow[];
    return rows.map(toAgent);
  }

  get(id: string): Agent | undefined {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
    return row === undefined ? undefined : toAgent(row);
  }

  update(id: string, input: UpdateAgentInput): Agent | undefined {
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

  delete(id: string): "deleted" | "not_found" {
    if (this.get(id) === undefined) return "not_found";
    const session = this.db.prepare("SELECT 1 FROM sessions WHERE agent_id = ? LIMIT 1").get(id);
    if (session !== undefined) throw new AgentManagerError("agent_has_sessions");
    const endpoint = this.db.prepare("SELECT 1 FROM integration_endpoints WHERE agent_id = ? LIMIT 1").get(id);
    if (endpoint !== undefined) throw new AgentManagerError("agent_has_integration_endpoints");

    this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
    rmSync(join(this.dataDir, "agents", id), { recursive: true, force: true });
    return "deleted";
  }

  async doctor(id: string): Promise<{
    provider: RuntimeDoctor;
    projectEnvironment: { ok: boolean; message: string; revisionId: string | null };
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

  private requireReadyEnvironment(id: string): void {
    const revision = this.projectEnvironmentStore.getCurrentRevision(id);
    if (revision?.status !== "ready" || revision.workspacePath === null) {
      throw new AgentManagerError("project_environment_unavailable");
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
