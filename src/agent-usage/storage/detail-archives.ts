import type Database from "better-sqlite3";
import type { UsageFilter } from "../core/types.js";
import { contentCapability, type CapabilityKind } from "../core/context-types.js";

/** The marker publishes frozen statistics before any evidence rows are removed. */
export const ensureDetailArchives = (db: Database.Database): void => {
  if (db.readonly) return;
  db.exec(`CREATE TABLE IF NOT EXISTS agent_usage_detail_archives (
    namespace TEXT NOT NULL, session_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    archived_at TEXT NOT NULL, completed_at TEXT,
    PRIMARY KEY(namespace,session_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS agent_usage_detail_archives_pending
    ON agent_usage_detail_archives(namespace,archived_at) WHERE completed_at IS NULL`);
};

export const detailsArchived = (db: Database.Database, namespace: string, sessionId: string): boolean =>
  Boolean(db.prepare("SELECT 1 FROM agent_usage_detail_archives WHERE namespace=? AND session_id=?").get(namespace,sessionId));

export const unarchivedDetails = (alias: string): string => `NOT EXISTS (
  SELECT 1 FROM agent_usage_detail_archives archive
  WHERE archive.namespace=${alias}.namespace AND archive.session_id=${alias}.session_id)`;

/** Expiry describes the requested evidence scope, including mixed live and archived pages. */
export const expiredDetailsInScope = (db: Database.Database, filter: UsageFilter,
  options: { capabilityKind?: CapabilityKind; capabilityId?: string; capabilityServerId?: string } = {},
  kind?: "context" | "content"): boolean => {
  const clauses = [`NOT (${unarchivedDetails("j")})`], params: string[] = [];
  for (const [field,column] of [["namespace","namespace"],["agentId","agent_id"],["sessionId","session_id"]] as const)
    if (filter[field] !== undefined) { clauses.push(`j.${column}=?`); params.push(filter[field]); }
  if (filter.from !== undefined) { clauses.push("j.to_at>?"); params.push(new Date(filter.from).toISOString()); }
  if (filter.to !== undefined) { clauses.push("j.from_at<?"); params.push(new Date(filter.to).toISOString()); }
  const branches: string[] = [];
  for (const projection of kind === "context" ? ["inputs"] : kind === "content" ? ["content"] : ["inputs","content"]) {
    const where = ["v.partition_id=j.id"];
    if (filter.runtimeKind !== undefined) { where.push("v.runtime_kind=?"); params.push(filter.runtimeKind); }
    if (projection === "inputs") {
      for (const [field,index] of [["capabilityKind",0],["capabilityServerId",1],["capabilityId",2]] as const)
        if (options[field] !== undefined) { where.push(`json_extract(v.capability_key,'$[${index}]')=?`); params.push(options[field]); }
    } else {
      const categories = ["configured_instructions","user_prompt","assistant_output","assistant_thought"].filter(category => {
        const capability = contentCapability(category)!;
        return (!options.capabilityKind || options.capabilityKind === capability.kind)
          && (!options.capabilityId || options.capabilityId === capability.id) && !options.capabilityServerId;
      });
      where.push("v.category IN (SELECT value FROM json_each(?))"); params.push(JSON.stringify(categories));
    }
    branches.push(`EXISTS (SELECT 1 FROM agent_usage_ranking_${projection} v WHERE ${where.join(" AND ")})`);
  }
  return Boolean(db.prepare(`SELECT 1 FROM agent_usage_ranking_days j WHERE ${clauses.join(" AND ")}
    AND (${branches.join(" OR ")}) LIMIT 1`).get(...params));
};
