import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { Event } from "../domain.js";
import type { EventStore } from "../events/event-store.js";
import type { SessionManager } from "../sessions/session-manager.js";
import type { RunExecutor } from "./run-executor.js";
import { RunRepositoryError, type RunRepository } from "./run-repository.js";
import type { RunScheduler } from "./run-scheduler.js";

export const SSE_HISTORY_BATCH_SIZE = 100;
export const SSE_LIVE_BUFFER_LIMIT = 256;
export const SSE_DRAIN_TIMEOUT_MS = 1_000;
export const SSE_HEARTBEAT_INTERVAL_MS = 20_000;

export interface SseWriter {
  readonly destroyed?: boolean;
  readonly writableEnded?: boolean;
  write(chunk: string): boolean;
  end(): void;
  on(event: "close", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  once(event: "drain", listener: () => void): this;
  off(event: "close", listener: () => void): this;
  off(event: "error", listener: (error: Error) => void): this;
  off(event: "drain", listener: () => void): this;
}

const createRunSchema = z.object({ input: z.string().trim().min(1) }).strict();
const eventQuerySchema = z.object({
  afterSeq: z.coerce.number().int().nonnegative().default(0)
});

const sendError = (reply: FastifyReply, statusCode: number, code: string, message: string) =>
  reply.code(statusCode).send({ error: { code, message } });

type StreamEvent = Omit<Event, "type"> & { type: string };

const handleRunError = (reply: FastifyReply, error: unknown) => {
  if (!(error instanceof RunRepositoryError)) throw error;
  if (error.code === "run_not_found") return sendError(reply, 404, "not_found", "Run not found");
  if (error.code === "session_busy") {
    return sendError(reply, 409, error.code, "Session already has an active Run");
  }
  return sendError(reply, 409, error.code, "Run state changed");
};

const sseFrame = (event: StreamEvent): string =>
  `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

export type RunEventStreamOptions = {
  heartbeatMs?: number;
  isTerminal?: () => boolean;
  terminalFrame?: () => string | undefined;
  subscribeStateChange?: (listener: () => void) => () => void;
  projectEvent?: (event: Event) => StreamEvent;
};

const endWriter = (writer: SseWriter): void => {
  if (writer.destroyed || writer.writableEnded) return;
  try {
    writer.end();
  } catch (_error) {
    // A broken SSE writer is already unusable.
  }
};

/** Writes one complete SSE frame and applies the same bounded drain policy to every frame type. */
export const writeChunkWithDrain = async (writer: SseWriter, chunk: string): Promise<boolean> => {
  if (writer.destroyed || writer.writableEnded) return false;
  try {
    if (writer.write(chunk)) return true;
  } catch (_error) {
    endWriter(writer);
    return false;
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (written: boolean): void => {
      if (settled) return;
      settled = true;
      writer.off("drain", onDrain);
      writer.off("close", onClose);
      writer.off("error", onError);
      if (timer !== undefined) clearTimeout(timer);
      resolve(written);
    };
    const onDrain = (): void => settle(true);
    const onClose = (): void => settle(false);
    const onError = (_error: Error): void => settle(false);
    writer.once("drain", onDrain);
    writer.on("close", onClose);
    writer.on("error", onError);
    timer = setTimeout(() => {
      endWriter(writer);
      settle(false);
    }, SSE_DRAIN_TIMEOUT_MS);
    timer.unref?.();
    if (writer.destroyed || writer.writableEnded) settle(false);
  });
};

/**
 * Streams bounded history followed by live Events with backpressure and reconnect-safe cursors.
 */
export const streamRunEvents = async (
  eventStore: EventStore,
  runId: string,
  afterSeq: number,
  writer: SseWriter,
  options: RunEventStreamOptions = {}
): Promise<void> => {
  let cursor = afterSeq;
  let closed = false;
  let unsubscribe: (() => void) | undefined;
  let wakeLive: (() => void) | undefined;
  let unsubscribeState: (() => void) | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatPending = false;
  let terminalFrameSent = false;
  const liveBuffer: Event[] = [];

  const finish = (shouldEndWriter: boolean): void => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    unsubscribe = undefined;
    unsubscribeState?.();
    unsubscribeState = undefined;
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
    wakeLive?.();
    if (shouldEndWriter) endWriter(writer);
  };
  const onClose = (): void => finish(false);
  const onError = (_error: Error): void => finish(false);
  writer.on("close", onClose);
  writer.on("error", onError);

  if (options.heartbeatMs !== undefined) {
    heartbeatTimer = setInterval(() => {
      heartbeatPending = true;
      wakeLive?.();
    }, options.heartbeatMs);
    heartbeatTimer.unref?.();
  }

  const write = async (event: Event): Promise<void> => {
    if (closed || event.seq <= cursor) return;
    const publicEvent = options.projectEvent?.(event) ?? event;
    const written = await writeChunkWithDrain(writer, sseFrame(publicEvent));
    if (!written) {
      finish(true);
      return;
    }
    cursor = event.seq;
  };

  const replayThrough = async (throughSeq: number): Promise<void> => {
    while (!closed && cursor < throughSeq) {
      const batch = eventStore.listBatch(runId, cursor, throughSeq, SSE_HISTORY_BATCH_SIZE);
      if (batch.length === 0) return;
      for (const event of batch) {
        await write(event);
        if (closed) return;
      }
    }
  };

  try {
    await replayThrough(eventStore.latestSeq(runId));
    if (closed) return;

    unsubscribe = eventStore.subscribe(runId, (event) => {
      if (closed || event.seq <= cursor) return;
      if (liveBuffer.length >= SSE_LIVE_BUFFER_LIMIT) {
        finish(true);
        return;
      }
      liveBuffer.push(event);
      wakeLive?.();
    });
    unsubscribeState = options.subscribeStateChange?.(() => wakeLive?.());
    if (closed) {
      unsubscribe();
      unsubscribe = undefined;
      return;
    }

    await replayThrough(eventStore.latestSeq(runId));
    while (!closed) {
      liveBuffer.sort((left, right) => left.seq - right.seq);
      const event = liveBuffer.shift();
      if (event !== undefined) {
        await write(event);
        continue;
      }
      if (options.isTerminal?.() === true) {
        if (!terminalFrameSent) {
          terminalFrameSent = true;
          const frame = options.terminalFrame?.();
          if (frame !== undefined && !await writeChunkWithDrain(writer, frame)) {
            finish(true);
            continue;
          }
        }
        finish(true);
        continue;
      }
      if (heartbeatPending) {
        heartbeatPending = false;
        if (!await writeChunkWithDrain(writer, ": heartbeat\n\n")) finish(true);
        continue;
      }
      await new Promise<void>((resolve) => {
        wakeLive = () => {
          wakeLive = undefined;
          resolve();
        };
        if (closed || liveBuffer.length > 0) wakeLive();
      });
    }
  } catch (_error) {
    finish(true);
  } finally {
    unsubscribe?.();
    unsubscribe = undefined;
    unsubscribeState?.();
    unsubscribeState = undefined;
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
    writer.off("close", onClose);
    writer.off("error", onError);
  }
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

    void streamRunEvents(deps.eventStore, request.params.id, parsed.data.afterSeq, reply.raw);
    return reply;
  });
};
