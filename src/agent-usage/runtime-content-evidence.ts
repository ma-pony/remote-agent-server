import type Database from "better-sqlite3";
import { capabilityKey } from "./core/context.js";
import { contentCapability, type Capability, type CapabilityKind, type TokenEstimate } from "./core/context-types.js";
import type { UsageFilter } from "./core/types.js";

const categories = ["configured_instructions", "user_prompt", "assistant_output", "assistant_thought"] as const;
export type RuntimeContentEvidence = {
  id: string; namespace: string; agentId: string; sessionId: string; runId: number; eventKey: string;
  category: typeof categories[number]; capability: Capability; occurredAt: string; runtimeKind: string;
  tokens: number | null; byteLength: number; partial: boolean; estimate: TokenEstimate;
};
type ContentRow = { namespace: string; agent_id: string; session_id: string; run_id: number; event_key: string;
  category: typeof categories[number]; occurred_at: string; runtime_kind: string; tokens: number | null;
  bytes: number; partial: number; estimate_json: string; capability_key: string };
export type RuntimeContentEvidenceOptions = { capabilityKind?: CapabilityKind; capabilityId?: string; capabilityServerId?: string; limit: number; cursor?: { t: string; id: string } };

/** Shared aggregate/list scope. Standalone attribution stores need no runtime-content table. */
export const runtimeContentScope = (db: Database.Database, filter: UsageFilter, options: { capabilityKind?: CapabilityKind; capabilityId?: string; capabilityServerId?: string; keys?: string[] } = {}): { sql: string; params: string[] } => {
  const selected = categories.filter(category => {
    const capability = contentCapability(category)!;
    return (options.capabilityKind === undefined || options.capabilityKind === capability.kind)
      && (options.capabilityId === undefined || options.capabilityId === capability.id)
      && options.capabilityServerId === undefined
      && (options.keys === undefined || options.keys.includes(capabilityKey(capability)));
  });
  if (!selected.length || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_usage_conversation_content'").get()) {
    return { sql: "SELECT NULL AS namespace,NULL AS agent_id,NULL AS session_id,NULL AS run_id,NULL AS event_key,NULL AS category,NULL AS occurred_at,NULL AS runtime_kind,NULL AS tokens,NULL AS bytes,NULL AS partial,NULL AS estimate_json,NULL AS estimate_id,NULL AS legacy_estimate_json,NULL AS capability_key WHERE 0", params: [] };
  }
  const params = selected.flatMap(category => [category, capabilityKey(contentCapability(category)!)]);
  const clauses = [`c.category IN (${selected.map(() => "?").join(",")})`];
  params.push(...selected);
  for (const [field, column] of [["namespace", "namespace"], ["agentId", "agent_id"], ["sessionId", "session_id"], ["runtimeKind", "runtime_kind"]] as const) {
    if (filter[field] !== undefined) { clauses.push(`c.${column}=?`); params.push(filter[field]); }
  }
  if (filter.from !== undefined) { clauses.push("c.occurred_at>=?"); params.push(new Date(filter.from).toISOString()); }
  if (filter.to !== undefined) { clauses.push("c.occurred_at<?"); params.push(new Date(filter.to).toISOString()); }
  return { sql: `SELECT c.namespace,c.agent_id,c.session_id,c.run_id,c.event_key,c.category,c.occurred_at,c.runtime_kind,c.tokens,c.bytes,c.partial,
    c.estimate_id,c.estimate_json AS legacy_estimate_json,COALESCE(t.estimate_json,c.estimate_json) AS estimate_json,
    CASE c.category ${selected.map(() => "WHEN ? THEN ?").join(" ")} END AS capability_key
    FROM agent_usage_conversation_content c LEFT JOIN agent_usage_token_estimates t ON t.id=c.estimate_id
    WHERE ${clauses.join(" AND ")}`, params };
};

const evidenceId = (row: Pick<ContentRow, "run_id" | "event_key" | "category">): string => `rc1.${Buffer.from(JSON.stringify([row.run_id,row.event_key,row.category])).toString("base64url")}`;
const decodeId = (id: string): [number, string, string] | null => {
  if (!id.startsWith("rc1.") || id.length > 1024) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(id.slice(4), "base64url").toString());
    if (!Array.isArray(value) || value.length !== 3 || !Number.isSafeInteger(value[0]) || value[0] <= 0
      || typeof value[1] !== "string" || !(categories as readonly unknown[]).includes(value[2])) return null;
    return value as [number,string,string];
  } catch { return null; }
};
const project = (row: ContentRow): RuntimeContentEvidence => ({ id: evidenceId(row), namespace: row.namespace,
  agentId: row.agent_id, sessionId: row.session_id, runId: row.run_id, eventKey: row.event_key, category: row.category,
  capability: contentCapability(row.category)!, occurredAt: row.occurred_at, runtimeKind: row.runtime_kind,
  tokens: row.tokens, byteLength: row.bytes, partial: Boolean(row.partial), estimate: JSON.parse(row.estimate_json) as TokenEstimate });

export const listRuntimeContentEvidence = (db: Database.Database, filter: UsageFilter, options: RuntimeContentEvidenceOptions): RuntimeContentEvidence[] => {
  const scope = runtimeContentScope(db, filter, options);
  const params: Array<string | number> = [...scope.params];
  let after = "";
  if (options.cursor) {
    const decoded = decodeId(options.cursor.id);
    if (!decoded) return [];
    after = "WHERE occurred_at<? OR (occurred_at=? AND (run_id<? OR (run_id=? AND (event_key>? OR (event_key=? AND category>?)))))";
    params.push(options.cursor.t, options.cursor.t, decoded[0], decoded[0], decoded[1], decoded[1], decoded[2]);
  }
  return (db.prepare(`WITH scoped AS (${scope.sql}) SELECT * FROM scoped ${after}
    ORDER BY occurred_at DESC,run_id DESC,event_key,category LIMIT ?`).all(...params, options.limit) as ContentRow[]).map(project);
};
export const getRuntimeContentEvidence = (db: Database.Database, namespace: string, id: string): RuntimeContentEvidence | null => {
  const decoded = decodeId(id);
  if (!decoded) return null;
  const scope = runtimeContentScope(db, { namespace });
  const row = db.prepare(`WITH scoped AS (${scope.sql}) SELECT * FROM scoped WHERE run_id=? AND event_key=? AND category=?`)
    .get(...scope.params, ...decoded) as ContentRow | undefined;
  return row ? project(row) : null;
};
