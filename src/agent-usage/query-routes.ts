import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { HostUsageCollector } from "./host-collector.js";
import { capabilityKinds, type AttributionRankRow } from "./core/context-types.js";
import { accountingRows, reconcileSources, sumUsage } from "./core/usage.js";
import type { UsageFilter, UsageRecord } from "./core/types.js";

const querySchema = z.object({
  agentId: z.string().regex(/^[1-9]\d*$/).optional(), sessionId: z.string().regex(/^[1-9]\d*$/).optional(),
  from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(),
  timezone: z.string().default("UTC").refine((value) => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
  }),
  runtimeKind: z.string().min(1).max(100).optional(), subagents: z.literal("self").default("self"),
  dimension: z.enum(capabilityKinds).default("mcp_tool"),
  sort: z.enum(["totalInputTokens", "inputBytes", "calls", "definitionInputTokens", "firstResultInputTokens", "repeatedResultInputTokens", "failures", "latencyMsP95"]).default("totalInputTokens"),
  bucket: z.enum(["day", "week", "month"]).default("day"),
  limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).max(100000).default(0),
  capabilityKind: z.enum(capabilityKinds).optional(),
  capabilityId: z.string().min(1).max(500).optional(), capabilityServerId: z.string().min(1).max(500).optional(),
  cursor: z.string().max(500).optional(),
  origin: z.enum(["counted", "execution", "context"]).default("counted")
}).strict().refine((query) => !query.from || !query.to || Date.parse(query.from) < Date.parse(query.to));

const periodKey = (timestamp: string, timezone: string, bucket: "day" | "week" | "month"): string => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(timestamp));
  const part = (kind: string) => parts.find((item) => item.type === kind)!.value;
  const day = `${part("year")}-${part("month")}-${part("day")}`;
  if (bucket === "day") return day;
  if (bucket === "month") return day.slice(0, 7);
  // Calendar arithmetic after timezone conversion; no assumption that every local day is 24 hours.
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
};
const inPeriod = (timestamp: string | null, filter: UsageFilter): boolean => timestamp !== null
  && (!filter.from || Date.parse(timestamp) >= Date.parse(filter.from)) && (!filter.to || Date.parse(timestamp) < Date.parse(filter.to));
const insights = (row: AttributionRankRow) => [
  ...(row.repeatedResultInputTokens !== null && row.repeatedResultInputTokens > 0 ? [{ kind: "repeated_results", tokens: row.repeatedResultInputTokens }] : []),
  ...(row.calls === 0 && (row.definitionInputTokens ?? 0) > 0 ? [{ kind: "unused_definitions", tokens: row.definitionInputTokens }] : []),
  ...(row.failures > 0 ? [{ kind: "failed_calls", count: row.failures }] : [])
];

/** Management-only projections; usage facts and estimated context contributions remain separate. */
export const registerUsageQueryRoutes = (app: FastifyInstance, collector: HostUsageCollector): void => {
  const namespace = collector.namespace;
  const providerEpoch = (sessionId: string, agentId: string | undefined): string | null => {
    const session = collector.db.prepare("SELECT agent_id FROM sessions WHERE id = ?").get(sessionId) as { agent_id: number } | undefined;
    if (session === undefined || (agentId !== undefined && String(session.agent_id) !== agentId)) return null;
    const subject = collector.db.prepare(`SELECT agent_id, epoch, state FROM agent_usage_subjects
      WHERE namespace = ? AND kind = 'session' AND subject_id = ?`)
      .get(namespace, sessionId) as { agent_id: string | null; epoch: number; state: string } | undefined;
    if (subject === undefined) return `session:${sessionId}:epoch:1`;
    if (subject.state !== "active" || subject.agent_id !== String(session.agent_id)) return null;
    return `session:${sessionId}:epoch:${subject.epoch}`;
  };
  for (const endpoint of ["summary", "timeseries", "capabilities", "invocations", "context-evidence"] as const) {
    app.get(`/usage/${endpoint}`, (request, reply) => {
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: { code: "invalid_request", message: "Invalid usage query" } });
      const query = parsed.data;
      const filter: UsageFilter = { namespace, agentId: query.agentId, sessionId: query.sessionId,
        from: query.from === undefined ? undefined : new Date(query.from).toISOString(),
        to: query.to === undefined ? undefined : new Date(query.to).toISOString(), runtimeKind: query.runtimeKind };
      const sources = collector.sources.listSources(namespace).filter((source) => source.mappings.some((mapping) =>
        (!query.sessionId || mapping.sessionId === query.sessionId) && (!query.agentId || collector.db.prepare(
          "SELECT 1 FROM agent_usage_subjects WHERE namespace = ? AND kind = 'session' AND subject_id = ? AND agent_id = ?"
        ).get(namespace, mapping.sessionId, query.agentId) !== undefined)));
      const collectionFailures = collector.collectionFailures(filter);
      const captureHealth = collector.capture?.health(filter) ?? [];
      const capturePartial = captureHealth.some((item) => item.status !== "observed");
      const metadata = { collectionFailures, captureHealth, asOf: new Date().toISOString(), timezone: query.timezone, from: query.from ?? null, to: query.to ?? null,
        subagents: "self", timeBasis: "source_timestamp", bodyStatus: "not_retained",
        analysisStatus: sources.some((source) => source.status === "collecting") ? "collecting"
          : capturePartial || collectionFailures.length > 0 || sources.some((source) => source.status === "failed") ? "partial" : "ready" };
      if (endpoint === "summary") {
        const summary = collector.store.summary(filter);
        return { ...metadata, ...summary, ...(capturePartial && summary.completeness !== "conflict" ? { completeness: "partial" } : {}), ...(query.sessionId === undefined ? {} : { providerEpochId: providerEpoch(query.sessionId, query.agentId) }),
          sources: sources.map((source) => ({ id: source.id, status: source.status, errorCode: source.errorCode })),
          analysisStatus: sources.length === 0 && summary.completeness === "none" && collectionFailures.length === 0 && captureHealth.length === 0 ? "empty" : metadata.analysisStatus };
      }
      if (endpoint === "timeseries") {
        const selected = accountingRows(reconcileSources(collector.store.records(filter)).records.filter((row) =>
          row.scope !== "provider_session" && row.occurredAt !== null)).filter((row) =>
          inPeriod(row.occurredAt, filter) && (row.intervalStart === undefined || inPeriod(row.intervalStart, filter)));
        const groups = new Map<string, UsageRecord[]>();
        const ambiguous: UsageRecord[] = [];
        for (const row of selected) {
          const key = periodKey(row.occurredAt!, query.timezone, query.bucket);
          if (row.intervalStart !== undefined && periodKey(row.intervalStart, query.timezone, query.bucket) !== key) {
            ambiguous.push(row); continue;
          }
          const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
        }
        return { ...metadata, bucket: query.bucket, items: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
          .map(([period, rows]) => ({ period, usage: sumUsage(rows), observedRanges: rows.length })),
          unplacedUsage: sumUsage([{ metrics: collector.store.summary(filter).unplacedUsage }, ...ambiguous]) };
      }
      if (endpoint === "capabilities") {
        const all = collector.attribution.rankings(filter, query.dimension).sort((a, b) =>
          (b[query.sort] ?? -1) - (a[query.sort] ?? -1) || a.capability.id.localeCompare(b.capability.id));
        const stages = collector.runtimeCapabilities.stageCounts(filter)
          .filter((stage) => stage.capability.kind === query.dimension);
        return { ...metadata, measurement: "estimated", dimension: query.dimension, sort: query.sort, total: all.length, stages,
          items: all.slice(query.offset, query.offset + query.limit).map((row) => ({ ...row, insights: insights(row) })) };
      }
      let cursor: { t: string; id: string } | undefined;
      if (query.cursor) {
        try { cursor = z.object({ t: z.string(), id: z.string() }).parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString())); }
        catch { return reply.code(400).send({ error: { code: "invalid_request", message: "Invalid usage cursor" } }); }
      }
      const page = { cursor, limit: query.limit + 1, capabilityId: query.capabilityId,
        capabilityKind: query.capabilityKind, capabilityServerId: query.capabilityServerId };
      if (endpoint === "context-evidence") {
        const contexts = collector.attribution.contextEvidence(filter, page);
        const items = contexts.slice(0, query.limit);
        const last = items.at(-1);
        return { ...metadata, items, nextCursor: contexts.length > query.limit && last
          ? Buffer.from(JSON.stringify({ t: last.occurredAt ?? "", id: last.id })).toString("base64url") : null };
      }
      const calls = collector.attribution.invocations(filter, query.origin, page);
      const items = calls.slice(0, query.limit);
      const last = items.at(-1);
      return { ...metadata, origin: query.origin, items, nextCursor: calls.length > query.limit && last
        ? Buffer.from(JSON.stringify({ t: last.startedAt ?? "", id: last.id })).toString("base64url") : null };
    });
  }
  app.get<{ Params: { id: string } }>("/usage/context-evidence/:id", (request, reply) => {
    const detail = collector.attribution.contextEvidenceDetail(namespace, request.params.id);
    if (!detail) return reply.code(404).send({ error: { code: "usage_context_evidence_not_found", message: "Usage context evidence not found" } });
    return { ...detail, bodyStatus: "not_retained", asOf: new Date().toISOString() };
  });
  app.get<{ Params: { id: string } }>("/usage/invocations/:id", (request, reply) => {
    const detail = collector.attribution.detail(namespace, request.params.id);
    if (!detail) return reply.code(404).send({ error: { code: "usage_invocation_not_found", message: "Usage invocation not found" } });
    const records = collector.store.records({ namespace, sessionId: detail.invocation.sessionId }).filter((row) =>
      row.invocationId !== null && detail.subsequentModelInvocationIds.includes(row.invocationId));
    return { ...detail, bodyStatus: "not_retained", usageEvidence: records, asOf: new Date().toISOString() };
  });
};
