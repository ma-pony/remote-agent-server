import type Database from "better-sqlite3";

import type { Event, Run } from "../domain.js";
import type { RunEventProjection } from "../events/event-store.js";
import type { RunStateProjection } from "../runs/run-repository.js";
import type { IntegrationStore } from "./integration-store.js";
import type { IntegrationTask } from "./integration-types.js";

export type { RunEventProjection, RunStateProjection };

export type IntegrationProjectionDependencies = {
  db: Database.Database;
  store: IntegrationStore;
  listEvents(runId: number): Event[];
  notify?: () => void;
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

const publicToolPayload = (
  content: Record<string, unknown>,
  toolCallId: string,
  status: string
): Record<string, unknown> => {
  const payload: Record<string, unknown> = { toolCallId };
  if (typeof content.kind === "string" && content.kind.trim() !== "") payload.kind = content.kind;
  payload.status = status;
  return payload;
};

const toolTerminalEventType = (status: string): "tool.completed" | "tool.failed" | undefined => {
  if (status === "completed") return "tool.completed";
  if (status === "failed") return "tool.failed";
  return undefined;
};

const PUBLIC_FAILURE_NOTICES = {
  agent_disabled: { code: "agent_disabled", message: "Agent is disabled" },
  mcp_preflight_failed: { code: "mcp_preflight_failed", message: "MCP preflight failed" },
  server_restarted: {
    code: "server_restarted",
    message: "Agent Run was interrupted by a server restart"
  }
} as const;

type PublicFailureNoticeCode = keyof typeof PUBLIC_FAILURE_NOTICES;

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
      occurredAt: run.startedAt!,
      payload: { status: "running", startedAt: run.startedAt }
    });
    return undefined;
  }

  onFinished(run: Run): undefined {
    if (this.dependencies.store.getTaskByRun(run.id) === undefined) return undefined;
    const completionEvents = this.completionEvents(run.id);
    const task = this.dependencies.store.finishTaskInTransaction(run, this.publicFailureNotice(run, completionEvents));
    if (task === undefined) return undefined;
    this.appendFinishedEvents(run, task, completionEvents);
    return undefined;
  }

  private completionEvents(runId: number): Event[] {
    const rows = this.dependencies.db.prepare(`
      SELECT id, run_id, seq, type, content_json, created_at
      FROM events
      WHERE run_id = ? AND type IN ('message', 'status', 'error')
      ORDER BY seq ASC
    `).all(runId) as Array<{
      id: number;
      run_id: number;
      seq: number;
      type: Event["type"];
      content_json: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      seq: row.seq,
      type: row.type,
      contentJson: row.content_json,
      createdAt: row.created_at
    }));
  }

  private appendFinishedEvents(run: Run, task: IntegrationTask, events: Event[]): void {
    this.appendTerminalEvent(run, task);
    this.appendSystemNotice(run, task);
    const output = this.agentOutput(events);
    if (output !== "") this.appendAgentReply(run, task, output);
  }

  private publicFailureNotice(run: Run, events: Event[]): { code: string; message: string; eventSeq: number | null } | undefined {
    if (run.status !== "failed") return undefined;
    const marker = events.flatMap((event) => {
      if (event.type !== "status") return [];
      const content = record(JSON.parse(event.contentJson));
      const code = nonEmptyString(content?.publicNoticeCode);
      return code === undefined ? [] : [code];
    }).at(-1);
    const code = run.error === "agent_disabled"
      ? "agent_disabled"
      : run.error === "server_restarted"
        ? "server_restarted"
        : marker === "mcp_preflight_failed"
          ? "mcp_preflight_failed"
          : undefined;
    if (code === undefined) return undefined;
    const notice = PUBLIC_FAILURE_NOTICES[code as PublicFailureNoticeCode];
    const eventSeq = events.filter((event) => event.type === "error").at(-1)?.seq ?? null;
    return { ...notice, eventSeq };
  }

  private appendSystemNotice(run: Run, task: IntegrationTask): void {
    if (task.publicNoticeCode === null || task.publicNoticeMessage === null) return;
    this.dependencies.store.appendTaskEventInTransaction({
      taskId: task.id,
      eventType: "message.system.notice",
      eventKey: `${task.id}:message.system.notice:${task.publicNoticeCode}`,
      occurredAt: run.finishedAt!,
      payload: { code: task.publicNoticeCode, message: task.publicNoticeMessage }
    });
  }

  private appendTerminalEvent(run: Run, task: IntegrationTask): void {
    this.dependencies.store.appendTaskEventInTransaction({
      taskId: task.id,
      eventType: `task.${run.status}`,
      eventKey: `${task.id}:task.${run.status}`,
      occurredAt: run.finishedAt!,
      payload: {
        status: run.status,
        finishedAt: run.finishedAt
      }
    });
  }

  private agentOutput(events: Event[]): string {
    return events.flatMap((event) => {
      if (event.type !== "message") return [];
      const content = record(JSON.parse(event.contentJson));
      return content?.stream === "output" && typeof content.text === "string" ? [content.text] : [];
    }).join("");
  }

  private appendAgentReply(run: Run, task: IntegrationTask, output: string): void {
    this.dependencies.store.appendTaskEventInTransaction({
      taskId: task.id,
      eventType: "message.agent.reply",
      eventKey: `${task.id}:message.agent.reply`,
      occurredAt: run.finishedAt!,
      payload: { message: output }
    });
  }

  afterCommit(run: Run): undefined {
    const task = this.dependencies.store.getTaskByRun(run.id);
    if (task !== undefined) {
      this.dependencies.store.notifyTaskChanged(task.id);
      this.dependencies.store.notifyDeliveriesChanged();
    }
    if (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") {
      this.notifyScheduler();
    }
    return undefined;
  }

  afterAppendCommit(event: Event): undefined {
    if (event.type === "tool" && this.dependencies.store.getTaskByRun(event.runId) !== undefined) {
      this.dependencies.store.notifyDeliveriesChanged();
    }
    return undefined;
  }

  onAppended(event: Event): undefined {
    this.projectToolEvent(event, false);
    return undefined;
  }

  private projectToolEvent(event: Event, recovering: boolean): void {
    if (event.type !== "tool") return undefined;
    const task = this.dependencies.store.getTaskByRun(event.runId);
    if (task === undefined) return undefined;
    const content = record(JSON.parse(event.contentJson));
    if (content === undefined) return undefined;
    const toolCallId = nonEmptyString(content.toolCallId);
    if (toolCallId === undefined) return undefined;
    this.appendToolEvent(event, task, "tool.started", `${task.id}:tool:${toolCallId}:started`,
      publicToolPayload(content, toolCallId, "started"), recovering);

    const status = nonEmptyString(content.status);
    if (status === undefined) return undefined;
    const terminalEventType = toolTerminalEventType(status);
    if (terminalEventType === undefined) return undefined;
    const terminalPhase = terminalEventType === "tool.completed" ? "completed" : "failed";
    this.appendToolEvent(event, task, terminalEventType, `${task.id}:tool:${toolCallId}:${terminalPhase}`,
      publicToolPayload(content, toolCallId, terminalPhase), recovering);
  }

  private appendToolEvent(
    event: Event,
    task: IntegrationTask,
    eventType: "tool.started" | "tool.completed" | "tool.failed",
    businessEventKey: string,
    payload: Record<string, unknown>,
    recovering: boolean
  ): void {
    if (!recovering) {
      this.dependencies.store.appendTaskEventInTransaction({
        taskId: task.id,
        eventType,
        eventKey: businessEventKey,
        occurredAt: event.createdAt,
        payload
      });
      return;
    }
    if (!this.dependencies.store.needsTaskEventDelivery(task.id, eventType, [businessEventKey])) return;
    this.dependencies.store.appendTaskEventInTransaction({
      taskId: task.id,
      eventType,
      eventKey: businessEventKey,
      occurredAt: event.createdAt,
      payload
    });
  }

  /** Reconciles only Runs whose durable Task state was interrupted by a restart. */
  recover(): void {
    for (const run of this.dependencies.store.listRunsNeedingProjection()) {
      this.dependencies.db.exec("BEGIN IMMEDIATE");
      try {
        if (run.status === "running") this.onStarted(run);
        if (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") {
          this.onFinished(run);
        }
        this.dependencies.db.exec("COMMIT");
      } catch (error) {
        this.dependencies.db.exec("ROLLBACK");
        throw error;
      }
      const task = this.dependencies.store.getTaskByRun(run.id);
      if (task !== undefined) this.dependencies.store.notifyTaskChanged(task.id);
    }
    this.dependencies.store.notifyDeliveriesChanged();
    this.notifyScheduler();
  }

  /** Explicitly repairs deleted deterministic projections; never runs on service startup. */
  repairAll(): void {
    for (const run of this.dependencies.store.listLinkedRuns()) {
      this.dependencies.db.exec("BEGIN IMMEDIATE");
      try {
        const events = this.dependencies.listEvents(run.id);
        const taskBefore = this.dependencies.store.getTaskByRun(run.id);
        if (run.status === "running" && taskBefore?.status === "queued") this.onStarted(run);
        if ((run.status === "succeeded" || run.status === "failed" || run.status === "cancelled")
          && (taskBefore?.status === "queued" || taskBefore?.status === "running")) {
          this.onFinished(run);
        }
        const task = this.dependencies.store.getTaskByRun(run.id);
        if (task !== undefined && (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled")) {
          const taskEventKey = `${task.id}:task.${run.status}`;
          const replyEventKey = `${task.id}:message.agent.reply`;
          if (this.dependencies.store.needsTaskEventDelivery(task.id, `task.${run.status}`, [taskEventKey])) {
            this.appendTerminalEvent(run, task);
          }
          if (task.publicNoticeCode !== null && task.publicNoticeMessage !== null) {
            const noticeEventKey = `${task.id}:message.system.notice:${task.publicNoticeCode}`;
            if (this.dependencies.store.needsTaskEventDelivery(
              task.id,
              "message.system.notice",
              [noticeEventKey]
            )) {
              this.appendSystemNotice(run, task);
            }
          }
          const output = this.agentOutput(events);
          if (output !== ""
            && this.dependencies.store.needsTaskEventDelivery(task.id, "message.agent.reply", [replyEventKey])) {
            this.appendAgentReply(run, task, output);
          }
        }
        for (const event of events) this.projectToolEvent(event, true);
        this.dependencies.db.exec("COMMIT");
      } catch (error) {
        this.dependencies.db.exec("ROLLBACK");
        throw error;
      }
      const task = this.dependencies.store.getTaskByRun(run.id);
      if (task !== undefined) this.dependencies.store.notifyTaskChanged(task.id);
    }
    this.dependencies.store.notifyDeliveriesChanged();
    this.notifyScheduler();
  }
}
