import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { AgentManager } from "./agent-manager.js";

const createAgentSchema = z.object({
  name: z.string().trim().min(1),
  provider: z.enum(["claude_code", "codex", "hermes"])
}).strict();

const updateAgentSchema = z.object({
  name: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional()
}).strict().refine((input) => input.name !== undefined || input.enabled !== undefined, {
  message: "At least one field must be provided"
});

const badRequest = (reply: FastifyReply, message: string) =>
  reply.code(400).send({ error: { code: "invalid_request", message } });

const notFound = (reply: FastifyReply) =>
  reply.code(404).send({ error: { code: "not_found", message: "Agent not found" } });

/**
 * Registers the authenticated Agent management routes.
 */
export const registerAgentRoutes = (app: FastifyInstance, agentManager: AgentManager): void => {
  app.get("/agents", () => agentManager.list());

  app.post("/agents", (request, reply) => {
    const parsed = createAgentSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, "Invalid Agent input");

    return reply.code(201).send(agentManager.create(parsed.data));
  });

  app.patch<{ Params: { id: string } }>("/agents/:id", (request, reply) => {
    const parsed = updateAgentSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, "Invalid Agent update");

    const agent = agentManager.update(request.params.id, parsed.data);
    return agent === undefined ? notFound(reply) : agent;
  });

  app.get<{ Params: { id: string } }>("/agents/:id/doctor", async (request, reply) => {
    const result = await agentManager.doctor(request.params.id);
    return result === undefined ? notFound(reply) : result;
  });
};
