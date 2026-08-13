import type { FastifyInstance } from "fastify";

import { requireIntegrationEndpoint } from "./integration-auth.js";
import type { IntegrationEndpointManager } from "./integration-endpoint-manager.js";

/**
 * Registers the authenticated external Integration API scope.
 * Task handlers are registered in the subsequent integration task.
 */
export const registerIntegrationRoutes = (app: FastifyInstance, manager: IntegrationEndpointManager): void => {
  app.all<{ Params: { slug: string } }>("/integration/v1/endpoints/:slug/*", {
    onRequest: requireIntegrationEndpoint(manager)
  }, (_request, reply) => reply.code(404).send({
    error: { code: "not_found", message: "Integration route not found" }
  }));
};
