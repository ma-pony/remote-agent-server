import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
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

const errorReply = (reply: FastifyReply, error: unknown) => {
  const errors: Record<string, number> = {
    usage_source_conflict: 409, usage_mapping_conflict: 409, usage_mapping_revoked: 409,
    usage_subject_deleted: 409, usage_collection_pending: 409, usage_epoch_mismatch: 400,
    usage_mapping_mismatch: 400, usage_source_path_denied: 400, usage_source_too_large: 400,
    usage_source_changed: 409, usage_session_not_found: 404, usage_source_not_found: 404
  };
  const code = error instanceof Error && Object.hasOwn(errors, error.message) ? error.message : "usage_source_failed";
  return reply.code(errors[code] ?? 400).send({ error: { code, message: "Usage source operation could not be completed" } });
};

export const registerUsageSourceRoutes = (app: FastifyInstance, manager: ManagedUsageSources): void => {
  const { collector } = manager;
  app.get("/usage/sources", () => collector.sources.listSources(collector.namespace));
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
      const source = collector.sources.listSources(collector.namespace).find((item) => item.id === request.params.id);
      if (!source) throw new Error("usage_source_not_found");
      if (source.mappings.every((mapping) => mapping.state === "revoked")) throw new Error("usage_mapping_revoked");
      return reply.code(202).send(collector.sources.startCollect(source.id));
    } catch (error) { return errorReply(reply, error); }
  });
};
