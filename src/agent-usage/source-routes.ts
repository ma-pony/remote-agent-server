import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { isPagedQuery, paginationQuerySchema } from "../pagination.js";
import { UsageError, type UsageErrorCode } from "./core/errors.js";
import type { ManagedUsageSources } from "./managed-sources.js";

const id = z.string().regex(/^[1-9]\d*$/).refine((value) => Number.isSafeInteger(Number(value)));
const path = z.string().min(1).max(2048);
const sourceSchema = z.object({
  sourceKey: z.string().min(1).max(200), kind: z.enum(["codex_log", "claude_log", "context_snapshot"]),
  inputRef: z.union([
    z.object({ importRootId: z.string().min(1).max(100), relativePath: path }).strict(),
    z.object({ providerSessionRef: id, relativePath: path }).strict()
  ]),
  mappings: z.array(z.object({ sourceSessionKey: z.string().min(1).max(200), sessionId: id,
    providerEpochId: z.string().min(1).max(200) }).strict()).min(1).max(100)
}).strict();
const sourceQuerySchema = paginationQuerySchema.extend({ agentId: id.optional(), sessionId: id.optional() }).strict();

const errorStatuses: Partial<Record<UsageErrorCode, number>> = {
  usage_source_conflict: 409, usage_mapping_conflict: 409, usage_mapping_revoked: 409,
  usage_subject_deleted: 409, usage_subject_mismatch: 409, usage_binding_stale: 409,
  usage_collection_pending: 409, usage_maintenance_conflict: 409, usage_epoch_mismatch: 400,
  usage_mapping_mismatch: 400, usage_source_path_denied: 400, usage_source_too_large: 400,
  usage_source_not_file: 400, usage_source_unsupported: 400, usage_source_changed: 409,
  usage_session_not_found: 404, usage_source_not_found: 404
};

const errorReply = (reply: FastifyReply, error: unknown) => {
  const status = error instanceof UsageError ? errorStatuses[error.code] : undefined;
  const code = error instanceof UsageError && status !== undefined ? error.code : "usage_source_failed";
  return reply.code(status ?? 500).send({ error: { code, message: "Usage source operation could not be completed" } });
};

export const registerUsageSourceRoutes = (app: FastifyInstance, manager: ManagedUsageSources): void => {
  const { collector } = manager;
  app.get("/usage/sources", (request, reply) => {
    const parsed = sourceQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: { code: "invalid_request", message: "Invalid usage source query" } });
    return isPagedQuery(request.query) ? collector.sources.listSourcesPage(collector.namespace, parsed.data, parsed.data)
      : collector.sources.listSources(collector.namespace, parsed.data);
  });
  app.post("/usage/sources", async (request, reply) => {
    const parsed = sourceSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "invalid_request", message: "Invalid usage source" } });
    try {
      const result = await manager.register(parsed.data);
      return reply.code(result.created ? 201 : 200).send(result.source);
    } catch (error) { return errorReply(reply, error); }
  });
  app.post<{ Params: { id: string } }>("/usage/sources/:id/collect", (request, reply) => {
    try {
      const source = collector.sources.listSources(collector.namespace, { id: request.params.id })[0];
      if (!source) throw new UsageError("usage_source_not_found");
      if (source.mappings.every((mapping) => mapping.state === "revoked")) throw new UsageError("usage_mapping_revoked");
      return reply.code(202).send(collector.sources.startCollect(source.id));
    } catch (error) { return errorReply(reply, error); }
  });
};
