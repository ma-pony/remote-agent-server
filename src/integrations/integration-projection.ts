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

const toolEventType = (status: string): "tool.started" | "tool.completed" | "tool.failed" | undefined => {
  if (status === "pending" || status === "in_progress") return "tool.started";
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

  onStarted(run: Run): void {
    const task = this.dependencies.store.markTaskRunningInTransaction(run.id, run.startedAt!);
    if (task === undefined) return;
    this.dependencies.store.appendTaskEventInTransaction({
      taskId: task.id,
      eventType: "task.started",
      eventKey: `${task.id}:task.started`,
      payload: { status: "running", startedAt: run.startedAt }
    });
  }

  onFinished(run: Run): void {
    const task = this.dependencies.store.finishTaskInTransaction(run);
    if (task === undefined) return;
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

    queueMicrotask(() => this.notifyScheduler());
  }

  onAppended(event: Event): void {
    if (event.type !== "tool") return;
    const task = this.dependencies.store.getTaskByRun(event.runId);
    if (task === undefined) return;
    const content = record(JSON.parse(event.contentJson));
    if (content === undefined) return;
    const toolCallId = nonEmptyString(content.toolCallId);
    const status = nonEmptyString(content.status);
    if (toolCallId === undefined || status === undefined) return;
    const eventType = toolEventType(status);
    if (eventType === undefined) return;

    this.dependencies.store.appendTaskEventInTransaction({
      taskId: task.id,
      eventType,
      eventKey: `${task.id}:tool:${toolCallId}:${status}`,
      payload: { ...content, toolCallId, status }
    });
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
    }
  }
}
