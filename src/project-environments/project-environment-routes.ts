import { isPagedQuery, paginationQuerySchema } from "../pagination.js";
import { join } from "node:path";

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { ProjectEnvironmentDetail } from "../domain.js";
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
const parseId = (value: string): number | undefined => {
  const parsed = z.coerce.number().int().positive().safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

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
  const presentEnvironment = (environment: ProjectEnvironmentDetail) => {
    const workspacePath = environment.currentRevision?.workspacePath ?? null;
    return {
      ...environment,
      workspacePath,
      sync: scheduler.getState(environment.id),
      repositories: environment.repositories.map((repository) => ({
        ...repository,
        workspacePath: workspacePath === null ? null : join(workspacePath, repository.name)
      }))
    };
  };

  const presentSummary = (environment: NonNullable<ReturnType<ProjectEnvironmentStore["getSummary"]>>) => ({
    ...environment, workspacePath: environment.currentRevision?.workspacePath ?? null, sync: scheduler.getState(environment.id)
  });
  app.get("/project-environments", (request, reply) => {
    const parsed = paginationQuerySchema.extend({ ready: z.enum(["true", "false"]).optional().transform((value) => value === "true") }).safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "invalid_request", "Invalid pagination");
    if (!isPagedQuery(request.query)) return store.list().map(presentEnvironment);
    const page = store.listPage(parsed.data);
    return { ...page, items: page.items.map(presentSummary) };
  });
  app.get<{ Params: { id: string } }>("/project-environments/:id/summary", (request, reply) => {
    const id = parseId(request.params.id);
    const environment = id === undefined ? undefined : store.getSummary(id);
    return environment === undefined ? sendError(reply, 404, "not_found", "Project environment not found") : presentSummary(environment);
  });
  for (const resource of ["repositories", "revisions"] as const) {
    app.get<{ Params: { id: string } }>(`/project-environments/:id/${resource}`, (request, reply) => {
      const pagination = paginationQuerySchema.safeParse(request.query);
      if (!pagination.success) return sendError(reply, 400, "invalid_request", "Invalid pagination");
      const id = parseId(request.params.id);
      const environment = id === undefined ? undefined : store.getSummary(id);
      if (environment === undefined) return sendError(reply, 404, "not_found", "Project environment not found");
      if (resource === "revisions") return store.listRevisionsPage(environment.id, pagination.data);
      const page = store.listRepositoriesPage(environment.id, pagination.data);
      const workspacePath = environment.currentRevision?.workspacePath ?? null;
      return { ...page, items: page.items.map((repository) => ({ ...repository, workspacePath: workspacePath === null ? null : join(workspacePath, repository.name) })) };
    });
  }

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
    const id = parseId(request.params.id);
    const environment = id === undefined ? undefined : store.get(id);
    return environment === undefined
      ? sendError(reply, 404, "not_found", "Project environment not found")
      : presentEnvironment(environment);
  });

  app.patch<{ Params: { id: string } }>("/project-environments/:id", (request, reply) => {
    const parsed = environmentSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "invalid_request", "Invalid project environment update");
    try {
      const id = parseId(request.params.id);
      if (id === undefined) return sendError(reply, 404, "not_found", "Project environment not found");
      return store.update(id, parsed.data)
        ?? sendError(reply, 404, "not_found", "Project environment not found");
    } catch (error) {
      return storeFailure(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/project-environments/:id/repositories", (request, reply) => {
    const id = parseId(request.params.id);
    if (id === undefined || store.get(id) === undefined) {
      return sendError(reply, 404, "not_found", "Project environment not found");
    }
    const parsed = repositorySchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "invalid_request", "Invalid repository input");
    try {
      const repository = store.addRepository(id, parsed.data);
      void scheduler.requestCheck(id).catch(() => undefined);
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
        const id = parseId(request.params.id);
        const repositoryId = parseId(request.params.repositoryId);
        if (id === undefined || repositoryId === undefined) return sendError(reply, 404, "not_found", "Repository not found");
        const repository = store.updateRepository(id, repositoryId, parsed.data);
        if (repository === undefined) return sendError(reply, 404, "not_found", "Repository not found");
        void scheduler.requestCheck(id).catch(() => undefined);
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
        const id = parseId(request.params.id);
        const repositoryId = parseId(request.params.repositoryId);
        if (id === undefined || repositoryId === undefined || !store.removeRepository(id, repositoryId)) {
          return sendError(reply, 404, "not_found", "Repository not found");
        }
        void scheduler.requestCheck(id).catch(() => undefined);
        return reply.code(204).send();
      } catch (error) {
        return storeFailure(reply, error);
      }
    }
  );

  app.post<{ Params: { id: string } }>("/project-environments/:id/sync", (request, reply) => {
    const id = parseId(request.params.id);
    if (id === undefined || store.get(id) === undefined) {
      return sendError(reply, 404, "not_found", "Project environment not found");
    }
    void scheduler.requestCheck(id).catch(() => undefined);
    return reply.code(202).send({ accepted: true });
  });
};
