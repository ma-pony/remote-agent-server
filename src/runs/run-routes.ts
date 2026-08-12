import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { Event } from "../domain.js";
import type { EventStore } from "../events/event-store.js";
import type { SessionManager } from "../sessions/session-manager.js";
import type { RunExecutor } from "./run-executor.js";
import { RunRepositoryError, type RunRepository } from "./run-repository.js";
import type { RunScheduler } from "./run-scheduler.js";

const createRunSchema = z.object({ input: z.string().trim().min(1) }).strict();
const eventQuerySchema = z.object({
  afterSeq: z.coerce.number().int().nonnegative().default(0)
});

const sendError = (reply: FastifyReply, statusCode: number, code: string, message: string) =>
  reply.code(statusCode).send({ error: { code, message } });

const handleRunError = (reply: FastifyReply, error: unknown) => {
  if (!(error instanceof RunRepositoryError)) throw error;
  if (error.code === "run_not_found") return sendError(reply, 404, "not_found", "Run not found");
  if (error.code === "session_busy") {
    return sendError(reply, 409, error.code, "Session already has an active Run");
  }
  return sendError(reply, 409, error.code, "Run state changed");
};

const writeSseEvent = (reply: FastifyReply, event: Event): void => {
  reply.raw.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
};

export type RunRouteDependencies = {
  runRepository: RunRepository;
  eventStore: EventStore;
  sessionManager: SessionManager;
  executor: RunExecutor;
  scheduler: RunScheduler;
};

/**
 * Registers authenticated Run lifecycle, history, and SSE routes.
 */
export const registerRunRoutes = (app: FastifyInstance, deps: RunRouteDependencies): void => {
  app.post<{ Params: { id: string } }>("/sessions/:id/runs", (request, reply) => {
    const parsed = createRunSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "invalid_request", "Invalid Run input");
    if (deps.sessionManager.get(request.params.id) === undefined) {
      return sendError(reply, 404, "not_found", "Session not found");
    }

    try {
      const run = deps.runRepository.create({ sessionId: request.params.id, input: parsed.data.input });
      deps.scheduler.enqueue(run.id);
      return reply.code(201).send(run);
    } catch (error) {
      return handleRunError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/runs/:id", (request, reply) => {
    const run = deps.runRepository.get(request.params.id);
    return run === undefined ? sendError(reply, 404, "not_found", "Run not found") : run;
  });

  app.post<{ Params: { id: string } }>("/runs/:id/cancel", async (request, reply) => {
    try {
      return await deps.executor.cancel(request.params.id);
    } catch (error) {
      return handleRunError(reply, error);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { afterSeq?: string } }>("/runs/:id/events", (request, reply) => {
    const parsed = eventQuerySchema.safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "invalid_request", "Invalid Event cursor");
    if (deps.runRepository.get(request.params.id) === undefined) {
      return sendError(reply, 404, "not_found", "Run not found");
    }
    return deps.eventStore.list(request.params.id, parsed.data.afterSeq);
  });

  app.get<{ Params: { id: string }; Querystring: { afterSeq?: string } }>("/runs/:id/events/stream", (request, reply) => {
    const parsed = eventQuerySchema.safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "invalid_request", "Invalid Event cursor");
    if (deps.runRepository.get(request.params.id) === undefined) {
      return sendError(reply, 404, "not_found", "Run not found");
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    reply.raw.flushHeaders();

    let cursor = parsed.data.afterSeq;
    let closed = false;
    let catchingUp = true;
    const buffered: Event[] = [];
    let unsubscribe = (): void => undefined;
    const send = (event: Event): void => {
      if (closed || event.seq <= cursor) return;
      writeSseEvent(reply, event);
      cursor = event.seq;
    };
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      unsubscribe();
    };
    reply.raw.once("close", cleanup);

    for (const event of deps.eventStore.list(request.params.id, cursor)) send(event);
    unsubscribe = deps.eventStore.subscribe(request.params.id, (event) => {
      if (catchingUp) buffered.push(event);
      else send(event);
    });
    if (closed) {
      unsubscribe();
      return reply;
    }

    for (const event of deps.eventStore.list(request.params.id, cursor)) send(event);
    buffered.sort((left, right) => left.seq - right.seq).forEach(send);
    catchingUp = false;
    return reply;
  });
};
