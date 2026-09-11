import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { IntegrationEndpointManagerError } from "./integration-endpoint-manager.js";
import { handleIntegrationError } from "./integration-routes.js";
import { webhookProviderIds } from "./integration-types.js";
import { WebhookIngressError } from "./webhook-adapters/adapter.js";
import { listWebhookProviders } from "./webhook-adapters/index.js";
import { WebhookIngress } from "./webhook-ingress.js";

const receiverSchema = z.object({
  provider: z.enum(webhookProviderIds),
  authMode: z.enum(["signature", "token"]),
  enabled: z.boolean(),
  secret: z.string().min(1).max(1024).refine((value) => value.trim() !== "").optional()
}).strict();

const handleIngressError = (reply: FastifyReply, error: unknown) => {
  if (error instanceof WebhookIngressError) {
    const messages = {
      invalid_webhook_credentials: "Invalid webhook credentials",
      invalid_webhook_request: "Invalid native webhook request",
      invalid_webhook_receiver: "Invalid authentication mode or secret; new receivers and provider or mode changes require a secret"
    };
    return reply.code(error.code === "invalid_webhook_credentials" ? 401 : 400)
      .send({ error: { code: error.code, message: messages[error.code] } });
  }
  if (error instanceof IntegrationEndpointManagerError && error.code === "endpoint_not_found") {
    return reply.code(404).send({ error: { code: error.code, message: "Integration Endpoint not found" } });
  }
  return handleIntegrationError(reply, error);
};

/** Registered within the management API's authentication scope. */
export const registerWebhookReceiverAdminRoutes = (app: FastifyInstance, ingress: WebhookIngress): void => {
  app.get("/integration-webhook-providers", () => listWebhookProviders());
  app.get<{ Params: { id: string } }>("/integration-endpoints/:id/webhook-receiver", (request, reply) => {
    try {
      return reply.send(ingress.get(Number(request.params.id)));
    } catch (error) {
      return handleIngressError(reply, error);
    }
  });
  app.put<{ Params: { id: string } }>("/integration-endpoints/:id/webhook-receiver", (request, reply) => {
    const parsed = receiverSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "invalid_request", message: "Invalid webhook receiver configuration" } });
    }
    try {
      return ingress.configure(Number(request.params.id), parsed.data);
    } catch (error) {
      return handleIngressError(reply, error);
    }
  });
};

/** Isolate raw-body parsing so other JSON API routes keep their existing contract. */
export const registerWebhookIngressRoutes = (app: FastifyInstance, ingress: WebhookIngress): void => {
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(["application/json", "application/x-www-form-urlencoded"], { parseAs: "buffer" },
      (_request, body, done) => done(null, body));
    scope.post<{ Params: { slug: string }; Body: Buffer }>("/integration/v1/endpoints/:slug/webhook", async (request, reply) => {
      try {
        const result = await ingress.receive(request.params.slug, request.headers, request.body);
        return reply.code(result.status === "ignored" ? 200 : 202).send(result);
      } catch (error) {
        return handleIngressError(reply, error);
      }
    });
  });
};
