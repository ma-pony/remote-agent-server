import { randomBytes, randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { SecretStore } from "../mcp/secret-store.js";
import type { RunExecutor } from "../runs/run-executor.js";
import { SessionManagerError } from "../sessions/session-manager.js";
import { WorkspaceCreateError } from "../workspaces/workspace-manager.js";
import { isManagedWebhookHeader } from "./webhook-contract.js";
import { IntegrationCoordinator, IntegrationCoordinatorError } from "./integration-coordinator.js";
import { IntegrationEndpointManager, IntegrationEndpointManagerError } from "./integration-endpoint-manager.js";
import { webhookEventId, type IntegrationStore } from "./integration-store.js";
import type { IntegrationTask, WebhookDelivery, WebhookSubscription } from "./integration-types.js";
import type { WebhookDispatcher } from "./webhook-dispatcher.js";
import type { IntegrationTaskScheduler } from "./integration-scheduler.js";

const webhookEvents = [
  "task.queued",
  "task.started",
  "task.succeeded",
  "task.failed",
  "task.cancelled",
  "message.user.received",
  "message.agent.reply",
  "message.system.notice",
  "tool.started",
  "tool.completed",
  "tool.failed"
] as const;
const slug = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const requestParameterMappingSchema = z.object({
  parameterKey: z.string().trim().min(1),
  source: z.literal("request"),
  requestKey: z.string().trim().min(1)
}).strict();
const fixedParameterMappingSchema = z.object({
  parameterKey: z.string().trim().min(1),
  source: z.literal("fixed"),
  value: z.string()
}).strict();
const fixedParameterMappingUpdateSchema = z.object({
  parameterKey: z.string().trim().min(1),
  source: z.literal("fixed"),
  value: z.string().optional()
}).strict();
const parameterMappings = z.array(z.discriminatedUnion("source", [
  requestParameterMappingSchema,
  fixedParameterMappingSchema
]));

const createEndpointSchema = z.object({
  name: z.string().trim().min(1),
  slug,
  agentId: z.number().int().positive(),
  enabled: z.boolean(),
  promptPrefix: z.string(),
  parameterMappings
}).strict();

const updateEndpointSchema = z.object({
  name: z.string().trim().min(1),
  slug,
  agentId: z.number().int().positive(),
  enabled: z.boolean(),
  promptPrefix: z.string(),
  parameterMappings: z.array(z.discriminatedUnion("source", [
    requestParameterMappingSchema,
    fixedParameterMappingUpdateSchema
  ]))
}).partial().strict().refine(
  (input) => Object.keys(input).length > 0,
  { message: "At least one field must be provided" }
);
const rotateTokenSchema = z.object({}).strict().optional();
const testTaskSchema = z.object({
  conversationKey: z.string().trim().min(1).optional(),
  message: z.string().trim().min(1),
  parameters: z.record(z.string(), z.string()).default({})
}).strict();
const webhookHeaders = z.record(z.string(), z.string()).superRefine((headers, context) => {
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || /[\r\n]/.test(value)) {
      context.addIssue({ code: "custom", message: "Invalid Webhook Header" });
    }
    if (isManagedWebhookHeader(name)) {
      context.addIssue({ code: "custom", message: "Managed Webhook Header cannot be overridden" });
    }
  }
});
const webhookUrl = z.string().url().refine((value) => {
  const url = new URL(value);
  return (url.protocol === "http:" || url.protocol === "https:")
    && url.username === ""
    && url.password === "";
}, { message: "Webhook URL must use HTTP or HTTPS without embedded credentials" });
const webhookSchema = z.object({
  name: z.string().trim().min(1),
  url: webhookUrl,
  enabled: z.boolean(),
  events: z.array(z.enum(webhookEvents)).min(1),
  headers: webhookHeaders,
  timeoutSeconds: z.number().int().min(1).max(60)
}).strict();
const updateWebhookSchema = webhookSchema.partial().strict().refine(
  (input) => Object.keys(input).length > 0,
  { message: "At least one field must be provided" }
);

const invalidRequest = (reply: FastifyReply, message: string) =>
  reply.code(400).send({ error: { code: "invalid_request", message } });
const numericId = (value: string): number => Number(value);

const endpointNotFound = (reply: FastifyReply) =>
  reply.code(404).send({ error: { code: "endpoint_not_found", message: "Integration endpoint not found" } });

const handleManagerError = (reply: FastifyReply, error: unknown) => {
  if (!(error instanceof IntegrationEndpointManagerError)) throw error;
  if (error.code === "endpoint_not_found") return endpointNotFound(reply);
  if (error.code === "agent_not_found") {
    return reply.code(404).send({ error: { code: "agent_not_found", message: "Agent not found" } });
  }
  if (error.code === "slug_conflict") {
    return reply.code(409).send({
      error: { code: "slug_conflict", message: "Integration endpoint slug already exists" }
    });
  }
  if (error.code === "endpoint_in_use" || error.code === "conversation_busy") {
    return reply.code(409).send({
      error: {
        code: error.code,
        message: error.code === "endpoint_in_use"
          ? "Integration endpoint has history and cannot be deleted"
          : "Integration endpoint has active work and cannot change Agent"
      }
    });
  }
  return reply.code(400).send({
    error: { code: error.code, message: "Invalid Integration Endpoint input" }
  });
};

const webhookNotFound = (reply: FastifyReply) =>
  reply.code(404).send({ error: { code: "webhook_not_found", message: "Webhook subscription not found" } });

const deliveryNotFound = (reply: FastifyReply) =>
  reply.code(404).send({ error: { code: "delivery_not_found", message: "Webhook delivery not found" } });

const handleTestTaskError = (reply: FastifyReply, error: unknown) => {
  if (error instanceof IntegrationCoordinatorError && error.code === "endpoint_disabled") {
    return reply.code(409).send({ error: { code: error.code, message: "请先启用接入端点再发送测试任务" } });
  }
  if (error instanceof IntegrationEndpointManagerError) {
    const messages: Partial<Record<typeof error.code, string>> = {
      missing_request_parameter: "缺少必填的动态参数",
      unknown_request_parameter: "包含未声明的动态参数",
      invalid_parameter_mapping: "接入端点的参数映射无效"
    };
    const message = messages[error.code];
    if (message !== undefined) return reply.code(400).send({ error: { code: error.code, message } });
    return handleManagerError(reply, error);
  }
  if (error instanceof WorkspaceCreateError) {
    return reply.code(500).send({ error: { code: error.code, message: "创建测试任务工作空间失败" } });
  }
  if (error instanceof SessionManagerError) {
    return reply.code(400).send({ error: { code: error.code, message: "创建测试任务会话失败" } });
  }
  throw error;
};

const parseHeaders = (subscription: WebhookSubscription, secrets: Pick<SecretStore, "decrypt">): Record<string, string> =>
  subscription.encryptedHeaders === null
    ? {}
    : JSON.parse(secrets.decrypt(subscription.encryptedHeaders)) as Record<string, string>;

const publicWebhook = (subscription: WebhookSubscription, secrets: Pick<SecretStore, "decrypt">) => ({
  id: subscription.id,
  endpointId: subscription.endpointId,
  name: subscription.name,
  url: subscription.url,
  enabled: subscription.enabled,
  events: JSON.parse(subscription.eventsJson) as string[],
  headers: Object.keys(parseHeaders(subscription, secrets)).map((name) => ({ name, configured: true })),
  signingSecretConfigured: true,
  timeoutSeconds: subscription.timeoutSeconds,
  createdAt: subscription.createdAt,
  updatedAt: subscription.updatedAt
});

const publicDelivery = (delivery: WebhookDelivery) => ({
  id: delivery.id,
  eventId: delivery.eventId,
  sequence: delivery.sequence,
  dispatchOrder: delivery.dispatchOrder,
  subscriptionId: delivery.subscriptionId,
  taskId: delivery.taskId,
  eventType: delivery.eventType,
  status: delivery.status,
  attemptCount: delivery.attemptCount,
  nextAttemptAt: delivery.nextAttemptAt,
  lastStatusCode: delivery.lastStatusCode,
  lastDurationMs: delivery.lastDurationMs,
  lastError: delivery.lastError,
  createdAt: delivery.createdAt,
  updatedAt: delivery.updatedAt
});

const publicTask = (task: IntegrationTask) => ({
  id: task.id,
  endpointId: task.endpointId,
  conversationId: task.conversationId,
  sessionId: task.sessionId,
  runId: task.runId,
  requestId: task.requestId,
  message: task.message,
  status: task.status,
  result: task.result,
  error: task.error,
  createdAt: task.createdAt,
  startedAt: task.startedAt,
  finishedAt: task.finishedAt
});

/**
 * Registers authenticated management routes for Integration Endpoints.
 */
export const registerIntegrationAdminRoutes = (
  app: FastifyInstance,
  dependencies: {
    manager: IntegrationEndpointManager;
    store: IntegrationStore;
    secrets: SecretStore;
    dispatcher: WebhookDispatcher;
    executor: RunExecutor;
    scheduler: IntegrationTaskScheduler;
    coordinator: IntegrationCoordinator;
  }
): void => {
  const { manager, store, secrets, dispatcher, executor, scheduler, coordinator } = dependencies;
  app.get("/integration-endpoints", () => {
    const summaries = new Map(store.listEndpointManagementSummaries().map((summary) => [summary.endpointId, summary]));
    return manager.list().map((endpoint) => {
      const summary = summaries.get(endpoint.id);
      return {
        ...endpoint,
        activeConversationCount: summary?.activeConversationCount ?? 0,
        activeTaskCount: summary?.activeTaskCount ?? 0,
        latestTask: summary?.latestTask ?? null
      };
    });
  });

  app.get<{ Params: { id: string } }>("/integration-endpoints/:id", (request, reply) => {
    const endpoint = manager.get(numericId(request.params.id));
    return endpoint === undefined ? endpointNotFound(reply) : endpoint;
  });

  app.post("/integration-endpoints", (request, reply) => {
    const parsed = createEndpointSchema.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply, "Invalid Integration Endpoint input");
    try {
      return reply.code(201).send(manager.create(parsed.data));
    } catch (error) {
      return handleManagerError(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/integration-endpoints/:id", (request, reply) => {
    const parsed = updateEndpointSchema.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply, "Invalid Integration Endpoint update");
    try {
      return manager.update(numericId(request.params.id), parsed.data);
    } catch (error) {
      return handleManagerError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/integration-endpoints/:id/rotate-token", (request, reply) => {
    const parsed = rotateTokenSchema.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply, "Invalid Integration Endpoint token rotation");
    try {
      return manager.rotateToken(numericId(request.params.id));
    } catch (error) {
      return handleManagerError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/integration-endpoints/:id", (request, reply) => {
    try {
      manager.delete(numericId(request.params.id));
      return reply.code(204).send();
    } catch (error) {
      return handleManagerError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/integration-endpoints/:id/conversations", (request, reply) => {
    const endpointId = numericId(request.params.id);
    if (manager.get(endpointId) === undefined) return endpointNotFound(reply);
    return store.listConversations(endpointId);
  });

  app.get<{ Params: { id: string } }>("/integration-endpoints/:id/tasks", (request, reply) => {
    const endpointId = numericId(request.params.id);
    if (manager.get(endpointId) === undefined) return endpointNotFound(reply);
    return store.listTasks(endpointId).map(publicTask);
  });

  app.post<{ Params: { id: string } }>("/integration-endpoints/:id/test-tasks", async (request, reply) => {
    const endpoint = manager.get(numericId(request.params.id));
    if (endpoint === undefined) return endpointNotFound(reply);
    const parsed = testTaskSchema.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply, "测试任务参数无效");
    try {
      const task = await coordinator.submit(endpoint, {
        requestId: `test-${randomUUID()}`,
        conversationKey: parsed.data.conversationKey,
        message: parsed.data.message,
        parameters: parsed.data.parameters
      });
      return reply.code(202).send(publicTask(task));
    } catch (error) {
      return handleTestTaskError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/integration-tasks/:id", (request, reply) => {
    const task = store.getTask(numericId(request.params.id));
    if (task === undefined) {
      return reply.code(404).send({ error: { code: "task_not_found", message: "Integration task not found" } });
    }
    return publicTask(task);
  });

  app.post<{ Params: { id: string } }>("/integration-tasks/:id/cancel", async (request, reply) => {
    let task = store.getTask(numericId(request.params.id));
    if (task === undefined) {
      return reply.code(404).send({ error: { code: "task_not_found", message: "Integration task not found" } });
    }
    if (task.status === "succeeded" || task.status === "failed" || task.status === "cancelled") return publicTask(task);
    if (task.status === "queued" && task.runId === null) {
      const cancelled = store.cancelUnlinkedQueuedTask(task.id, task.endpointId);
      if (cancelled !== undefined) {
        scheduler.notify();
        return publicTask(cancelled);
      }
      task = store.getTask(task.id)!;
    }
    if (task.runId === null) {
      return reply.code(409).send({ error: { code: "task_cancel_failed", message: "Integration task cannot be cancelled" } });
    }
    try {
      await executor.cancel(task.runId);
      return publicTask(store.getTask(task.id)!);
    } catch (_error) {
      const current = store.getTask(task.id);
      if (current !== undefined && ["succeeded", "failed", "cancelled"].includes(current.status)) return publicTask(current);
      return reply.code(409).send({ error: { code: "task_cancel_failed", message: "Integration task cannot be cancelled" } });
    }
  });

  app.get<{ Params: { id: string } }>("/integration-endpoints/:id/webhooks", (request, reply) => {
    const endpointId = numericId(request.params.id);
    if (manager.get(endpointId) === undefined) return endpointNotFound(reply);
    return store.listSubscriptions(endpointId).map((subscription) => publicWebhook(subscription, secrets));
  });

  app.post<{ Params: { id: string } }>("/integration-endpoints/:id/webhooks", (request, reply) => {
    const endpointId = numericId(request.params.id);
    if (manager.get(endpointId) === undefined) return endpointNotFound(reply);
    const parsed = webhookSchema.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply, "Invalid Webhook input");
    const signingSecret = `whsec_${randomBytes(32).toString("base64url")}`;
    const subscription = store.createSubscription({
      endpointId,
      name: parsed.data.name,
      url: parsed.data.url,
      enabled: parsed.data.enabled,
      eventsJson: JSON.stringify(parsed.data.events),
      encryptedHeaders: Object.keys(parsed.data.headers).length === 0
        ? null
        : secrets.encrypt(JSON.stringify(parsed.data.headers)),
      encryptedSigningSecret: secrets.encrypt(signingSecret),
      timeoutSeconds: parsed.data.timeoutSeconds
    });
    return reply.code(201).send({ webhook: publicWebhook(subscription, secrets), signingSecret });
  });

  app.patch<{ Params: { id: string; webhookId: string } }>(
    "/integration-endpoints/:id/webhooks/:webhookId",
    (request, reply) => {
      const endpointId = numericId(request.params.id);
      if (manager.get(endpointId) === undefined) return endpointNotFound(reply);
      const existing = store.getSubscriptionForEndpoint(numericId(request.params.webhookId), endpointId);
      if (existing === undefined) return webhookNotFound(reply);
      const parsed = updateWebhookSchema.safeParse(request.body);
      if (!parsed.success) return invalidRequest(reply, "Invalid Webhook update");
      const currentHeaders = parseHeaders(existing, secrets);
      const headers = parsed.data.headers ?? currentHeaders;
      const updated = store.updateSubscription(existing.id, {
        name: parsed.data.name ?? existing.name,
        url: parsed.data.url ?? existing.url,
        enabled: parsed.data.enabled ?? existing.enabled,
        eventsJson: JSON.stringify(parsed.data.events ?? JSON.parse(existing.eventsJson) as string[]),
        encryptedHeaders: Object.keys(headers).length === 0 ? null : secrets.encrypt(JSON.stringify(headers)),
        encryptedSigningSecret: existing.encryptedSigningSecret,
        timeoutSeconds: parsed.data.timeoutSeconds ?? existing.timeoutSeconds
      })!;
      dispatcher.notify();
      return publicWebhook(updated, secrets);
    }
  );

  app.post<{ Params: { id: string; webhookId: string } }>(
    "/integration-endpoints/:id/webhooks/:webhookId/rotate-secret",
    (request, reply) => {
      const endpointId = numericId(request.params.id);
      if (manager.get(endpointId) === undefined) return endpointNotFound(reply);
      const existing = store.getSubscriptionForEndpoint(numericId(request.params.webhookId), endpointId);
      if (existing === undefined) return webhookNotFound(reply);
      const signingSecret = `whsec_${randomBytes(32).toString("base64url")}`;
      const updated = store.updateSubscription(existing.id, {
        name: existing.name,
        url: existing.url,
        enabled: existing.enabled,
        eventsJson: existing.eventsJson,
        encryptedHeaders: existing.encryptedHeaders,
        encryptedSigningSecret: secrets.encrypt(signingSecret),
        timeoutSeconds: existing.timeoutSeconds
      })!;
      return { webhook: publicWebhook(updated, secrets), signingSecret };
    }
  );

  app.delete<{ Params: { id: string; webhookId: string } }>(
    "/integration-endpoints/:id/webhooks/:webhookId",
    (request, reply) => {
      const endpointId = numericId(request.params.id);
      if (manager.get(endpointId) === undefined) return endpointNotFound(reply);
      const existing = store.getSubscriptionForEndpoint(numericId(request.params.webhookId), endpointId);
      if (existing === undefined) return webhookNotFound(reply);
      store.deleteSubscription(existing.id);
      return reply.code(204).send();
    }
  );

  app.post<{ Params: { id: string; webhookId: string } }>(
    "/integration-endpoints/:id/webhooks/:webhookId/test",
    (request, reply) => {
      const endpointId = numericId(request.params.id);
      if (manager.get(endpointId) === undefined) return endpointNotFound(reply);
      const subscription = store.getSubscriptionForEndpoint(numericId(request.params.webhookId), endpointId);
      if (subscription === undefined) return webhookNotFound(reply);
      if (!subscription.enabled) {
        return reply.code(409).send({
          error: { code: "webhook_disabled", message: "Enable the Webhook before testing it" }
        });
      }
      const eventId = randomUUID();
      const occurredAt = new Date().toISOString();
      const eventKey = `webhook.test:${eventId}`;
      const publicEventId = webhookEventId(endpointId, eventKey);
      const endpoint = manager.get(endpointId)!;
      const delivery = store.createDelivery({
        eventId: publicEventId,
        eventKey,
        sequence: 0,
        subscriptionId: subscription.id,
        taskId: null,
        eventType: "webhook.test",
        payloadJson: JSON.stringify({
          eventId: publicEventId,
          eventType: "webhook.test",
          sequence: 0,
          occurredAt,
          endpoint: { id: endpoint.id, slug: endpoint.slug },
          task: null,
          notice: { code: "webhook_test", message: "Webhook test" }
        }),
        nextAttemptAt: occurredAt
      });
      return reply.code(202).send(publicDelivery(delivery));
    }
  );

  app.get<{ Params: { id: string } }>("/integration-endpoints/:id/webhook-deliveries", (request, reply) => {
    const endpointId = numericId(request.params.id);
    if (manager.get(endpointId) === undefined) return endpointNotFound(reply);
    return store.listDeliveriesForEndpoint(endpointId).map(publicDelivery);
  });

  app.post<{ Params: { id: string } }>("/webhook-deliveries/:id/retry", (request, reply) => {
    const existing = store.getDelivery(numericId(request.params.id));
    if (existing === undefined) return deliveryNotFound(reply);
    if (existing.status !== "failed") {
      return reply.code(409).send({
        error: { code: "delivery_not_failed", message: "Only failed Webhook deliveries can be retried" }
      });
    }
    const delivery = store.retryDelivery(existing.id)!;
    return reply.code(202).send(publicDelivery(delivery));
  });
};
