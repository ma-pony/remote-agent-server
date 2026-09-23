import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { HostUsageCollector } from "./host-collector.js";
import { capabilityKinds, type AttributionRankRow } from "./core/context-types.js";
import type { UsageFilter } from "./core/types.js";
import { getRuntimeContentEvidence, listRuntimeContentEvidence } from "./runtime-content-evidence.js";
import { UsageQueryCache } from "./query-cache.js";
import { UsageQueryWorker, UsageQueryWorkerError } from "./query-worker.js";

const querySchema = z.object({
  agentId: z.string().regex(/^[1-9]\d*$/).optional(), sessionId: z.string().regex(/^[1-9]\d*$/).optional(),
  from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(),
  timezone: z.string().default("UTC").refine((value) => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
  }),
  runtimeKind: z.string().min(1).max(100).optional(), subagents: z.literal("self").default("self"),
  dimension: z.enum(["all", ...capabilityKinds]).default("all"),
  sort: z.enum(["observedTotalTokens", "observedArgumentTokens", "observedResultTokens", "totalInputTokens", "inputBytes", "calls", "definitionInputTokens", "argumentInputTokens", "firstResultInputTokens", "repeatedResultInputTokens", "failures", "latencyMsP95"]).default("observedTotalTokens"),
  bucket: z.enum(["day", "week", "month"]).default("day"),
  limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).max(100000).default(0),
  capturePage: z.coerce.number().int().min(1).default(1), failurePage: z.coerce.number().int().min(1).default(1),
  stageOffset: z.coerce.number().int().min(0).max(100000).default(0),
  capabilityKind: z.enum(capabilityKinds).optional(),
  capabilityId: z.string().min(1).max(500).optional(), capabilityServerId: z.string().min(1).max(500).optional(),
  cursor: z.string().max(500).optional(),
  origin: z.enum(["counted", "execution", "context"]).default("counted")
}).strict().refine((query) => !query.from || !query.to || Date.parse(query.from) < Date.parse(query.to));

const insights = (row: AttributionRankRow) => [
  ...(row.repeatedResultInputTokens !== null && row.repeatedResultInputTokens > 0 ? [{ kind: "repeated_results", tokens: row.repeatedResultInputTokens }] : []),
  ...(row.calls === 0 && (row.definitionInputTokens ?? 0) > 0 ? [{ kind: "unused_definitions", tokens: row.definitionInputTokens }] : []),
  ...(row.failures > 0 ? [{ kind: "failed_calls", count: row.failures }] : [])
];
const queryError = (error: Error, _request: FastifyRequest, reply: FastifyReply) => {
  const code = error instanceof UsageQueryWorkerError ? error.code : "usage_query_failed";
  return reply.code(code === "usage_query_failed" ? 500 : 503)
    .send({ error: { code, message: "Usage analysis is temporarily unavailable" } });
};

/** Management-only projections; usage facts and estimated context contributions remain separate. */
export const registerUsageQueryRoutes = (app: FastifyInstance, collector: HostUsageCollector): void => {
  const namespace = collector.namespace;
  const cache = new UsageQueryCache(collector.db);
  const reader = new UsageQueryWorker(collector);
  app.addHook("preClose", async () => { await reader.close(); });
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
  app.get("/usage/session-summaries", { errorHandler: queryError }, async (request, reply) => {
    const parsed = z.object({ ids: z.string().regex(/^[1-9]\d*(,[1-9]\d*)*$/).max(2100) }).strict().safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: { code: "invalid_request", message: "Invalid usage query" } });
    const ids = [...new Set(parsed.data.ids.split(","))];
    if (ids.length > 100) return reply.code(400).send({ error: { code: "invalid_request", message: "Invalid usage query" } });
    return { revision: cache.revision(), items: await cache.getAsync(`session-totals:${ids.join(",")}`,
      () => reader.read("sessionSummaries", [namespace, ids])) };
  });
  for (const endpoint of ["status", "summary", "timeseries", "capabilities", "invocations", "context-evidence", "content-evidence"] as const) {
    app.get(`/usage/${endpoint}`, { errorHandler: queryError }, async (request, reply) => {
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: { code: "invalid_request", message: "Invalid usage query" } });
      const query = parsed.data;
      const filter: UsageFilter = { namespace, agentId: query.agentId, sessionId: query.sessionId,
        from: query.from === undefined ? undefined : new Date(query.from).toISOString(),
        to: query.to === undefined ? undefined : new Date(query.to).toISOString(), runtimeKind: query.runtimeKind };
      const revision = cache.revision();
      const status = cache.get(`status:${JSON.stringify(filter)}`, () => ({
        sourceCounts: collector.sources.sourceStatusCounts(namespace, filter),
        collectionFailureTotal: collector.collectionFailureCount(filter),
        captureHealthCounts: collector.capture?.healthCounts(filter) ?? {},
        contentBackfill: collector.contentBackfill.status(filter)
      }));
      if (endpoint === "status") return { ...status, revision, recovery: collector.recoveryStatus(),
        eventRetention: collector.eventRetention.status() };
      const { sourceCounts, captureHealthCounts, contentBackfill } = status;
      const sourceCount = Object.values(sourceCounts).reduce((sum, count) => sum + count, 0);
      const failurePage = cache.get(`failures:${JSON.stringify([filter, query.failurePage])}`,
        () => collector.collectionFailurePage(filter, { page: query.failurePage, pageSize: 20 }));
      const capturePage = cache.get(`captures:${JSON.stringify([filter, query.capturePage])}`,
        () => collector.capture?.healthPage(filter, { page: query.capturePage, pageSize: 20 }) ?? null);
      const collectionFailures = failurePage.items;
      const captureHealth = capturePage?.items ?? [];
      const capturePartial = Object.entries(captureHealthCounts).some(([status, count]) => status !== "observed" && count > 0);
      const metadata = { collectionFailures, collectionFailureTotal: failurePage.total,
        captureHealth, captureHealthTotal: capturePage?.total ?? 0, captureHealthCounts,
        contentBackfill, revision, asOf: new Date().toISOString(), timezone: query.timezone, from: query.from ?? null, to: query.to ?? null,
        subagents: "self", timeBasis: "source_timestamp", bodyStatus: "not_retained",
        analysisStatus: sourceCounts.collecting || contentBackfill.status === "pending" || contentBackfill.status === "running" ? "collecting"
          : capturePartial || contentBackfill.status === "failed" || failurePage.total > 0 || sourceCounts.failed ? "partial" : "ready" };
      if (endpoint === "summary") {
        const { summary } = await cache.getAsync(`totals:${JSON.stringify([filter, query.timezone, query.bucket])}`,
          () => reader.read("overview", [filter, query.timezone, query.bucket]));
        const hasCapabilityEvidence = collector.attribution.hasEvidence(filter);
        return { ...metadata, ...summary, hasCapabilityEvidence,
          ...(capturePartial && summary.completeness !== "conflict" ? { completeness: "partial" } : {}), ...(query.sessionId === undefined ? {} : { providerEpochId: providerEpoch(query.sessionId, query.agentId) }),
          sourceCounts,
          analysisStatus: sourceCount === 0 && summary.completeness === "none" && failurePage.total === 0 && !capturePage?.total
            && contentBackfill.status === "completed" && !hasCapabilityEvidence ? "empty" : metadata.analysisStatus };
      }
      if (endpoint === "timeseries") {
        const { timeseries: series } = await cache.getAsync(`totals:${JSON.stringify([filter, query.timezone, query.bucket])}`,
          () => reader.read("overview", [filter, query.timezone, query.bucket]));
        return { ...metadata, ...series, total: series.items.length, items: series.items.slice(query.offset, query.offset + query.limit) };
      }
      if (endpoint === "capabilities") {
        const page = await cache.getAsync(`ranking:${JSON.stringify([filter, query.dimension, query.sort, query.limit, query.offset])}`,
          () => reader.read("rankings", [filter, query.dimension, query]));
        const stages = cache.get(`stages:${JSON.stringify([filter, query.dimension, query.stageOffset])}`,
          () => collector.runtimeCapabilities.stageCountsPage(filter, { dimension: query.dimension, limit: 20, offset: query.stageOffset }));
        return { ...metadata, measurement: "estimated", dimension: query.dimension, sort: query.sort, total: page.total,
          stages: stages.items, stageTotal: stages.total,
          items: page.items.map((row) => ({ ...row, insights: insights(row) })) };
      }
      let cursor: { t: string; id: string } | undefined;
      if (query.cursor) {
        try { cursor = z.object({ t: z.string(), id: z.string() }).parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString())); }
        catch { return reply.code(400).send({ error: { code: "invalid_request", message: "Invalid usage cursor" } }); }
      }
      const page = { cursor, limit: query.limit + 1, capabilityId: query.capabilityId,
        capabilityKind: query.capabilityKind, capabilityServerId: query.capabilityServerId };
      if (endpoint === "content-evidence") {
        const rows = listRuntimeContentEvidence(collector.db, filter, page);
        const items = rows.slice(0, query.limit), last = items.at(-1);
        return { ...metadata, items, nextCursor: rows.length > query.limit && last
          ? Buffer.from(JSON.stringify({ t: last.occurredAt, id: last.id })).toString("base64url") : null };
      }
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
  app.get<{ Params: { id: string } }>("/usage/content-evidence/:id", (request, reply) => {
    const detail = getRuntimeContentEvidence(collector.db, namespace, request.params.id);
    if (!detail) return reply.code(404).send({ error: { code: "usage_content_evidence_not_found", message: "Content evidence not found" } });
    return { ...detail, bodyStatus: "not_retained", asOf: new Date().toISOString() };
  });
  app.get<{ Params: { id: string } }>("/usage/context-evidence/:id", (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: { code: "invalid_request", message: "Invalid usage query" } });
    const detail = collector.attribution.contextEvidenceDetail(namespace, request.params.id, parsed.data);
    if (!detail) return reply.code(404).send({ error: { code: "usage_context_evidence_not_found", message: "Usage context evidence not found" } });
    return { ...detail, bodyStatus: "not_retained", asOf: new Date().toISOString() };
  });
  app.get<{ Params: { id: string } }>("/usage/invocations/:id", (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: { code: "invalid_request", message: "Invalid usage query" } });
    const detail = collector.attribution.detail(namespace, request.params.id, parsed.data);
    if (!detail) return reply.code(404).send({ error: { code: "usage_invocation_not_found", message: "Usage invocation not found" } });
    const records = collector.store.records({ namespace, sessionId: detail.invocation.sessionId }, detail.subsequentModelInvocationIds);
    return { ...detail, bodyStatus: "not_retained", usageEvidence: records, asOf: new Date().toISOString() };
  });
};
