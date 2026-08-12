import { createHash, timingSafeEqual } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";

const unauthorized = (reply: FastifyReply): void => {
  reply.code(401).send({ error: { code: "unauthorized", message: "Invalid API token" } });
};

const tokenDigest = (token: string): Buffer => createHash("sha256").update(token, "utf8").digest();

/**
 * Compares API tokens after normalizing them to fixed-size cryptographic digests.
 */
export const constantTimeTokenEqual = (expectedToken: string, actualToken: string): boolean =>
  timingSafeEqual(tokenDigest(expectedToken), tokenDigest(actualToken));

/**
 * Creates the API Bearer token authentication hook.
 */
export const requireApiToken = (apiToken: string) => {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const authorization = request.headers.authorization;
    const token = typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : undefined;

    if (token === undefined) {
      unauthorized(reply);
      return;
    }

    if (!constantTimeTokenEqual(apiToken, token)) {
      unauthorized(reply);
    }
  };
};
