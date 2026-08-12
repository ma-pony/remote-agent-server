import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";

import { registerAgentRoutes } from "./agents/agent-routes.js";
import { AgentManager } from "./agents/agent-manager.js";
import { requireApiToken } from "./auth.js";
import type { AppConfig } from "./config.js";
import { EventStore } from "./events/event-store.js";
import { AcpxAgentRuntime } from "./runtime/acpx-runtime.js";
import type { AgentRuntime } from "./runtime/agent-runtime.js";
import { SkillProjector } from "./runtime/skill-projector.js";
import { RunExecutor } from "./runs/run-executor.js";
import { RunRepository } from "./runs/run-repository.js";
import { registerRunRoutes } from "./runs/run-routes.js";
import { RunScheduler } from "./runs/run-scheduler.js";
import { SessionManager } from "./sessions/session-manager.js";
import { registerSessionRoutes } from "./sessions/session-routes.js";
import { BtrfsWorkspaceManager, type CommandRunner, systemCommandRunner } from "./workspaces/btrfs-workspace.js";

export type AppDependencies = {
  config: AppConfig;
  db: Database.Database;
  runtime?: AgentRuntime;
  commandRunner?: CommandRunner;
  workspaceManager?: BtrfsWorkspaceManager;
  runRepository?: RunRepository;
  eventStore?: EventStore;
  skillProjector?: SkillProjector;
};

/**
 * Builds the HTTP API from the supplied infrastructure dependencies.
 */
export const buildApp = (deps: AppDependencies): FastifyInstance => {
  const app = Fastify({ forceCloseConnections: true });
  const runtime = deps.runtime ?? new AcpxAgentRuntime(deps.config);
  const agentManager = new AgentManager({
    db: deps.db,
    dataDir: deps.config.dataDir,
    runtime
  });
  const workspaceManager = deps.workspaceManager ?? new BtrfsWorkspaceManager({
    workspaceTemplate: deps.config.workspaceTemplate,
    sessionsRoot: deps.config.sessionsRoot,
    commandRunner: deps.commandRunner ?? systemCommandRunner
  });
  const sessionManager = new SessionManager({
    db: deps.db,
    dataDir: deps.config.dataDir,
    agentManager,
    runtime,
    workspaceManager
  });
  const runRepository = deps.runRepository ?? new RunRepository({ db: deps.db });
  const eventStore = deps.eventStore ?? new EventStore({ db: deps.db });
  const skillProjector = deps.skillProjector ?? new SkillProjector(deps.config.dataDir);
  const executor = new RunExecutor({ runtime, skillProjector, runRepository, eventStore, sessionManager });
  const scheduler = new RunScheduler({
    runRepository,
    executor,
    maxConcurrentRuns: deps.config.maxConcurrentRuns
  });

  app.get("/api/health", () => ({ ok: true }));
  app.register((api) => {
    api.addHook("onRequest", requireApiToken(deps.config.apiToken));
    registerAgentRoutes(api, agentManager);
    registerSessionRoutes(api, sessionManager, runRepository);
    registerRunRoutes(api, { runRepository, eventStore, sessionManager, executor, scheduler });
  }, { prefix: "/api" });
  let stopped = false;
  let shutdownError: unknown;
  app.addHook("preClose", async () => {
    if (stopped) return;
    stopped = true;
    const failures: unknown[] = [];
    try {
      await scheduler.stop();
    } catch (error) {
      failures.push(error);
    }
    try {
      await runtime.shutdown();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) shutdownError = failures[0];
    if (failures.length > 1) shutdownError = new AggregateError(failures, "Application shutdown failed");
  });
  app.addHook("onClose", async () => {
    if (shutdownError !== undefined) throw shutdownError;
  });
  scheduler.start();

  return app;
};
