import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type Database from "better-sqlite3";

import type { Agent, Provider } from "../domain.js";
import type { AgentRuntime, RuntimeDoctor } from "../runtime/agent-runtime.js";

type AgentRow = {
  id: string;
  name: string;
  provider: Provider;
  enabled: number;
  created_at: string;
  updated_at: string;
};

export type CreateAgentInput = {
  name: string;
  provider: Provider;
};

export type UpdateAgentInput = {
  name?: string;
  enabled?: boolean;
};

export type AgentManagerDependencies = {
  db: Database.Database;
  dataDir: string;
  runtime: AgentRuntime;
};

const toAgent = (row: AgentRow): Agent => ({
  id: row.id,
  name: row.name,
  provider: row.provider,
  enabled: row.enabled === 1,
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

  constructor({ db, dataDir, runtime }: AgentManagerDependencies) {
    this.db = db;
    this.dataDir = dataDir;
    this.runtime = runtime;
  }

  create(input: CreateAgentInput): Agent {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const agentDir = join(this.dataDir, "agents", id);

    mkdirSync(join(agentDir, "skills"), { recursive: true });
    mkdirSync(join(agentDir, "provider-home", "hermes"), { recursive: true });
    writeFileSync(join(agentDir, "MEMORY.md"), "", { flag: "a" });
    this.db
      .prepare(
        "INSERT INTO agents (id, name, provider, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(id, input.name, input.provider, 1, createdAt, createdAt);

    return {
      id,
      name: input.name,
      provider: input.provider,
      enabled: true,
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
    const updatedAt = new Date().toISOString();
    this.db
      .prepare("UPDATE agents SET name = ?, enabled = ?, updated_at = ? WHERE id = ?")
      .run(name, enabled ? 1 : 0, updatedAt, id);

    return { ...agent, name, enabled, updatedAt };
  }

  async doctor(id: string): Promise<RuntimeDoctor | undefined> {
    const agent = this.get(id);
    return agent === undefined ? undefined : this.runtime.doctor(agent.provider, agent.id);
  }
}
