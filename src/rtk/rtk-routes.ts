import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { RtkError } from "./rtk-download.js";
import type { RtkManager } from "./rtk-manager.js";
import { rtkVersionPattern } from "./rtk-types.js";

const enabledSchema = z.object({ enabled: z.boolean() }).strict();
const versionSchema = z.object({ version: z.string().regex(rtkVersionPattern) }).strict();

/** These routes inherit the management API authentication hook. */
export const registerRtkRoutes = (app: FastifyInstance, manager: RtkManager): void => {
  app.get("/system-settings/rtk", () => manager.status());
  app.put("/system-settings/rtk", (request, reply) => {
    const input = enabledSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: { code: "invalid_request", message: "Invalid RTK settings" } });
    try { return manager.setEnabled(input.data.enabled); }
    catch (error) {
      if (!(error instanceof RtkError)) throw error;
      return reply.code(409).send({ error: { code: error.code, message: "RTK settings are busy; refresh its status" } });
    }
  });
  for (const action of ["check", "update", "rollback"] as const) {
    app.post(`/system-settings/rtk/${action}`, (request, reply) => {
      const input = action === "check" ? z.object({}).strict().safeParse(request.body ?? {}) : versionSchema.safeParse(request.body);
      if (!input.success) return reply.code(400).send({ error: { code: "invalid_request", message: "Invalid RTK operation" } });
      try {
        const result = action === "check" ? manager.check()
          : manager[action]((input.data as { version: string }).version);
        return reply.code(202).send(result);
      } catch (error) {
        if (!(error instanceof RtkError)) throw error;
        return reply.code(409).send({ error: { code: error.code, message: "RTK operation could not be started; refresh its status" } });
      }
    });
  }
};
