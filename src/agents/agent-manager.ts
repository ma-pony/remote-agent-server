import { PROVIDER_CAPABILITIES } from "../domain.js";
import { ProviderExtensionManager } from "../provider-extensions/provider-extension-manager.js";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type Database from "better-sqlite3";

import { pageResult, type PaginationQuery } from "../pagination.js";
import type { Agent, Provider } from "../domain.js";
import { insertedId } from "../db.js";
import { ProjectEnvironmentStore } from "../project-environments/project-environment-store.js";
import type { AgentRuntime, RuntimeDoctor, RuntimeModelCatalog } from "../runtime/agent-runtime.js";
import type { RtkManager } from "../rtk/rtk-manager.js";
import { ConcurrencySettingsStore } from "../settings/concurrency-settings-store.js";
import {
  configuredModels,
  parseStoredModelPolicy,
  PROVIDER_DEFAULT_MODEL_POLICY,
  type AgentModelPolicy
} from "./model-policy.js";

type AgentRow = {
  id: number;
  name: string;
  provider: Provider;
  enabled: number;
  instructions: string;
  max_concurrent_runs: number | null;
  model_policy_json: string;
  provider_default_model: string | null;
  project_environment_id: number | null;
  created_at: string;
  updated_at: string;
};

export type CreateAgentInput = {
  name: string;
  provider: Provider;
  projectEnvironmentId: number;
  instructions?: string;
  maxConcurrentRuns?: number | null;
};

export type UpdateAgentInput = {
  name?: string;
  enabled?: boolean;
  projectEnvironmentId?: number;
  instructions?: string;
  maxConcurrentRuns?: number | null;
  modelPolicy?: AgentModelPolicy;
};

export type CloneAgentInput = {
  name: string;
};

export type SwitchAgentProviderInput = { provider: Provider; handoff?: string; modelPolicy?: AgentModelPolicy };

export type AgentManagerDependencies = {
  db: Database.Database;
  dataDir: string;
  runtime: AgentRuntime;
  projectEnvironmentStore?: ProjectEnvironmentStore;
  concurrencySettingsStore?: ConcurrencySettingsStore;
  rtkManager?: Pick<RtkManager, "resolveForRun">;
  providerExtensionManager?: ProviderExtensionManager;
};

const toAgent = (row: AgentRow, globalRunConcurrency: number): Agent => ({
  id: row.id,
  name: row.name,
  provider: row.provider,
  enabled: row.enabled === 1,
  instructions: row.instructions,
  maxConcurrentRuns: row.max_concurrent_runs,
  effectiveMaxConcurrentRuns: Math.min(globalRunConcurrency, row.max_concurrent_runs ?? globalRunConcurrency),
  modelPolicy: parseStoredModelPolicy(row.model_policy_json),
  providerDefaultModel: row.provider_default_model,
  projectEnvironmentId: row.project_environment_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const selectableDefaultModel = (catalog: RuntimeModelCatalog): string | null => catalog.currentModel !== null
  && catalog.availableModels.includes(catalog.currentModel)
  ? catalog.currentModel
  : null;

/**
 * Stores Agent profiles and prepares their provider-specific home directories.
 */
export class AgentManager {
  private readonly db: Database.Database;
  private readonly dataDir: string;
  private readonly runtime: AgentRuntime;
  private readonly projectEnvironmentStore: ProjectEnvironmentStore;
  private readonly modelSnapshots = new Map<number, {key: string; expiresAt: number; catalog: Promise<RuntimeModelCatalog>}>();
  private readonly concurrencySettingsStore: ConcurrencySettingsStore;
  private readonly providerExtensionManager: ProviderExtensionManager;
  private readonly rtkManager: Pick<RtkManager, "resolveForRun"> | undefined;

  constructor({ db, dataDir, runtime, projectEnvironmentStore, concurrencySettingsStore, rtkManager, providerExtensionManager }: AgentManagerDependencies) {
    this.db = db;
    this.dataDir = dataDir;
    this.runtime = runtime;
    this.projectEnvironmentStore = projectEnvironmentStore ?? new ProjectEnvironmentStore({ db });
    this.concurrencySettingsStore = concurrencySettingsStore ?? new ConcurrencySettingsStore(db);
    this.rtkManager = rtkManager;
    this.providerExtensionManager = providerExtensionManager ?? new ProviderExtensionManager({ db });
  }

  create(input: CreateAgentInput): Agent {
    const instructions = input.instructions ?? "";
    this.requireSupportedInstructions(input.provider, instructions);
    this.requireReadyEnvironment(input.projectEnvironmentId);
    const createdAt = new Date().toISOString();
    const id = insertedId(this.db
      .prepare(
        "INSERT INTO agents (name, provider, enabled, instructions, max_concurrent_runs, model_policy_json, project_environment_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        input.name,
        input.provider,
        1,
        instructions,
        input.maxConcurrentRuns ?? null,
        JSON.stringify(PROVIDER_DEFAULT_MODEL_POLICY),
        input.projectEnvironmentId,
        createdAt,
        createdAt
      ));
    const agentDir = this.agentDirectory(id);
    try {
      this.initializeAgentDirectory(id);
    } catch (error) {
      this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
      throw error;
    }

    const globalRunConcurrency = this.concurrencySettingsStore.get().globalRunConcurrency;
    return {
      id,
      name: input.name,
      provider: input.provider,
      enabled: true,
      instructions,
      maxConcurrentRuns: input.maxConcurrentRuns ?? null,
      effectiveMaxConcurrentRuns: Math.min(
        globalRunConcurrency,
        input.maxConcurrentRuns ?? globalRunConcurrency
      ),
      modelPolicy: PROVIDER_DEFAULT_MODEL_POLICY,
      providerDefaultModel: null,
      projectEnvironmentId: input.projectEnvironmentId,
      createdAt,
      updatedAt: createdAt
    };
  }

  /** Changes the default Provider only when no Session under this Agent is active. */
  async switchProvider(id: number, input: SwitchAgentProviderInput): Promise<Agent | undefined> {
    const current = this.get(id);
    if (current === undefined) return undefined;
    this.requireSupportedInstructions(input.provider, current.instructions);
    const assertIdle = () => {
      const snapshots = this.db.prepare("SELECT instructions_snapshot FROM sessions WHERE agent_id = ? AND storage_cleaned_at IS NULL")
        .all(id) as Array<{ instructions_snapshot: string }>;
      for (const session of snapshots) this.requireSupportedInstructions(input.provider, session.instructions_snapshot);
      const busy = this.db.prepare(`
        SELECT 1 FROM sessions session
        WHERE session.agent_id = ?
          AND (session.status = 'running' OR session.pending_operation IS NOT NULL
            OR EXISTS (SELECT 1 FROM runs WHERE session_id = session.id AND status IN ('queued', 'running')))
        LIMIT 1
      `).get(id);
      if (busy !== undefined) throw new AgentManagerError("agent_has_running_sessions");
    };
    assertIdle();
    if (input.provider === current.provider) return current;
    if (this.rtkManager !== undefined) {
      const rtk = await this.rtkManager.resolveForRun(input.provider);
      if (rtk.requested && rtk.reason === "unsupported") throw new AgentManagerError("agent_rtk_unsupported");
    }
    this.providerExtensionManager.assertSwitchCompatible(id, input.provider);
    let catalog: RuntimeModelCatalog;
    try {
      const report = await this.runtime.doctor(input.provider, id);
      if (!report.ok) throw new AgentManagerError("agent_provider_unavailable");
      catalog = await this.discoverModels({ ...current, provider: input.provider });
    } catch { throw new AgentManagerError("agent_provider_unavailable"); }
    const now = new Date().toISOString();
    const handoff = input.handoff?.trim() || null;
    this.db.transaction(() => {
      assertIdle();
      if (JSON.stringify(this.get(id)) !== JSON.stringify(current)) throw new AgentManagerError("agent_changed");
      this.providerExtensionManager.assertSwitchCompatible(id, input.provider);
      this.db.prepare(`
        INSERT INTO agent_provider_model_policies (agent_id, provider, model_policy_json)
        VALUES (?, ?, ?)
        ON CONFLICT(agent_id, provider) DO UPDATE SET
          model_policy_json = excluded.model_policy_json
      `).run(id, current.provider, JSON.stringify(current.modelPolicy));
      const target = this.db.prepare(`
        SELECT model_policy_json FROM agent_provider_model_policies
        WHERE agent_id = ? AND provider = ?
      `).get(id, input.provider) as { model_policy_json: string } | undefined;
      const targetPolicy = input.modelPolicy ?? parseStoredModelPolicy(target?.model_policy_json ?? JSON.stringify(PROVIDER_DEFAULT_MODEL_POLICY));
      const requested = configuredModels(targetPolicy);
      if (requested.length && !catalog.supported) throw new AgentManagerError("agent_model_selection_unsupported");
      if (requested.some(model => !catalog.availableModels.includes(model))) throw new AgentManagerError("agent_model_unavailable");
      this.db.prepare(`
        UPDATE agents SET provider = ?, model_policy_json = ?, provider_default_model = ?, updated_at = ? WHERE id = ?
      `).run(input.provider, JSON.stringify(targetPolicy), selectableDefaultModel(catalog), now, id);
      const sessions = this.db.prepare("SELECT id FROM sessions WHERE agent_id = ? AND storage_cleaned_at IS NULL").all(id) as Array<{ id: number }>;
      for (const session of sessions) {
        this.db.prepare("UPDATE sessions SET provider_session_id = NULL WHERE id = ?").run(session.id);
        this.db.prepare("UPDATE execution_contexts SET retired_at = ? WHERE session_id = ? AND retired_at IS NULL")
          .run(now, session.id);
        this.db.prepare(`
          INSERT INTO execution_contexts (session_id, provider, provider_session_id, handoff, created_at)
          VALUES (?, ?, NULL, ?, ?)
        `).run(session.id, input.provider, handoff, now);
      }
    })();
    this.modelSnapshots.delete(id);
    this.concurrencySettingsStore.notify();
    return this.get(id);
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
            (name, provider, enabled, instructions, max_concurrent_runs, model_policy_json,
             provider_default_model, project_environment_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.name,
          source.provider,
          source.enabled ? 1 : 0,
          source.instructions,
          source.maxConcurrentRuns,
          JSON.stringify(source.modelPolicy),
          source.providerDefaultModel,
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
          SELECT id, source_mcp_server_id, name, transport, enabled, url, command,
                 check_timeout_seconds, allowed_tools_json
          FROM agent_mcp_servers WHERE agent_id = ? ORDER BY created_at ASC, id ASC
        `).all(id) as Array<{
          id: number; source_mcp_server_id: number | null; name: string; transport: string; enabled: number; url: string | null;
          command: string | null; check_timeout_seconds: number; allowed_tools_json: string | null;
        }>;
        for (const server of servers) {
          const newServerId = insertedId(this.db.prepare(`
            INSERT INTO agent_mcp_servers
              (agent_id, source_mcp_server_id, name, transport, enabled, url, command,
               check_timeout_seconds, allowed_tools_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            clonedId,
            server.source_mcp_server_id ?? server.id,
            server.name,
            server.transport,
            server.enabled,
            server.url,
            server.command,
            server.check_timeout_seconds,
            server.allowed_tools_json,
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

        this.db.prepare(`
          INSERT INTO agent_provider_extensions
            (agent_id, provider, kind, extension_id, name, description,
             source_fingerprint, enabled, created_at, updated_at)
          SELECT ?, provider, kind, extension_id, name, description,
                 source_fingerprint, enabled, ?, ?
          FROM agent_provider_extensions
          WHERE agent_id = ?
        `).run(clonedId, createdAt, createdAt, id);

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
      maxConcurrentRuns: source.maxConcurrentRuns,
      effectiveMaxConcurrentRuns: source.effectiveMaxConcurrentRuns,
      modelPolicy: source.modelPolicy,
      providerDefaultModel: source.providerDefaultModel,
      projectEnvironmentId: source.projectEnvironmentId,
      createdAt,
      updatedAt: createdAt
    };
  }

  list(): Agent[] {
    const rows = this.db.prepare("SELECT * FROM agents ORDER BY created_at ASC, id ASC").all() as AgentRow[];
    const globalRunConcurrency = this.concurrencySettingsStore.get().globalRunConcurrency;
    return rows.map((row) => toAgent(row, globalRunConcurrency));
  }

  listPage(input: PaginationQuery & { enabled?: boolean; provider?: Provider }) {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (input.query) { clauses.push("instr(lower(a.name), lower(?)) > 0"); params.push(input.query); }
    if (input.enabled !== undefined) { clauses.push("a.enabled = ?"); params.push(Number(input.enabled)); }
    if (input.provider !== undefined) { clauses.push("a.provider = ?"); params.push(input.provider); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = (this.db.prepare(`SELECT COUNT(*) AS total FROM agents a ${where}`).get(...params) as {total: number}).total;
    const rows = this.db.prepare(`SELECT a.*, e.name AS project_environment_name FROM agents a
      LEFT JOIN project_environments e ON e.id = a.project_environment_id ${where}
      ORDER BY a.created_at ASC, a.id ASC LIMIT ? OFFSET ?`)
      .all(...params, input.pageSize, (input.page - 1) * input.pageSize) as Array<AgentRow & {project_environment_name: string | null}>;
    const concurrency = this.concurrencySettingsStore.get().globalRunConcurrency;
    return pageResult(rows.map(row => ({...toAgent(row, concurrency), projectEnvironmentName: row.project_environment_name})), total, input);
  }

  get(id: number): Agent | undefined {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
    return row === undefined
      ? undefined
      : toAgent(row, this.concurrencySettingsStore.get().globalRunConcurrency);
  }

  async update(id: number, input: UpdateAgentInput): Promise<Agent | undefined> {
    const agent = this.get(id);
    if (agent === undefined) return undefined;

    const name = input.name ?? agent.name;
    const enabled = input.enabled ?? agent.enabled;
    const instructions = input.instructions ?? agent.instructions;
    this.requireSupportedInstructions(agent.provider, instructions);
    const projectEnvironmentId = input.projectEnvironmentId ?? agent.projectEnvironmentId;
    const maxConcurrentRuns = input.maxConcurrentRuns === undefined
      ? agent.maxConcurrentRuns
      : input.maxConcurrentRuns;
    if (projectEnvironmentId === null) throw new AgentManagerError("project_environment_unavailable");
    this.requireReadyEnvironment(projectEnvironmentId);
    const modelPolicy = input.modelPolicy ?? agent.modelPolicy;
    let providerDefaultModel = agent.providerDefaultModel;
    if (input.modelPolicy !== undefined) {
      const catalog = await this.discoverModels({
        ...agent,
        instructions,
        projectEnvironmentId
      });
      const requestedModels = configuredModels(modelPolicy);
      if (requestedModels.length > 0 && !catalog.supported) {
        throw new AgentManagerError("agent_model_selection_unsupported");
      }
      if (requestedModels.some((model) => !catalog.availableModels.includes(model))) {
        throw new AgentManagerError("agent_model_unavailable");
      }
      providerDefaultModel = selectableDefaultModel(catalog);
    }
    if (JSON.stringify(this.get(id)) !== JSON.stringify(agent)) throw new AgentManagerError("agent_changed");
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(`
        UPDATE agents SET name = ?, enabled = ?, instructions = ?, max_concurrent_runs = ?,
          model_policy_json = ?, provider_default_model = ?, project_environment_id = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        name,
        enabled ? 1 : 0,
        instructions,
        maxConcurrentRuns,
        JSON.stringify(modelPolicy),
        providerDefaultModel,
        projectEnvironmentId,
        updatedAt,
        id
      );
    this.db.prepare(`
      INSERT INTO agent_provider_model_policies (agent_id, provider, model_policy_json)
      VALUES (?, ?, ?)
      ON CONFLICT(agent_id, provider) DO UPDATE SET
        model_policy_json = excluded.model_policy_json
    `).run(id, agent.provider, JSON.stringify(modelPolicy));
    if (maxConcurrentRuns !== agent.maxConcurrentRuns
      || JSON.stringify(modelPolicy) !== JSON.stringify(agent.modelPolicy)) {
      this.concurrencySettingsStore.notify();
    }

    const globalRunConcurrency = this.concurrencySettingsStore.get().globalRunConcurrency;
    return {
      ...agent,
      name,
      enabled,
      instructions,
      maxConcurrentRuns,
      effectiveMaxConcurrentRuns: Math.min(globalRunConcurrency, maxConcurrentRuns ?? globalRunConcurrency),
      modelPolicy,
      providerDefaultModel,
      projectEnvironmentId,
      updatedAt
    };
  }

  /** Reads the model selector advertised by the Agent Core through ACP. */
  async models(id: number, useSnapshot = false): Promise<RuntimeModelCatalog | undefined> {
    const agent = this.get(id);
    if (agent === undefined) return undefined;
    const key = JSON.stringify([agent.provider, agent.instructions, agent.projectEnvironmentId,
      agent.projectEnvironmentId === null ? null : this.projectEnvironmentStore.getCurrentRevision(agent.projectEnvironmentId)?.id]);
    let snapshot = this.modelSnapshots.get(id);
    if (!useSnapshot || snapshot?.key !== key || snapshot.expiresAt <= Date.now()) {
      const catalog = this.discoverModels(agent);
      snapshot = {key, expiresAt: Date.now() + 30_000, catalog};
      if (useSnapshot) {
        this.modelSnapshots.delete(id);
        while (this.modelSnapshots.size >= 16) this.modelSnapshots.delete(this.modelSnapshots.keys().next().value!);
        this.modelSnapshots.set(id, snapshot);
        void catalog.catch(() => {if (this.modelSnapshots.get(id)?.catalog === catalog) this.modelSnapshots.delete(id);});
      }
    }
    const catalog = await snapshot.catalog;
    if (this.get(id)?.provider !== agent.provider) throw new AgentManagerError("agent_changed");
    const providerDefaultModel = selectableDefaultModel(catalog);
    if (providerDefaultModel !== agent.providerDefaultModel) {
      this.db.prepare("UPDATE agents SET provider_default_model = ? WHERE id = ?")
        .run(providerDefaultModel, id);

    }
    return catalog;
  }

  delete(id: number): "deleted" | "not_found" {
    if (this.get(id) === undefined) return "not_found";
    const session = this.db.prepare("SELECT 1 FROM sessions WHERE agent_id = ? LIMIT 1").get(id);
    if (session !== undefined) throw new AgentManagerError("agent_has_sessions");
    const endpoint = this.db.prepare("SELECT 1 FROM integration_endpoints WHERE agent_id = ? LIMIT 1").get(id);
    if (endpoint !== undefined) throw new AgentManagerError("agent_has_integration_endpoints");

    this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
    this.modelSnapshots.delete(id);
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

  private async discoverModels(agent: Pick<Agent, "id" | "provider" | "instructions" | "projectEnvironmentId">): Promise<RuntimeModelCatalog> {
    if (agent.projectEnvironmentId === null) throw new AgentManagerError("project_environment_unavailable");
    const revision = this.projectEnvironmentStore.getCurrentRevision(agent.projectEnvironmentId);
    if (revision?.status !== "ready" || revision.workspacePath === null) {
      throw new AgentManagerError("project_environment_unavailable");
    }
    if (this.runtime.listModels === undefined) {
      return { supported: false, currentModel: null, availableModels: [] };
    }
    return this.runtime.listModels({
      agentId: agent.id,
      provider: agent.provider,
      workspacePath: revision.workspacePath,
      instructions: agent.instructions
    });
  }

  private agentDirectory(id: number): string {
    return join(this.dataDir, "agents", String(id));
  }

  private initializeAgentDirectory(id: number): void {
    const agentDir = this.agentDirectory(id);
    mkdirSync(join(agentDir, "skills"), { recursive: true });
    for (const providerHome of ["claude", "codex", "hermes", "deepseek-harness"]) {
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
    if (!PROVIDER_CAPABILITIES[provider].instructions && instructions.trim() !== "") {
      throw new AgentManagerError("agent_instructions_unsupported");
    }
  }
}

export class AgentManagerError extends Error {
  constructor(readonly code:
    | "project_environment_unavailable"
    | "agent_has_sessions"
    | "agent_has_integration_endpoints"
    | "agent_has_running_sessions"
    | "agent_provider_unavailable"
    | "agent_changed"
    | "agent_instructions_unsupported"
    | "agent_model_selection_unsupported"
    | "agent_model_unavailable"
    | "agent_rtk_unsupported"
  ) {
    super(code);
  }
}
