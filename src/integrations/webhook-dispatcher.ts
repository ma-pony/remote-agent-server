import { createHmac } from "node:crypto";

import type { SecretStore } from "../mcp/secret-store.js";
import { settleBestEffort } from "../runtime/bounded-operation.js";
import type { IntegrationStore } from "./integration-store.js";
import type { WebhookDelivery } from "./integration-types.js";

const RETRY_DELAYS_MS = [10_000, 60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000] as const;
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const STOP_WAIT_MS = 5_000;

type WebhookDispatcherDependencies = {
  store: IntegrationStore;
  secrets: Pick<SecretStore, "decrypt">;
  fetch?: typeof fetch;
};

const customHeaders = (serialized: string | null, secrets: Pick<SecretStore, "decrypt">): Record<string, string> => {
  if (serialized === null) return {};
  const value = JSON.parse(secrets.decrypt(serialized)) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid_webhook_headers");
  }
  for (const headerValue of Object.values(value)) {
    if (typeof headerValue !== "string") throw new Error("invalid_webhook_headers");
  }
  return value as Record<string, string>;
};

const deliveryFailure = (error: unknown, timedOut: boolean): string => {
  if (timedOut) return "Webhook request timed out";
  if (error instanceof Error && /^HTTP \d{3}$/.test(error.message)) return error.message;
  return "Webhook request failed";
};

/** Delivers committed Webhook outbox rows without polling. */
export class WebhookDispatcher {
  private readonly fetch: typeof fetch;
  private started = false;
  private draining = false;
  private notifiedWhileDraining = false;
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly active = new Map<string, { deliveryId: string; promise: Promise<void>; controller: AbortController }>();

  constructor(private readonly dependencies: WebhookDispatcherDependencies) {
    this.fetch = dependencies.fetch ?? globalThis.fetch;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.dependencies.store.subscribeDeliveries(() => this.notify());
    this.notify();
  }

  notify(): void {
    if (!this.started) return;
    if (this.draining) {
      this.notifiedWhileDraining = true;
      return;
    }
    this.clearDeadline();
    this.draining = true;
    try {
      do {
        this.notifiedWhileDraining = false;
        const due = this.dependencies.store.listDueDeliveries(new Date().toISOString());
        for (const delivery of due) {
          if (!this.active.has(delivery.subscriptionId)) this.startDelivery(delivery);
        }
      } while (this.notifiedWhileDraining && this.started);
    } finally {
      this.draining = false;
      this.scheduleDeadline();
    }
  }

  async deliver(id: string): Promise<void> {
    const current = this.dependencies.store.getDelivery(id);
    if (current === undefined || this.active.has(current.subscriptionId)) return;
    const controller = new AbortController();
    const promise = this.runDelivery(id, controller).finally(() => {
      const active = this.active.get(current.subscriptionId);
      if (active?.promise === promise) this.active.delete(current.subscriptionId);
      if (this.started) this.notify();
    });
    this.active.set(current.subscriptionId, { deliveryId: current.id, promise, controller });
    await promise;
  }

  recover(): number {
    return this.dependencies.store.recoverDeliveries();
  }

  async stop(): Promise<void> {
    if (!this.started && this.active.size === 0) return;
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.clearDeadline();
    const active = [...this.active.values()];
    for (const { controller } of active) controller.abort("dispatcher_stopped");
    await Promise.race([
      Promise.allSettled(active.map(({ promise }) => promise)).then(() => undefined),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, STOP_WAIT_MS);
        timer.unref?.();
      })
    ]);
    for (const { deliveryId } of this.active.values()) this.dependencies.store.releaseDelivery(deliveryId);
  }

  private startDelivery(delivery: WebhookDelivery): void {
    const controller = new AbortController();
    const promise = this.runDelivery(delivery.id, controller).finally(() => {
      const active = this.active.get(delivery.subscriptionId);
      if (active?.promise === promise) this.active.delete(delivery.subscriptionId);
      if (this.started) this.notify();
    });
    this.active.set(delivery.subscriptionId, { deliveryId: delivery.id, promise, controller });
  }

  private async runDelivery(id: string, controller: AbortController): Promise<void> {
    try {
      await this.deliverClaimed(id, controller);
    } catch (_error) {
      try {
        this.dependencies.store.releaseDelivery(id);
      } catch (_releaseError) {
        // A closed/unavailable store is recovered from durable state on the next process start.
      }
    }
  }

  private async deliverClaimed(id: string, stopController: AbortController): Promise<void> {
    const claimed = this.dependencies.store.claimDelivery(id);
    if (claimed === undefined) return;
    const subscription = this.dependencies.store.getSubscription(claimed.subscriptionId);
    if (subscription === undefined || !subscription.enabled) {
      this.dependencies.store.releaseDelivery(claimed.id);
      return;
    }

    const startedAt = Date.now();
    const timeoutSignal = AbortSignal.timeout(subscription.timeoutSeconds * 1_000);
    const signal = AbortSignal.any([stopController.signal, timeoutSignal]);
    let statusCode: number | null = null;
    try {
      const timestamp = Math.floor(Date.now() / 1_000).toString();
      const signingSecret = this.dependencies.secrets.decrypt(subscription.encryptedSigningSecret);
      const signature = createHmac("sha256", signingSecret)
        .update(`${timestamp}.${claimed.payloadJson}`)
        .digest("hex");
      const headers = new Headers(customHeaders(subscription.encryptedHeaders, this.dependencies.secrets));
      headers.set("content-type", "application/json");
      headers.set("x-remote-agent-event", claimed.eventType);
      headers.set("x-remote-agent-event-id", claimed.eventId);
      headers.set("x-remote-agent-timestamp", timestamp);
      headers.set("x-remote-agent-signature", `v1=${signature}`);
      const response = await this.fetch(subscription.url, {
        method: "POST",
        headers,
        body: claimed.payloadJson,
        redirect: "manual",
        signal
      });
      statusCode = response.status;
      if (response.body !== null) await settleBestEffort(() => response.body!.cancel());
      if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
      this.dependencies.store.markDeliverySucceeded(claimed.id, {
        statusCode: response.status,
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      if (stopController.signal.aborted) {
        this.dependencies.store.releaseDelivery(claimed.id);
        return;
      }
      const terminal = claimed.attemptCount >= MAX_ATTEMPTS;
      const retryDelay = RETRY_DELAYS_MS[Math.min(claimed.attemptCount - 1, RETRY_DELAYS_MS.length - 1)] ?? 0;
      this.dependencies.store.markDeliveryFailed(claimed.id, {
        terminal,
        nextAttemptAt: new Date(Date.now() + retryDelay).toISOString(),
        statusCode,
        durationMs: Date.now() - startedAt,
        error: deliveryFailure(error, timeoutSignal.aborted)
      });
    }
  }

  private scheduleDeadline(): void {
    if (!this.started || this.deadlineTimer !== undefined) return;
    const next = this.dependencies.store.nextPendingDeliveryAt();
    if (next === undefined) return;
    const delay = Math.max(0, new Date(next).getTime() - Date.now());
    this.deadlineTimer = setTimeout(() => {
      this.deadlineTimer = undefined;
      this.notify();
    }, delay);
    this.deadlineTimer.unref?.();
  }

  private clearDeadline(): void {
    if (this.deadlineTimer !== undefined) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = undefined;
  }
}
