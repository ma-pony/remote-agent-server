import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";

import { registerAgentRoutes } from "./agents/agent-routes.js";
import { AgentManager } from "./agents/agent-manager.js";
import { requireApiToken } from "./auth.js";
import type { AppConfig } from "./config.js";
import type { AgentRuntime } from "./runtime/agent-runtime.js";

export type AppDependencies = {
  config: AppConfig;
  db: Database.Database;
  runtime: AgentRuntime;
};

/**
 * Builds the HTTP API from the supplied infrastructure dependencies.
 */
export const buildApp = (deps: AppDependencies): FastifyInstance => {
  const app = Fastify();
  const agentManager = new AgentManager({
    db: deps.db,
    dataDir: deps.config.dataDir,
    runtime: deps.runtime
  });

  app.get("/api/health", () => ({ ok: true }));
  app.register((api) => {
    api.addHook("onRequest", requireApiToken(deps.config.apiToken));
    registerAgentRoutes(api, agentManager);
  }, { prefix: "/api" });

  return app;
};
