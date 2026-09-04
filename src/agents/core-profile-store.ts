import type Database from "better-sqlite3";

import { insertedId } from "../db.js";
import type { AgentCoreProfile, Provider } from "../domain.js";

type CoreProfileRow = {
  id: number;
  agent_id: number;
  name: string;
  provider: Provider;
  enabled: number;
  max_concurrent_runs: number | null;
  created_at: string;
  updated_at: string;
};

const toProfile = (row: CoreProfileRow): AgentCoreProfile => ({
  id: row.id,
  agentId: row.agent_id,
  name: row.name,
  provider: row.provider,
  enabled: row.enabled === 1,
  maxConcurrentRuns: row.max_concurrent_runs,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

export type CreateCoreProfileInput = {
  name: string;
  provider: Provider;
  maxConcurrentRuns?: number | null;
};

export type UpdateCoreProfileInput = {
  name?: string;
  enabled?: boolean;
  maxConcurrentRuns?: number | null;
};

/** Stores the trusted Agent Core choices assigned to an Agent. */
export class CoreProfileStore {
  constructor(private readonly db: Database.Database) {}

  list(agentId: number): AgentCoreProfile[] {
    return (this.db.prepare(`
      SELECT * FROM agent_core_profiles WHERE agent_id = ? ORDER BY id ASC
    `).all(agentId) as CoreProfileRow[]).map(toProfile);
  }

  get(id: number): AgentCoreProfile | undefined {
    const row = this.db.prepare("SELECT * FROM agent_core_profiles WHERE id = ?").get(id) as CoreProfileRow | undefined;
    return row === undefined ? undefined : toProfile(row);
  }

  create(agentId: number, input: CreateCoreProfileInput): AgentCoreProfile {
    const createdAt = new Date().toISOString();
    const id = insertedId(this.db.prepare(`
      INSERT INTO agent_core_profiles
        (agent_id, name, provider, enabled, max_concurrent_runs, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?, ?)
    `).run(agentId, input.name, input.provider, input.maxConcurrentRuns ?? null, createdAt, createdAt));
    return this.get(id)!;
  }

  update(id: number, input: UpdateCoreProfileInput): AgentCoreProfile | undefined {
    const current = this.get(id);
    if (current === undefined) return undefined;
    const updatedAt = new Date().toISOString();
    this.db.prepare(`
      UPDATE agent_core_profiles
      SET name = ?, enabled = ?, max_concurrent_runs = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.name ?? current.name,
      (input.enabled ?? current.enabled) ? 1 : 0,
      input.maxConcurrentRuns === undefined ? current.maxConcurrentRuns : input.maxConcurrentRuns,
      updatedAt,
      id
    );
    return this.get(id)!;
  }

  delete(id: number): boolean {
    return this.db.prepare("DELETE FROM agent_core_profiles WHERE id = ?").run(id).changes === 1;
  }
}
