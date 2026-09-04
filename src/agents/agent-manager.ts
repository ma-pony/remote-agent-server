import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type Database from "better-sqlite3";

import type { Agent, AgentCoreProfile, CoreRoutingMode, Provider } from "../domain.js";
import { insertedId } from "../db.js";
import { ProjectEnvironmentStore } from "../project-environments/project-environment-store.js";
import type { AgentRuntime, RuntimeDoctor, RuntimeModelCatalog } from "../runtime/agent-runtime.js";
import { ConcurrencySettingsStore } from "../settings/concurrency-settings-store.js";
import {
  configuredCoreProfileIds,
  parseStoredModelPolicy,
  PROVIDER_DEFAULT_MODEL_POLICY,
  type AgentModelPolicy
} from "./model-policy.js";
import {
  CoreProfileStore,
  type CreateCoreProfileInput,
  type UpdateCoreProfileInput
} from "./core-profile-store.js";

type AgentRow = {
  id: number;
  name: string;
  provider: Provider;
  enabled: number;
  instructions: string;
  max_concurrent_runs: number | null;
  model_policy_json: string;
  provider_default_model: string | null;
  core_routing_mode: CoreRoutingMode;
  default_core_profile_id: number;
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
  coreRoutingMode?: CoreRoutingMode;
  defaultCoreProfileId?: number;
};

export type CloneAgentInput = {
  name: string;
};

export type AgentManagerDependencies = {
  db: Database.Database;
  dataDir: string;
  runtime: AgentRuntime;
  projectEnvironmentStore?: ProjectEnvironmentStore;
  concurrencySettingsStore?: ConcurrencySettingsStore;
};

const toAgent = (row: AgentRow, coreProfiles: AgentCoreProfile[], globalRunConcurrency: number): Agent => ({
  id: row.id,
  name: row.name,
  provider: row.provider,
  enabled: row.enabled === 1,
  instructions: row.instructions,
  maxConcurrentRuns: row.max_concurrent_runs,
  effectiveMaxConcurrentRuns: Math.min(globalRunConcurrency, row.max_concurrent_runs ?? globalRunConcurrency),
  modelPolicy: parseStoredModelPolicy(row.model_policy_json),
  providerDefaultModel: row.provider_default_model,
  coreRoutingMode: row.core_routing_mode,
  defaultCoreProfileId: row.default_core_profile_id,
  coreProfiles,
  projectEnvironmentId: row.project_environment_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const selectableDefaultModel = (catalog: RuntimeModelCatalog): string | null => catalog.currentModel !== null
  && catalog.availableModels.includes(catalog.currentModel)
  ? catalog.currentModel
  : null;

const remapPolicyProfiles = (policy: AgentModelPolicy, ids: Map<number, number>): AgentModelPolicy => {
  const remap = (profileId: number): number => {
    const clonedId = ids.get(profileId);
    if (clonedId === undefined) throw new Error("agent_core_profile_clone_mapping_missing");
    return clonedId;
  };
  if (policy.mode === "provider_default") {
    return policy.coreProfileId === undefined
      ? policy
      : { ...policy, coreProfileId: remap(policy.coreProfileId) };
  }
  if (policy.mode === "fixed") {
    return policy.coreProfileId === undefined
      ? policy
      : { ...policy, coreProfileId: remap(policy.coreProfileId) };
  }
  return {
    ...policy,
    ...(policy.defaultCoreProfileId === undefined
      ? {}
      : { defaultCoreProfileId: remap(policy.defaultCoreProfileId) }),
    windows: policy.windows.map((window) => window.coreProfileId === undefined
      ? window
      : { ...window, coreProfileId: remap(window.coreProfileId) })
  };
};

const policyModelsByProfile = (
  policy: AgentModelPolicy,
  defaultCoreProfileId: number
): Map<number, Set<string>> => {
  const result = new Map<number, Set<string>>();
  const add = (profileId: number, model: string): void => {
    const models = result.get(profileId) ?? new Set<string>();
    models.add(model);
    result.set(profileId, models);
  };
  if (policy.mode === "provider_default") return result;
  if (policy.mode === "fixed") {
    add(policy.coreProfileId ?? defaultCoreProfileId, policy.model);
    return result;
  }
  add(policy.defaultCoreProfileId ?? defaultCoreProfileId, policy.defaultModel);
  for (const window of policy.windows) add(window.coreProfileId ?? defaultCoreProfileId, window.model);
  return result;
};

/**
 * Stores Agent profiles and prepares their provider-specific home directories.
 */
export class AgentManager {
  private readonly db: Database.Database;
  private readonly dataDir: string;
  private readonly runtime: AgentRuntime;
  private readonly projectEnvironmentStore: ProjectEnvironmentStore;
  private readonly concurrencySettingsStore: ConcurrencySettingsStore;
  private readonly coreProfileStore: CoreProfileStore;

  constructor({ db, dataDir, runtime, projectEnvironmentStore, concurrencySettingsStore }: AgentManagerDependencies) {
    this.db = db;
    this.dataDir = dataDir;
    this.runtime = runtime;
    this.projectEnvironmentStore = projectEnvironmentStore ?? new ProjectEnvironmentStore({ db });
    this.concurrencySettingsStore = concurrencySettingsStore ?? new ConcurrencySettingsStore(db);
    this.coreProfileStore = new CoreProfileStore(db);
  }

  create(input: CreateAgentInput): Agent {
    const instructions = input.instructions ?? "";
    this.requireSupportedInstructions(input.provider, instructions);
    this.requireReadyEnvironment(input.projectEnvironmentId);
    const createdAt = new Date().toISOString();
    let id = 0;
    this.db.transaction(() => {
      id = insertedId(this.db.prepare(`
        INSERT INTO agents
          (name, provider, enabled, instructions, max_concurrent_runs, model_policy_json,
           core_routing_mode, project_environment_id, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?, ?, 'session_sticky', ?, ?, ?)
      `).run(
        input.name,
        input.provider,
        instructions,
        input.maxConcurrentRuns ?? null,
        JSON.stringify(PROVIDER_DEFAULT_MODEL_POLICY),
        input.projectEnvironmentId,
        createdAt,
        createdAt
      ));
      const profile = this.coreProfileStore.create(id, { name: "Default", provider: input.provider });
      this.db.prepare("UPDATE agents SET default_core_profile_id = ? WHERE id = ?").run(profile.id, id);
    })();
    const agentDir = this.agentDirectory(id);
    try {
      this.initializeAgentDirectory(id);
    } catch (error) {
      this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
      throw error;
    }

    return this.get(id)!;
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
             provider_default_model, core_routing_mode, project_environment_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.name,
          source.provider,
          source.enabled ? 1 : 0,
          source.instructions,
          source.maxConcurrentRuns,
          JSON.stringify(PROVIDER_DEFAULT_MODEL_POLICY),
          source.providerDefaultModel,
          source.coreRoutingMode,
          source.projectEnvironmentId,
          createdAt,
          createdAt
        ));

        const profileIds = new Map<number, number>();
        for (const profile of source.coreProfiles) {
          const cloned = this.coreProfileStore.create(clonedId, {
            name: profile.name,
            provider: profile.provider,
            maxConcurrentRuns: profile.maxConcurrentRuns
          });
          if (!profile.enabled) this.coreProfileStore.update(cloned.id, { enabled: false });
          profileIds.set(profile.id, cloned.id);
        }
        const defaultCoreProfileId = profileIds.get(source.defaultCoreProfileId)!;
        this.db.prepare(`
          UPDATE agents SET default_core_profile_id = ?, model_policy_json = ? WHERE id = ?
        `).run(defaultCoreProfileId, JSON.stringify(remapPolicyProfiles(source.modelPolicy, profileIds)), clonedId);

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
             source_fingerprint, created_at, updated_at)
          SELECT ?, provider, kind, extension_id, name, description,
                 source_fingerprint, ?, ?
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

    return this.get(clonedId)!;
  }

  list(): Agent[] {
    const rows = this.db.prepare("SELECT * FROM agents ORDER BY created_at ASC, id ASC").all() as AgentRow[];
    const globalRunConcurrency = this.concurrencySettingsStore.get().globalRunConcurrency;
    return rows.map((row) => toAgent(row, this.coreProfileStore.list(row.id), globalRunConcurrency));
  }

  get(id: number): Agent | undefined {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
    return row === undefined
      ? undefined
      : toAgent(row, this.coreProfileStore.list(row.id), this.concurrencySettingsStore.get().globalRunConcurrency);
  }

  async update(id: number, input: UpdateAgentInput): Promise<Agent | undefined> {
    const agent = this.get(id);
    if (agent === undefined) return undefined;

    const name = input.name ?? agent.name;
    const enabled = input.enabled ?? agent.enabled;
    const instructions = input.instructions ?? agent.instructions;
    const projectEnvironmentId = input.projectEnvironmentId ?? agent.projectEnvironmentId;
    const maxConcurrentRuns = input.maxConcurrentRuns === undefined
      ? agent.maxConcurrentRuns
      : input.maxConcurrentRuns;
    if (projectEnvironmentId === null) throw new AgentManagerError("project_environment_unavailable");
    this.requireReadyEnvironment(projectEnvironmentId);
    const modelPolicy = input.modelPolicy ?? agent.modelPolicy;
    const coreRoutingMode = input.coreRoutingMode ?? agent.coreRoutingMode;
    const defaultCoreProfileId = input.defaultCoreProfileId ?? agent.defaultCoreProfileId;
    const defaultProfile = agent.coreProfiles.find((profile) => profile.id === defaultCoreProfileId);
    if (defaultProfile === undefined || !defaultProfile.enabled) {
      throw new AgentManagerError("agent_core_profile_unavailable");
    }
    const configuredProfiles = configuredCoreProfileIds(modelPolicy);
    if (configuredProfiles.some((profileId) => !agent.coreProfiles.some((profile) => profile.id === profileId && profile.enabled))) {
      throw new AgentManagerError("agent_core_profile_unavailable");
    }
    if (coreRoutingMode === "session_sticky"
      && configuredProfiles.some((profileId) => profileId !== defaultCoreProfileId)) {
      throw new AgentManagerError("agent_core_profile_conflict");
    }
    for (const profile of agent.coreProfiles.filter(({ enabled }) => enabled)) {
      this.requireSupportedInstructions(profile.provider, instructions);
    }
    let providerDefaultModel = agent.providerDefaultModel;
    if (input.modelPolicy !== undefined || input.defaultCoreProfileId !== undefined) {
      for (const [profileId, models] of policyModelsByProfile(modelPolicy, defaultCoreProfileId)) {
        const profile = agent.coreProfiles.find((candidate) => candidate.id === profileId)!;
        const catalog = await this.discoverModels({ ...agent, instructions, projectEnvironmentId }, profile);
        if (!catalog.supported) throw new AgentManagerError("agent_model_selection_unsupported");
        if ([...models].some((model) => !catalog.availableModels.includes(model))) {
          throw new AgentManagerError("agent_model_unavailable");
        }
        if (profileId === defaultCoreProfileId) providerDefaultModel = selectableDefaultModel(catalog);
      }
      if (policyModelsByProfile(modelPolicy, defaultCoreProfileId).size === 0) {
        const catalog = await this.discoverModels({ ...agent, instructions, projectEnvironmentId }, defaultProfile);
        providerDefaultModel = selectableDefaultModel(catalog);
      }
    }
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(`
        UPDATE agents SET name = ?, enabled = ?, instructions = ?, max_concurrent_runs = ?,
          model_policy_json = ?, provider_default_model = ?, core_routing_mode = ?,
          default_core_profile_id = ?, provider = ?, project_environment_id = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        name,
        enabled ? 1 : 0,
        instructions,
        maxConcurrentRuns,
        JSON.stringify(modelPolicy),
        providerDefaultModel,
        coreRoutingMode,
        defaultCoreProfileId,
        defaultProfile.provider,
        projectEnvironmentId,
        updatedAt,
        id
      );
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
      provider: defaultProfile.provider,
      coreRoutingMode,
      defaultCoreProfileId,
      projectEnvironmentId,
      updatedAt
    };
  }

  /** Reads the model selector advertised by the Agent Core through ACP. */
  async models(id: number, coreProfileId?: number): Promise<RuntimeModelCatalog | undefined> {
    const agent = this.get(id);
    if (agent === undefined) return undefined;
    const profile = agent.coreProfiles.find((candidate) => candidate.id === (coreProfileId ?? agent.defaultCoreProfileId));
    if (profile === undefined) throw new AgentManagerError("agent_core_profile_unavailable");
    const catalog = await this.discoverModels(agent, profile);
    const providerDefaultModel = selectableDefaultModel(catalog);
    if (profile.id === agent.defaultCoreProfileId && providerDefaultModel !== agent.providerDefaultModel) {
      this.db.prepare("UPDATE agents SET provider_default_model = ? WHERE id = ?")
        .run(providerDefaultModel, id);
    }
    return catalog;
  }

  createCoreProfile(agentId: number, input: CreateCoreProfileInput): AgentCoreProfile | undefined {
    const agent = this.get(agentId);
    if (agent === undefined) return undefined;
    this.requireSupportedInstructions(input.provider, agent.instructions);
    const name = input.name.trim();
    if (agent.coreProfiles.some((profile) => profile.name === name)) {
      throw new AgentManagerError("agent_core_profile_name_conflict");
    }
    const profile = this.coreProfileStore.create(agentId, { ...input, name });
    this.concurrencySettingsStore.notify();
    return profile;
  }

  updateCoreProfile(agentId: number, profileId: number, input: UpdateCoreProfileInput): AgentCoreProfile | undefined {
    const agent = this.get(agentId);
    const profile = this.coreProfileStore.get(profileId);
    if (agent === undefined || profile?.agentId !== agentId) return undefined;
    const name = input.name?.trim();
    if (name !== undefined && agent.coreProfiles.some((candidate) => candidate.id !== profileId && candidate.name === name)) {
      throw new AgentManagerError("agent_core_profile_name_conflict");
    }
    if (profile.id === agent.defaultCoreProfileId && input.enabled === false) {
      throw new AgentManagerError("agent_default_core_profile_required");
    }
    if (input.enabled === true) this.requireSupportedInstructions(profile.provider, agent.instructions);
    if (input.enabled === false && configuredCoreProfileIds(agent.modelPolicy).includes(profile.id)) {
      throw new AgentManagerError("agent_core_profile_in_use");
    }
    if (input.enabled === false) {
      const pinned = this.db.prepare(`
        SELECT 1 FROM sessions WHERE pinned_core_profile_id = ? LIMIT 1
      `).get(profile.id);
      if (pinned !== undefined) throw new AgentManagerError("agent_core_profile_in_use");
    }
    const updated = this.coreProfileStore.update(profileId, { ...input, ...(name === undefined ? {} : { name }) });
    this.concurrencySettingsStore.notify();
    return updated;
  }

  deleteCoreProfile(agentId: number, profileId: number): "deleted" | "not_found" {
    const agent = this.get(agentId);
    const profile = this.coreProfileStore.get(profileId);
    if (agent === undefined || profile?.agentId !== agentId) return "not_found";
    if (profile.id === agent.defaultCoreProfileId) throw new AgentManagerError("agent_default_core_profile_required");
    if (configuredCoreProfileIds(agent.modelPolicy).includes(profile.id)) {
      throw new AgentManagerError("agent_core_profile_in_use");
    }
    const referenced = this.db.prepare(`
      SELECT 1 FROM session_core_bindings WHERE core_profile_id = ? LIMIT 1
    `).get(profileId);
    if (referenced !== undefined) throw new AgentManagerError("agent_core_profile_in_use");
    this.coreProfileStore.delete(profileId);
    this.concurrencySettingsStore.notify();
    return "deleted";
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

  private async discoverModels(
    agent: Pick<Agent, "id" | "instructions" | "projectEnvironmentId">,
    profile: Pick<AgentCoreProfile, "id" | "provider">
  ): Promise<RuntimeModelCatalog> {
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
      provider: profile.provider,
      coreProfileId: profile.id,
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
  constructor(readonly code:
    | "project_environment_unavailable"
    | "agent_has_sessions"
    | "agent_has_integration_endpoints"
    | "agent_instructions_unsupported"
    | "agent_model_selection_unsupported"
    | "agent_model_unavailable"
    | "agent_core_profile_unavailable"
    | "agent_core_profile_conflict"
    | "agent_core_profile_name_conflict"
    | "agent_default_core_profile_required"
    | "agent_core_profile_in_use"
  ) {
    super(code);
  }
}
