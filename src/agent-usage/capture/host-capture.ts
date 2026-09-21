import { MAX_CONTEXT_BLOCKS } from "../core/context.js";
import { randomUUID } from "node:crypto";
import { isAbsolute, normalize, relative, resolve } from "node:path";
import type { Provider } from "../../domain.js";
import type { RuntimeMcpServer } from "../../mcp/mcp-types.js";
import type { HostUsageCollector } from "../host-collector.js";
import type { UsageBinding, UsageFilter } from "../core/types.js";
import type { Capability } from "../core/context-types.js";
import { normalizeCanonicalExchanges, type CanonicalCall } from "../adapters/context-snapshot.js";
import { UsageHttpRelay, type CapturedExchange, type RelayRoute } from "./http-relay.js";
import { decodeExchange } from "./protocol.js";
import type { CaptureUpstreams, CaptureProtocol } from "./config.js";
type Subject = { binding: UsageBinding; epoch: string; provider: Provider; workspacePath: string; route: RelayRoute;
  runId: number | null; historyComplete: boolean; aliases: Array<{ runtimeName: string; capability: Capability }>; calls: Map<string, CanonicalCall> };
type Intent = { id: string; aliases: Subject["aliases"]; subject: Subject; binding: UsageBinding; epoch: string; runId: number | null; startedAt: string };
export type CaptureHealth = { sessionId: string; runtimeKind: string; status: string; observed: number; incomplete: number; errorCode: string | null };
/** Host adapter: freezes business identity on HTTP admission, persists metadata only. */
export class HostUsageCapture {
  private readonly relay = new UsageHttpRelay();
  private readonly subjects = new Map<number, Subject>();
  constructor(private readonly host: HostUsageCollector, private readonly upstreams: CaptureUpstreams, private readonly keys: Map<string, string>) {
    host.capture = this;
    host.db.exec(`CREATE TABLE IF NOT EXISTS agent_usage_capture_sessions (
      namespace TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, epoch_id TEXT NOT NULL, runtime_kind TEXT NOT NULL,
      status TEXT NOT NULL, PRIMARY KEY(namespace, session_id, epoch_id));
      CREATE TABLE IF NOT EXISTS agent_usage_captures (
      id TEXT PRIMARY KEY, namespace TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, epoch_id TEXT NOT NULL,
      execution_id TEXT, runtime_kind TEXT NOT NULL, started_at TEXT NOT NULL, status TEXT NOT NULL, error_code TEXT);
      CREATE INDEX IF NOT EXISTS agent_usage_captures_subject ON agent_usage_captures(namespace, session_id, epoch_id);
      CREATE TABLE IF NOT EXISTS agent_usage_capture_calls (
      namespace TEXT NOT NULL, session_id TEXT NOT NULL, epoch_id TEXT NOT NULL, call_id TEXT NOT NULL, metadata_json TEXT NOT NULL,
      PRIMARY KEY(namespace, session_id, epoch_id, call_id));`);
    host.db.prepare("UPDATE agent_usage_captures SET status='incomplete', error_code='interrupted' WHERE status='pending'").run();
  }
  async prepare(input: { sessionId: number; provider: Provider; workspacePath: string; providerSessionId?: string | null; mcpServers: RuntimeMcpServer[] }): Promise<RelayRoute | undefined> {
    const upstream = this.upstreams[input.provider]; if (!upstream) return undefined;
    const epoch = this.host.epoch(input.sessionId); const old = this.subjects.get(input.sessionId);
    if (old?.epoch === epoch) { old.aliases = this.aliases(input.mcpServers); return old.route; }
    await this.release(input.sessionId);
    const binding = this.host.binding(input.sessionId);
    const calls = new Map<string, CanonicalCall>((this.host.db.prepare(`SELECT call_id, metadata_json FROM agent_usage_capture_calls
      WHERE namespace=? AND session_id=? AND epoch_id=? LIMIT 2048`).all(binding.namespace, binding.sessionId, epoch) as Array<{ call_id: string; metadata_json: string }>)
      .map((row) => [row.call_id, JSON.parse(row.metadata_json) as CanonicalCall]));
    const subject: Subject = { binding, epoch, provider: input.provider, workspacePath: input.workspacePath, runId: null, historyComplete: input.providerSessionId === null && !this.host.db.prepare("SELECT 1 FROM agent_usage_capture_sessions WHERE namespace=? AND session_id=? AND epoch_id=?").get(binding.namespace, binding.sessionId, epoch),
      aliases: this.aliases(input.mcpServers), calls, route: undefined as unknown as RelayRoute };
    subject.route = await this.relay.register({ ...upstream, apiKey: this.keys.get(input.provider)! }, () => this.begin(subject),
      (intent, exchange) => this.finish(intent, exchange, upstream.protocol));
    this.subjects.set(input.sessionId, subject);
    this.host.db.prepare("INSERT OR IGNORE INTO agent_usage_capture_sessions VALUES (?, ?, ?, ?, ?, 'waiting')")
      .run(binding.namespace, binding.agentId, binding.sessionId, epoch, input.provider);
    return subject.route;
  }
  startRun(sessionId: number, runId: number): void { const subject = this.subjects.get(sessionId); if (subject) subject.runId = runId; }
  endRun(sessionId: number, runId: number): void { const subject = this.subjects.get(sessionId); if (subject?.runId === runId) subject.runId = null; }
  private begin(subject: Subject): Intent {
    const intent: Intent = { id: randomUUID(), aliases: subject.aliases, subject, binding: { ...subject.binding }, epoch: subject.epoch, runId: subject.runId, startedAt: new Date().toISOString() };
    this.assertIntent(intent);
    this.host.db.prepare("INSERT INTO agent_usage_captures VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL)")
      .run(intent.id, intent.binding.namespace, intent.binding.agentId, intent.binding.sessionId, intent.epoch,
        intent.runId === null ? null : String(intent.runId), subject.provider, intent.startedAt);
    return intent;
  }
  private assertIntent(intent: Intent): void {
    this.host.store.assertBinding(intent.binding);
    const row = this.host.db.prepare("SELECT epoch, state FROM agent_usage_subjects WHERE namespace=? AND kind='session' AND subject_id=?")
      .get(intent.binding.namespace, intent.binding.sessionId) as { epoch: number; state: string } | undefined;
    if (row?.state !== "active" || intent.epoch !== `session:${intent.binding.sessionId}:epoch:${row.epoch}`) throw new Error("capture_binding_stale");
  }
  private async finish(intent: Intent | undefined, exchange: CapturedExchange, protocol: CaptureProtocol): Promise<void> {
    if (!intent) return;
    let issue = exchange.issue;
    try {
      const decoded = await decodeExchange(exchange, protocol); issue ??= decoded.issue;
      if (intent.runId === null) issue ??= "outside_run";
      if (issue || decoded.request?.previous_response_id || decoded.request?.conversation) intent.subject.historyComplete = false;
      const native = typeof decoded.response?.id === "string" && decoded.response.id.length <= 512 ? decoded.response.id : null;
      const invocationId = native ? protocol === "anthropic_messages" ? `claude-message:${native}` : `${protocol}:${native}` : `capture-unresolved:${intent.id}`;
      let committedCalls: Map<string, CanonicalCall> | undefined;
      this.host.db.transaction(() => {
        this.assertIntent(intent);
        if (decoded.request && intent.runId !== null) {
          const subject = intent.subject;
          const calls = new Map(subject.calls);
          const entries = normalizeCanonicalExchanges({ revision: 1, historyComplete: subject.historyComplete, capabilities: intent.aliases,
            requests: [{ request: decoded.request, response: decoded.response, record: { id: intent.id, invocationId,
              session_id: intent.epoch, timestamp: intent.startedAt, provider: subject.provider, agent: subject.provider,
              modelProvider: this.upstreams[subject.provider]?.modelProvider,
              endpoint: exchange.endpoint, context_fidelity: "partial", response_complete: decoded.complete } }] }, calls,
          (name, args) => this.skillTags(intent, name, args));
          const entry = entries[0]!;
          if ((entry.context?.blocks.length ?? 0) > MAX_CONTEXT_BLOCKS) issue ??= "context_block_limit";
          if (entry.context?.blocks.some((block) => block.content.modality === "unsupported")) issue ??= "unsupported_content";
          if (issue) { subject.historyComplete = false; if (entry.context) entry.context.historyComplete = false; }
          this.host.store.observe(intent.binding, { ...entry.observation, sourceId: "http_capture", sourcePriority: 10,
            eventId: intent.id, providerEpochId: intent.epoch, executionId: String(intent.runId), ...(issue ? { issues: [issue] } : {}) });
          if (entry.context) this.host.attribution.upsertContext(intent.binding, { ...entry.context, sourceId: "http_capture", providerEpochId: intent.epoch });
          for (const invocation of entry.invocations ?? []) this.host.attribution.observeInvocation(intent.binding,
            { ...invocation, sourceId: "http_capture", providerEpochId: intent.epoch, executionId: String(intent.runId) });
          if (calls.size > 2048) { issue ??= "call_cache_limit"; while (calls.size > 2048) calls.delete(calls.keys().next().value!); }
          const remove = this.host.db.prepare("DELETE FROM agent_usage_capture_calls WHERE namespace=? AND session_id=? AND epoch_id=? AND call_id=?");
          for (const id of subject.calls.keys()) if (!calls.has(id)) remove.run(intent.binding.namespace, intent.binding.sessionId, intent.epoch, id);
          const insert = this.host.db.prepare(`INSERT INTO agent_usage_capture_calls VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(namespace, session_id, epoch_id, call_id) DO UPDATE SET metadata_json=excluded.metadata_json
            WHERE metadata_json != excluded.metadata_json`);
          for (const [id, metadata] of calls) {
            if (id.length > 1024 || metadata.name.length > 512) continue;
            if (metadata === subject.calls.get(id)) continue;
            const json = JSON.stringify(metadata);
            if (json !== JSON.stringify(subject.calls.get(id))) insert.run(intent.binding.namespace, intent.binding.sessionId, intent.epoch, id, json);
          }
          committedCalls = calls;
        }
        this.host.db.prepare("UPDATE agent_usage_captures SET status=?, error_code=? WHERE id=?")
          .run(issue ? "incomplete" : "observed", issue, intent.id);
        this.host.db.prepare("UPDATE agent_usage_capture_sessions SET status='observed' WHERE namespace=? AND session_id=? AND epoch_id=?")
          .run(intent.binding.namespace, intent.binding.sessionId, intent.epoch);
      })();
      if (committedCalls) intent.subject.calls = committedCalls;
    } catch {
      intent.subject.historyComplete = false;
      this.host.db.prepare("UPDATE agent_usage_captures SET status='incomplete', error_code='capture_processing_failed' WHERE id=? AND status='pending'").run(intent.id);
    }
  }
  private aliases(servers: RuntimeMcpServer[]): Subject["aliases"] {
    const entries = servers.flatMap((server) => (server.usageIdentity?.tools ?? []).map((tool) => ({ runtimeName: `mcp__${server.name}__${tool}`,
      capability: { id: `mcp:${server.usageIdentity!.serverId}:${tool}`, kind: "mcp_tool" as const, name: tool, serverId: server.usageIdentity!.serverId } })));
    return entries.filter((entry, index) => entries.findIndex((other) => other.runtimeName === entry.runtimeName) === index
      && !entries.some((other) => other.runtimeName === entry.runtimeName && other.capability.id !== entry.capability.id));
  }
  private skillTags(intent: Intent, name: string, args: unknown): Capability[] {
    if (!["Read", "read_file"].includes(name)) return [];
    let input: Record<string, unknown>; try { input = (typeof args === "string" ? JSON.parse(args) : args) as Record<string, unknown>; } catch { return []; }
    const path = input?.path ?? input?.file_path ?? input?.filePath; if (typeof path !== "string" || path.length > 4096) return [];
    const target = normalize(isAbsolute(path) ? path : resolve(intent.subject.workspacePath, path));
    const projections = this.host.db.prepare(`SELECT capability_json, plugin_json, directory_aliases_json FROM agent_usage_runtime_skill_projections
      WHERE namespace=? AND session_id=? AND provider_epoch_id=? AND execution_id=? LIMIT 512`)
      .all(intent.binding.namespace, intent.binding.sessionId, intent.epoch, String(intent.runId)) as Array<{ capability_json: string; plugin_json: string | null; directory_aliases_json: string }>;
    for (const row of projections) if ((JSON.parse(row.directory_aliases_json) as string[]).some((directory) => {
      const rel = relative(normalize(directory), target); return rel === "" || !rel.startsWith("..") && !isAbsolute(rel);
    })) return [JSON.parse(row.capability_json) as Capability, ...(row.plugin_json ? [JSON.parse(row.plugin_json) as Capability] : [])];
    return [];
  }
  health(filter: UsageFilter): CaptureHealth[] {
    const rows = this.host.db.prepare(`SELECT s.session_id AS sessionId, s.runtime_kind AS runtimeKind,
      CASE WHEN SUM(CASE WHEN c.status='pending' THEN 1 ELSE 0 END)>0 THEN 'pending'
      WHEN SUM(CASE WHEN c.status='incomplete' THEN 1 ELSE 0 END)>0 THEN 'incomplete' ELSE s.status END AS status,
      SUM(CASE WHEN c.status='observed' THEN 1 ELSE 0 END) AS observed,
      SUM(CASE WHEN c.status='incomplete' THEN 1 ELSE 0 END) AS incomplete, MAX(c.error_code) AS errorCode
      FROM agent_usage_capture_sessions s LEFT JOIN agent_usage_captures c ON c.namespace=s.namespace AND c.session_id=s.session_id AND c.epoch_id=s.epoch_id
      AND (? IS NULL OR c.started_at >= ?) AND (? IS NULL OR c.started_at < ?)
      WHERE s.namespace=? AND (? IS NULL OR s.agent_id=?) AND (? IS NULL OR s.session_id=?) AND (? IS NULL OR s.runtime_kind=?)
      GROUP BY s.namespace, s.session_id, s.epoch_id`).all(filter.from ?? null, filter.from ?? null, filter.to ?? null, filter.to ?? null,
        this.host.namespace, filter.agentId ?? null, filter.agentId ?? null, filter.sessionId ?? null, filter.sessionId ?? null, filter.runtimeKind ?? null, filter.runtimeKind ?? null) as CaptureHealth[];
    return rows;
  }
  async release(sessionId: number): Promise<void> { const subject = this.subjects.get(sessionId); this.subjects.delete(sessionId); await subject?.route.revoke(); }
  deleteSession(sessionId: number): void {
    void this.release(sessionId);
    for (const table of ["agent_usage_captures", "agent_usage_capture_sessions", "agent_usage_capture_calls"]) this.host.db.prepare(`DELETE FROM ${table} WHERE namespace=? AND session_id=?`).run(this.host.namespace, String(sessionId));
  }
  async drain(): Promise<void> { await this.relay.drain(); }
  async close(): Promise<void> { this.subjects.clear(); await this.relay.close(); }
}
