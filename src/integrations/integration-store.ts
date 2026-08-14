import { createHash, randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type { Run, RunStatus } from "../domain.js";
import type {
  IntegrationConversation,
  IntegrationConversationStatus,
  IntegrationEndpoint,
  IntegrationTask,
  IntegrationTaskStatus,
  ParameterMapping,
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookSubscription
} from "./integration-types.js";

type EndpointRow = {
  id: string;
  name: string;
  slug: string;
  agent_id: string;
  enabled: 0 | 1;
  token_hash: string;
  prompt_prefix: string;
  parameter_mappings_json: string;
  encrypted_fixed_values: string | null;
  next_delivery_order: number;
  created_at: string;
  updated_at: string;
};

type ConversationRow = {
  id: string;
  endpoint_id: string;
  conversation_key: string;
  session_id: string;
  status: IntegrationConversationStatus;
  created_at: string;
  ended_at: string | null;
};

type TaskRow = {
  id: string;
  endpoint_id: string;
  conversation_id: string | null;
  session_id: string;
  run_id: string | null;
  request_id: string;
  request_fingerprint: string;
  message: string;
  effective_prompt: string;
  encrypted_parameters: string | null;
  status: IntegrationTaskStatus;
  result: string | null;
  error: string | null;
  event_sequence: number;
  event_sequences_json: string;
  event_dispatch_orders_json: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

type SubscriptionRow = {
  id: string;
  endpoint_id: string;
  name: string;
  url: string;
  enabled: 0 | 1;
  events_json: string;
  encrypted_headers: string | null;
  encrypted_signing_secret: string;
  timeout_seconds: number;
  created_at: string;
  updated_at: string;
};

type DeliveryRow = {
  id: string;
  event_id: string;
  event_key: string;
  sequence: number;
  dispatch_order: number;
  subscription_id: string;
  task_id: string | null;
  event_type: string;
  payload_json: string;
  status: WebhookDeliveryStatus;
  attempt_count: number;
  next_attempt_at: string;
  last_status_code: number | null;
  last_duration_ms: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type LinkedRunRow = {
  id: string;
  session_id: string;
  status: RunStatus;
  input: string;
  result: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type EndpointPersistenceInput = {
  id?: string;
  name: string;
  slug: string;
  agentId: string;
  enabled: boolean;
  tokenHash: string;
  promptPrefix: string;
  parameterMappings: ParameterMapping[];
  encryptedFixedValues: string | null;
};

export type CreateIntegrationConversationInput = {
  id?: string;
  endpointId: string;
  conversationKey: string;
  sessionId: string;
};

export type CreateIntegrationTaskInput = {
  id?: string;
  endpointId: string;
  conversationId: string | null;
  sessionId: string;
  requestId: string;
  requestFingerprint: string;
  message: string;
  effectivePrompt: string;
  encryptedParameters: string | null;
};

export type CreateWebhookSubscriptionInput = {
  id?: string;
  endpointId: string;
  name: string;
  url: string;
  enabled: boolean;
  eventsJson: string;
  encryptedHeaders: string | null;
  encryptedSigningSecret: string;
  timeoutSeconds: number;
};

export type UpdateWebhookSubscriptionInput = Omit<CreateWebhookSubscriptionInput, "id" | "endpointId">;

export type CreateWebhookDeliveryInput = {
  id?: string;
  eventId: string;
  eventKey: string;
  sequence: number;
  subscriptionId: string;
  taskId: string | null;
  eventType: string;
  payloadJson: string;
  nextAttemptAt: string;
};

type PersistedWebhookDeliveryInput = CreateWebhookDeliveryInput & { dispatchOrder: number };

export type AppendTaskEventInput = {
  taskId: string;
  eventType: string;
  eventKey?: string;
  occurredAt?: string;
  payload: Record<string, unknown>;
};

export const webhookEventId = (endpointId: string, eventKey: string): string =>
  `evt_${createHash("sha256").update(`${endpointId}:${eventKey}`, "utf8").digest("hex").slice(0, 32)}`;

const publicToolPayload = (eventType: string, input: Record<string, unknown>): Record<string, unknown> => {
  const payload: Record<string, unknown> = {
    toolCallId: typeof input.toolCallId === "string" ? input.toolCallId : "",
    status: eventType.slice("tool.".length)
  };
  if (typeof input.title === "string" && input.title !== "") payload.title = input.title;
  if (typeof input.kind === "string" && input.kind !== "") payload.kind = input.kind;
  if (Array.isArray(input.locations)) {
    const locations = input.locations.flatMap((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
      const location = item as Record<string, unknown>;
      if (typeof location.path !== "string" || location.path === "") return [];
      return [location.line === null || typeof location.line === "number"
        ? { path: location.path, line: location.line }
        : { path: location.path }];
    });
    if (locations.length > 0) payload.locations = locations;
  }
  return payload;
};

const toEndpoint = (row: EndpointRow): IntegrationEndpoint => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  agentId: row.agent_id,
  enabled: row.enabled === 1,
  promptPrefix: row.prompt_prefix,
  parameterMappings: JSON.parse(row.parameter_mappings_json) as ParameterMapping[],
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const toConversation = (row: ConversationRow): IntegrationConversation => ({
  id: row.id,
  endpointId: row.endpoint_id,
  conversationKey: row.conversation_key,
  sessionId: row.session_id,
  status: row.status,
  createdAt: row.created_at,
  endedAt: row.ended_at
});

const toTask = (row: TaskRow): IntegrationTask => ({
  id: row.id,
  endpointId: row.endpoint_id,
  conversationId: row.conversation_id,
  sessionId: row.session_id,
  runId: row.run_id,
  requestId: row.request_id,
  requestFingerprint: row.request_fingerprint,
  message: row.message,
  effectivePrompt: row.effective_prompt,
  encryptedParameters: row.encrypted_parameters,
  status: row.status,
  result: row.result,
  error: row.error,
  eventSequence: row.event_sequence,
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at
});

const toSubscription = (row: SubscriptionRow): WebhookSubscription => ({
  id: row.id,
  endpointId: row.endpoint_id,
  name: row.name,
  url: row.url,
  enabled: row.enabled === 1,
  eventsJson: row.events_json,
  encryptedHeaders: row.encrypted_headers,
  encryptedSigningSecret: row.encrypted_signing_secret,
  timeoutSeconds: row.timeout_seconds,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const toDelivery = (row: DeliveryRow): WebhookDelivery => ({
  id: row.id,
  eventId: row.event_id,
  eventKey: row.event_key,
  sequence: row.sequence,
  dispatchOrder: row.dispatch_order,
  subscriptionId: row.subscription_id,
  taskId: row.task_id,
  eventType: row.event_type,
  payloadJson: row.payload_json,
  status: row.status,
  attemptCount: row.attempt_count,
  nextAttemptAt: row.next_attempt_at,
  lastStatusCode: row.last_status_code,
  lastDurationMs: row.last_duration_ms,
  lastError: row.last_error,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const toRun = (row: LinkedRunRow): Run => ({
  id: row.id,
  sessionId: row.session_id,
  status: row.status,
  input: row.input,
  result: row.result,
  error: row.error,
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at
});

/** Stores integration state; InTransaction methods join a caller-owned SQLite transaction. */
export class IntegrationStore {
  private readonly taskListeners = new Map<string, Set<() => unknown>>();
  private readonly deliveryListeners = new Set<() => unknown>();

  constructor(private readonly dependencies: { db: Database.Database }) {}

  private get db(): Database.Database {
    return this.dependencies.db;
  }

  listEndpoints(): IntegrationEndpoint[] {
    return (this.db.prepare("SELECT * FROM integration_endpoints ORDER BY created_at ASC, id ASC").all() as EndpointRow[]).map(toEndpoint);
  }

  getEndpoint(id: string): IntegrationEndpoint | undefined {
    const row = this.endpointRow(id);
    return row === undefined ? undefined : toEndpoint(row);
  }

  getEndpointBySlug(slug: string): IntegrationEndpoint | undefined {
    const row = this.db.prepare("SELECT * FROM integration_endpoints WHERE slug = ?").get(slug) as EndpointRow | undefined;
    return row === undefined ? undefined : toEndpoint(row);
  }

  endpointTokenHash(id: string): string | undefined {
    return (this.db.prepare("SELECT token_hash FROM integration_endpoints WHERE id = ?").get(id) as { token_hash: string } | undefined)?.token_hash;
  }

  endpointBySlugWithTokenHash(slug: string): { endpoint: IntegrationEndpoint; tokenHash: string } | undefined {
    const row = this.db.prepare("SELECT * FROM integration_endpoints WHERE slug = ?").get(slug) as EndpointRow | undefined;
    return row === undefined ? undefined : { endpoint: toEndpoint(row), tokenHash: row.token_hash };
  }

  getEndpointByTokenHash(tokenHash: string): IntegrationEndpoint | undefined {
    const row = this.db.prepare("SELECT * FROM integration_endpoints WHERE token_hash = ?").get(tokenHash) as
      | EndpointRow
      | undefined;
    return row === undefined ? undefined : toEndpoint(row);
  }

  endpointEncryptedFixedValues(id: string): string | null | undefined {
    const row = this.db.prepare("SELECT encrypted_fixed_values FROM integration_endpoints WHERE id = ?").get(id) as
      | { encrypted_fixed_values: string | null }
      | undefined;
    return row?.encrypted_fixed_values;
  }

  createEndpoint(input: EndpointPersistenceInput): IntegrationEndpoint {
    return this.immediateTransaction(() => this.createEndpointInTransaction(input));
  }

  createEndpointInTransaction(input: EndpointPersistenceInput): IntegrationEndpoint {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO integration_endpoints
        (id, name, slug, agent_id, enabled, token_hash, prompt_prefix, parameter_mappings_json, encrypted_fixed_values, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.name, input.slug, input.agentId, input.enabled ? 1 : 0, input.tokenHash, input.promptPrefix,
      JSON.stringify(input.parameterMappings), input.encryptedFixedValues, now, now
    );
    return this.getEndpoint(id)!;
  }

  updateEndpoint(id: string, input: EndpointPersistenceInput): IntegrationEndpoint | undefined {
    return this.immediateTransaction(() => this.updateEndpointInTransaction(id, input));
  }

  updateEndpointInTransaction(id: string, input: EndpointPersistenceInput): IntegrationEndpoint | undefined {
    const result = this.db.prepare(`
      UPDATE integration_endpoints SET
        name = ?, slug = ?, agent_id = ?, enabled = ?, token_hash = ?, prompt_prefix = ?,
        parameter_mappings_json = ?, encrypted_fixed_values = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.name, input.slug, input.agentId, input.enabled ? 1 : 0, input.tokenHash, input.promptPrefix,
      JSON.stringify(input.parameterMappings), input.encryptedFixedValues, new Date().toISOString(), id
    );
    return result.changes === 0 ? undefined : this.getEndpoint(id)!;
  }

  rotateEndpointToken(id: string, tokenHash: string): IntegrationEndpoint | undefined {
    return this.immediateTransaction(() => this.rotateEndpointTokenInTransaction(id, tokenHash));
  }

  rotateEndpointTokenInTransaction(id: string, tokenHash: string): IntegrationEndpoint | undefined {
    const result = this.db.prepare("UPDATE integration_endpoints SET token_hash = ?, updated_at = ? WHERE id = ?")
      .run(tokenHash, new Date().toISOString(), id);
    return result.changes === 0 ? undefined : this.getEndpoint(id)!;
  }

  deleteEndpoint(id: string): boolean {
    return this.immediateTransaction(() => this.deleteEndpointInTransaction(id));
  }

  deleteEndpointInTransaction(id: string): boolean {
    return this.db.prepare("DELETE FROM integration_endpoints WHERE id = ?").run(id).changes === 1;
  }

  listConversations(endpointId: string): IntegrationConversation[] {
    return (this.db.prepare(`
      SELECT * FROM integration_conversations WHERE endpoint_id = ? ORDER BY created_at ASC, id ASC
    `).all(endpointId) as ConversationRow[]).map(toConversation);
  }

  getActiveConversation(endpointId: string, conversationKey: string): IntegrationConversation | undefined {
    const row = this.db.prepare(`
      SELECT * FROM integration_conversations
      WHERE endpoint_id = ? AND conversation_key = ? AND status = 'active'
    `).get(endpointId, conversationKey) as ConversationRow | undefined;
    return row === undefined ? undefined : toConversation(row);
  }

  getLatestConversation(endpointId: string, conversationKey: string): IntegrationConversation | undefined {
    const row = this.db.prepare(`
      SELECT * FROM integration_conversations
      WHERE endpoint_id = ? AND conversation_key = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(endpointId, conversationKey) as ConversationRow | undefined;
    return row === undefined ? undefined : toConversation(row);
  }

  getConversation(id: string): IntegrationConversation | undefined {
    const row = this.conversationRow(id);
    return row === undefined ? undefined : toConversation(row);
  }

  createConversation(input: CreateIntegrationConversationInput): IntegrationConversation {
    return this.immediateTransaction(() => this.createConversationInTransaction(input));
  }

  createConversationInTransaction(input: CreateIntegrationConversationInput): IntegrationConversation {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO integration_conversations (id, endpoint_id, conversation_key, session_id, status, created_at, ended_at)
      VALUES (?, ?, ?, ?, 'active', ?, NULL)
    `).run(id, input.endpointId, input.conversationKey, input.sessionId, now);
    return toConversation(this.conversationRow(id)!);
  }

  endConversationInTransaction(id: string): IntegrationConversation | undefined {
    const result = this.db.prepare(`
      UPDATE integration_conversations SET status = 'ended', ended_at = ? WHERE id = ? AND status = 'active'
    `).run(new Date().toISOString(), id);
    return result.changes === 0 ? undefined : toConversation(this.conversationRow(id)!);
  }

  endConversation(id: string): IntegrationConversation | undefined {
    return this.immediateTransaction(() => this.endConversationInTransaction(id));
  }

  listTasks(endpointId: string): IntegrationTask[] {
    return (this.db.prepare(`
      SELECT * FROM integration_tasks WHERE endpoint_id = ? ORDER BY created_at ASC, id ASC
    `).all(endpointId) as TaskRow[]).map(toTask);
  }

  getTask(id: string): IntegrationTask | undefined {
    const row = this.taskRow(id);
    return row === undefined ? undefined : toTask(row);
  }

  getTaskByRequestId(endpointId: string, requestId: string): IntegrationTask | undefined {
    const row = this.db.prepare(`
      SELECT * FROM integration_tasks WHERE endpoint_id = ? AND request_id = ?
    `).get(endpointId, requestId) as TaskRow | undefined;
    return row === undefined ? undefined : toTask(row);
  }

  getTaskForEndpoint(id: string, endpointId: string): IntegrationTask | undefined {
    const row = this.db.prepare(`
      SELECT * FROM integration_tasks WHERE id = ? AND endpoint_id = ?
    `).get(id, endpointId) as TaskRow | undefined;
    return row === undefined ? undefined : toTask(row);
  }

  getTaskByRun(runId: string): IntegrationTask | undefined {
    const row = this.db.prepare("SELECT * FROM integration_tasks WHERE run_id = ?").get(runId) as TaskRow | undefined;
    return row === undefined ? undefined : toTask(row);
  }

  /** Returns only the first unlinked queued Task for each free Conversation, plus every one-off Task. */
  listDispatchableTasks(): IntegrationTask[] {
    const rows = this.db.prepare(`
      SELECT task.*
      FROM integration_tasks task
      WHERE task.status = 'queued'
        AND task.run_id IS NULL
        AND (
          task.conversation_id IS NULL
          OR (
            NOT EXISTS (
              SELECT 1 FROM integration_tasks active
              WHERE active.conversation_id = task.conversation_id
                AND (
                  active.status = 'running'
                  OR (active.status = 'queued' AND active.run_id IS NOT NULL)
                )
            )
            AND task.id = (
              SELECT queued.id FROM integration_tasks queued
              WHERE queued.conversation_id = task.conversation_id AND queued.status = 'queued'
              ORDER BY queued.created_at ASC, queued.id ASC
              LIMIT 1
            )
          )
        )
      ORDER BY task.created_at ASC, task.id ASC
    `).all() as TaskRow[];
    return rows.map(toTask);
  }

  /** Links an unclaimed queued Task to a newly-inserted Run in the caller's transaction. */
  linkTaskRunInTransaction(taskId: string, runId: string): IntegrationTask {
    const result = this.db.prepare(`
      UPDATE integration_tasks SET run_id = ?
      WHERE id = ? AND status = 'queued' AND run_id IS NULL
    `).run(runId, taskId);
    if (result.changes !== 1) throw new Error("integration_task_not_dispatchable");
    return toTask(this.taskRow(taskId)!);
  }

  /** Notifies in-process Task observers after the owning transaction has committed. */
  notifyTaskChanged(taskId: string): void {
    for (const listener of [...(this.taskListeners.get(taskId) ?? [])]) {
      try {
        void Promise.resolve(listener()).catch(() => undefined);
      } catch (_error) {
        // A listener observes committed state and cannot affect persistence or other listeners.
      }
    }
  }

  /** Notifies delivery observers only after the owning transaction has committed. */
  notifyDeliveriesChanged(): void {
    for (const listener of [...this.deliveryListeners]) {
      try {
        void Promise.resolve(listener()).catch(() => undefined);
      } catch (_error) {
        // Delivery observers cannot affect persisted business state or other observers.
      }
    }
  }

  subscribeDeliveries(listener: () => unknown): () => void {
    this.deliveryListeners.add(listener);
    return () => this.deliveryListeners.delete(listener);
  }

  subscribeTask(taskId: string, listener: () => unknown): () => void {
    let listeners = this.taskListeners.get(taskId);
    if (listeners === undefined) {
      listeners = new Set();
      this.taskListeners.set(taskId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners!.delete(listener);
      if (listeners!.size === 0) this.taskListeners.delete(taskId);
    };
  }

  markTaskRunningInTransaction(runId: string, startedAt: string): IntegrationTask | undefined {
    const result = this.db.prepare(`
      UPDATE integration_tasks SET status = 'running', started_at = ?
      WHERE run_id = ? AND status = 'queued'
    `).run(startedAt, runId);
    return result.changes === 0 ? undefined : this.getTaskByRun(runId);
  }

  finishTaskInTransaction(run: Run): IntegrationTask | undefined {
    const result = this.db.prepare(`
      UPDATE integration_tasks
      SET status = ?, result = ?, error = ?, finished_at = ?
      WHERE run_id = ? AND status IN ('queued', 'running')
    `).run(run.status, run.result, run.error, run.finishedAt, run.id);
    return result.changes === 0 ? undefined : this.getTaskByRun(run.id);
  }

  /** Terminates a queued Task that cannot create a Run. */
  failTaskBeforeRun(id: string, failure: { code: string; message: string }): IntegrationTask | undefined {
    const failed = this.immediateTransaction(() => {
      const finishedAt = new Date().toISOString();
      const result = this.db.prepare(`
        UPDATE integration_tasks SET status = 'failed', error = ?, finished_at = ?
        WHERE id = ? AND status = 'queued' AND run_id IS NULL
      `).run(failure.code, finishedAt, id);
      if (result.changes === 0) return undefined;
      this.appendTaskEventInTransaction({
        taskId: id,
        eventType: "task.failed",
        eventKey: `${id}:task.failed`,
        occurredAt: finishedAt,
        payload: { status: "failed", error: failure.code }
      });
      this.appendTaskEventInTransaction({
        taskId: id,
        eventType: "message.system.notice",
        eventKey: `${id}:message.system.notice:dispatch_failed`,
        occurredAt: finishedAt,
        payload: { code: failure.code, message: failure.message }
      });
      return this.getTask(id);
    });
    if (failed !== undefined) {
      this.notifyTaskChanged(failed.id);
      this.notifyDeliveriesChanged();
    }
    return failed;
  }

  /** Cancels only an unlinked queued Task and emits its Webhook event atomically. */
  cancelUnlinkedQueuedTask(id: string, endpointId: string): IntegrationTask | undefined {
    const cancelled = this.immediateTransaction(() => {
      const finishedAt = new Date().toISOString();
      const result = this.db.prepare(`
        UPDATE integration_tasks
        SET status = 'cancelled', finished_at = ?
        WHERE id = ? AND endpoint_id = ? AND status = 'queued' AND run_id IS NULL
      `).run(finishedAt, id, endpointId);
      if (result.changes === 0) return undefined;
      this.appendTaskEventInTransaction({
        taskId: id,
        eventType: "task.cancelled",
        eventKey: `${id}:task.cancelled`,
        occurredAt: finishedAt,
        payload: { status: "cancelled", finishedAt }
      });
      return this.getTaskForEndpoint(id, endpointId);
    });
    if (cancelled !== undefined) {
      this.notifyTaskChanged(cancelled.id);
      this.notifyDeliveriesChanged();
    }
    return cancelled;
  }

  /** Finds linked Runs whose current state has not yet been projected to their Task. */
  listRunsNeedingProjection(): Run[] {
    const rows = this.db.prepare(`
      SELECT run.*
      FROM runs run
      JOIN integration_tasks task ON task.run_id = run.id
      WHERE (run.status = 'running' AND task.status = 'queued')
         OR (run.status IN ('succeeded', 'failed', 'cancelled') AND task.status IN ('queued', 'running'))
      ORDER BY run.created_at ASC, run.id ASC
    `).all() as LinkedRunRow[];
    return rows.map(toRun);
  }

  /** Lists every linked Run so deterministic Webhook projections can be reconciled after restart. */
  listLinkedRuns(): Run[] {
    const rows = this.db.prepare(`
      SELECT run.*
      FROM runs run
      JOIN integration_tasks task ON task.run_id = run.id
      ORDER BY run.created_at ASC, run.id ASC
    `).all() as LinkedRunRow[];
    return rows.map(toRun);
  }

  createTask(input: CreateIntegrationTaskInput): IntegrationTask {
    return this.immediateTransaction(() => this.createTaskInTransaction(input));
  }

  createTaskInTransaction(input: CreateIntegrationTaskInput): IntegrationTask {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO integration_tasks
        (id, endpoint_id, conversation_id, session_id, run_id, request_id, request_fingerprint, message, effective_prompt,
         encrypted_parameters, status, result, error, event_sequence, created_at, started_at, finished_at)
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'queued', NULL, NULL, 0, ?, NULL, NULL)
    `).run(
      id, input.endpointId, input.conversationId, input.sessionId, input.requestId, input.requestFingerprint,
      input.message, input.effectivePrompt, input.encryptedParameters, now
    );
    return toTask(this.taskRow(id)!);
  }

  conversationHasActiveTasks(conversationId: string): boolean {
    return this.db.prepare(`
      SELECT 1 FROM integration_tasks
      WHERE conversation_id = ? AND status IN ('queued', 'running')
      LIMIT 1
    `).get(conversationId) !== undefined;
  }

  listSubscriptions(endpointId: string): WebhookSubscription[] {
    return (this.db.prepare(`
      SELECT * FROM webhook_subscriptions WHERE endpoint_id = ? ORDER BY created_at ASC, id ASC
    `).all(endpointId) as SubscriptionRow[]).map(toSubscription);
  }

  getSubscription(id: string): WebhookSubscription | undefined {
    const row = this.subscriptionRow(id);
    return row === undefined ? undefined : toSubscription(row);
  }

  getSubscriptionForEndpoint(id: string, endpointId: string): WebhookSubscription | undefined {
    const row = this.db.prepare(`
      SELECT * FROM webhook_subscriptions WHERE id = ? AND endpoint_id = ?
    `).get(id, endpointId) as SubscriptionRow | undefined;
    return row === undefined ? undefined : toSubscription(row);
  }

  createSubscription(input: CreateWebhookSubscriptionInput): WebhookSubscription {
    return this.immediateTransaction(() => this.createSubscriptionInTransaction(input));
  }

  createSubscriptionInTransaction(input: CreateWebhookSubscriptionInput): WebhookSubscription {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO webhook_subscriptions
        (id, endpoint_id, name, url, enabled, events_json, encrypted_headers, encrypted_signing_secret, timeout_seconds, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.endpointId, input.name, input.url, input.enabled ? 1 : 0, input.eventsJson,
      input.encryptedHeaders, input.encryptedSigningSecret, input.timeoutSeconds, now, now
    );
    return toSubscription(this.subscriptionRow(id)!);
  }

  updateSubscription(id: string, input: UpdateWebhookSubscriptionInput): WebhookSubscription | undefined {
    const subscription = this.immediateTransaction(() => {
      const result = this.db.prepare(`
        UPDATE webhook_subscriptions SET
          name = ?, url = ?, enabled = ?, events_json = ?, encrypted_headers = ?,
          encrypted_signing_secret = ?, timeout_seconds = ?, updated_at = ?
        WHERE id = ?
      `).run(
        input.name,
        input.url,
        input.enabled ? 1 : 0,
        input.eventsJson,
        input.encryptedHeaders,
        input.encryptedSigningSecret,
        input.timeoutSeconds,
        new Date().toISOString(),
        id
      );
      return result.changes === 0 ? undefined : toSubscription(this.subscriptionRow(id)!);
    });
    if (subscription?.enabled === true) this.notifyDeliveriesChanged();
    return subscription;
  }

  deleteSubscription(id: string): boolean {
    return this.immediateTransaction(() => {
      this.db.prepare("DELETE FROM webhook_deliveries WHERE subscription_id = ?").run(id);
      return this.db.prepare("DELETE FROM webhook_subscriptions WHERE id = ?").run(id).changes === 1;
    });
  }

  listDeliveries(subscriptionId: string): WebhookDelivery[] {
    return (this.db.prepare(`
      SELECT * FROM webhook_deliveries
      WHERE subscription_id = ?
      ORDER BY dispatch_order ASC, rowid ASC
    `).all(subscriptionId) as DeliveryRow[]).map(toDelivery);
  }

  listDeliveriesForEndpoint(endpointId: string): WebhookDelivery[] {
    return (this.db.prepare(`
      SELECT delivery.*
      FROM webhook_deliveries delivery
      JOIN webhook_subscriptions subscription ON subscription.id = delivery.subscription_id
      WHERE subscription.endpoint_id = ?
      ORDER BY delivery.created_at DESC, delivery.id DESC
    `).all(endpointId) as DeliveryRow[]).map(toDelivery);
  }

  getDelivery(id: string): WebhookDelivery | undefined {
    const row = this.deliveryRow(id);
    return row === undefined ? undefined : toDelivery(row);
  }

  findDeliveryByEventKey(subscriptionId: string, eventKey: string): WebhookDelivery | undefined {
    const row = this.db.prepare(`
      SELECT * FROM webhook_deliveries WHERE subscription_id = ? AND event_key = ?
    `).get(subscriptionId, eventKey) as DeliveryRow | undefined;
    return row === undefined ? undefined : toDelivery(row);
  }

  /** Checks whether an enabled subscriber is missing all equivalent keys for one Task event. */
  needsTaskEventDelivery(taskId: string, eventType: string, eventKeys: string[]): boolean {
    const task = this.taskRow(taskId);
    if (task === undefined) return false;
    const subscriptions = this.db.prepare(`
      SELECT * FROM webhook_subscriptions WHERE endpoint_id = ? AND enabled = 1
    `).all(task.endpoint_id) as SubscriptionRow[];
    return subscriptions.some((subscription) => {
      const events = JSON.parse(subscription.events_json) as string[];
      if (!events.includes(eventType)) return false;
      return eventKeys.every((eventKey) => this.db.prepare(`
        SELECT 1 FROM webhook_deliveries WHERE subscription_id = ? AND event_key = ? LIMIT 1
      `).get(subscription.id, eventKey) === undefined);
    });
  }

  /** Appends one Task event and its subscribed Deliveries inside the caller's transaction. */
  appendTaskEventInTransaction(input: AppendTaskEventInput): WebhookDelivery[] {
    const task = this.taskRow(input.taskId);
    if (task === undefined) return [];
    const eventSequences = JSON.parse(task.event_sequences_json) as Record<string, number>;
    const eventDispatchOrders = JSON.parse(task.event_dispatch_orders_json) as Record<string, number>;
    const provisionalSequence = task.event_sequence + 1;
    const eventKey = input.eventKey ?? `${task.id}:${provisionalSequence}`;
    const existing = this.db.prepare(`
        SELECT * FROM webhook_deliveries
        WHERE task_id = ? AND event_key = ?
        ORDER BY rowid ASC
      `).all(task.id, eventKey) as DeliveryRow[];
    const firstExisting = existing[0];
    const knownSequence = eventSequences[eventKey];
    const knownDispatchOrder = eventDispatchOrders[eventKey];
    const sequence = firstExisting?.sequence ?? knownSequence ?? provisionalSequence;
    const dispatchOrder = knownDispatchOrder ?? this.allocateEndpointDeliveryOrderInTransaction(task.endpoint_id);
    const eventId = firstExisting?.event_id ?? webhookEventId(task.endpoint_id, eventKey);
    const occurredAt = firstExisting === undefined
      ? input.occurredAt ?? new Date().toISOString()
      : (JSON.parse(firstExisting.payload_json) as { occurredAt: string }).occurredAt;
    if (knownSequence === undefined || knownDispatchOrder === undefined) {
      if (knownSequence === undefined) eventSequences[eventKey] = sequence;
      if (knownDispatchOrder === undefined) eventDispatchOrders[eventKey] = dispatchOrder;
      this.db.prepare(`
        UPDATE integration_tasks
        SET event_sequence = ?, event_sequences_json = ?, event_dispatch_orders_json = ?
        WHERE id = ?
      `).run(
        knownSequence === undefined ? sequence : task.event_sequence,
        JSON.stringify(eventSequences),
        JSON.stringify(eventDispatchOrders),
        task.id
      );
    }

    const subscriptions = this.db.prepare(`
      SELECT * FROM webhook_subscriptions
      WHERE endpoint_id = ? AND enabled = 1
      ORDER BY created_at ASC, id ASC
    `).all(task.endpoint_id) as SubscriptionRow[];
    const payloadJson = firstExisting?.payload_json
      ?? this.publicTaskPayloadJson(task, { ...input, eventKey }, eventId, sequence, occurredAt);
    const deliveries = subscriptions.flatMap((row) => {
      const events = JSON.parse(row.events_json) as string[];
      if (!events.includes(input.eventType)) return [];
      return [this.createDeliveryInTransaction({
        eventId,
        eventKey,
        sequence,
        dispatchOrder,
        subscriptionId: row.id,
        taskId: task.id,
        eventType: input.eventType,
        payloadJson,
        nextAttemptAt: occurredAt
      })];
    });
    return deliveries;
  }

  createDelivery(input: CreateWebhookDeliveryInput): WebhookDelivery {
    const delivery = this.immediateTransaction(() => {
      const subscription = this.subscriptionRow(input.subscriptionId)!;
      const dispatchOrder = this.allocateEndpointDeliveryOrderInTransaction(subscription.endpoint_id);
      return this.createDeliveryInTransaction({ ...input, dispatchOrder });
    });
    this.notifyDeliveriesChanged();
    return delivery;
  }

  createDeliveryInTransaction(input: PersistedWebhookDeliveryInput): WebhookDelivery {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO webhook_deliveries
        (id, event_id, event_key, sequence, dispatch_order, subscription_id, task_id, event_type, payload_json,
         status, attempt_count,
         next_attempt_at, last_status_code, last_duration_ms, last_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, ?, ?)
      ON CONFLICT(subscription_id, event_key) DO NOTHING
    `).run(
      id, input.eventId, input.eventKey, input.sequence, input.dispatchOrder, input.subscriptionId, input.taskId,
      input.eventType, input.payloadJson, input.nextAttemptAt, now, now
    );
    const row = this.deliveryRow(id) ?? this.db.prepare(`
      SELECT * FROM webhook_deliveries WHERE subscription_id = ? AND event_key = ?
    `).get(input.subscriptionId, input.eventKey) as DeliveryRow | undefined;
    return toDelivery(row!);
  }

  /** Returns one due head Delivery for each enabled Subscription. */
  listDueDeliveries(now: string): WebhookDelivery[] {
    const rows = this.db.prepare(`
      SELECT delivery.*
      FROM webhook_deliveries delivery
      JOIN webhook_subscriptions subscription ON subscription.id = delivery.subscription_id
      WHERE delivery.status = 'pending'
        AND delivery.next_attempt_at <= ?
        AND subscription.enabled = 1
        AND delivery.rowid = (
          SELECT earlier.rowid
          FROM webhook_deliveries earlier
          WHERE earlier.subscription_id = delivery.subscription_id
            AND earlier.status IN ('pending', 'delivering')
          ORDER BY earlier.dispatch_order ASC, earlier.rowid ASC
          LIMIT 1
        )
      ORDER BY delivery.dispatch_order ASC, delivery.rowid ASC
    `).all(now) as DeliveryRow[];
    return rows.map(toDelivery);
  }

  nextPendingDeliveryAt(): string | undefined {
    const row = this.db.prepare(`
      SELECT MIN(delivery.next_attempt_at) AS next_attempt_at
      FROM webhook_deliveries delivery
      JOIN webhook_subscriptions subscription ON subscription.id = delivery.subscription_id
      WHERE delivery.status = 'pending'
        AND subscription.enabled = 1
        AND delivery.rowid = (
          SELECT earlier.rowid
          FROM webhook_deliveries earlier
          WHERE earlier.subscription_id = delivery.subscription_id
            AND earlier.status IN ('pending', 'delivering')
          ORDER BY earlier.dispatch_order ASC, earlier.rowid ASC
          LIMIT 1
        )
    `).get() as { next_attempt_at: string | null };
    return row.next_attempt_at ?? undefined;
  }

  /** Atomically claims a due head Delivery and increments its persisted attempt count. */
  claimDelivery(id: string, now = new Date().toISOString()): WebhookDelivery | undefined {
    return this.immediateTransaction(() => {
      const candidate = this.db.prepare(`
        SELECT delivery.id
        FROM webhook_deliveries delivery
        JOIN webhook_subscriptions subscription ON subscription.id = delivery.subscription_id
        WHERE delivery.id = ?
          AND delivery.status = 'pending'
          AND delivery.next_attempt_at <= ?
          AND subscription.enabled = 1
          AND delivery.rowid = (
            SELECT earlier.rowid
            FROM webhook_deliveries earlier
            WHERE earlier.subscription_id = delivery.subscription_id
              AND earlier.status IN ('pending', 'delivering')
            ORDER BY earlier.dispatch_order ASC, earlier.rowid ASC
            LIMIT 1
          )
      `).get(id, now) as { id: string } | undefined;
      if (candidate === undefined) return undefined;
      const result = this.db.prepare(`
        UPDATE webhook_deliveries
        SET status = 'delivering', attempt_count = attempt_count + 1, updated_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(now, id);
      return result.changes === 0 ? undefined : toDelivery(this.deliveryRow(id)!);
    });
  }

  markDeliverySucceeded(id: string, input: { statusCode: number; durationMs: number }): WebhookDelivery | undefined {
    return this.immediateTransaction(() => {
      const result = this.db.prepare(`
        UPDATE webhook_deliveries
        SET status = 'succeeded', last_status_code = ?, last_duration_ms = ?, last_error = NULL, updated_at = ?
        WHERE id = ? AND status = 'delivering'
      `).run(input.statusCode, input.durationMs, new Date().toISOString(), id);
      return result.changes === 0 ? undefined : toDelivery(this.deliveryRow(id)!);
    });
  }

  markDeliveryFailed(id: string, input: {
    terminal: boolean;
    nextAttemptAt: string;
    statusCode: number | null;
    durationMs: number;
    error: string;
  }): WebhookDelivery | undefined {
    return this.immediateTransaction(() => {
      const result = this.db.prepare(`
        UPDATE webhook_deliveries
        SET status = ?, next_attempt_at = ?, last_status_code = ?, last_duration_ms = ?, last_error = ?, updated_at = ?
        WHERE id = ? AND status = 'delivering'
      `).run(
        input.terminal ? "failed" : "pending",
        input.nextAttemptAt,
        input.statusCode,
        input.durationMs,
        input.error,
        new Date().toISOString(),
        id
      );
      return result.changes === 0 ? undefined : toDelivery(this.deliveryRow(id)!);
    });
  }

  releaseDelivery(id: string, nextAttemptAt = new Date().toISOString()): WebhookDelivery | undefined {
    return this.immediateTransaction(() => {
      const result = this.db.prepare(`
        UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = ?, updated_at = ?
        WHERE id = ? AND status = 'delivering'
      `).run(nextAttemptAt, new Date().toISOString(), id);
      return result.changes === 0 ? undefined : toDelivery(this.deliveryRow(id)!);
    });
  }

  retryDelivery(id: string): WebhookDelivery | undefined {
    const delivery = this.immediateTransaction(() => {
      const now = new Date().toISOString();
      const result = this.db.prepare(`
        UPDATE webhook_deliveries
        SET status = 'pending', attempt_count = 0, next_attempt_at = ?, last_status_code = NULL,
            last_duration_ms = NULL, last_error = NULL, updated_at = ?
        WHERE id = ? AND status = 'failed'
      `).run(now, now, id);
      return result.changes === 0 ? undefined : toDelivery(this.deliveryRow(id)!);
    });
    if (delivery !== undefined) this.notifyDeliveriesChanged();
    return delivery;
  }

  recoverDeliveries(): number {
    const changes = this.immediateTransaction(() => {
      const now = new Date().toISOString();
      return this.db.prepare(`
        UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = ?, updated_at = ?
        WHERE status = 'delivering'
      `).run(now, now).changes;
    });
    if (changes > 0) this.notifyDeliveriesChanged();
    return changes;
  }

  endpointHasHistory(id: string): boolean {
    return this.db.prepare(`
      SELECT 1 FROM integration_conversations WHERE endpoint_id = ?
      UNION ALL
      SELECT 1 FROM integration_tasks WHERE endpoint_id = ?
      UNION ALL
      SELECT 1 FROM webhook_subscriptions WHERE endpoint_id = ?
      LIMIT 1
    `).get(id, id, id) !== undefined;
  }

  endpointHasActiveWork(id: string): boolean {
    return this.db.prepare(`
      SELECT 1 FROM integration_conversations WHERE endpoint_id = ? AND status = 'active'
      UNION ALL
      SELECT 1 FROM integration_tasks WHERE endpoint_id = ? AND status IN ('queued', 'running')
      LIMIT 1
    `).get(id, id) !== undefined;
  }

  private endpointRow(id: string): EndpointRow | undefined {
    return this.db.prepare("SELECT * FROM integration_endpoints WHERE id = ?").get(id) as EndpointRow | undefined;
  }

  private conversationRow(id: string): ConversationRow | undefined {
    return this.db.prepare("SELECT * FROM integration_conversations WHERE id = ?").get(id) as ConversationRow | undefined;
  }

  private taskRow(id: string): TaskRow | undefined {
    return this.db.prepare("SELECT * FROM integration_tasks WHERE id = ?").get(id) as TaskRow | undefined;
  }

  private subscriptionRow(id: string): SubscriptionRow | undefined {
    return this.db.prepare("SELECT * FROM webhook_subscriptions WHERE id = ?").get(id) as SubscriptionRow | undefined;
  }

  private deliveryRow(id: string): DeliveryRow | undefined {
    return this.db.prepare("SELECT * FROM webhook_deliveries WHERE id = ?").get(id) as DeliveryRow | undefined;
  }

  private allocateEndpointDeliveryOrderInTransaction(endpointId: string): number {
    const row = this.db.prepare(`
      UPDATE integration_endpoints
      SET next_delivery_order = next_delivery_order + 1
      WHERE id = ?
      RETURNING next_delivery_order
    `).get(endpointId) as { next_delivery_order: number } | undefined;
    if (row === undefined) throw new Error("integration_endpoint_not_found");
    return row.next_delivery_order;
  }

  private publicTaskPayloadJson(
    task: TaskRow,
    input: AppendTaskEventInput & { eventKey: string },
    eventId: string,
    sequence: number,
    occurredAt: string
  ): string {
    const endpoint = this.endpointRow(task.endpoint_id)!;
    const conversationKey = task.conversation_id === null
      ? null
      : this.conversationRow(task.conversation_id)?.conversation_key ?? null;
    const publicTaskStatus = input.eventType === "task.queued" || input.eventType === "message.user.received"
      ? "queued"
      : input.eventType === "task.started" || input.eventType.startsWith("tool.")
        ? "running"
        : input.eventType.startsWith("task.")
          ? input.eventType.slice("task.".length)
          : task.status;
    const payload: Record<string, unknown> = {
      eventId,
      eventType: input.eventType,
      sequence,
      occurredAt,
      endpoint: { id: endpoint.id, slug: endpoint.slug },
      task: {
        id: task.id,
        requestId: task.request_id,
        conversationKey,
        sessionId: task.session_id,
        runId: task.run_id,
        status: publicTaskStatus
      }
    };
    if (input.eventType === "message.user.received" || input.eventType === "message.agent.reply") {
      payload.message = {
        role: input.eventType === "message.agent.reply" ? "agent" : "user",
        content: typeof input.payload.message === "string" ? input.payload.message : "",
        runStatus: publicTaskStatus
      };
    } else if (input.eventType === "message.system.notice") {
      payload.notice = {
        code: typeof input.payload.code === "string" ? input.payload.code : "system_notice",
        message: typeof input.payload.message === "string" ? input.payload.message : "System notice"
      };
    } else if (input.eventType.startsWith("tool.")) {
      payload.tool = publicToolPayload(input.eventType, input.payload);
    }
    return JSON.stringify(payload);
  }

  private immediateTransaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
