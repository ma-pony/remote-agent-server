import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { ProjectEnvironmentCheckScheduler } from "./project-environment-scheduler.js";
import type { ProjectEnvironmentStore } from "./project-environment-store.js";

const environmentSchema = z.object({ name: z.string().trim().min(1).max(120) }).strict();
const repositoryName = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).max(120);
const repositorySchema = z.object({
  name: repositoryName,
  gitUrl: z.string().trim().min(1).max(2_000),
  prepareCommand: z.string().trim().max(4_000).nullable().optional().default(null)
}).strict();
const repositoryUpdateSchema = z.object({
  name: repositoryName.optional(),
  gitUrl: z.string().trim().min(1).max(2_000).optional(),
  prepareCommand: z.string().trim().max(4_000).nullable().optional()
}).strict().refine((value) => Object.keys(value).length > 0);

const sendError = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).send({ error: { code, message } });

const storeFailure = (reply: FastifyReply, error: unknown) => {
  if (error instanceof Error && error.message === "environment_busy") {
    return sendError(reply, 409, "environment_busy", "Project environment is being updated");
  }
  if (error instanceof Error && error.message.includes("UNIQUE")) {
    return sendError(reply, 409, "already_exists", "Project environment or repository name already exists");
  }
  throw error;
};

/** Registers authenticated project-environment management routes. */
export const registerProjectEnvironmentRoutes = (
  app: FastifyInstance,
  store: ProjectEnvironmentStore,
  scheduler: ProjectEnvironmentCheckScheduler
): void => {
  app.get("/project-environments", () => store.list());

  app.post("/project-environments", (request, reply) => {
    const parsed = environmentSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "invalid_request", "Invalid project environment input");
    try {
      return reply.code(201).send(store.create(parsed.data));
    } catch (error) {
      return storeFailure(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/project-environments/:id", (request, reply) => {
    const environment = store.get(request.params.id);
    return environment ?? sendError(reply, 404, "not_found", "Project environment not found");
  });

  app.patch<{ Params: { id: string } }>("/project-environments/:id", (request, reply) => {
    const parsed = environmentSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "invalid_request", "Invalid project environment update");
    try {
      return store.update(request.params.id, parsed.data)
        ?? sendError(reply, 404, "not_found", "Project environment not found");
    } catch (error) {
      return storeFailure(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/project-environments/:id/repositories", (request, reply) => {
    if (store.get(request.params.id) === undefined) {
      return sendError(reply, 404, "not_found", "Project environment not found");
    }
    const parsed = repositorySchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "invalid_request", "Invalid repository input");
    try {
      const repository = store.addRepository(request.params.id, parsed.data);
      void scheduler.requestCheck(request.params.id).catch(() => undefined);
      return reply.code(201).send(repository);
    } catch (error) {
      return storeFailure(reply, error);
    }
  });

  app.patch<{ Params: { id: string; repositoryId: string } }>(
    "/project-environments/:id/repositories/:repositoryId",
    (request, reply) => {
      const parsed = repositoryUpdateSchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_request", "Invalid repository update");
      try {
        const repository = store.updateRepository(request.params.id, request.params.repositoryId, parsed.data);
        if (repository === undefined) return sendError(reply, 404, "not_found", "Repository not found");
        void scheduler.requestCheck(request.params.id).catch(() => undefined);
        return repository;
      } catch (error) {
        return storeFailure(reply, error);
      }
    }
  );

  app.delete<{ Params: { id: string; repositoryId: string } }>(
    "/project-environments/:id/repositories/:repositoryId",
    (request, reply) => {
      try {
        if (!store.removeRepository(request.params.id, request.params.repositoryId)) {
          return sendError(reply, 404, "not_found", "Repository not found");
        }
        void scheduler.requestCheck(request.params.id).catch(() => undefined);
        return reply.code(204).send();
      } catch (error) {
        return storeFailure(reply, error);
      }
    }
  );

  app.post<{ Params: { id: string } }>("/project-environments/:id/check", (request, reply) => {
    if (store.get(request.params.id) === undefined) {
      return sendError(reply, 404, "not_found", "Project environment not found");
    }
    void scheduler.requestCheck(request.params.id).catch(() => undefined);
    return reply.code(202).send({ accepted: true });
  });
};
