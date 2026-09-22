import type { Capability, InvocationInput, InvocationStatus, ToolContentEstimate } from "./core/context-types.js";
import type { UsageBinding } from "./core/types.js";
import type { AttributionStore } from "./storage/attribution-store.js";
import type { UsageStore } from "./storage/usage-store.js";

type Mirror = { server_name: string | null; tool_name: string | null; first_observed_at: string | null;
  matched_public_id: string | null; pending_result_json: string | null };
type Wrapper = { public_id: string; server_id: string; started_at: string | null; ended_at: string | null };
type Payload = Pick<InvocationInput, "argumentEstimate" | "resultEstimate">;
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;

/** Historical ACP mirrors may enrich one unambiguous wrapper; they never add a second wrapper call. */
export class RuntimeMcpReplay {
  constructor(private readonly store: UsageStore, private readonly attribution: AttributionStore) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS agent_usage_runtime_mcp_mirrors (
      namespace TEXT NOT NULL, session_id TEXT NOT NULL, provider_epoch_id TEXT NOT NULL,
      execution_id TEXT NOT NULL, native_call_id TEXT NOT NULL,
      PRIMARY KEY(namespace, session_id, provider_epoch_id, execution_id, native_call_id)
    )`);
    const columns = store.db.prepare("PRAGMA table_info(agent_usage_runtime_mcp_mirrors)").all() as Array<{ name: string }>;
    for (const column of ["server_name", "tool_name", "first_observed_at", "matched_public_id", "pending_result_json"]) {
      if (!columns.some(item => item.name === column)) store.db.exec(`ALTER TABLE agent_usage_runtime_mcp_mirrors ADD COLUMN ${column} TEXT`);
    }
  }

  record(binding: UsageBinding, epoch: string, runId: string, nativeId: string,
    input: Record<string, unknown> | undefined, mcp: Record<string, unknown> | undefined,
    observedAt: string, historical: boolean, status: InvocationStatus, measure: () => Payload)
    : { isMcp: boolean; capability?: Capability; matched?: boolean } {
    const key = [binding.namespace, binding.sessionId, epoch, runId, nativeId];
    const explicit = [input, mcp].find(value => identity(value?.server) && identity(value?.tool));
    if (explicit) {
      this.store.db.prepare(`INSERT INTO agent_usage_runtime_mcp_mirrors
        (namespace,session_id,provider_epoch_id,execution_id,native_call_id,server_name,tool_name,first_observed_at)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(namespace,session_id,provider_epoch_id,execution_id,native_call_id)
        DO UPDATE SET server_name=COALESCE(server_name,excluded.server_name), tool_name=COALESCE(tool_name,excluded.tool_name),
          first_observed_at=CASE WHEN first_observed_at IS NULL OR excluded.first_observed_at < first_observed_at
            THEN excluded.first_observed_at ELSE first_observed_at END`)
        .run(...key, explicit.server, explicit.tool, observedAt);
    }
    const mirror = this.store.db.prepare(`SELECT server_name,tool_name,first_observed_at,matched_public_id,pending_result_json
      FROM agent_usage_runtime_mcp_mirrors WHERE namespace=? AND session_id=? AND provider_epoch_id=? AND execution_id=? AND native_call_id=?`)
      .get(...key) as Mirror | undefined;
    if (!mirror) return { isMcp: false };
    if (!historical || !mirror.server_name || !mirror.tool_name) return { isMcp: true };

    const payload = measure();
    if (status === "running" && payload.resultEstimate) {
      // Keep only the measurement until completion; a sparse terminal event may refer to this last output.
      this.store.db.prepare(`UPDATE agent_usage_runtime_mcp_mirrors SET pending_result_json=?
        WHERE namespace=? AND session_id=? AND provider_epoch_id=? AND execution_id=? AND native_call_id=?`)
        .run(JSON.stringify(payload.resultEstimate), ...key);
    }
    const resultEstimate = status === "running" ? undefined : payload.resultEstimate
      ?? (mirror.pending_result_json === null ? undefined : JSON.parse(mirror.pending_result_json) as ToolContentEstimate);

    let original = mirror.matched_public_id ? this.attribution.invocation(binding.namespace, mirror.matched_public_id) : null;
    if (original && (original.sessionId !== binding.sessionId || original.executionId !== runId
      || original.capability.name !== mirror.tool_name || !original.sourceId.startsWith("mcp-observer:"))) original = null;

    // Current names help narrow existing evidence, but cannot prove an ID for an unobserved historical call.
    const server = this.store.db.prepare("SELECT id FROM agent_mcp_servers WHERE agent_id=? AND name=?")
      .get(binding.agentId, mirror.server_name) as { id: number } | undefined;
    const serverId = server ? String(server.id) : /^\d+$/.test(mirror.server_name) ? mirror.server_name : undefined;
    const sameTool = original ? [] : this.store.db.prepare(`SELECT public_id,started_at,ended_at,
      json_extract(capability_json,'$.serverId') AS server_id FROM agent_usage_invocations
      WHERE namespace=? AND session_id=? AND execution_id=? AND source_id LIKE 'mcp-observer:%' AND origin='execution'
        AND json_extract(capability_json,'$.kind')='mcp_tool' AND json_extract(capability_json,'$.name')=?`)
      .all(binding.namespace, binding.sessionId, runId, mirror.tool_name) as Wrapper[];
    if (!original && serverId !== undefined) {
      const time = Date.parse(mirror.first_observed_at ?? observedAt);
      const candidates = sameTool.filter(row => {
        const start = row.started_at === null ? Date.parse(row.ended_at ?? "") : Date.parse(row.started_at);
        const end = row.ended_at === null ? Date.parse(row.started_at ?? "") : Date.parse(row.ended_at);
        return row.server_id === serverId && time >= start - 2_000 && time <= end + 2_000;
      });
      if (candidates.length === 1) {
        const candidate = candidates[0]!;
        const claimed = this.store.db.prepare(`SELECT 1 FROM agent_usage_runtime_mcp_mirrors
          WHERE namespace=? AND session_id=? AND execution_id=? AND matched_public_id=? AND native_call_id!=?`)
          .get(binding.namespace, binding.sessionId, runId, candidate.public_id, nativeId);
        if (!claimed) original = this.attribution.invocation(binding.namespace, candidate.public_id);
      }
    }
    if (original) {
      this.attribution.recordPayload(binding, original.id, {
        argumentEstimate: original.argumentEstimate === null ? payload.argumentEstimate : undefined,
        resultEstimate: original.resultEstimate === null ? resultEstimate : undefined
      });
      this.store.db.prepare(`UPDATE agent_usage_runtime_mcp_mirrors SET matched_public_id=?
        WHERE namespace=? AND session_id=? AND provider_epoch_id=? AND execution_id=? AND native_call_id=?`)
        .run(original.id, ...key);
      return { isMcp: true, matched: true };
    }
    // Existing same-tool evidence that cannot be paired safely must not become a duplicate call.
    if (sameTool.length > 0) return { isMcp: true };
    const restoredServerId = /^\d+$/.test(mirror.server_name) ? mirror.server_name : `runtime:${mirror.server_name}`;
    return { isMcp: true, capability: { id: `mcp:${restoredServerId}:${mirror.tool_name}`,
      kind: "mcp_tool", name: mirror.tool_name, serverId: restoredServerId } };
  }
}
