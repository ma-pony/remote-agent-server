import { dirname, join } from "node:path";

import type { EventType, Run } from "../domain.js";
import type { EventStore } from "../events/event-store.js";
import type { AgentRuntime, RuntimeEvent, RuntimeTurnResult } from "../runtime/agent-runtime.js";
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

  constructor({ runtime, skillProjector, runRepository, eventStore, sessionManager }: RunExecutorDependencies) {
    this.runtime = runtime;
    this.skillProjector = skillProjector;
    this.runRepository = runRepository;
    this.eventStore = eventStore;
    this.sessionManager = sessionManager;
  }

  /**
   * Marks the Run running before projecting files or touching the Runtime.
   */
  async execute(runId: string): Promise<Run> {
    const run = this.runRepository.markRunning(runId);

    try {
      const { agent, session } = this.sessionManager.getRuntimeContext(run.sessionId);
      const memory = this.skillProjector.prepare(agent, session);
      const runtimeSession = await this.runtime.ensureSession({
        sessionId: session.id,
        agentId: agent.id,
        provider: agent.provider,
        workspacePath: session.workspacePath,
        browserProfilePath: join(dirname(session.workspacePath), "browser"),
        providerSessionId: session.providerSessionId,
        memory
      });
      this.sessionManager.saveProviderSessionId(session.id, runtimeSession.providerSessionId);

      const turn = this.runtime.startTurn({ sessionId: session.id, requestId: run.id, text: run.input });
      let output = "";
      const iterator = turn.events[Symbol.asyncIterator]();
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
          break;
        }
        if (outcome.source === "result_error") {
          await settleBestEffort(() => turn.closeEvents());
          await settleBestEffort(async () => iterator.return?.());
          throw outcome.error;
        }
        if (outcome.source === "event_error") {
          await Promise.all([
            settleBestEffort(() => turn.cancel()),
            settleBestEffort(() => turn.closeEvents())
          ]);
          throw outcome.error;
        }
        if (outcome.iteration.done) {
          const canonical = await resultOutcome;
          if (canonical.source === "result") result = canonical.result;
          else if (canonical.source === "result_error") throw canonical.error;
          else throw new Error("Unexpected turn outcome");
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
      const message = errorMessage(error);
      try {
        this.eventStore.append(run.id, "error", { message });
      } catch (_eventError) {
        // A failed event append must not leave the Run and Session active.
      }
      return this.runRepository.finish(run.id, { status: "failed", error: message });
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
    if (run.status === "running") await this.runtime.cancel(run.sessionId);
    return this.requireRun(runId);
  }

  private finishFromCanonicalResult(runId: string, output: string, result: RuntimeTurnResult): Run {
    if (result.status === "completed") {
      this.eventStore.append(runId, "status", { status: "succeeded" });
      return this.runRepository.finish(runId, { status: "succeeded", result: output });
    }
    if (result.status === "cancelled") {
      this.eventStore.append(runId, "status", { status: "cancelled" });
      return this.runRepository.finish(runId, { status: "cancelled" });
    }

    this.eventStore.append(runId, "error", {
      ...(result.code === undefined ? {} : { code: result.code }),
      message: result.message
    });
    this.eventStore.append(runId, "status", { status: "failed" });
    return this.runRepository.finish(runId, { status: "failed", error: result.message });
  }

  private nextEvent(iterator: AsyncIterator<RuntimeEvent>): Promise<TurnRace> {
    return Promise.resolve().then(() => iterator.next()).then<TurnRace, TurnRace>(
      (iteration) => ({ source: "event", iteration }),
      (error: unknown) => ({ source: "event_error", error })
    );
  }

  private requireRun(id: string): Run {
    const run = this.runRepository.get(id);
    if (run === undefined) throw new RunRepositoryError("run_not_found");
    return run;
  }
}
