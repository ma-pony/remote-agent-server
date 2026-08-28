import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { ConcurrencySettingsStore } from "./concurrency-settings-store.js";

const concurrencyOnlySchema = z.object({
  globalRunConcurrency: z.number().int().min(1).max(64),
  webhookConcurrency: z.number().int().min(1).max(64),
  environmentBuildConcurrency: z.number().int().min(1).max(64)
}).strict();

const concurrencySettingsSchema = concurrencyOnlySchema.extend({
  runTimeoutMinutes: z.number().int().min(1).max(1440),
  sessionStorageRetentionHours: z.number().int().min(0).max(8760)
}).strict();

/** Registers authenticated global concurrency settings routes. */
export const registerConcurrencySettingsRoutes = (
  app: FastifyInstance,
  store: ConcurrencySettingsStore
): void => {
  app.get("/system-settings/concurrency", () => store.getAll());

  app.put("/system-settings/concurrency", (request, reply) => {
    const parsed = concurrencySettingsSchema.safeParse(request.body);
    if (parsed.success) return store.updateAll(parsed.data);
    const concurrencyOnly = concurrencyOnlySchema.safeParse(request.body);
    if (concurrencyOnly.success) return store.update(concurrencyOnly.data);
    return reply.code(400).send({
      error: { code: "invalid_request", message: "Invalid concurrency settings" }
    });
  });
};
