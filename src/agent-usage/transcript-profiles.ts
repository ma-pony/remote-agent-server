import type Database from "better-sqlite3";
import { isAbsolute, normalize, relative, resolve } from "node:path";
import type { RuntimeMcpServer } from "../mcp/mcp-types.js";
import type { TranscriptProfile } from "./adapters/transcript-context.js";
import type { Capability } from "./core/context-types.js";
import { capturedToolCapability, commandFiles, toolInput } from "./core/tool-capabilities.js";

/** Frozen capability configuration; no credentials or invocation bodies. */
export class TranscriptProfiles {
  constructor(private readonly db: Database.Database, private readonly namespace: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_usage_context_profiles (
      namespace TEXT NOT NULL, session_id TEXT NOT NULL, run_id INTEGER NOT NULL,
      tools_json TEXT NOT NULL, PRIMARY KEY(namespace,session_id,run_id))`);
  }

  record(sessionId: number, runId: number, servers: RuntimeMcpServer[]): void {
    const tools: TranscriptProfile["tools"] = servers.flatMap(server => {
      const identity = server.usageIdentity;
      if (!identity) return [];
      return (identity.definitions ?? []).map(tool => {
        const runtimeName = `mcp__${server.name}__${tool.name}`;
        return { runtimeName,
          capability: { id: `mcp:${identity.serverId}:${tool.name}`, kind: "mcp_tool" as const, name: tool.name, serverId: identity.serverId },
          definition: { name: runtimeName, description: tool.description ?? "", input_schema: tool.inputSchema ?? { type: "object" } } };
      });
    });
    const json = JSON.stringify(tools);
    const previous = this.db.prepare(`SELECT tools_json FROM agent_usage_context_profiles
      WHERE namespace=? AND session_id=? AND run_id<=? ORDER BY run_id DESC LIMIT 1`)
      .get(this.namespace, String(sessionId), runId) as { tools_json: string } | undefined;
    if (previous?.tools_json === json) return;
    this.db.prepare("INSERT OR REPLACE INTO agent_usage_context_profiles VALUES (?, ?, ?, ?)")
      .run(this.namespace, String(sessionId), runId, json);
  }

  private run(sessionId: string, time: string | null) {
    return this.db.prepare(`SELECT r.id,r.resolved_model,s.instructions_snapshot,s.workspace_path,a.provider,
      u.provider_epoch_id FROM runs r JOIN sessions s ON s.id=r.session_id JOIN agents a ON a.id=s.agent_id
      LEFT JOIN agent_usage_runtime_runs u ON u.namespace=? AND u.session_id=? AND u.execution_id=CAST(r.id AS TEXT)
      WHERE r.session_id=? ${time === null ? "" : "AND r.started_at<=?"} ORDER BY r.started_at DESC,r.id DESC LIMIT 1`)
      .get(this.namespace, sessionId, sessionId, ...(time === null ? [] : [time])) as {
        id: number; resolved_model: string | null; instructions_snapshot: string; workspace_path: string;
        provider: string; provider_epoch_id: string | null
      } | undefined;
  }

  model(sessionId: string): string | null { return this.run(sessionId, null)?.resolved_model ?? null; }

  profile(sessionId: string, time: string | null): TranscriptProfile {
    const run = this.run(sessionId, time);
    if (!run) return { tools: [] };
    const row = this.db.prepare(`SELECT tools_json FROM agent_usage_context_profiles
      WHERE namespace=? AND session_id=? AND run_id<=? ORDER BY run_id DESC LIMIT 1`)
      .get(this.namespace, sessionId, run.id) as { tools_json: string } | undefined;
    return { instructions: run.instructions_snapshot, tools: row ? JSON.parse(row.tools_json) as TranscriptProfile["tools"] : [] };
  }

  skillTagger(sessionId: string): (name: string, args: unknown, time: string | null) => Capability[] {
    let runId: number | undefined;
    let tagger: ReturnType<typeof createProjectedSkillTagger>;
    return (name, args, time) => {
      const run = this.run(sessionId, time);
      if (!run) return [];
      if (run.id !== runId) {
        tagger = createProjectedSkillTagger(this.db, this.namespace, sessionId, run.provider_epoch_id ?? "", String(run.id),
          run.provider, run.workspace_path);
        runId = run.id;
      }
      return tagger(name, args);
    };
  }
}

/** Cache only for one transcript collection or HTTP exchange; a later collection sees fresh projections. */
export const createProjectedSkillTagger = (db: Database.Database, namespace: string, sessionId: string, epoch: string,
  runId: string, provider: string, workspace: string): (name: string, args: unknown) => Capability[] => {
  let projections: Array<{ capability: Capability; plugin: Capability | null; directories: string[] }> | undefined;
  return (name, args) => {
    const input = toolInput(args);
    const path = input?.path ?? input?.file_path ?? input?.filePath;
    const files = capturedToolCapability(provider, name, args)?.kind === "cli" ? commandFiles(input) : { readPaths: [], scriptPaths: [] };
    const paths = [...(["Read", "read_file"].includes(name) && typeof path === "string" ? [path] : []), ...files.readPaths, ...files.scriptPaths];
    const skillName = name === "Skill" && typeof input?.skill === "string" ? input.skill : null;
    if (!paths.length && !skillName) return [];
    const cwd = "cwd" in files && files.cwd ? resolve(workspace, files.cwd) : workspace;
    const targets = paths.map(item => normalize(isAbsolute(item) ? item : resolve(cwd, item)));
    if (!projections) {
      const rows = db.prepare(`SELECT capability_json,plugin_json,directory_aliases_json FROM agent_usage_runtime_skill_projections
        WHERE namespace=? AND session_id=? AND provider_epoch_id=? AND execution_id=? LIMIT 512`)
        .all(namespace, sessionId, epoch, runId) as Array<{ capability_json: string; plugin_json: string | null; directory_aliases_json: string }>;
      projections = rows.map(row => ({ capability: JSON.parse(row.capability_json) as Capability,
        plugin: row.plugin_json ? JSON.parse(row.plugin_json) as Capability : null,
        directories: JSON.parse(row.directory_aliases_json) as string[] }));
    }
    const tags = new Map<string, Capability>();
    for (const { capability, plugin, directories } of projections) {
      const namedSkill = skillName !== null && (skillName === capability.name
        || plugin !== null && skillName === `${plugin.name}:${capability.name}`);
      if (!namedSkill && !targets.some(target => directories.some(directory => {
        const path = relative(normalize(directory), target);
        return path === "" || !path.startsWith("..") && !isAbsolute(path);
      }))) continue;
      for (const tag of [capability, plugin]) {
        if (tag) tags.set(JSON.stringify([tag.kind, tag.id, tag.version]), tag);
      }
    }
    return [...tags.values()];
  };
};
