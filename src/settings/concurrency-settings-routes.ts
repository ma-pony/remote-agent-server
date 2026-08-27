import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { ConcurrencySettingsStore } from "./concurrency-settings-store.js";

const concurrencySettingsSchema = z.object({
  globalRunConcurrency: z.number().int().min(1).max(64),
  webhookConcurrency: z.number().int().min(1).max(64),
  environmentBuildConcurrency: z.number().int().min(1).max(64)
}).strict();

/** Registers authenticated global concurrency settings routes. */
export const registerConcurrencySettingsRoutes = (
  app: FastifyInstance,
  store: ConcurrencySettingsStore
): void => {
  app.get("/system-settings/concurrency", () => store.get());

  app.put("/system-settings/concurrency", (request, reply) => {
    const parsed = concurrencySettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: "invalid_request", message: "Invalid concurrency settings" }
      });
    }
    return store.update(parsed.data);
  });
};
