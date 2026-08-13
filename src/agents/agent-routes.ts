import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { AgentManager, AgentManagerError } from "./agent-manager.js";

const createAgentSchema = z.object({
  name: z.string().trim().min(1),
  provider: z.enum(["claude_code", "codex", "hermes"]),
  projectEnvironmentId: z.string().uuid()
}).strict();

const updateAgentSchema = z.object({
  name: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
  projectEnvironmentId: z.string().uuid().optional()
}).strict().refine(
  (input) => input.name !== undefined || input.enabled !== undefined || input.projectEnvironmentId !== undefined,
  {
  message: "At least one field must be provided"
  }
);

const badRequest = (reply: FastifyReply, message: string) =>
  reply.code(400).send({ error: { code: "invalid_request", message } });

const notFound = (reply: FastifyReply) =>
  reply.code(404).send({ error: { code: "not_found", message: "Agent not found" } });

const handleAgentError = (reply: FastifyReply, error: unknown) => {
  if (error instanceof AgentManagerError) {
    if (error.code === "agent_has_sessions") {
      return reply.code(409).send({
        error: {
          code: error.code,
          message: "Agent has Sessions and cannot be deleted; disable it instead"
        }
      });
    }
    return reply.code(400).send({
      error: { code: error.code, message: "Project environment has no ready revision" }
    });
  }
  throw error;
};

/**
 * Registers the authenticated Agent management routes.
 */
export const registerAgentRoutes = (app: FastifyInstance, agentManager: AgentManager): void => {
  app.get("/agents", () => agentManager.list());

  app.post("/agents", (request, reply) => {
    const parsed = createAgentSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, "Invalid Agent input");

    try {
      return reply.code(201).send(agentManager.create(parsed.data));
    } catch (error) {
      return handleAgentError(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/agents/:id", (request, reply) => {
    const parsed = updateAgentSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, "Invalid Agent update");

    try {
      const agent = agentManager.update(request.params.id, parsed.data);
      return agent === undefined ? notFound(reply) : agent;
    } catch (error) {
      return handleAgentError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/agents/:id", (request, reply) => {
    try {
      const result = agentManager.delete(request.params.id);
      return result === "not_found" ? notFound(reply) : reply.code(204).send();
    } catch (error) {
      return handleAgentError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/agents/:id/doctor", async (request, reply) => {
    const result = await agentManager.doctor(request.params.id);
    return result === undefined ? notFound(reply) : result;
  });
};
