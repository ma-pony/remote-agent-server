import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { RunRepository } from "../runs/run-repository.js";
import { WorkspaceCreateError } from "../workspaces/workspace-manager.js";
import { SessionManager, SessionManagerError } from "./session-manager.js";

const createSessionSchema = z.object({
  agentId: z.string().uuid(),
  title: z.string().trim().min(1)
}).strict();

const sendError = (reply: FastifyReply, statusCode: number, code: string, message: string) =>
  reply.code(statusCode).send({ error: { code, message } });

const handleError = (reply: FastifyReply, error: unknown) => {
  if (error instanceof WorkspaceCreateError) {
    return sendError(reply, 500, error.code, error.message);
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
    case "session_create_failed":
      return sendError(reply, 500, error.code, "Failed to save session");
    case "runtime_reset_failed":
      return sendError(reply, 500, error.code, "Failed to reset runtime session");
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
  app.get("/sessions", () => sessionManager.list());

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
    const session = sessionManager.get(request.params.id);
    return session === undefined
      ? sendError(reply, 404, "not_found", "Session not found")
      : { ...session, runs: runRepository.listBySession(session.id) };
  });

  app.post<{ Params: { id: string } }>("/sessions/:id/reset", async (request, reply) => {
    try {
      return await sessionManager.resetProviderSession(request.params.id);
    } catch (error) {
      return handleError(reply, error);
    }
  });
};
