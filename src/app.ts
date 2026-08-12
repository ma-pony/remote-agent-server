import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";

import { registerAgentRoutes } from "./agents/agent-routes.js";
import { AgentManager } from "./agents/agent-manager.js";
import { requireApiToken } from "./auth.js";
import type { AppConfig } from "./config.js";
import type { AgentRuntime } from "./runtime/agent-runtime.js";
import { SessionManager } from "./sessions/session-manager.js";
import { registerSessionRoutes } from "./sessions/session-routes.js";
import { BtrfsWorkspaceManager, type CommandRunner, systemCommandRunner } from "./workspaces/btrfs-workspace.js";

export type AppDependencies = {
  config: AppConfig;
  db: Database.Database;
  runtime: AgentRuntime;
  commandRunner?: CommandRunner;
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
  const workspaceManager = new BtrfsWorkspaceManager({
    workspaceTemplate: deps.config.workspaceTemplate,
    sessionsRoot: deps.config.sessionsRoot,
    commandRunner: deps.commandRunner ?? systemCommandRunner
  });
  const sessionManager = new SessionManager({
    db: deps.db,
    dataDir: deps.config.dataDir,
    agentManager,
    runtime: deps.runtime,
    workspaceManager
  });

  app.get("/api/health", () => ({ ok: true }));
  app.register((api) => {
    api.addHook("onRequest", requireApiToken(deps.config.apiToken));
    registerAgentRoutes(api, agentManager);
    registerSessionRoutes(api, sessionManager);
  }, { prefix: "/api" });

  return app;
};
