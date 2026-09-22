import { prepareAttachments } from "../attachments/prepare-attachments.js";
import type { HostUsageCollector } from "../agent-usage/host-collector.js";
import { dirname, join } from "node:path";

import { resolveModelPolicy } from "../agents/model-policy.js";
import type { EventType, Run, TokenUsage } from "../domain.js";
import type { EventStore } from "../events/event-store.js";
import type { RunMcpPreparer } from "../mcp/run-mcp-preparer.js";
import type { ProviderExtensionManager } from "../provider-extensions/provider-extension-manager.js";
import type { AgentRuntime, RuntimeEvent, RuntimeTurn, RuntimeTurnResult } from "../runtime/agent-runtime.js";
import { settleBestEffort } from "../runtime/bounded-operation.js";
import type { SkillProjector } from "../runtime/skill-projector.js";
import { SessionManagerError, type SessionManager } from "../sessions/session-manager.js";
import type { ConcurrencySettingsStore } from "../settings/concurrency-settings-store.js";
import { RunRepositoryError, type RunRepository } from "./run-repository.js";

export type RunExecutorDependencies = {
  runtime: AgentRuntime;
  skillProjector: Pick<SkillProjector, "prepare">;
  runRepository: RunRepository;
  eventStore: EventStore;
  sessionManager: SessionManager;
  mcpPreparer: Pick<RunMcpPreparer, "prepare">;
  providerExtensionManager: Pick<ProviderExtensionManager, "revision">;
  runtimeSettings?: Pick<ConcurrencySettingsStore, "getRuntime">;
  runTimeoutMs?: number;
  usageCollector?: HostUsageCollector;
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const MESSAGE_BATCH_INTERVAL_MS = 100;
const MESSAGE_BATCH_MAX_BYTES = 4 * 1024;
const DEFAULT_RUN_TIMEOUT_MS = 60 * 60 * 1000;

class RunTimedOutError extends Error {
  constructor() {
    super("run_timed_out");
  }
}

const persistedEvent = (event: Exclude<RuntimeEvent, { type: "usage" }>): { type: EventType; content: unknown } => {
  switch (event.type) {
    case "message":
      return { type: "message", content: { stream: event.stream, text: event.text } };
    case "tool":
      return { type: "tool", content: event.content };
    case "status":
      return { type: "status", content: { text: event.text } };
    case "error":
      return {
        type: "error",
        content: { ...(event.code === undefined ? {} : { code: event.code }), message: event.message }
      };
  }
};

type TurnRace =
  | { source: "event"; iteration: IteratorResult<RuntimeEvent> }
  | { source: "event_error"; error: unknown }
  | { source: "result"; result: RuntimeTurnResult }
  | { source: "result_error"; error: unknown }
  | { source: "message_flush" }
  | { source: "timeout" };

/**
 * Executes one persisted Run against the provider-neutral Runtime boundary.
 */
export class RunExecutor {
  private readonly runtime: AgentRuntime;
  private readonly skillProjector: Pick<SkillProjector, "prepare">;
  private readonly runRepository: RunRepository;
  private readonly eventStore: EventStore;
  private readonly sessionManager: SessionManager;
  private readonly mcpPreparer: Pick<RunMcpPreparer, "prepare">;
  private readonly providerExtensionManager: Pick<ProviderExtensionManager, "revision">;
  private readonly runtimeSettings: Pick<ConcurrencySettingsStore, "getRuntime"> | undefined;
  private readonly runTimeoutMs: number;
  private readonly usageCollector: HostUsageCollector;
  private readonly cancellationIntents = new Set<number>();

  constructor({
    runtime,
    skillProjector,
    runRepository,
    eventStore,
    sessionManager,
    mcpPreparer,
    providerExtensionManager,
    runtimeSettings,
    runTimeoutMs = DEFAULT_RUN_TIMEOUT_MS,
    usageCollector
  }: RunExecutorDependencies) {
    this.runtime = runtime;
    this.skillProjector = skillProjector;
    this.runRepository = runRepository;
    this.eventStore = eventStore;
    this.sessionManager = sessionManager;
    this.mcpPreparer = mcpPreparer;
    this.providerExtensionManager = providerExtensionManager;
    this.runtimeSettings = runtimeSettings;
    this.runTimeoutMs = runTimeoutMs;
    this.usageCollector = usageCollector ?? sessionManager.usageCollector;
  }

  /**
   * Marks the Run running before projecting files or touching the Runtime.
   */
  async execute(runId: number): Promise<Run> {
    const run = this.runRepository.markRunning(runId);
    let liveTurn: RuntimeTurn | undefined;
    let liveIterator: AsyncIterator<RuntimeEvent> | undefined;
    let publicNoticeCode: "mcp_preflight_failed" | "run_timed_out" | undefined;
    let usage: Partial<TokenUsage> = {};
    let messageBatch: { stream: "output" | "thought"; text: string; bytes: number } | undefined;
    let messageFlushTimer: ReturnType<typeof setTimeout> | undefined;
    let messageFlushSignal: Promise<TurnRace> | undefined;
    let runTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const runAbortController = new AbortController();

    const clearMessageFlushTimer = (): void => {
      if (messageFlushTimer !== undefined) clearTimeout(messageFlushTimer);
      messageFlushTimer = undefined;
      messageFlushSignal = undefined;
    };
    const flushMessageBatch = (): void => {
      const batch = messageBatch;
      if (batch === undefined) return;
      messageBatch = undefined;
      clearMessageFlushTimer();
      const content = { stream: batch.stream, text: batch.text };
      const event = this.eventStore.append(run.id, "message", content);
      try { this.usageCollector.conversationContent.recordMessage(run.id, content, { sequence: event.seq, occurredAt: event.createdAt }); }
      catch { console.error(`runtime_content_persistence_failed runId=${run.id}`); }
    };
    const startMessageFlushTimer = (): void => {
      messageFlushSignal = new Promise<TurnRace>((resolve) => {
        messageFlushTimer = setTimeout(() => resolve({ source: "message_flush" }), MESSAGE_BATCH_INTERVAL_MS);
        messageFlushTimer.unref();
      });
    };
    const bufferMessage = (event: Extract<RuntimeEvent, { type: "message" }>): void => {
      if (messageBatch !== undefined && messageBatch.stream !== event.stream) flushMessageBatch();
      if (messageBatch === undefined) {
        messageBatch = { stream: event.stream, text: event.text, bytes: Buffer.byteLength(event.text) };
        startMessageFlushTimer();
      } else {
        messageBatch.text += event.text;
        messageBatch.bytes += Buffer.byteLength(event.text);
      }
      if (messageBatch.bytes >= MESSAGE_BATCH_MAX_BYTES) flushMessageBatch();
    };

    try {
      const runTimeoutMs = this.runtimeSettings === undefined
        ? this.runTimeoutMs
        : this.runtimeSettings.getRuntime().runTimeoutMinutes * 60 * 1000;
      const timeoutOutcome = new Promise<{ source: "timeout" }>((resolve) => {
        runTimeoutTimer = setTimeout(() => {
          runAbortController.abort();
          resolve({ source: "timeout" });
        }, runTimeoutMs);
        runTimeoutTimer.unref();
      });
      const withinRunTimeout = async <T>(operation: Promise<T>): Promise<T> => {
        const outcome = await Promise.race([
          operation.then((value) => ({ source: "value" as const, value })),
          timeoutOutcome
        ]);
        if (outcome.source === "timeout") {
          publicNoticeCode = "run_timed_out";
          throw new RunTimedOutError();
        }
        return outcome.value;
      };
      const { agent, session } = this.sessionManager.getRuntimeContext(run.sessionId);
      if (session.projectEnvironmentRevisionId !== null) {
        await withinRunTimeout(this.sessionManager.ensureWorkspacePrepared(session.id, runAbortController.signal));
      }
      const browserProfilePath = join(dirname(session.workspacePath), "browser");
      let mcpServers: Awaited<ReturnType<RunMcpPreparer["prepare"]>>;
      try {
        const mcpPreparation = this.mcpPreparer.prepare({
          agentId: agent.id,
          sessionId: session.id,
          runId: run.id,
          workspacePath: session.workspacePath,
          browserProfilePath
        });
        mcpServers = mcpPreparation instanceof Promise
          ? await withinRunTimeout(mcpPreparation)
          : mcpPreparation;
      } catch (error) {
        if (error instanceof RunTimedOutError) throw error;
        publicNoticeCode = "mcp_preflight_failed";
        throw error;
      }
      const { memory, revision: skillsRevision, projectedSkills } = this.skillProjector.prepare(agent, session);
      this.runRepository.setSkillsRevision(run.id, skillsRevision);
      try {
        this.usageCollector.runtimeCapabilities.recordRun(run.id);
      } catch {
        console.error(`runtime_capability_run_failed runId=${run.id}`);
      }
      if (projectedSkills !== undefined) {
        try {
          this.usageCollector.runtimeCapabilities.recordProjection(run.id, projectedSkills);
        } catch {
          // Observability failure must not change the model's business result or expose payloads.
          console.error(`runtime_capability_projection_failed runId=${run.id}`);
        }
      }
      const extensionsRevision = this.providerExtensionManager.revision(agent.id);
      const resolvedModel = resolveModelPolicy(agent.modelPolicy, new Date()) ?? agent.providerDefaultModel ?? undefined;
      this.runRepository.setResolvedModel(run.id, resolvedModel ?? null);
      try { this.usageCollector.conversationContent.recordRun(run.id); }
      catch { console.error(`runtime_content_persistence_failed runId=${run.id}`); }
      const runtimeSessionPromise = this.runtime.ensureSession({
        sessionId: session.id,
        agentId: agent.id,
        provider: agent.provider,
        workspacePath: session.workspacePath,
        browserProfilePath,
        providerSessionId: session.providerSessionId,
        instructions: session.instructionsSnapshot,
        memory,
        skillsRevision,
        extensionsRevision,
        mcpServers,
        ...(resolvedModel === undefined ? {} : { model: resolvedModel })
      });
      let runtimeSession;
      try {
        runtimeSession = await withinRunTimeout(runtimeSessionPromise);
      } catch (error) {
        if (error instanceof RunTimedOutError) {
          void runtimeSessionPromise.then(
            () => this.releaseSessionBestEffort(session.id),
            () => undefined
          );
        }
        throw error;
      }
      this.sessionManager.saveProviderSessionId(session.id, runtimeSession.providerSessionId);

      if (this.cancellationIntents.has(run.id)) {
        return this.finishRun(run.id, { status: "cancelled" }, usage);
      }
      const prompt = await withinRunTimeout(prepareAttachments(this.runRepository.attachments, run.id, session.workspacePath, run.input, runAbortController.signal));
      if (this.cancellationIntents.has(run.id)) return this.finishRun(run.id, { status: "cancelled" }, usage);
      const turn = this.runtime.startTurn({ sessionId: session.id, requestId: run.id, ...prompt });
      liveTurn = turn;
      let output = "";
      const iterator = turn.events[Symbol.asyncIterator]();
      liveIterator = iterator;
      const resultOutcome = turn.result.then<TurnRace, TurnRace>(
        (result) => ({ source: "result", result }),
        (error: unknown) => ({ source: "result_error", error })
      );
      let nextEvent = this.nextEvent(iterator);
      let result: RuntimeTurnResult | undefined;

      while (result === undefined) {
        const outcome = await Promise.race([
          nextEvent,
          resultOutcome,
          timeoutOutcome,
          ...(messageFlushSignal === undefined ? [] : [messageFlushSignal])
        ]);
        if (outcome.source === "timeout") {
          publicNoticeCode = "run_timed_out";
          throw new RunTimedOutError();
        }
        if (outcome.source === "message_flush") {
          flushMessageBatch();
          continue;
        }
        if (outcome.source === "result") {
          flushMessageBatch();
          result = outcome.result;
          const closeOutcome = await settleBestEffort(() => turn.closeEvents());
          const iteratorOutcome = await settleBestEffort(async () => iterator.return?.());
          if (closeOutcome.status !== "fulfilled" || iteratorOutcome.status !== "fulfilled") {
            await this.releaseSessionBestEffort(run.sessionId);
          }
          liveTurn = undefined;
          liveIterator = undefined;
          break;
        }
        if (outcome.source === "result_error") {
          flushMessageBatch();
          throw outcome.error;
        }
        if (outcome.source === "event_error") {
          flushMessageBatch();
          throw outcome.error;
        }
        if (outcome.iteration.done) {
          flushMessageBatch();
          const canonical = await Promise.race([resultOutcome, timeoutOutcome]);
          if (canonical.source === "timeout") {
            publicNoticeCode = "run_timed_out";
            throw new RunTimedOutError();
          }
          if (canonical.source === "result") result = canonical.result;
          else if (canonical.source === "result_error") throw canonical.error;
          else throw new Error("Unexpected turn outcome");
          liveTurn = undefined;
          liveIterator = undefined;
          break;
        }

        const runtimeEvent = outcome.iteration.value;
        if (runtimeEvent.type === "message") {
          if (runtimeEvent.stream === "output") output += runtimeEvent.text;
          bufferMessage(runtimeEvent);
          nextEvent = this.nextEvent(iterator);
          continue;
        }
        flushMessageBatch();
        if (runtimeEvent.type === "usage") {
          usage = { ...usage, ...runtimeEvent.usage };
          try {
            this.usageCollector.recordRunUsage(run.id, usage, runtimeEvent.observation);
          } catch {
            // Observability failure must not change the model's business result or expose payloads.
            console.error(`usage_persistence_failed runId=${run.id}`);
          }
          nextEvent = this.nextEvent(iterator);
          continue;
        }
        const event = persistedEvent(runtimeEvent);
        this.eventStore.append(run.id, event.type, event.content);
        if (runtimeEvent.type === "tool") {
          try {
            this.usageCollector.runtimeCapabilities.recordTool(run.id, runtimeEvent.content);
          } catch {
            // Observability failure must not change the model's business result or expose payloads.
            console.error(`runtime_capability_persistence_failed runId=${run.id}`);
          }
        }
        nextEvent = this.nextEvent(iterator);
      }

      if (result.sessionUsage !== undefined) {
        this.sessionManager.saveTokenUsage(session.id, result.sessionUsage);
      }
      return this.finishFromCanonicalResult(run.id, output, result, usage);
    } catch (error) {
      clearMessageFlushTimer();
      await this.cleanupFailedTurn(liveTurn, liveIterator);
      if (error instanceof RunTimedOutError) await this.releaseSessionBestEffort(run.sessionId);
      const message = errorMessage(error);
      const stableNoticeCode = publicNoticeCode
        ?? (error instanceof SessionManagerError && error.code === "agent_disabled" ? "agent_disabled" : undefined);
      if (stableNoticeCode !== undefined) {
        this.appendBestEffort(run.id, "status", { status: "failed", publicNoticeCode: stableNoticeCode });
      }
      this.appendBestEffort(run.id, "error", { message });
      return this.finishRun(run.id, { status: "failed", error: message }, usage);
    } finally {
      clearMessageFlushTimer();
      if (runTimeoutTimer !== undefined) clearTimeout(runTimeoutTimer);
      this.cancellationIntents.delete(run.id);
      try { await this.usageCollector.collectSession(run.sessionId); }
      catch { console.error(`usage_collection_failed sessionId=${run.sessionId}`); }
    }
  }

  /**
   * Cancels queued Runs locally and delegates running cancellation to the Runtime.
   */
  async cancel(runId: number): Promise<Run> {
    let run = this.requireRun(runId);
    if (run.status === "queued") {
      try {
        return this.runRepository.cancelQueued(run.id);
      } catch (error) {
        if (!(error instanceof RunRepositoryError) || error.code !== "invalid_run_state") throw error;
        run = this.requireRun(runId);
      }
    }
    if (run.status === "running") {
      this.cancellationIntents.add(run.id);
      await this.runtime.cancel(run.sessionId);
    }
    return this.requireRun(runId);
  }

  private finishFromCanonicalResult(
    runId: number,
    output: string,
    result: RuntimeTurnResult,
    usage: Partial<TokenUsage>
  ): Run {
    if (result.status === "completed") {
      return this.finishRun(runId, { status: "succeeded", result: output }, usage);
    }
    if (result.status === "cancelled") {
      return this.finishRun(runId, { status: "cancelled" }, usage);
    }

    this.appendBestEffort(runId, "error", {
      ...(result.code === undefined ? {} : { code: result.code }),
      message: result.message
    });
    return this.finishRun(runId, { status: "failed", error: result.message }, usage);
  }

  private finishRun(
    runId: number,
    result: { status: "succeeded"; result: string } | { status: "failed"; error: string } | { status: "cancelled" },
    usage: Partial<TokenUsage> = {}
  ): Run {
    this.appendBestEffort(runId, "status", { status: result.status });
    return this.runRepository.finish(runId, {
      ...result,
      ...(Object.keys(usage).length === 0 ? {} : { usage })
    });
  }

  private appendBestEffort(runId: number, type: EventType, content: unknown): void {
    try {
      this.eventStore.append(runId, type, content);
    } catch (_error) {
      // Event persistence cannot leave the canonical Run and Session active.
    }
  }

  private nextEvent(iterator: AsyncIterator<RuntimeEvent>): Promise<TurnRace> {
    return Promise.resolve().then(() => iterator.next()).then<TurnRace, TurnRace>(
      (iteration) => ({ source: "event", iteration }),
      (error: unknown) => ({ source: "event_error", error })
    );
  }

  private async cleanupFailedTurn(
    turn: RuntimeTurn | undefined,
    iterator: AsyncIterator<RuntimeEvent> | undefined
  ): Promise<void> {
    if (turn === undefined) return;
    await Promise.all([
      settleBestEffort(() => turn.cancel()),
      settleBestEffort(() => turn.closeEvents())
    ]);
    if (iterator !== undefined) await settleBestEffort(async () => iterator.return?.());
  }

  private async releaseSessionBestEffort(sessionId: number): Promise<void> {
    if (this.runtime.releaseSession === undefined) return;
    await settleBestEffort(() => this.runtime.releaseSession!(sessionId));
  }

  private requireRun(id: number): Run {
    const run = this.runRepository.get(id);
    if (run === undefined) throw new RunRepositoryError("run_not_found");
    return run;
  }
}
