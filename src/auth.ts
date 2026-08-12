import { timingSafeEqual } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";

const unauthorized = (reply: FastifyReply): void => {
  reply.code(401).send({ error: { code: "unauthorized", message: "Invalid API token" } });
};

/**
 * Creates the API Bearer token authentication hook.
 */
export const requireApiToken = (apiToken: string) => {
  const expected = Buffer.from(apiToken, "utf8");

  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const authorization = request.headers.authorization;
    const token = typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : undefined;

    if (token === undefined) {
      unauthorized(reply);
      return;
    }

    const actual = Buffer.from(token, "utf8");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      unauthorized(reply);
    }
  };
};
