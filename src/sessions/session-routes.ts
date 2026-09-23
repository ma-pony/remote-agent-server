import { paginationQuerySchema } from "../pagination.js";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { RunRepository } from "../runs/run-repository.js";
import { McpManagerError } from "../mcp/mcp-manager.js";
import { WorkspaceCreateError } from "../workspaces/workspace-manager.js";
import { SessionManager, SessionManagerError } from "./session-manager.js";

const parameterDetailQuerySchema = z.object({ includeParameters: z.enum(["true", "false"]).default("true") }).strict();

const createSessionSchema = z.object({
  agentId: z.number().int().positive(),
  title: z.string().trim().min(1),
  mcpParameters: z.record(z.string(), z.string().nullable()).default({})
}).strict();
const parseId = (value: string): number | undefined => {
  const parsed = z.coerce.number().int().positive().safeParse(value);
  return parsed.success ? parsed.data : undefined;
};
const updateMcpParametersSchema = z.object({
  values: z.record(z.string(), z.string().nullable())
}).strict();
const runHistoryQuerySchema = z.object({
  beforeId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});
const sessionListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  query: z.string().trim().max(200).optional(),
  agentId: z.coerce.number().int().positive().optional(),
  status: z.enum(["idle", "running"]).optional(),
  storage: z.literal("active").optional()
});

const sendError = (reply: FastifyReply, statusCode: number, code: string, message: string) =>
  reply.code(statusCode).send({ error: { code, message } });

const handleError = (reply: FastifyReply, error: unknown) => {
  if (error instanceof WorkspaceCreateError) {
    return sendError(reply, 500, error.code, error.message);
  }
  if (error instanceof McpManagerError) {
    return sendError(reply, 400, error.code, "Invalid Session MCP parameters");
  }
  if (!(error instanceof SessionManagerError)) throw error;

  switch (error.code) {
    case "agent_not_found":
      return sendError(reply, 404, "not_found", "Agent not found");
    case "agent_disabled":
      return sendError(reply, 400, error.code, "Agent is disabled");
    case "project_environment_unavailable":
      return sendError(reply, 400, error.code, "Project environment has no ready revision");
    case "session_not_found":
      return sendError(reply, 404, "not_found", "Session not found");
    case "session_busy":
      return sendError(reply, 409, error.code, "Session is running");
    case "session_storage_cleaned":
      return sendError(reply, 410, error.code, "Session storage has been cleaned");
    case "session_create_failed":
      return sendError(reply, 500, error.code, "Failed to save session");
    case "runtime_reset_failed":
      return sendError(reply, 500, error.code, "Failed to reset runtime session");
    case "session_delete_failed":
      return sendError(reply, 500, error.code, "Failed to delete session");
    case "session_cleanup_failed":
      return sendError(reply, 500, error.code, "Failed to clean session storage");
    case "usage_collection_pending":
      return sendError(reply, 409, error.code, "Usage collection must finish before session storage is removed");
  }
};

/**
 * Registers the authenticated Session lifecycle routes.
 */
export const registerSessionRoutes = (
  app: FastifyInstance,
  sessionManager: SessionManager,
  runRepository: RunRepository
): void => {
  app.get<{ Querystring: { page?: string; pageSize?: string; query?: string; agentId?: string; status?: string; storage?: string } }>(
    "/sessions",
    (request, reply) => {
      const parsed = sessionListQuerySchema.safeParse(request.query);
      return parsed.success
        ? sessionManager.list(parsed.data)
        : sendError(reply, 400, "invalid_request", "Invalid Session list query");
    }
  );

  app.post("/sessions", async (request, reply) => {
    const parsed = createSessionSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "invalid_request", "Invalid Session input");

    try {
      return reply.code(201).send(await sessionManager.create(parsed.data));
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/sessions/:id", (request, reply) => {
    const id = parseId(request.params.id);
    const query = parameterDetailQuerySchema.safeParse(request.query);
    if (!query.success) return sendError(reply, 400, "invalid_request", "Invalid Session detail query");
    const session = id === undefined ? undefined : query.data.includeParameters === "false" ? sessionManager.getSummary(id) : sessionManager.get(id);
    return session === undefined
      ? sendError(reply, 404, "not_found", "Session not found")
      : (() => {
        const page = runRepository.listSessionPage(session.id, undefined, 20);
        return {
          ...session,
          runs: page.items,
          hasOlderRuns: page.hasMore
        };
      })();
  });

  app.get<{ Params: { id: string }; Querystring: { beforeId?: string; limit?: string } }>(
    "/sessions/:id/runs",
    (request, reply) => {
      const id = parseId(request.params.id);
      if (id === undefined || sessionManager.get(id) === undefined) {
        return sendError(reply, 404, "not_found", "Session not found");
      }
      const parsed = runHistoryQuerySchema.safeParse(request.query);
      if (!parsed.success) return sendError(reply, 400, "invalid_request", "Invalid Run history cursor");
      return runRepository.listSessionPage(id, parsed.data.beforeId, parsed.data.limit);
    }
  );

  app.get<{ Params: { id: string } }>("/sessions/:id/mcp-parameters", (request, reply) => {
    const parsed = paginationQuerySchema.strict().safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "invalid_request", "Invalid Session parameter pagination");
    const id = parseId(request.params.id);
    const page = id === undefined ? undefined : sessionManager.parameterPage(id, parsed.data);
    return page ?? sendError(reply, 404, "not_found", "Session not found");
  });

  app.patch<{ Params: { id: string } }>("/sessions/:id/mcp-parameters", (request, reply) => {
    const query = parameterDetailQuerySchema.safeParse(request.query);
    if (!query.success) return sendError(reply, 400, "invalid_request", "Invalid Session detail query");
    const parsed = updateMcpParametersSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "invalid_request", "Invalid Session MCP parameters");
    try {
      const id = parseId(request.params.id);
      if (id === undefined) return sendError(reply, 404, "not_found", "Session not found");
      return sessionManager.updateMcpParameters(id, parsed.data.values, query.data.includeParameters !== "false");
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/sessions/:id/reset", async (request, reply) => {
    const query = parameterDetailQuerySchema.safeParse(request.query);
    if (!query.success) return sendError(reply, 400, "invalid_request", "Invalid Session detail query");
    try {
      const id = parseId(request.params.id);
      if (id === undefined) return sendError(reply, 404, "not_found", "Session not found");
      return await sessionManager.resetProviderSession(id, query.data.includeParameters !== "false");
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/sessions/:id", async (request, reply) => {
    try {
      const id = parseId(request.params.id);
      if (id === undefined) return sendError(reply, 404, "not_found", "Session not found");
      await sessionManager.delete(id);
      return reply.code(204).send();
    } catch (error) {
      return handleError(reply, error);
    }
  });
};
