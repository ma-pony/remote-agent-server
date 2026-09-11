import { webhookProviderIds, type WebhookProvider, type WebhookProviderDefinition } from "../integration-types.js";
import type { WebhookAdapter } from "./adapter.js";
import { githubWebhookAdapter } from "./github.js";
import { gitlabWebhookAdapter } from "./gitlab.js";

const adapters: Record<WebhookProvider, WebhookAdapter> = {
  github: githubWebhookAdapter,
  gitlab: gitlabWebhookAdapter
};

export const webhookAdapter = (provider: WebhookProvider): WebhookAdapter => adapters[provider];
export const listWebhookProviders = (): WebhookProviderDefinition[] =>
  webhookProviderIds.map((id) => adapters[id].definition);
