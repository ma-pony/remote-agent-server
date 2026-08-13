import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { McpManagerError } from "../mcp/mcp-manager.js";
import { SessionManagerError } from "../sessions/session-manager.js";
import { WorkspaceCreateError } from "../workspaces/workspace-manager.js";
import { requireIntegrationEndpoint } from "./integration-auth.js";
import { IntegrationCoordinator, IntegrationCoordinatorError } from "./integration-coordinator.js";
import { IntegrationEndpointManager, IntegrationEndpointManagerError } from "./integration-endpoint-manager.js";
import type { IntegrationTask } from "./integration-types.js";

const submitTaskSchema = z.object({
  requestId: z.string().refine((value) => value.trim() !== ""),
  conversationKey: z.string().refine((value) => value.trim() !== "").optional(),
  message: z.string().refine((value) => value.trim() !== ""),
  parameters: z.record(z.string(), z.string()).default({})
}).strict();

const sendError = (reply: FastifyReply, statusCode: number, code: string, message: string) =>
  reply.code(statusCode).send({ error: { code, message } });

const publicTask = (task: IntegrationTask) => {
  const { encryptedParameters: _encryptedParameters, requestFingerprint: _requestFingerprint, ...result } = task;
  return result;
};

const handleError = (reply: FastifyReply, error: unknown) => {
  if (error instanceof IntegrationCoordinatorError) {
    switch (error.code) {
      case "idempotency_conflict":
        return sendError(reply, 409, error.code, "requestId was already used with different input");
      case "conversation_busy":
        return sendError(reply, 409, error.code, "Conversation has an active Task");
      case "task_not_found":
        return sendError(reply, 404, error.code, "Integration Task not found");
      case "conversation_not_found":
        return sendError(reply, 404, error.code, "Integration Conversation not found");
      case "endpoint_disabled":
        return sendError(reply, 403, error.code, "Integration Endpoint is disabled");
    }
  }
  if (error instanceof IntegrationEndpointManagerError) {
    if (error.code === "endpoint_not_found") {
      return sendError(reply, 404, error.code, "Integration Endpoint not found");
    }
    return sendError(reply, 400, error.code, "Invalid Integration Task parameters");
  }
  if (error instanceof McpManagerError) {
    return sendError(reply, 400, error.code, "Invalid Integration Task parameters");
  }
  if (error instanceof WorkspaceCreateError) {
    return sendError(reply, 500, error.code, error.message);
  }
  if (error instanceof SessionManagerError) {
    const statusCode = error.code === "agent_not_found" || error.code === "session_not_found" ? 404
      : error.code === "session_create_failed" || error.code === "session_delete_failed" ? 500
        : error.code === "session_busy" ? 409 : 400;
    return sendError(reply, statusCode, error.code, "Failed to create Integration Session");
  }
  throw error;
};

const bearerToken = (authorization: string | undefined): string | undefined =>
  authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;

export type IntegrationRouteDependencies = {
  manager: IntegrationEndpointManager;
  coordinator: IntegrationCoordinator;
};

/** Registers the authenticated external Integration API. */
export const registerIntegrationRoutes = (
  app: FastifyInstance,
  { manager, coordinator }: IntegrationRouteDependencies
): void => {
  app.decorateRequest("integrationEndpoint", null);

  app.post<{ Params: { slug: string } }>("/integration/v1/endpoints/:slug/tasks", {
    onRequest: requireIntegrationEndpoint(manager)
  }, async (request, reply) => {
    const parsed = submitTaskSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "invalid_request", "Invalid Integration Task input");
    try {
      return reply.code(202).send(publicTask(await coordinator.submit(request.integrationEndpoint!, parsed.data)));
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post<{ Params: { slug: string; conversationKey: string } }>(
    "/integration/v1/endpoints/:slug/conversations/:conversationKey/end",
    { onRequest: requireIntegrationEndpoint(manager) },
    async (request, reply) => {
      try {
        return await coordinator.endConversation(request.integrationEndpoint!.id, request.params.conversationKey);
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.get<{ Params: { taskId: string } }>("/integration/v1/tasks/:taskId", (request, reply) => {
    const task = coordinator.getTask(request.params.taskId);
    if (task === undefined) return sendError(reply, 404, "task_not_found", "Integration Task not found");
    const endpoint = manager.get(task.endpointId);
    const token = bearerToken(request.headers.authorization);
    if (endpoint === undefined || token === undefined || manager.authenticate(endpoint.slug, token) === undefined) {
      return sendError(reply, 401, "invalid_endpoint_token", "Invalid integration endpoint token");
    }
    return publicTask(task);
  });

  app.all<{ Params: { slug: string } }>("/integration/v1/endpoints/:slug/*", {
    onRequest: requireIntegrationEndpoint(manager)
  }, (_request, reply) => reply.code(404).send({
    error: { code: "not_found", message: "Integration route not found" }
  }));
};
