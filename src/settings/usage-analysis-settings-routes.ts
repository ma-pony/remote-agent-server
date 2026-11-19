import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { UsageAnalysisSettingsStore } from "./usage-analysis-settings-store.js";

const usageAnalysisSettingsSchema = z.object({ enabled: z.boolean() }).strict();

/** Registers authenticated usage-analysis switch routes. */
export const registerUsageAnalysisSettingsRoutes = (app: FastifyInstance, store: UsageAnalysisSettingsStore): void => {
  app.get("/system-settings/usage-analysis", () => store.get());

  app.put("/system-settings/usage-analysis", (request, reply) => {
    const parsed = usageAnalysisSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "invalid_request", message: "Invalid usage analysis settings" } });
    }
    return store.update(parsed.data);
  });
};
