import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

import type { SecretStore } from "../mcp/secret-store.js";
import { IntegrationCoordinatorError, type IntegrationCoordinator } from "./integration-coordinator.js";
import { IntegrationEndpointManagerError } from "./integration-endpoint-manager.js";
import type { IntegrationStore } from "./integration-store.js";
import type {
  ExternalIntegrationTask, IntegrationEndpoint, WebhookReceiverDetail, WebhookReceiverInput
} from "./integration-types.js";

import { WebhookIngressError } from "./webhook-adapters/adapter.js";
import { webhookAdapter } from "./webhook-adapters/index.js";
import { evaluateWebhookFilter, type WebhookFilter, type WebhookFilterEvent } from "./webhook-filter.js";

const payloadValue = (payload: Record<string, unknown>, path: string): string | undefined => {
  let value: unknown = payload;
  for (const segment of path.split(".")) {
    if (typeof value !== "object" || value === null || !Object.hasOwn(value, segment)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value) : undefined;
};

/** Shared receiver configuration and durable Task admission; provider protocols live in adapters. */
export class WebhookIngress {
  private readonly admissions = new Map<number, Promise<ExternalIntegrationTask>>();
  constructor(private readonly dependencies: {
    store: IntegrationStore;
    secrets: Pick<SecretStore, "encrypt" | "decrypt">;
    coordinator: IntegrationCoordinator;
  }) {}

  get(endpointId: number): WebhookReceiverDetail | null {
    this.requireEndpoint(endpointId);
    const receiver = this.dependencies.store.getWebhookReceiver(endpointId);
    return receiver === undefined ? null : {
      provider: receiver.provider, authMode: receiver.authMode, enabled: receiver.enabled, secretConfigured: true,
      filter: receiver.filter, filterVersion: receiver.filterVersion
    };
  }

  configure(endpointId: number, input: WebhookReceiverInput): WebhookReceiverDetail {
    this.requireEndpoint(endpointId);
    const current = this.dependencies.store.getWebhookReceiver(endpointId);
    const adapter = webhookAdapter(input.provider);
    if (!adapter.definition.authModes.includes(input.authMode)
      || (input.secret === undefined && (current === undefined || current.provider !== input.provider || current.authMode !== input.authMode))
      || (input.secret !== undefined && !adapter.validateSecret(input.secret, input.authMode))) {
      throw new WebhookIngressError("invalid_webhook_receiver");
    }
    const filter = input.filter === undefined ? (current?.provider === input.provider ? current.filter : null) : input.filter;
    const filterChanged = current !== undefined && (current.provider !== input.provider || JSON.stringify(current.filter) !== JSON.stringify(filter));
    this.dependencies.store.setWebhookReceiver(endpointId, {
      provider: input.provider,
      authMode: input.authMode,
      enabled: input.enabled,
      filter,
      filterVersion: (current?.filterVersion ?? 1) + (filterChanged ? 1 : 0),
      encryptedSecret: input.secret === undefined ? current!.encryptedSecret : this.dependencies.secrets.encrypt(input.secret)
    });
    return this.get(endpointId)!;
  }

  preview(endpointId: number, input: WebhookFilterEvent & { provider: WebhookReceiverInput["provider"]; filter: WebhookFilter | null }) {
    this.requireEndpoint(endpointId);
    const result = evaluateWebhookFilter(input.filter, input);
    const ping = input.provider === "github" && input.eventType === "ping";
    return { ...result, matched: !ping && result.matched, reason: ping ? "ping" : result.matched ? "filter_matched" : "filter_not_matched" };
  }

  receipts(endpointId: number) {
    this.requireEndpoint(endpointId);
    return this.dependencies.store.listWebhookReceipts(endpointId);
  }

  async receive(slug: string, headers: IncomingHttpHeaders, body: Buffer): Promise<
    { status: "ignored"; reason: string } | ExternalIntegrationTask
  > {
    const endpoint = this.dependencies.store.getEndpointBySlug(slug);
    const receiver = endpoint === undefined ? undefined : this.dependencies.store.getWebhookReceiver(endpoint.id);
    if (endpoint === undefined || receiver === undefined) throw new WebhookIngressError("invalid_webhook_credentials");
    const adapter = webhookAdapter(receiver.provider);
    const secret = this.dependencies.secrets.decrypt(receiver.encryptedSecret);
    const request = { headers, body };
    if (!adapter.definition.authModes.includes(receiver.authMode) || !adapter.authenticate(request, secret, receiver.authMode)) {
      throw new WebhookIngressError("invalid_webhook_credentials");
    }
    if (!endpoint.enabled || !receiver.enabled) throw new IntegrationCoordinatorError("endpoint_disabled");
    const event = adapter.normalize(request);
    let message: string;
    try {
      message = `${receiver.provider} webhook: ${event.eventType}\n\n${JSON.stringify(event.payload)}`;
    } catch {
      throw new WebhookIngressError("invalid_webhook_request");
    }
    const fingerprint = createHash("sha256").update(message).digest("hex");
    const requestId = `${receiver.provider}:${event.deliveryId}`;
    let receipt = this.dependencies.store.getWebhookReceipt(endpoint.id, receiver.provider, event.deliveryId);
    const existing = this.dependencies.store.getTaskByRequestId(endpoint.id, requestId);
    if ((receipt !== undefined && receipt.fingerprint !== fingerprint) || (existing !== undefined && existing.message !== message)) {
      throw new IntegrationCoordinatorError("idempotency_conflict");
    }
    if (receipt === undefined) {
      const matched = evaluateWebhookFilter(receiver.filter, event).matched;
      // Existing Tasks retain their admission even when upgrading from a version without receipts.
      const reason = existing !== undefined ? "filter_matched" : event.ignoreReason === "ping" ? "ping"
        : matched ? "filter_matched" : "filter_not_matched";
      receipt = this.dependencies.store.createWebhookReceipt(endpoint.id, {
        provider: receiver.provider, deliveryId: event.deliveryId, eventType: event.eventType,
        fingerprint, filterVersion: receiver.filterVersion,
        decision: reason === "filter_matched" ? "accepted" : "ignored", reason
      });
    }
    if (receipt.decision === "ignored") return { status: "ignored", reason: receipt.reason };
    if (existing !== undefined) return this.dependencies.coordinator.toExternalTask(existing);
    const pending = this.admissions.get(receipt.id);
    if (pending !== undefined) return pending;

    const parameters = Object.fromEntries(endpoint.parameterMappings.flatMap((mapping) => {
      if (mapping.source !== "request") return [];
      const value = payloadValue(event.payload, mapping.requestKey);
      return value === undefined ? [] : [[mapping.requestKey, value]];
    }));
    // The durable decision precedes admission. After a crash, look up the Task by its stable
    // requestId; if it does not exist, retry admission using the original decision.
    const admission = this.dependencies.coordinator.submit(endpoint, { requestId, message, parameters })
      .then((task) => this.dependencies.coordinator.toExternalTask(task));
    this.admissions.set(receipt.id, admission);
    try {
      return await admission;
    } finally {
      this.admissions.delete(receipt.id);
    }
  }

  private requireEndpoint(endpointId: number): IntegrationEndpoint {
    const endpoint = this.dependencies.store.getEndpoint(endpointId);
    if (endpoint === undefined) throw new IntegrationEndpointManagerError("endpoint_not_found");
    return endpoint;
  }
}
