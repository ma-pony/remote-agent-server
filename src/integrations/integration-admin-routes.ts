import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { IntegrationEndpointManager, IntegrationEndpointManagerError } from "./integration-endpoint-manager.js";

const slug = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const requestParameterMappingSchema = z.object({
  parameterKey: z.string().trim().min(1),
  source: z.literal("request"),
  requestKey: z.string().trim().min(1)
}).strict();
const fixedParameterMappingSchema = z.object({
  parameterKey: z.string().trim().min(1),
  source: z.literal("fixed"),
  value: z.string()
}).strict();
const parameterMappings = z.array(z.discriminatedUnion("source", [
  requestParameterMappingSchema,
  fixedParameterMappingSchema
]));

const createEndpointSchema = z.object({
  name: z.string().trim().min(1),
  slug,
  agentId: z.string().min(1),
  enabled: z.boolean(),
  promptPrefix: z.string(),
  parameterMappings
}).strict();

const updateEndpointSchema = createEndpointSchema.partial().strict().refine(
  (input) => Object.keys(input).length > 0,
  { message: "At least one field must be provided" }
);

const invalidRequest = (reply: FastifyReply, message: string) =>
  reply.code(400).send({ error: { code: "invalid_request", message } });

const endpointNotFound = (reply: FastifyReply) =>
  reply.code(404).send({ error: { code: "endpoint_not_found", message: "Integration endpoint not found" } });

const handleManagerError = (reply: FastifyReply, error: unknown) => {
  if (!(error instanceof IntegrationEndpointManagerError)) throw error;
  if (error.code === "endpoint_not_found") return endpointNotFound(reply);
  if (error.code === "agent_not_found") {
    return reply.code(404).send({ error: { code: "agent_not_found", message: "Agent not found" } });
  }
  if (error.code === "endpoint_in_use" || error.code === "conversation_busy") {
    return reply.code(409).send({
      error: {
        code: error.code,
        message: error.code === "endpoint_in_use"
          ? "Integration endpoint has history and cannot be deleted"
          : "Integration endpoint has active work and cannot change Agent"
      }
    });
  }
  return reply.code(400).send({
    error: { code: error.code, message: "Invalid Integration Endpoint input" }
  });
};

/**
 * Registers authenticated management routes for Integration Endpoints.
 */
export const registerIntegrationAdminRoutes = (app: FastifyInstance, manager: IntegrationEndpointManager): void => {
  app.get("/integration-endpoints", () => manager.list());

  app.get<{ Params: { id: string } }>("/integration-endpoints/:id", (request, reply) => {
    const endpoint = manager.get(request.params.id);
    return endpoint === undefined ? endpointNotFound(reply) : endpoint;
  });

  app.post("/integration-endpoints", (request, reply) => {
    const parsed = createEndpointSchema.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply, "Invalid Integration Endpoint input");
    try {
      return reply.code(201).send(manager.create(parsed.data));
    } catch (error) {
      return handleManagerError(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/integration-endpoints/:id", (request, reply) => {
    const parsed = updateEndpointSchema.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply, "Invalid Integration Endpoint update");
    try {
      return manager.update(request.params.id, parsed.data);
    } catch (error) {
      return handleManagerError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/integration-endpoints/:id/rotate-token", (request, reply) => {
    try {
      return manager.rotateToken(request.params.id);
    } catch (error) {
      return handleManagerError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/integration-endpoints/:id", (request, reply) => {
    try {
      manager.delete(request.params.id);
      return reply.code(204).send();
    } catch (error) {
      return handleManagerError(reply, error);
    }
  });
};
