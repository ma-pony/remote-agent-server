import type { FastifyReply, FastifyRequest } from "fastify";

import type { IntegrationEndpoint } from "./integration-types.js";
import type { IntegrationEndpointManager } from "./integration-endpoint-manager.js";

declare module "fastify" {
  interface FastifyRequest {
    integrationEndpoint: IntegrationEndpoint | null;
  }
}

const bearerToken = (authorization: string | undefined): string | undefined =>
  typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;

/**
 * Requires an Integration Endpoint Bearer token bound to the endpoint slug.
 */
export const requireIntegrationEndpoint = (manager: IntegrationEndpointManager) =>
  async (request: FastifyRequest<{ Params: { slug: string } }>, reply: FastifyReply): Promise<void> => {
    const token = bearerToken(request.headers.authorization);
    const endpoint = token === undefined ? undefined : manager.authenticate(request.params.slug, token);
    if (endpoint === undefined) {
      reply.code(401).send({
        error: { code: "invalid_endpoint_token", message: "Invalid integration endpoint token" }
      });
      return;
    }
    request.integrationEndpoint = endpoint;
  };
