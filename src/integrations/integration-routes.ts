import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { Event } from "../domain.js";
import type { EventStore } from "../events/event-store.js";
import { McpManagerError } from "../mcp/mcp-manager.js";
import type { RunExecutor } from "../runs/run-executor.js";
import {
  SSE_HEARTBEAT_INTERVAL_MS,
  streamRunEvents,
  type SseWriter,
  writeChunkWithDrain
} from "../runs/run-routes.js";
import { SessionManagerError } from "../sessions/session-manager.js";
import { WorkspaceCreateError } from "../workspaces/workspace-manager.js";
import { requireIntegrationEndpoint } from "./integration-auth.js";
import { IntegrationCoordinator, IntegrationCoordinatorError } from "./integration-coordinator.js";
import { IntegrationEndpointManager, IntegrationEndpointManagerError } from "./integration-endpoint-manager.js";
import type { IntegrationTaskScheduler } from "./integration-scheduler.js";
import type { IntegrationStore } from "./integration-store.js";
import type { IntegrationTask } from "./integration-types.js";

const submitTaskSchema = z.object({
  requestId: z.string().refine((value) => value.trim() !== ""),
  conversationKey: z.string().refine((value) => value.trim() !== "").optional(),
  message: z.string().refine((value) => value.trim() !== ""),
  parameters: z.record(z.string(), z.string()).default({})
}).strict();
const eventQuerySchema = z.object({
  afterSeq: z.coerce.number().int().nonnegative().default(0)
});

const sendError = (reply: FastifyReply, statusCode: number, code: string, message: string) =>
  reply.code(statusCode).send({ error: { code, message } });

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

const isTerminalTask = (task: IntegrationTask | undefined): boolean =>
  task?.status === "succeeded" || task?.status === "failed" || task?.status === "cancelled";

const terminalTaskFrame = (task: IntegrationTask): string =>
  `event: task.status\ndata: ${JSON.stringify({ status: task.status })}\n\n`;

const closeWriter = (writer: SseWriter): void => {
  if (writer.destroyed || writer.writableEnded) return;
  try {
    writer.end();
  } catch (_error) {
    // A broken external SSE connection has no effect on its Task.
  }
};

export const listIntegrationTaskEvents = (
  store: IntegrationStore,
  eventStore: EventStore,
  taskId: string,
  endpointId: string,
  afterSeq: number
): Event[] => {
  const task = store.getTaskForEndpoint(taskId, endpointId);
  return task?.runId === null || task === undefined ? [] : eventStore.list(task.runId, afterSeq);
};

const waitForLinkedRun = async (
  store: IntegrationStore,
  taskId: string,
  endpointId: string,
  writer: SseWriter
): Promise<IntegrationTask | undefined> => {
  let closed = false;
  let heartbeatPending = false;
  let wake: (() => void) | undefined;
  const signal = (): void => wake?.();
  const onClose = (): void => {
    closed = true;
    signal();
  };
  const onError = (_error: Error): void => onClose();
  const unsubscribe = store.subscribeTask(taskId, signal);
  const heartbeatTimer = setInterval(() => {
    heartbeatPending = true;
    signal();
  }, SSE_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();
  writer.on("close", onClose);
  writer.on("error", onError);

  try {
    while (!closed) {
      const task = store.getTaskForEndpoint(taskId, endpointId);
      if (task === undefined || task.runId !== null || isTerminalTask(task)) return task;
      if (heartbeatPending) {
        heartbeatPending = false;
        if (!await writeChunkWithDrain(writer, ": heartbeat\n\n")) return undefined;
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = () => {
          wake = undefined;
          resolve();
        };
        if (closed || heartbeatPending) wake();
      });
    }
    return undefined;
  } finally {
    clearInterval(heartbeatTimer);
    unsubscribe();
    writer.off("close", onClose);
    writer.off("error", onError);
  }
};

/** Waits for Task-to-Run linkage, then reuses the canonical Run Event stream. */
export const streamIntegrationTaskEvents = async (input: {
  store: IntegrationStore;
  eventStore: EventStore;
  taskId: string;
  endpointId: string;
  afterSeq: number;
  writer: SseWriter;
}): Promise<void> => {
  const task = await waitForLinkedRun(input.store, input.taskId, input.endpointId, input.writer);
  if (task === undefined) return;
  if (task.runId === null) {
    if (isTerminalTask(task)) await writeChunkWithDrain(input.writer, terminalTaskFrame(task));
    closeWriter(input.writer);
    return;
  }
  const currentTask = (): IntegrationTask | undefined =>
    input.store.getTaskForEndpoint(input.taskId, input.endpointId);
  await streamRunEvents(input.eventStore, task.runId, input.afterSeq, input.writer, {
    heartbeatMs: SSE_HEARTBEAT_INTERVAL_MS,
    isTerminal: () => isTerminalTask(currentTask()),
    terminalFrame: () => {
      const current = currentTask();
      return current !== undefined && isTerminalTask(current) ? terminalTaskFrame(current) : undefined;
    },
    subscribeStateChange: (listener) => input.store.subscribeTask(input.taskId, listener)
  });
};

export type IntegrationRouteDependencies = {
  manager: IntegrationEndpointManager;
  coordinator: IntegrationCoordinator;
  store: IntegrationStore;
  eventStore: EventStore;
  executor: Pick<RunExecutor, "cancel">;
  scheduler: Pick<IntegrationTaskScheduler, "notify">;
};

/** Registers the authenticated external Integration API. */
export const registerIntegrationRoutes = (
  app: FastifyInstance,
  { manager, coordinator, store, eventStore, executor, scheduler }: IntegrationRouteDependencies
): void => {
  app.decorateRequest("integrationEndpoint", null);

  app.post<{ Params: { slug: string } }>("/integration/v1/endpoints/:slug/tasks", {
    onRequest: requireIntegrationEndpoint(manager)
  }, async (request, reply) => {
    const parsed = submitTaskSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "invalid_request", "Invalid Integration Task input");
    try {
      const task = await coordinator.submit(request.integrationEndpoint!, parsed.data);
      return reply.code(202).send(coordinator.toExternalTask(task));
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
    const token = bearerToken(request.headers.authorization);
    const endpoint = token === undefined ? undefined : manager.authenticateToken(token);
    if (endpoint === undefined) {
      return sendError(reply, 401, "invalid_endpoint_token", "Invalid integration endpoint token");
    }
    const task = coordinator.getTaskForEndpoint(request.params.taskId, endpoint.id);
    return task === undefined
      ? sendError(reply, 404, "task_not_found", "Integration Task not found")
      : coordinator.toExternalTask(task);
  });

  app.get<{ Params: { taskId: string }; Querystring: { afterSeq?: string } }>(
    "/integration/v1/tasks/:taskId/events",
    (request, reply) => {
      const token = bearerToken(request.headers.authorization);
      const endpoint = token === undefined ? undefined : manager.authenticateToken(token);
      if (endpoint === undefined) {
        return sendError(reply, 401, "invalid_endpoint_token", "Invalid integration endpoint token");
      }
      const task = store.getTaskForEndpoint(request.params.taskId, endpoint.id);
      if (task === undefined) return sendError(reply, 404, "task_not_found", "Integration Task not found");
      const parsed = eventQuerySchema.safeParse(request.query);
      if (!parsed.success) return sendError(reply, 400, "invalid_request", "Invalid Event cursor");
      return task.runId === null ? [] : eventStore.list(task.runId, parsed.data.afterSeq);
    }
  );

  app.get<{ Params: { taskId: string }; Querystring: { afterSeq?: string } }>(
    "/integration/v1/tasks/:taskId/events/stream",
    (request, reply) => {
      const token = bearerToken(request.headers.authorization);
      const endpoint = token === undefined ? undefined : manager.authenticateToken(token);
      if (endpoint === undefined) {
        return sendError(reply, 401, "invalid_endpoint_token", "Invalid integration endpoint token");
      }
      if (store.getTaskForEndpoint(request.params.taskId, endpoint.id) === undefined) {
        return sendError(reply, 404, "task_not_found", "Integration Task not found");
      }
      const parsed = eventQuerySchema.safeParse(request.query);
      if (!parsed.success) return sendError(reply, 400, "invalid_request", "Invalid Event cursor");

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      reply.raw.flushHeaders();
      void streamIntegrationTaskEvents({
        store,
        eventStore,
        taskId: request.params.taskId,
        endpointId: endpoint.id,
        afterSeq: parsed.data.afterSeq,
        writer: reply.raw
      });
      return reply;
    }
  );

  app.post<{ Params: { taskId: string } }>("/integration/v1/tasks/:taskId/cancel", async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    const endpoint = token === undefined ? undefined : manager.authenticateToken(token);
    if (endpoint === undefined) {
      return sendError(reply, 401, "invalid_endpoint_token", "Invalid integration endpoint token");
    }
    let task = store.getTaskForEndpoint(request.params.taskId, endpoint.id);
    if (task === undefined) return sendError(reply, 404, "task_not_found", "Integration Task not found");
    if (isTerminalTask(task)) return coordinator.toExternalTask(task);

    if (task.status === "queued" && task.runId === null) {
      const cancelled = store.cancelUnlinkedQueuedTask(task.id, endpoint.id);
      if (cancelled !== undefined) {
        scheduler.notify();
        return coordinator.toExternalTask(cancelled);
      }
      task = store.getTaskForEndpoint(task.id, endpoint.id);
      if (task === undefined) return sendError(reply, 404, "task_not_found", "Integration Task not found");
      if (isTerminalTask(task)) return coordinator.toExternalTask(task);
    }

    if (task.runId === null) return sendError(reply, 409, "task_cancel_failed", "Integration Task cannot be cancelled");
    try {
      await executor.cancel(task.runId);
    } catch (_error) {
      const current = store.getTaskForEndpoint(task.id, endpoint.id);
      if (isTerminalTask(current)) return coordinator.toExternalTask(current!);
      return sendError(reply, 409, "task_cancel_failed", "Integration Task cannot be cancelled");
    }
    return coordinator.toExternalTask(store.getTaskForEndpoint(task.id, endpoint.id)!);
  });

  app.all<{ Params: { slug: string } }>("/integration/v1/endpoints/:slug/*", {
    onRequest: requireIntegrationEndpoint(manager)
  }, (_request, reply) => reply.code(404).send({
    error: { code: "not_found", message: "Integration route not found" }
  }));
};
