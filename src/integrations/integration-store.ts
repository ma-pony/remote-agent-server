import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

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

export type AppendTaskEventInput = {
  taskId: string;
  eventType: string;
  payload: Record<string, unknown>;
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

/** Stores integration state; InTransaction methods join a caller-owned SQLite transaction. */
export class IntegrationStore {
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

  listDeliveries(subscriptionId: string): WebhookDelivery[] {
    return (this.db.prepare(`
      SELECT * FROM webhook_deliveries WHERE subscription_id = ? ORDER BY sequence ASC, created_at ASC, id ASC
    `).all(subscriptionId) as DeliveryRow[]).map(toDelivery);
  }

  /** Appends one Task event and its subscribed Deliveries inside the caller's transaction. */
  appendTaskEventInTransaction(input: AppendTaskEventInput): WebhookDelivery[] {
    const task = this.taskRow(input.taskId);
    if (task === undefined) return [];
    const sequence = task.event_sequence + 1;
    const eventId = randomUUID();
    const eventKey = `${task.id}:${sequence}`;
    const occurredAt = new Date().toISOString();
    this.db.prepare("UPDATE integration_tasks SET event_sequence = ? WHERE id = ?").run(sequence, task.id);

    const subscriptions = this.db.prepare(`
      SELECT * FROM webhook_subscriptions
      WHERE endpoint_id = ? AND enabled = 1
      ORDER BY created_at ASC, id ASC
    `).all(task.endpoint_id) as SubscriptionRow[];
    const payloadJson = JSON.stringify({
      id: eventId,
      type: input.eventType,
      sequence,
      taskId: task.id,
      occurredAt,
      data: input.payload
    });
    return subscriptions.flatMap((row) => {
      const events = JSON.parse(row.events_json) as string[];
      if (!events.includes(input.eventType)) return [];
      return [this.createDeliveryInTransaction({
        eventId,
        eventKey,
        sequence,
        subscriptionId: row.id,
        taskId: task.id,
        eventType: input.eventType,
        payloadJson,
        nextAttemptAt: occurredAt
      })];
    });
  }

  createDelivery(input: CreateWebhookDeliveryInput): WebhookDelivery {
    return this.immediateTransaction(() => this.createDeliveryInTransaction(input));
  }

  createDeliveryInTransaction(input: CreateWebhookDeliveryInput): WebhookDelivery {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO webhook_deliveries
        (id, event_id, event_key, sequence, subscription_id, task_id, event_type, payload_json, status, attempt_count,
         next_attempt_at, last_status_code, last_duration_ms, last_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, ?, ?)
    `).run(
      id, input.eventId, input.eventKey, input.sequence, input.subscriptionId, input.taskId, input.eventType,
      input.payloadJson, input.nextAttemptAt, now, now
    );
    return toDelivery(this.deliveryRow(id)!);
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
