import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

import type { SecretStore } from "../mcp/secret-store.js";
import type { SessionManager } from "../sessions/session-manager.js";
import type { IntegrationEndpointManager } from "./integration-endpoint-manager.js";
import type { IntegrationStore } from "./integration-store.js";
import type {
  ExternalIntegrationTask,
  IntegrationConversation,
  IntegrationEndpoint,
  IntegrationTask
} from "./integration-types.js";

export type SubmitIntegrationTaskInput = {
  requestId: string;
  conversationKey?: string;
  message: string;
  parameters: Record<string, string>;
};

export type IntegrationCoordinatorErrorCode =
  | "endpoint_disabled"
  | "task_not_found"
  | "conversation_not_found"
  | "idempotency_conflict"
  | "conversation_busy";

export class IntegrationCoordinatorError extends Error {
  constructor(readonly code: IntegrationCoordinatorErrorCode) {
    super(code);
    this.name = "IntegrationCoordinatorError";
  }
}

export const integrationRequestFingerprint = (input: SubmitIntegrationTaskInput): string =>
  createHash("sha256").update(JSON.stringify({
    conversationKey: input.conversationKey ?? null,
    message: input.message,
    parameters: Object.fromEntries(
      Object.entries(input.parameters).sort(([left], [right]) => left.localeCompare(right))
    )
  }), "utf8").digest("hex");

/** Coordinates external requests without performing workspace I/O inside SQLite transactions. */
export class IntegrationCoordinator {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly dependencies: {
    db: Database.Database;
    store: IntegrationStore;
    endpointManager: IntegrationEndpointManager;
    sessionManager: SessionManager;
    secrets: SecretStore;
    notifyTaskQueued?: () => void;
  }) {}

  async submit(endpoint: IntegrationEndpoint, input: SubmitIntegrationTaskInput): Promise<IntegrationTask> {
    const fingerprint = integrationRequestFingerprint(input);
    const existing = this.idempotentTask(endpoint.id, input.requestId, fingerprint);
    if (existing !== undefined) return existing;
    if (!endpoint.enabled) throw new IntegrationCoordinatorError("endpoint_disabled");

    const lockKey = `${endpoint.id}:${input.conversationKey ?? input.requestId}`;
    return this.withKeyedLock(lockKey, async () => {
      const repeated = this.idempotentTask(endpoint.id, input.requestId, fingerprint);
      if (repeated !== undefined) return repeated;

      const resolvedParameters = this.dependencies.endpointManager.resolveRequest(endpoint.id, input.parameters);
      const encryptedParameters = this.dependencies.secrets.encrypt(JSON.stringify(resolvedParameters));
      const effectivePrompt = this.effectivePrompt(endpoint.promptPrefix, input.message);
      const activeConversation = input.conversationKey === undefined
        ? undefined
        : this.dependencies.store.getActiveConversation(endpoint.id, input.conversationKey);
      const createdSession = activeConversation === undefined
        ? await this.dependencies.sessionManager.create({
          agentId: endpoint.agentId,
          title: endpoint.name,
          mcpParameters: resolvedParameters
        })
        : undefined;

      try {
        const task = this.inImmediateTransaction(() => {
          const duplicate = this.idempotentTask(endpoint.id, input.requestId, fingerprint);
          if (duplicate !== undefined) return duplicate;

          const conversation = input.conversationKey === undefined
            ? undefined
            : this.dependencies.store.getActiveConversation(endpoint.id, input.conversationKey)
              ?? this.dependencies.store.createConversationInTransaction({
                endpointId: endpoint.id,
                conversationKey: input.conversationKey,
                sessionId: createdSession!.id
              });
          const sessionId = conversation?.sessionId ?? createdSession!.id;
          const createdTask = this.dependencies.store.createTaskInTransaction({
            endpointId: endpoint.id,
            conversationId: conversation?.id ?? null,
            sessionId,
            requestId: input.requestId,
            requestFingerprint: fingerprint,
            message: input.message,
            effectivePrompt,
            encryptedParameters
          });
          this.dependencies.store.appendTaskEventInTransaction({
            taskId: createdTask.id,
            eventType: "task.queued",
            eventKey: `${createdTask.id}:task.queued`,
            occurredAt: createdTask.createdAt,
            payload: { status: "queued" }
          });
          this.dependencies.store.appendTaskEventInTransaction({
            taskId: createdTask.id,
            eventType: "message.user.received",
            eventKey: `${createdTask.id}:message.user.received`,
            occurredAt: createdTask.createdAt,
            payload: { message: input.message }
          });
          return this.dependencies.store.getTask(createdTask.id)!;
        });

        if (createdSession !== undefined && task.sessionId !== createdSession.id) {
          await this.deleteCreatedSession(createdSession.id);
        }
        this.dependencies.notifyTaskQueued?.();
        return task;
      } catch (error) {
        if (createdSession !== undefined) await this.deleteCreatedSession(createdSession.id);
        throw error;
      }
    });
  }

  async endConversation(endpointId: string, conversationKey: string): Promise<IntegrationConversation> {
    return this.withKeyedLock(`${endpointId}:${conversationKey}`, async () => this.inImmediateTransaction(() => {
      const active = this.dependencies.store.getActiveConversation(endpointId, conversationKey);
      if (active === undefined) {
        const latest = this.dependencies.store.getLatestConversation(endpointId, conversationKey);
        if (latest === undefined) throw new IntegrationCoordinatorError("conversation_not_found");
        return latest;
      }
      if (this.dependencies.store.conversationHasActiveTasks(active.id)) {
        throw new IntegrationCoordinatorError("conversation_busy");
      }
      return this.dependencies.store.endConversationInTransaction(active.id)!;
    }));
  }

  getTaskForEndpoint(id: string, endpointId: string): IntegrationTask | undefined {
    return this.dependencies.store.getTaskForEndpoint(id, endpointId);
  }

  toExternalTask(task: IntegrationTask): ExternalIntegrationTask {
    const conversationKey = task.conversationId === null
      ? null
      : this.dependencies.store.getConversation(task.conversationId)?.conversationKey ?? null;
    return {
      taskId: task.id,
      requestId: task.requestId,
      conversationKey,
      sessionId: task.sessionId,
      runId: task.runId,
      status: task.status
    };
  }

  getConversation(endpointId: string, conversationKey: string): IntegrationConversation | undefined {
    return this.dependencies.store.getActiveConversation(endpointId, conversationKey)
      ?? this.dependencies.store.getLatestConversation(endpointId, conversationKey);
  }

  private idempotentTask(endpointId: string, requestId: string, fingerprint: string): IntegrationTask | undefined {
    const task = this.dependencies.store.getTaskByRequestId(endpointId, requestId);
    if (task !== undefined && task.requestFingerprint !== fingerprint) {
      throw new IntegrationCoordinatorError("idempotency_conflict");
    }
    return task;
  }

  private effectivePrompt(prefixValue: string, message: string): string {
    const prefix = prefixValue.trim();
    return prefix === "" ? message : `${prefix}\n\n${message}`;
  }

  private async deleteCreatedSession(id: string): Promise<void> {
    try {
      await this.dependencies.sessionManager.delete(id);
    } catch (_cleanupError) {
      // The Task transaction result remains authoritative; cleanup was still attempted.
    }
  }

  private inImmediateTransaction<T>(operation: () => T): T {
    this.dependencies.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.dependencies.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.dependencies.db.exec("ROLLBACK");
      throw error;
    }
  }

  private async withKeyedLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }
}
