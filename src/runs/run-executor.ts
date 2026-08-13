import { dirname, join } from "node:path";

import type { EventType, Run } from "../domain.js";
import type { EventStore } from "../events/event-store.js";
import type { RunMcpPreparer } from "../mcp/run-mcp-preparer.js";
import type { AgentRuntime, RuntimeEvent, RuntimeTurn, RuntimeTurnResult } from "../runtime/agent-runtime.js";
import { settleBestEffort } from "../runtime/bounded-operation.js";
import type { SkillProjector } from "../runtime/skill-projector.js";
import type { SessionManager } from "../sessions/session-manager.js";
import { RunRepositoryError, type RunRepository } from "./run-repository.js";

export type RunExecutorDependencies = {
  runtime: AgentRuntime;
  skillProjector: Pick<SkillProjector, "prepare">;
  runRepository: RunRepository;
  eventStore: EventStore;
  sessionManager: SessionManager;
  mcpPreparer: Pick<RunMcpPreparer, "prepare">;
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const persistedEvent = (event: RuntimeEvent): { type: EventType; content: unknown } => {
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
  | { source: "result_error"; error: unknown };

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
  private readonly cancellationIntents = new Set<string>();

  constructor({ runtime, skillProjector, runRepository, eventStore, sessionManager, mcpPreparer }: RunExecutorDependencies) {
    this.runtime = runtime;
    this.skillProjector = skillProjector;
    this.runRepository = runRepository;
    this.eventStore = eventStore;
    this.sessionManager = sessionManager;
    this.mcpPreparer = mcpPreparer;
  }

  /**
   * Marks the Run running before projecting files or touching the Runtime.
   */
  async execute(runId: string): Promise<Run> {
    const run = this.runRepository.markRunning(runId);
    let liveTurn: RuntimeTurn | undefined;
    let liveIterator: AsyncIterator<RuntimeEvent> | undefined;

    try {
      const { agent, session } = this.sessionManager.getRuntimeContext(run.sessionId);
      const browserProfilePath = join(dirname(session.workspacePath), "browser");
      const mcpPreparation = this.mcpPreparer.prepare({
        agentId: agent.id,
        sessionId: session.id,
        runId: run.id,
        workspacePath: session.workspacePath,
        browserProfilePath
      });
      const mcpServers = mcpPreparation instanceof Promise ? await mcpPreparation : mcpPreparation;
      const memory = this.skillProjector.prepare(agent, session);
      const runtimeSession = await this.runtime.ensureSession({
        sessionId: session.id,
        agentId: agent.id,
        provider: agent.provider,
        workspacePath: session.workspacePath,
        browserProfilePath,
        providerSessionId: session.providerSessionId,
        memory,
        mcpServers
      });
      this.sessionManager.saveProviderSessionId(session.id, runtimeSession.providerSessionId);

      if (this.cancellationIntents.has(run.id)) {
        return this.finishRun(run.id, { status: "cancelled" });
      }
      const turn = this.runtime.startTurn({ sessionId: session.id, requestId: run.id, text: run.input });
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
        const outcome = await Promise.race([nextEvent, resultOutcome]);
        if (outcome.source === "result") {
          result = outcome.result;
          await settleBestEffort(() => turn.closeEvents());
          await settleBestEffort(async () => iterator.return?.());
          liveTurn = undefined;
          liveIterator = undefined;
          break;
        }
        if (outcome.source === "result_error") {
          throw outcome.error;
        }
        if (outcome.source === "event_error") {
          throw outcome.error;
        }
        if (outcome.iteration.done) {
          const canonical = await resultOutcome;
          if (canonical.source === "result") result = canonical.result;
          else if (canonical.source === "result_error") throw canonical.error;
          else throw new Error("Unexpected turn outcome");
          liveTurn = undefined;
          liveIterator = undefined;
          break;
        }

        const runtimeEvent = outcome.iteration.value;
        if (runtimeEvent.type === "message" && runtimeEvent.stream === "output") output += runtimeEvent.text;
        const event = persistedEvent(runtimeEvent);
        this.eventStore.append(run.id, event.type, event.content);
        nextEvent = this.nextEvent(iterator);
      }

      return this.finishFromCanonicalResult(run.id, output, result);
    } catch (error) {
      await this.cleanupFailedTurn(liveTurn, liveIterator);
      const message = errorMessage(error);
      this.appendBestEffort(run.id, "error", { message });
      return this.finishRun(run.id, { status: "failed", error: message });
    } finally {
      this.cancellationIntents.delete(run.id);
    }
  }

  /**
   * Cancels queued Runs locally and delegates running cancellation to the Runtime.
   */
  async cancel(runId: string): Promise<Run> {
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

  private finishFromCanonicalResult(runId: string, output: string, result: RuntimeTurnResult): Run {
    if (result.status === "completed") {
      return this.finishRun(runId, { status: "succeeded", result: output });
    }
    if (result.status === "cancelled") {
      return this.finishRun(runId, { status: "cancelled" });
    }

    this.appendBestEffort(runId, "error", {
      ...(result.code === undefined ? {} : { code: result.code }),
      message: result.message
    });
    return this.finishRun(runId, { status: "failed", error: result.message });
  }

  private finishRun(
    runId: string,
    result: { status: "succeeded"; result: string } | { status: "failed"; error: string } | { status: "cancelled" }
  ): Run {
    this.appendBestEffort(runId, "status", { status: result.status });
    return this.runRepository.finish(runId, result);
  }

  private appendBestEffort(runId: string, type: EventType, content: unknown): void {
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

  private requireRun(id: string): Run {
    const run = this.runRepository.get(id);
    if (run === undefined) throw new RunRepositoryError("run_not_found");
    return run;
  }
}
