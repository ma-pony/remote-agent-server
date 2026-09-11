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
  constructor(private readonly dependencies: {
    store: IntegrationStore;
    secrets: Pick<SecretStore, "encrypt" | "decrypt">;
    coordinator: IntegrationCoordinator;
  }) {}

  get(endpointId: number): WebhookReceiverDetail | null {
    this.requireEndpoint(endpointId);
    const receiver = this.dependencies.store.getWebhookReceiver(endpointId);
    return receiver === undefined ? null : {
      provider: receiver.provider, authMode: receiver.authMode, enabled: receiver.enabled, secretConfigured: true
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
    this.dependencies.store.setWebhookReceiver(endpointId, {
      provider: input.provider,
      authMode: input.authMode,
      enabled: input.enabled,
      encryptedSecret: input.secret === undefined ? current!.encryptedSecret : this.dependencies.secrets.encrypt(input.secret)
    });
    return this.get(endpointId)!;
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
    if (event.ignoreReason !== undefined) return { status: "ignored", reason: event.ignoreReason };

    const parameters = Object.fromEntries(endpoint.parameterMappings.flatMap((mapping) => {
      if (mapping.source !== "request") return [];
      const value = payloadValue(event.payload, mapping.requestKey);
      return value === undefined ? [] : [[mapping.requestKey, value]];
    }));
    let message: string;
    try {
      message = `${receiver.provider} webhook: ${event.eventType}\n\n${JSON.stringify(event.payload)}`;
    } catch {
      throw new WebhookIngressError("invalid_webhook_request");
    }
    const task = await this.dependencies.coordinator.submit(endpoint, {
      requestId: `${receiver.provider}:${event.deliveryId}`, message, parameters
    });
    return this.dependencies.coordinator.toExternalTask(task);
  }

  private requireEndpoint(endpointId: number): IntegrationEndpoint {
    const endpoint = this.dependencies.store.getEndpoint(endpointId);
    if (endpoint === undefined) throw new IntegrationEndpointManagerError("endpoint_not_found");
    return endpoint;
  }
}
