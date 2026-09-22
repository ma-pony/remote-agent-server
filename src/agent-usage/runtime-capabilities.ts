import { isAbsolute, join, normalize, relative, resolve } from "node:path";

import { UsageError } from "./core/errors.js";
import { runtimeToolCapability, structuredExecutable } from "./core/tool-capabilities.js";
import type { Capability, InvocationStatus } from "./core/context-types.js";
import type { UsageFilter } from "./core/types.js";
import type { ProjectedSkill } from "../runtime/skill-projector.js";
import type { AttributionStore } from "./storage/attribution-store.js";
import type { UsageStore } from "./storage/usage-store.js";

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
};

type ProjectionRow = {
  capability_json: string;
  plugin_json: string | null;
  skill_md_path: string;
  directory_aliases_json: string;
};

type InvocationRow = {
  capability_json: string;
  started_at: string | null;
  status: InvocationStatus;
  revision: number;
  raw_result_bytes: number | null;
};

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
 * Persists bounded, body-free evidence from Runtime tool events. MCP identity is deliberately
 * excluded here because the MCP wrapper is authoritative for server/tool attribution.
 */
export class RuntimeCapabilityCollector {
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
    store.db.exec(`CREATE TABLE IF NOT EXISTS agent_usage_runtime_mcp_mirrors (
      namespace TEXT NOT NULL, session_id TEXT NOT NULL, provider_epoch_id TEXT NOT NULL,
      execution_id TEXT NOT NULL, native_call_id TEXT NOT NULL,
      PRIMARY KEY(namespace, session_id, provider_epoch_id, execution_id, native_call_id)
    )`);
    store.db.exec(`CREATE INDEX IF NOT EXISTS agent_usage_runtime_activity_call
      ON agent_usage_runtime_activity(namespace, session_id, provider_epoch_id, execution_id, native_call_id)`);
  }

  recordProjection(runId: number, projectedSkills: readonly ProjectedSkill[]): void {
    const run = this.runContext(runId);
    const binding = this.store.bindSession(this.namespace, String(run.agentId), String(run.sessionId));
    const epoch = this.epoch(binding.namespace, binding.sessionId);
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

  recordTool(runId: number, content: Record<string, unknown>): void {
    const nativeId = typeof content.toolCallId === "string" && content.toolCallId.length > 0
      && content.toolCallId.length <= MAX_NATIVE_ID_LENGTH
      ? content.toolCallId
      : undefined;
    if (nativeId === undefined) return;
    const run = this.runContext(runId);
    const binding = this.store.bindSession(this.namespace, String(run.agentId), String(run.sessionId));
    const epoch = this.epoch(binding.namespace, binding.sessionId);
    const kind = typeof content.kind === "string" ? content.kind : "unknown";
    const input = record(content.rawInput);
    const mirrorKey = [binding.namespace, binding.sessionId, epoch, String(runId), nativeId];
    const mcp = record(content.mcp);
    if (typeof input?.server === "string" && typeof input?.tool === "string"
      || typeof mcp?.server === "string" && typeof mcp?.tool === "string") {
      this.store.db.prepare("INSERT OR IGNORE INTO agent_usage_runtime_mcp_mirrors VALUES (?, ?, ?, ?, ?)").run(...mirrorKey);
      // A sparse initial event can precede the structured identity. The wrapper owns MCP accounting.
      this.store.db.prepare(`DELETE FROM agent_usage_invocations WHERE namespace = ? AND session_id = ?
        AND provider_epoch_id = ? AND execution_id = ? AND invocation_id = ?`)
        .run(binding.namespace, binding.sessionId, epoch, String(runId), `runtime:${run.runtimeKind}:run:${runId}:call:${nativeId}`);
    }
    if (this.store.db.prepare(`SELECT 1 FROM agent_usage_runtime_mcp_mirrors WHERE namespace = ? AND session_id = ?
      AND provider_epoch_id = ? AND execution_id = ? AND native_call_id = ?`).get(...mirrorKey)) return;
    const executable = structuredExecutable(kind, input);
    const status = statusOf(content.status);
    const observedAt = new Date().toISOString();
    const bytes = outputBytes(content.rawOutput);
    const baseInvocationId = `runtime:${run.runtimeKind}:run:${runId}:call:${nativeId}`;

    const primary = runtimeToolCapability(run.runtimeKind, kind, input);
    this.observe(binding, epoch, String(runId), run.runtimeKind, baseInvocationId, primary, status, observedAt, bytes);

    let associations = this.associations(binding.namespace, binding.sessionId, epoch, String(runId), nativeId);
    if (associations.length === 0) {
      const projections = this.projections(binding.namespace, binding.sessionId, epoch, String(runId));
      const eventPath = this.eventPath(run.workspacePath, kind, input, content.locations);
      const executablePath = executable?.path === undefined ? undefined : normalizedPath(run.workspacePath, executable.path);
      for (const projection of projections) {
        const capability = JSON.parse(projection.capability_json) as Capability;
        const aliases = JSON.parse(projection.directory_aliases_json) as string[];
        const skillMdPaths = [projection.skill_md_path, ...aliases.map((directory) => join(directory, "SKILL.md"))]
          .map((path) => normalize(path));
        let stage: Exclude<SkillActivityStage, "catalog_visible"> | undefined;
        if (eventPath !== undefined && kind === "read") {
          if (skillMdPaths.includes(eventPath)) stage = "body_read";
          else if (aliases.some((directory) => withinDirectory(eventPath, normalize(directory)))) stage = "reference_read";
        }
        if (executablePath !== undefined && aliases.some((directory) => withinDirectory(executablePath, normalize(directory)))) {
          stage = "script_executed";
        }
        if (stage === undefined) continue;
        const skillInvocationId = `${baseInvocationId}:skill:${capability.id}`;
        this.recordActivity(binding, epoch, String(runId), run.runtimeKind, skillInvocationId, capability, stage, nativeId);
        if (projection.plugin_json !== null) {
          const plugin = JSON.parse(projection.plugin_json) as Capability;
          const pluginInvocationId = `${baseInvocationId}:plugin:${plugin.id}`;
          this.recordActivity(binding, epoch, String(runId), run.runtimeKind, pluginInvocationId, plugin, stage, nativeId);
        }
        break;
      }
      associations = this.associations(binding.namespace, binding.sessionId, epoch, String(runId), nativeId);
    }
    for (const association of associations) {
      this.observe(binding, epoch, String(runId), run.runtimeKind, association.event_id,
        JSON.parse(association.capability_json) as Capability, status, observedAt, bytes);
    }
  }

  stageCounts(filter: UsageFilter): SkillStageCount[] {
    const clauses: string[] = [];
    const params: string[] = [];
    for (const [field, column] of [["namespace", "namespace"], ["agentId", "agent_id"], ["sessionId", "session_id"]] as const) {
      const value = filter[field];
      if (value !== undefined) { clauses.push(`${column} = ?`); params.push(value); }
    }
    if (filter.runtimeKind !== undefined) { clauses.push("runtime_kind = ?"); params.push(filter.runtimeKind); }
    if (filter.from !== undefined) { clauses.push("observed_at >= ?"); params.push(filter.from); }
    if (filter.to !== undefined) { clauses.push("observed_at < ?"); params.push(filter.to); }
    const rows = this.store.db.prepare(`SELECT capability_json, stage, COUNT(*) AS count
      FROM agent_usage_runtime_activity ${clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`}
      GROUP BY capability_json, stage ORDER BY count DESC, capability_json ASC`).all(...params) as Array<{
        capability_json: string; stage: SkillActivityStage; count: number;
      }>;
    return rows.map((row) => ({
      capability: JSON.parse(row.capability_json) as Capability,
      stage: row.stage,
      count: row.count
    }));
  }

  deleteSession(namespace: string, sessionId: string): void {
    this.store.db.prepare("DELETE FROM agent_usage_runtime_mcp_mirrors WHERE namespace = ? AND session_id = ?")
      .run(namespace, sessionId);
    this.store.db.prepare("DELETE FROM agent_usage_runtime_activity WHERE namespace = ? AND session_id = ?")
      .run(namespace, sessionId);
    this.store.db.prepare("DELETE FROM agent_usage_runtime_skill_projections WHERE namespace = ? AND session_id = ?")
      .run(namespace, sessionId);
  }

  private runContext(runId: number): RunContext & { agentId: number } {
    const row = this.store.db.prepare(`SELECT r.session_id, s.agent_id, s.workspace_path, a.provider
      FROM runs r JOIN sessions s ON s.id = r.session_id JOIN agents a ON a.id = s.agent_id WHERE r.id = ?`)
      .get(runId) as { session_id: number; agent_id: number; workspace_path: string; provider: string } | undefined;
    if (row === undefined) throw new UsageError("usage_run_not_found");
    return { sessionId: row.session_id, agentId: row.agent_id, workspacePath: row.workspace_path, runtimeKind: row.provider };
  }

  private epoch(namespace: string, sessionId: string): string {
    const row = this.store.db.prepare(`SELECT epoch FROM agent_usage_subjects
      WHERE namespace = ? AND kind = 'session' AND subject_id = ? AND state = 'active'`)
      .get(namespace, sessionId) as { epoch: number } | undefined;
    if (row === undefined) throw new UsageError("usage_subject_deleted");
    return `session:${sessionId}:epoch:${row.epoch}`;
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
    bytes: number | null
  ): void {
    const previous = this.store.db.prepare(`SELECT capability_json, started_at, status, revision, raw_result_bytes
      FROM agent_usage_invocations WHERE namespace = ? AND session_id = ? AND provider_epoch_id = ? AND invocation_id = ?`)
      .get(binding.namespace, binding.sessionId, epoch, invocationId) as InvocationRow | undefined;
    const priorCapability = previous === undefined ? undefined : JSON.parse(previous.capability_json) as Capability;
    const stableCapability = priorCapability === undefined || priorCapability.kind === "unknown" ? capability : priorCapability;
    const startedAt = previous?.started_at ?? (status === "running" ? observedAt : null);
    this.attribution.observeInvocation(binding, {
      invocationId,
      providerEpochId: epoch,
      executionId,
      capability: stableCapability,
      startedAt,
      endedAt: terminal(status) ? observedAt : null,
      status,
      runtimeKind,
      executionEvidence: "direct",
      origin: "execution",
      sourceId,
      revision: (previous?.revision ?? 0) + 1,
      rawResultBytes: bytes ?? previous?.raw_result_bytes ?? null
    });
  }

  private recordActivity(
    binding: ReturnType<UsageStore["bindSession"]>,
    epoch: string,
    executionId: string,
    runtimeKind: string,
    eventId: string,
    capability: Capability,
    stage: SkillActivityStage,
    nativeCallId: string | null
  ): void {
    this.store.db.prepare(`INSERT OR IGNORE INTO agent_usage_runtime_activity
      (namespace, agent_id, session_id, generation, provider_epoch_id, execution_id, runtime_kind,
       native_call_id, event_id, capability_json, stage, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(binding.namespace, binding.agentId, binding.sessionId, binding.generation, epoch, executionId,
        runtimeKind, nativeCallId, eventId, JSON.stringify(capability), stage, new Date().toISOString());
  }
}
