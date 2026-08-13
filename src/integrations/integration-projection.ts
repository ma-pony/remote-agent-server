import type Database from "better-sqlite3";

import type { Event, Run } from "../domain.js";
import type { RunEventProjection } from "../events/event-store.js";
import type { RunStateProjection } from "../runs/run-repository.js";
import type { IntegrationStore } from "./integration-store.js";

export type { RunEventProjection, RunStateProjection };

export type IntegrationProjectionDependencies = {
  db: Database.Database;
  store: IntegrationStore;
  listEvents(runId: string): Event[];
  notify?: () => void;
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

const publicToolLocations = (value: unknown): Array<{ path: string; line?: number | null }> | undefined => {
  if (!Array.isArray(value)) return undefined;
  const locations = value.flatMap((item) => {
    const location = record(item);
    const path = nonEmptyString(location?.path);
    if (path === undefined) return [];
    const line = location?.line;
    return [line === null || typeof line === "number" ? { path, line } : { path }];
  });
  return locations.length === 0 ? undefined : locations;
};

const publicToolPayload = (
  content: Record<string, unknown>,
  toolCallId: string,
  status: string
): Record<string, unknown> => {
  const payload: Record<string, unknown> = { toolCallId };
  const title = nonEmptyString(content.title);
  const kind = nonEmptyString(content.kind);
  const locations = publicToolLocations(content.locations);
  if (title !== undefined) payload.title = title;
  if (kind !== undefined) payload.kind = kind;
  payload.status = status;
  if (locations !== undefined) payload.locations = locations;
  return payload;
};

const toolTerminalEventType = (status: string): "tool.completed" | "tool.failed" | undefined => {
  if (status === "completed") return "tool.completed";
  if (status === "failed") return "tool.failed";
  return undefined;
};

/** Projects generic Run state and Events into external Integration Task state. */
export class IntegrationProjection implements RunStateProjection, RunEventProjection {
  private notifyScheduler: () => void;

  constructor(private readonly dependencies: IntegrationProjectionDependencies) {
    this.notifyScheduler = dependencies.notify ?? (() => undefined);
  }

  setNotify(notify: () => void): void {
    this.notifyScheduler = notify;
  }

  onStarted(run: Run): undefined {
    const task = this.dependencies.store.markTaskRunningInTransaction(run.id, run.startedAt!);
    if (task === undefined) return undefined;
    this.dependencies.store.appendTaskEventInTransaction({
      taskId: task.id,
      eventType: "task.started",
      eventKey: `${task.id}:task.started`,
      payload: { status: "running", startedAt: run.startedAt }
    });
    return undefined;
  }

  onFinished(run: Run): undefined {
    const task = this.dependencies.store.finishTaskInTransaction(run);
    if (task === undefined) return undefined;
    this.dependencies.store.appendTaskEventInTransaction({
      taskId: task.id,
      eventType: `task.${run.status}`,
      eventKey: `${task.id}:task.${run.status}`,
      payload: {
        status: run.status,
        result: run.result,
        error: run.error,
        finishedAt: run.finishedAt
      }
    });

    const output = this.dependencies.listEvents(run.id).flatMap((event) => {
      if (event.type !== "message") return [];
      const content = record(JSON.parse(event.contentJson));
      return content?.stream === "output" && typeof content.text === "string" ? [content.text] : [];
    }).join("");
    if (output !== "") {
      this.dependencies.store.appendTaskEventInTransaction({
        taskId: task.id,
        eventType: "message.agent.reply",
        eventKey: `${task.id}:message.agent.reply`,
        payload: { message: output }
      });
    }

    return undefined;
  }

  afterCommit(run: Run): undefined {
    const task = this.dependencies.store.getTaskByRun(run.id);
    if (task !== undefined) this.dependencies.store.notifyTaskChanged(task.id);
    if (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") {
      this.notifyScheduler();
    }
    return undefined;
  }

  onAppended(event: Event): undefined {
    if (event.type !== "tool") return undefined;
    const task = this.dependencies.store.getTaskByRun(event.runId);
    if (task === undefined) return undefined;
    const content = record(JSON.parse(event.contentJson));
    if (content === undefined) return undefined;
    const toolCallId = nonEmptyString(content.toolCallId);
    if (toolCallId === undefined) return undefined;
    const priorToolContents = this.dependencies.listEvents(event.runId).flatMap((candidate) => {
      if (candidate.type !== "tool" || candidate.seq >= event.seq) return [];
      const prior = record(JSON.parse(candidate.contentJson));
      return nonEmptyString(prior?.toolCallId) === toolCallId && prior !== undefined ? [prior] : [];
    });

    if (priorToolContents.length === 0) {
      this.dependencies.store.appendTaskEventInTransaction({
        taskId: task.id,
        eventType: "tool.started",
        eventKey: `${task.id}:tool:${toolCallId}:started`,
        payload: publicToolPayload(content, toolCallId, "started")
      });
    }

    const status = nonEmptyString(content.status);
    if (status === undefined) return undefined;
    const terminalEventType = toolTerminalEventType(status);
    if (terminalEventType === undefined) return undefined;
    const terminalPhase = terminalEventType === "tool.completed" ? "completed" : "failed";
    const terminalAlreadyProjected = priorToolContents.some((prior) =>
      toolTerminalEventType(nonEmptyString(prior.status) ?? "") === terminalEventType
    );
    if (terminalAlreadyProjected) return undefined;
    this.dependencies.store.appendTaskEventInTransaction({
      taskId: task.id,
      eventType: terminalEventType,
      eventKey: `${task.id}:tool:${toolCallId}:${terminalPhase}`,
      payload: publicToolPayload(content, toolCallId, terminalPhase)
    });
    return undefined;
  }

  /** Replays only missing linked Task projections after Run restart recovery. */
  recover(): void {
    for (const run of this.dependencies.store.listRunsNeedingProjection()) {
      this.dependencies.db.exec("BEGIN IMMEDIATE");
      try {
        if (run.status === "running") this.onStarted(run);
        else this.onFinished(run);
        this.dependencies.db.exec("COMMIT");
      } catch (error) {
        this.dependencies.db.exec("ROLLBACK");
        throw error;
      }
      this.afterCommit(run);
    }
  }
}
