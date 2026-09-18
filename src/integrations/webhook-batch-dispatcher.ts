import { z } from "zod";

import type { SecretStore } from "../mcp/secret-store.js";
import type { IntegrationCoordinator } from "./integration-coordinator.js";
import type { IntegrationStore } from "./integration-store.js";

const inputSchema = z.object({ message: z.string(), parameters: z.record(z.string(), z.string()) }).strict();

/** Durable debounce before Task/Session admission. One bounded drain runs at a time. */
export class WebhookBatchDispatcher {
  private started = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private draining: Promise<void> | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly dependencies: {
    store: IntegrationStore;
    secrets: Pick<SecretStore, "decrypt">;
    coordinator: IntegrationCoordinator;
  }) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.dependencies.store.subscribeWebhookBatches(() => this.schedule());
    this.schedule();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.draining;
  }

  private tick(): void {
    if (!this.started) return;
    this.timer = undefined;
    this.draining = this.drain().catch(() => {
      // A database error must not stop recovery or expose payloads/credentials in logs.
      console.error("webhook_batch_scan_failed");
      this.scheduleRetry();
    }).finally(() => {
      this.draining = undefined;
      if (this.timer === undefined) this.schedule();
    });
  }

  private schedule(): void {
    if (!this.started || this.draining !== undefined) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    try {
      const dueAt = this.dependencies.store.nextWebhookBatchDueAt();
      if (dueAt === undefined) return;
      this.timer = setTimeout(() => this.tick(), Math.max(1, Math.min(2_147_483_647, dueAt - Date.now())));
      this.timer.unref?.();
    } catch {
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (!this.started) return;
    this.timer = setTimeout(() => this.tick(), 1_000);
    this.timer.unref?.();
  }

  private async drain(): Promise<void> {
    const { store, coordinator, secrets } = this.dependencies;
    for (const id of store.listDueWebhookBatchIds(Date.now())) {
      if (!this.started) return;
      const current = store.getWebhookBatch(id);
      if (current === undefined || current.status === "completed" || current.dueAt > Date.now()) continue;
      const endpoint = store.getEndpoint(current.endpointId);
      const receiver = store.getWebhookReceiver(current.endpointId);
      if (!endpoint?.enabled || !receiver?.enabled || receiver.provider !== current.provider) continue;
      const batch = store.claimWebhookBatch(id)!;
      try {
        // A crash after Task commit but before marking the batch complete reuses that Task.
        if (store.getTaskByRequestId(batch.endpointId, batch.requestId) === undefined) {
          const input = inputSchema.parse(JSON.parse(secrets.decrypt(batch.encryptedInput!)));
          await coordinator.submit(endpoint, { ...input, requestId: batch.requestId });
        }
        store.completeWebhookBatch(id);
      } catch {
        // Keep the frozen payload and request ID. Retry without requiring platform redelivery.
        store.retryWebhookBatch(id, Date.now() + 30_000);
      }
    }
  }
}
