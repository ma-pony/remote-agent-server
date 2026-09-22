import { isAbsolute, join, normalize, relative, resolve } from "node:path";

import { UsageError } from "./core/errors.js";
import { commandFiles, runtimeToolCapability, toolInput } from "./core/tool-capabilities.js";
import type { Capability, CapabilityKind, InvocationStatus, InvocationInput, ToolContentEstimate } from "./core/context-types.js";
import type { UsageFilter } from "./core/types.js";
import type { ProjectedSkill } from "../runtime/skill-projector.js";
import type { AttributionStore } from "./storage/attribution-store.js";
import type { UsageStore } from "./storage/usage-store.js";
import { RuntimeMcpReplay } from "./runtime-mcp-replay.js";

export type SkillActivityStage = "catalog_visible" | "body_read" | "reference_read" | "script_executed";

export type SkillStageCount = {
  capability: Capability;
  stage: SkillActivityStage;
  count: number;
};

type RunContext = {
  sessionId: number;
  runtimeKind: string;
  workspacePath: string;
  model: string | null;
};

type ProjectionRow = {
  capability_json: string;
  plugin_json: string | null;
  skill_md_path: string;
  directory_aliases_json: string;
};

type InvocationRow = {
  public_id: string;
  capability_json: string;
  started_at: string | null;
  ended_at: string | null;
  status: InvocationStatus;
  revision: number;
  raw_result_bytes: number | null;
  replay_result_json: string | null;
};

export type RuntimeToolEvent = { eventId: number; sequence: number; occurredAt: string };

type ActivityAssociationRow = {
  event_id: string;
  capability_json: string;
};

const MAX_PROJECTED_SKILLS = 512;
const MAX_PATH_LENGTH = 4_096;
const MAX_NATIVE_ID_LENGTH = 512;
const sourceId = "runtime_capabilities";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const safePath = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_PATH_LENGTH ? value : undefined;

const normalizedPath = (workspacePath: string, value: string): string =>
  normalize(isAbsolute(value) ? value : resolve(workspacePath, value));

const withinDirectory = (path: string, directory: string): boolean => {
  const fromDirectory = relative(directory, path);
  return fromDirectory === "" || (!fromDirectory.startsWith("..") && !isAbsolute(fromDirectory));
};

const outputBytes = (value: unknown): number | null => {
  if (value === undefined) return null;
  if (typeof value === "string") return Buffer.byteLength(value);
  if (value instanceof Uint8Array) return value.byteLength;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : Buffer.byteLength(serialized);
  } catch {
    return null;
  }
};

const statusOf = (value: unknown): InvocationStatus => {
  if (value === "completed" || value === "complete" || value === "succeeded" || value === "success") return "succeeded";
  if (value === "cancelled" || value === "canceled") return "cancelled";
  if (value === "transport_error") return "transport_error";
  if (value === "failed" || value === "error" || value === "tool_error") return "tool_error";
  return "running";
};

const terminal = (status: InvocationStatus): boolean => status !== "running";

/**
 * Persists bounded, body-free evidence from Runtime tool events. Live MCP mirrors are excluded;
 * retained events can enrich an unambiguous wrapper or restore a call without wrapper evidence.
 */
export class RuntimeCapabilityCollector {
  private readonly mcpReplay: RuntimeMcpReplay;
  constructor(
    private readonly store: UsageStore,
    private readonly attribution: AttributionStore,
    private readonly namespace = "remote-agent-server"
  ) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_usage_runtime_skill_projections (
        namespace TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, generation INTEGER NOT NULL,
        provider_epoch_id TEXT NOT NULL, execution_id TEXT NOT NULL, runtime_kind TEXT NOT NULL,
        skill_id TEXT NOT NULL, capability_json TEXT NOT NULL, plugin_json TEXT, source_json TEXT NOT NULL,
        skill_md_path TEXT NOT NULL, directory_aliases_json TEXT NOT NULL,
        PRIMARY KEY(namespace, session_id, provider_epoch_id, execution_id, skill_id)
      );
      CREATE TABLE IF NOT EXISTS agent_usage_runtime_activity (
        namespace TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, generation INTEGER NOT NULL,
        provider_epoch_id TEXT NOT NULL, execution_id TEXT NOT NULL, runtime_kind TEXT NOT NULL,
        native_call_id TEXT, event_id TEXT NOT NULL, capability_json TEXT NOT NULL,
        stage TEXT NOT NULL, observed_at TEXT NOT NULL,
        PRIMARY KEY(namespace, session_id, provider_epoch_id, execution_id, event_id, capability_json, stage)
      );
      CREATE INDEX IF NOT EXISTS agent_usage_runtime_projection_run
        ON agent_usage_runtime_skill_projections(namespace, session_id, execution_id);
      CREATE INDEX IF NOT EXISTS agent_usage_runtime_activity_subject
        ON agent_usage_runtime_activity(namespace, agent_id, session_id, observed_at);
    `);
    const activityColumns = store.db.prepare("PRAGMA table_info(agent_usage_runtime_activity)").all() as Array<{ name: string }>;
    if (!activityColumns.some((column) => column.name === "native_call_id")) {
      store.db.exec("ALTER TABLE agent_usage_runtime_activity ADD COLUMN native_call_id TEXT");
    }
    this.mcpReplay = new RuntimeMcpReplay(store, attribution);
    store.db.exec(`CREATE INDEX IF NOT EXISTS agent_usage_runtime_activity_call
      ON agent_usage_runtime_activity(namespace, session_id, provider_epoch_id, execution_id, native_call_id)`);
    store.db.exec(`CREATE TABLE IF NOT EXISTS agent_usage_runtime_runs (
      namespace TEXT NOT NULL, session_id TEXT NOT NULL, execution_id TEXT NOT NULL, provider_epoch_id TEXT NOT NULL,
      PRIMARY KEY(namespace, session_id, execution_id)
    )`);
  }

  recordRun(runId: number): void {
    const run = this.runContext(runId);
    const binding = this.store.bindSession(this.namespace, String(run.agentId), String(run.sessionId));
    this.runEpoch(binding.namespace, binding.sessionId, String(runId), false);
  }

  recordProjection(runId: number, projectedSkills: readonly ProjectedSkill[]): void {
    const run = this.runContext(runId);
    const binding = this.store.bindSession(this.namespace, String(run.agentId), String(run.sessionId));
    const epoch = this.runEpoch(binding.namespace, binding.sessionId, String(runId), false);
    const skills = projectedSkills.slice(0, MAX_PROJECTED_SKILLS);
    this.store.db.transaction(() => {
      this.store.assertBinding(binding);
      this.store.db.prepare(`DELETE FROM agent_usage_runtime_skill_projections
        WHERE namespace = ? AND session_id = ? AND provider_epoch_id = ? AND execution_id = ?`)
        .run(binding.namespace, binding.sessionId, epoch, String(runId));
      const insertProjection = this.store.db.prepare(`INSERT INTO agent_usage_runtime_skill_projections
        (namespace, agent_id, session_id, generation, provider_epoch_id, execution_id, runtime_kind,
         skill_id, capability_json, plugin_json, source_json, skill_md_path, directory_aliases_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const skill of skills) {
        const skillMdPath = safePath(skill.skillMdPath);
        const directoryAliases = skill.directoryAliases.slice(0, 8).flatMap((path) => safePath(path) ?? []);
        if (skillMdPath === undefined || directoryAliases.length === 0) throw new Error("invalid_projected_skill_path");
        const capability: Capability = { id: skill.id, kind: "skill", name: skill.name, version: skill.revision };
        const plugin = skill.pluginId === undefined ? null : {
          id: skill.pluginId,
          kind: "plugin" as const,
          name: skill.pluginName ?? skill.pluginId,
          ...(skill.pluginVersion === undefined ? {} : { version: skill.pluginVersion })
        };
        insertProjection.run(binding.namespace, binding.agentId, binding.sessionId, binding.generation,
          epoch, String(runId), run.runtimeKind, skill.id, JSON.stringify(capability),
          plugin === null ? null : JSON.stringify(plugin), JSON.stringify({
            source: skill.source,
            ...(skill.sourceId === undefined ? {} : { sourceId: skill.sourceId }),
            ...(skill.packageName === undefined ? {} : { packageName: skill.packageName })
          }), skillMdPath, JSON.stringify(directoryAliases));
        this.recordActivity(binding, epoch, String(runId), run.runtimeKind, `projection:${skill.id}`,
          capability, "catalog_visible", null);
      }
    })();
  }

  async recordTool(runId: number, content: Record<string, unknown>, event?: RuntimeToolEvent, signal?: AbortSignal): Promise<void> {
    const nativeId = typeof content.toolCallId === "string" && content.toolCallId.length > 0
      && content.toolCallId.length <= MAX_NATIVE_ID_LENGTH
      ? content.toolCallId
      : undefined;
    if (nativeId === undefined) return;
    const run = this.runContext(runId);
    const binding = this.store.bindSession(this.namespace, String(run.agentId), String(run.sessionId));
    const epoch = this.runEpoch(binding.namespace, binding.sessionId, String(runId), event !== undefined);
    const kind = typeof content.kind === "string" ? content.kind : "unknown";
    const input = toolInput(content.rawInput);
    const mcp = record(content.mcp);
    const status = statusOf(content.status);
    const observedAt = event?.occurredAt ?? new Date().toISOString();
    const result = content.rawOutput === undefined ? content.content : content.rawOutput;
    const liveMcp = event === undefined && ([input, mcp].some(value =>
      typeof value?.server === "string" && typeof value?.tool === "string") || this.store.db.prepare(`SELECT 1
        FROM agent_usage_runtime_mcp_mirrors WHERE namespace=? AND session_id=? AND provider_epoch_id=?
          AND execution_id=? AND native_call_id=?`).get(binding.namespace, binding.sessionId, epoch, String(runId), nativeId));
    const measuredPayload: Pick<InvocationInput, "argumentEstimate" | "resultEstimate"> = liveMcp ? {} : {
      argumentEstimate: await this.attribution.measureContent(input?.server !== undefined && input?.tool !== undefined
        ? input.arguments : content.rawInput, "arguments", run.model, signal),
      resultEstimate: await this.attribution.measureContent(result, "result", run.model, signal)
    };
    const measure = () => measuredPayload;
    this.store.db.transaction(() => {
      this.store.assertBinding(binding);
      const baseInvocationId = `runtime:${run.runtimeKind}:run:${runId}:call:${nativeId}`;

      const mcpResult = this.mcpReplay.record(binding, epoch, String(runId), nativeId, input, mcp, observedAt, event !== undefined, status, measure);
      if (mcpResult.isMcp) {
        if (mcpResult.capability) {
          this.observe(binding, epoch, String(runId), run.runtimeKind, baseInvocationId, mcpResult.capability,
            status, observedAt, outputBytes(result), measure(), event !== undefined);
        } else {
          // Retire a sparse unknown row, or an older fallback now owned by a matched wrapper.
          this.store.db.prepare(`DELETE FROM agent_usage_invocations WHERE namespace=? AND session_id=?
            AND provider_epoch_id=? AND invocation_id=? AND (? OR json_extract(capability_json,'$.kind')!='mcp_tool')`)
            .run(binding.namespace, binding.sessionId, epoch, baseInvocationId, Number(mcpResult.matched ?? false));
        }
        return;
      }

      const bytes = outputBytes(result);
      const payload = measure();
      const primary = runtimeToolCapability(run.runtimeKind, kind, input);
      this.observe(binding, epoch, String(runId), run.runtimeKind, baseInvocationId, primary, status, observedAt, bytes, payload, event !== undefined);

      let associations = this.associations(binding.namespace, binding.sessionId, epoch, String(runId), nativeId);
      if (associations.length === 0) {
        const projections = this.projections(binding.namespace, binding.sessionId, epoch, String(runId));
        const files = kind === "execute" ? commandFiles(input) : { readPaths: [], scriptPaths: [], cwd: undefined };
        const directory = files.cwd === undefined ? run.workspacePath : normalizedPath(run.workspacePath, files.cwd);
        const eventPath = this.eventPath(run.workspacePath, kind, input, content.locations);
        const readPaths = eventPath === undefined ? files.readPaths.map(path => normalizedPath(directory, path)) : [eventPath];
        const scriptPaths = files.scriptPaths.map(path => normalizedPath(directory, path));
        for (const projection of projections) {
          const capability = JSON.parse(projection.capability_json) as Capability;
          const aliases = JSON.parse(projection.directory_aliases_json) as string[];
          const skillMdPaths = [projection.skill_md_path, ...aliases.map((directory) => join(directory, "SKILL.md"))]
            .map((path) => normalize(path));
          let stage: Exclude<SkillActivityStage, "catalog_visible"> | undefined;
          if (readPaths.some(path => skillMdPaths.includes(path))) stage = "body_read";
          else if (readPaths.some(path => aliases.some(directory => withinDirectory(path, normalize(directory))))) {
            stage = "reference_read";
          }
          if (scriptPaths.some(path => aliases.some(directory => withinDirectory(path, normalize(directory))))) {
            stage = "script_executed";
          }
          if (stage === undefined) continue;
          const skillInvocationId = `${baseInvocationId}:skill:${capability.id}`;
          this.recordActivity(binding, epoch, String(runId), run.runtimeKind, skillInvocationId, capability, stage, nativeId, observedAt);
          if (projection.plugin_json !== null) {
            const plugin = JSON.parse(projection.plugin_json) as Capability;
            const pluginInvocationId = `${baseInvocationId}:plugin:${plugin.id}`;
            this.recordActivity(binding, epoch, String(runId), run.runtimeKind, pluginInvocationId, plugin, stage, nativeId, observedAt);
          }
        }
        associations = this.associations(binding.namespace, binding.sessionId, epoch, String(runId), nativeId);
      }
      for (const association of associations) {
        this.observe(binding, epoch, String(runId), run.runtimeKind, association.event_id,
          JSON.parse(association.capability_json) as Capability, status, observedAt, bytes, payload, event !== undefined);
      }
    })();
    if ([measuredPayload.argumentEstimate, measuredPayload.resultEstimate].some(value => value?.estimate.reason === "tokenizer_pending")) {
      throw new UsageError("usage_tokenizer_pending");
    }
  }

  private stageCountQuery(filter: UsageFilter, dimension: "all" | CapabilityKind = "all") {
    const clauses: string[] = [];
    const params: string[] = [];
    for (const [field, column] of [["namespace", "namespace"], ["agentId", "agent_id"], ["sessionId", "session_id"]] as const) {
      const value = filter[field];
      if (value !== undefined) { clauses.push(`${column} = ?`); params.push(value); }
    }
    if (filter.runtimeKind !== undefined) { clauses.push("runtime_kind = ?"); params.push(filter.runtimeKind); }
    if (filter.from !== undefined) { clauses.push("observed_at >= ?"); params.push(filter.from); }
    if (filter.to !== undefined) { clauses.push("observed_at < ?"); params.push(filter.to); }
    if (dimension !== "all") { clauses.push("json_extract(capability_json, '$.kind') = ?"); params.push(dimension); }
    return { sql: `SELECT capability_json, stage, COUNT(*) AS count
      FROM agent_usage_runtime_activity ${clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`}
      GROUP BY capability_json, stage`, params };
  }

  stageCounts(filter: UsageFilter): SkillStageCount[] {
    const query = this.stageCountQuery(filter);
    const rows = this.store.db.prepare(query.sql + " ORDER BY count DESC, capability_json ASC, stage ASC").all(...query.params) as Array<{ capability_json: string; stage: SkillActivityStage; count: number }>;
    return rows.map((row) => ({ capability: JSON.parse(row.capability_json) as Capability, stage: row.stage, count: row.count }));
  }

  stageCountsPage(filter: UsageFilter, pagination: { dimension: "all" | CapabilityKind; limit: number; offset: number }): { items: SkillStageCount[]; total: number } {
    const query = this.stageCountQuery(filter, pagination.dimension);
    const total = (this.store.db.prepare(`SELECT COUNT(*) AS total FROM (${query.sql})`).get(...query.params) as { total: number }).total;
    const rows = this.store.db.prepare(query.sql + " ORDER BY count DESC, capability_json ASC, stage ASC LIMIT ? OFFSET ?")
      .all(...query.params, pagination.limit, pagination.offset) as Array<{ capability_json: string; stage: SkillActivityStage; count: number }>;
    return { total, items: rows.map((row) => ({ capability: JSON.parse(row.capability_json) as Capability, stage: row.stage, count: row.count })) };
  }

  deleteSession(namespace: string, sessionId: string): void {
    this.store.db.prepare("DELETE FROM agent_usage_runtime_runs WHERE namespace = ? AND session_id = ?")
      .run(namespace, sessionId);
    this.store.db.prepare("DELETE FROM agent_usage_runtime_mcp_mirrors WHERE namespace = ? AND session_id = ?")
      .run(namespace, sessionId);
    this.store.db.prepare("DELETE FROM agent_usage_runtime_activity WHERE namespace = ? AND session_id = ?")
      .run(namespace, sessionId);
    this.store.db.prepare("DELETE FROM agent_usage_runtime_skill_projections WHERE namespace = ? AND session_id = ?")
      .run(namespace, sessionId);
  }

  private runContext(runId: number): RunContext & { agentId: number } {
    const row = this.store.db.prepare(`SELECT r.session_id, r.resolved_model, s.agent_id, s.workspace_path, a.provider
      FROM runs r JOIN sessions s ON s.id = r.session_id JOIN agents a ON a.id = s.agent_id WHERE r.id = ?`)
      .get(runId) as { session_id: number; agent_id: number; workspace_path: string; provider: string; resolved_model: string | null } | undefined;
    if (row === undefined) throw new UsageError("usage_run_not_found");
    return { sessionId: row.session_id, agentId: row.agent_id, workspacePath: row.workspace_path, runtimeKind: row.provider, model: row.resolved_model };
  }

  private epoch(namespace: string, sessionId: string): string {
    const row = this.store.db.prepare(`SELECT epoch FROM agent_usage_subjects
      WHERE namespace = ? AND kind = 'session' AND subject_id = ? AND state = 'active'`)
      .get(namespace, sessionId) as { epoch: number } | undefined;
    if (row === undefined) throw new UsageError("usage_subject_deleted");
    return `session:${sessionId}:epoch:${row.epoch}`;
  }

  private runEpoch(namespace: string, sessionId: string, executionId: string, historical: boolean): string {
    const existing = this.store.db.prepare(`SELECT provider_epoch_id FROM agent_usage_runtime_runs
      WHERE namespace=? AND session_id=? AND execution_id=?`).get(namespace, sessionId, executionId) as { provider_epoch_id: string } | undefined;
    if (existing) return existing.provider_epoch_id;
    const prior = this.store.db.prepare(`SELECT provider_epoch_id FROM agent_usage_invocations
      WHERE namespace=? AND session_id=? AND execution_id=? AND origin='execution'
      ORDER BY CASE WHEN source_id='runtime_capabilities' THEN 0 ELSE 1 END, started_at, ended_at LIMIT 1`)
      .get(namespace, sessionId, executionId) as { provider_epoch_id: string } | undefined;
    const projection = this.store.db.prepare(`SELECT provider_epoch_id FROM agent_usage_runtime_skill_projections
      WHERE namespace=? AND session_id=? AND execution_id=? LIMIT 1`).get(namespace, sessionId, executionId) as { provider_epoch_id: string } | undefined;
    const epoch = prior?.provider_epoch_id ?? projection?.provider_epoch_id
      ?? (historical ? `session:${sessionId}:run:${executionId}` : this.epoch(namespace, sessionId));
    this.store.db.prepare("INSERT INTO agent_usage_runtime_runs VALUES (?, ?, ?, ?)").run(namespace, sessionId, executionId, epoch);
    return epoch;
  }

  private projections(namespace: string, sessionId: string, epoch: string, executionId: string): ProjectionRow[] {
    return this.store.db.prepare(`SELECT capability_json, plugin_json, skill_md_path, directory_aliases_json
      FROM agent_usage_runtime_skill_projections
      WHERE namespace = ? AND session_id = ? AND provider_epoch_id = ? AND execution_id = ?`)
      .all(namespace, sessionId, epoch, executionId) as ProjectionRow[];
  }

  private associations(
    namespace: string,
    sessionId: string,
    epoch: string,
    executionId: string,
    nativeCallId: string
  ): ActivityAssociationRow[] {
    const rows = this.store.db.prepare(`SELECT event_id, capability_json FROM agent_usage_runtime_activity
      WHERE namespace = ? AND session_id = ? AND provider_epoch_id = ? AND execution_id = ?
        AND native_call_id = ? AND stage != 'catalog_visible'
      ORDER BY event_id ASC`).all(namespace, sessionId, epoch, executionId, nativeCallId) as ActivityAssociationRow[];
    return [...new Map(rows.map((row) => [row.event_id, row])).values()];
  }

  private eventPath(
    workspacePath: string,
    kind: string,
    input: Record<string, unknown> | undefined,
    locations: unknown
  ): string | undefined {
    if (kind !== "read") return undefined;
    const inputPath = safePath(input?.path) ?? safePath(input?.filePath) ?? safePath(input?.file_path);
    if (inputPath !== undefined) return normalizedPath(workspacePath, inputPath);
    if (!Array.isArray(locations)) return undefined;
    for (const value of locations.slice(0, 64)) {
      const path = safePath(record(value)?.path);
      if (path !== undefined) return normalizedPath(workspacePath, path);
    }
    return undefined;
  }

  private observe(
    binding: ReturnType<UsageStore["bindSession"]>,
    epoch: string,
    executionId: string,
    runtimeKind: string,
    invocationId: string,
    capability: Capability,
    status: InvocationStatus,
    observedAt: string,
    bytes: number | null,
    payload: Pick<InvocationInput, "argumentEstimate" | "resultEstimate"> = {},
    replay = false
  ): void {
    const previous = this.store.db.prepare(`SELECT public_id, capability_json, started_at, ended_at, status, revision, raw_result_bytes, replay_result_json
      FROM agent_usage_invocations WHERE namespace = ? AND session_id = ? AND provider_epoch_id = ? AND invocation_id = ?`)
      .get(binding.namespace, binding.sessionId, epoch, invocationId) as InvocationRow | undefined;
    const priorCapability = previous === undefined ? undefined : JSON.parse(previous.capability_json) as Capability;
    const genericShell = priorCapability?.kind === "cli" && priorCapability.id.endsWith(":cli:shell") && capability.kind === "cli";
    const stableCapability = priorCapability === undefined || priorCapability.kind === "unknown" || genericShell ? capability : priorCapability;
    const startedAt = previous?.started_at ?? (status === "running" ? observedAt : null);
    const stableStatus = previous !== undefined && terminal(previous.status) ? previous.status : status;
    const priorTerminal = previous !== undefined && terminal(previous.status) && status === "running";
    const existingResult = priorTerminal ? this.attribution.invocation(binding.namespace, previous.public_id)?.resultEstimate : null;
    // A sparse terminal event can refer to the final progress payload. Stage counts, never its body,
    // until replay reaches that terminal event so older progress cannot overwrite the finished result.
    const stagedResult = replay && status === "running" ? payload.resultEstimate : undefined;
    const pendingResult = payload.resultEstimate?.estimate.reason === "tokenizer_pending" ? payload.resultEstimate : undefined;
    const resultEstimate = replay && status === "running" ? pendingResult
      : payload.resultEstimate ?? (replay && previous?.replay_result_json ? JSON.parse(previous.replay_result_json) as ToolContentEstimate : undefined);
    this.attribution.observeInvocation(binding, {
      invocationId,
      providerEpochId: epoch,
      executionId,
      capability: stableCapability,
      startedAt,
      endedAt: previous?.ended_at ?? (terminal(status) ? observedAt : null),
      status: stableStatus,
      runtimeKind,
      executionEvidence: "direct",
      origin: "execution",
      sourceId,
      revision: (previous?.revision ?? 0) + 1,
      rawResultBytes: priorTerminal ? previous.raw_result_bytes ?? bytes : bytes ?? previous?.raw_result_bytes ?? null,
      ...payload,
      resultEstimate: existingResult && !pendingResult ? undefined : resultEstimate
    });
    if (replay && (stagedResult || terminal(status))) this.store.db.prepare(`UPDATE agent_usage_invocations SET replay_result_json=?
      WHERE namespace=? AND session_id=? AND provider_epoch_id=? AND invocation_id=?`)
      .run(stagedResult ? JSON.stringify(stagedResult) : null, binding.namespace, binding.sessionId, epoch, invocationId);
  }

  private recordActivity(
    binding: ReturnType<UsageStore["bindSession"]>,
    epoch: string,
    executionId: string,
    runtimeKind: string,
    eventId: string,
    capability: Capability,
    stage: SkillActivityStage,
    nativeCallId: string | null,
    observedAt = new Date().toISOString()
  ): void {
    this.store.db.prepare(`INSERT OR IGNORE INTO agent_usage_runtime_activity
      (namespace, agent_id, session_id, generation, provider_epoch_id, execution_id, runtime_kind,
       native_call_id, event_id, capability_json, stage, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(binding.namespace, binding.agentId, binding.sessionId, binding.generation, epoch, executionId,
        runtimeKind, nativeCallId, eventId, JSON.stringify(capability), stage, observedAt);
  }
}
