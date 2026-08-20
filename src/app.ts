import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";

import { registerAgentRoutes } from "./agents/agent-routes.js";
import { AgentManager } from "./agents/agent-manager.js";
import { requireApiToken } from "./auth.js";
import type { AppConfig } from "./config.js";
import { EventStore } from "./events/event-store.js";
import { registerIntegrationAdminRoutes } from "./integrations/integration-admin-routes.js";
import { IntegrationCoordinator } from "./integrations/integration-coordinator.js";
import { IntegrationEndpointManager } from "./integrations/integration-endpoint-manager.js";
import { IntegrationProjection } from "./integrations/integration-projection.js";
import { registerIntegrationRoutes } from "./integrations/integration-routes.js";
import {
  IntegrationTaskScheduler,
  reportIntegrationSchedulerError
} from "./integrations/integration-scheduler.js";
import { IntegrationStore } from "./integrations/integration-store.js";
import { WebhookDispatcher } from "./integrations/webhook-dispatcher.js";
import { SdkMcpChecker, type McpChecker } from "./mcp/mcp-checker.js";
import { McpManager } from "./mcp/mcp-manager.js";
import { registerMcpRoutes } from "./mcp/mcp-routes.js";
import { RunMcpPreparer } from "./mcp/run-mcp-preparer.js";
import { SecretStore } from "./mcp/secret-store.js";
import { ProjectEnvironmentBuilder } from "./project-environments/project-environment-builder.js";
import { SystemProjectEnvironmentCommands } from "./project-environments/project-environment-commands.js";
import { registerProjectEnvironmentRoutes } from "./project-environments/project-environment-routes.js";
import {
  ProjectEnvironmentScheduler,
  type ProjectEnvironmentCheckScheduler
} from "./project-environments/project-environment-scheduler.js";
import { ProjectEnvironmentStore } from "./project-environments/project-environment-store.js";
import { AcpxAgentRuntime } from "./runtime/acpx-runtime.js";
import type { AgentRuntime } from "./runtime/agent-runtime.js";
import { SkillProjector } from "./runtime/skill-projector.js";
import { SkillManager } from "./skills/skill-manager.js";
import { RunExecutor } from "./runs/run-executor.js";
import { RunRepository } from "./runs/run-repository.js";
import { registerRunRoutes } from "./runs/run-routes.js";
import { RunScheduler } from "./runs/run-scheduler.js";
import { SessionManager } from "./sessions/session-manager.js";
import { registerSessionRoutes } from "./sessions/session-routes.js";
import { createWorkspaceManager } from "./workspaces/create-workspace-manager.js";
import { type CommandRunner, type WorkspaceManager } from "./workspaces/workspace-manager.js";

export type AppDependencies = {
  config: AppConfig;
  db: Database.Database;
  runtime?: AgentRuntime;
  commandRunner?: CommandRunner;
  workspaceManager?: WorkspaceManager;
  runRepository?: RunRepository;
  eventStore?: EventStore;
  skillProjector?: SkillProjector;
  skillManager?: SkillManager;
  projectEnvironmentStore?: ProjectEnvironmentStore;
  projectEnvironmentScheduler?: ProjectEnvironmentCheckScheduler;
  mcpManager?: McpManager;
  mcpChecker?: McpChecker;
  integrationStore?: IntegrationStore;
  integrationProjection?: IntegrationProjection;
  webhookDispatcher?: WebhookDispatcher;
  webhookFetch?: typeof fetch;
  webRoot?: string;
};

/**
 * Builds the HTTP API from the supplied infrastructure dependencies.
 */
export const buildApp = (deps: AppDependencies): FastifyInstance => {
  const app = Fastify({ forceCloseConnections: true });
  const skillManager = deps.skillManager ?? new SkillManager({ dataDir: deps.config.dataDir });
  const secrets = SecretStore.open({ dataDir: deps.config.dataDir });
  const mcpManager = deps.mcpManager ?? new McpManager({
    db: deps.db,
    secrets
  });
  const mcpChecker = deps.mcpChecker ?? new SdkMcpChecker();
  const mcpPreparer = new RunMcpPreparer({ manager: mcpManager, checker: mcpChecker });
  const runtime = deps.runtime ?? new AcpxAgentRuntime(deps.config, skillManager);
  const projectEnvironmentStore = deps.projectEnvironmentStore ?? new ProjectEnvironmentStore({ db: deps.db });
  const agentManager = new AgentManager({
    db: deps.db,
    dataDir: deps.config.dataDir,
    runtime,
    projectEnvironmentStore
  });
  const integrationStore = deps.integrationStore ?? new IntegrationStore({ db: deps.db });
  const integrationEndpointManager = new IntegrationEndpointManager({
    db: deps.db,
    store: integrationStore,
    secrets
  });
  const webhookDispatcher = deps.webhookDispatcher ?? new WebhookDispatcher({
    store: integrationStore,
    secrets,
    fetch: deps.webhookFetch
  });
  const workspaceManager = deps.workspaceManager ?? createWorkspaceManager({
    projectEnvironmentsRoot: deps.config.projectEnvironmentsRoot,
    sessionsRoot: deps.config.sessionsRoot,
    commandRunner: deps.commandRunner
  });
  const sessionManager = new SessionManager({
    db: deps.db,
    dataDir: deps.config.dataDir,
    agentManager,
    runtime,
    workspaceManager,
    projectEnvironmentStore,
    mcpManager
  });
  let eventStore = deps.eventStore;
  const integrationProjection = deps.integrationProjection ?? new IntegrationProjection({
    db: deps.db,
    store: integrationStore,
    listEvents: (runId) => eventStore!.list(runId, 0)
  });
  const runRepository = deps.runRepository ?? new RunRepository({ db: deps.db, projection: integrationProjection });
  eventStore ??= new EventStore({ db: deps.db, projection: integrationProjection });
  const skillProjector = deps.skillProjector ?? new SkillProjector(deps.config.dataDir);
  const projectEnvironmentScheduler = deps.projectEnvironmentScheduler ?? new ProjectEnvironmentScheduler({
    store: projectEnvironmentStore,
    builder: new ProjectEnvironmentBuilder({
      store: projectEnvironmentStore,
      workspaceManager,
      commands: new SystemProjectEnvironmentCommands(),
      projectEnvironmentsRoot: deps.config.projectEnvironmentsRoot,
      prepareTimeoutMs: deps.config.projectPrepareTimeoutMs
    }),
    intervalMs: deps.config.projectEnvironmentCheckIntervalMs
  });
  const executor = new RunExecutor({ runtime, skillProjector, runRepository, eventStore, sessionManager, mcpPreparer });
  const scheduler = new RunScheduler({
    runRepository,
    executor,
    maxConcurrentRuns: deps.config.maxConcurrentRuns
  });
  const integrationTaskScheduler = new IntegrationTaskScheduler({
    store: integrationStore,
    runRepository,
    runScheduler: scheduler,
    sessionManager,
    secrets,
    projection: integrationProjection,
    onSchedulerError: reportIntegrationSchedulerError
  });
  integrationProjection.setNotify(() => integrationTaskScheduler.notify());
  const integrationCoordinator = new IntegrationCoordinator({
    db: deps.db,
    store: integrationStore,
    endpointManager: integrationEndpointManager,
    sessionManager,
    secrets,
    notifyTaskQueued: () => {
      integrationTaskScheduler.notify();
      integrationStore.notifyDeliveriesChanged();
    }
  });

  app.get("/api/health", () => ({ ok: true }));
  app.register((api) => {
    api.addHook("onRequest", requireApiToken(deps.config.apiToken));
    api.get("/auth/verify", async (_request, reply) => reply.code(204).send());
    registerProjectEnvironmentRoutes(api, projectEnvironmentStore, projectEnvironmentScheduler);
    registerAgentRoutes(api, agentManager, skillManager, runRepository);
    registerMcpRoutes(api, { mcpManager, mcpChecker });
    registerIntegrationAdminRoutes(api, {
      manager: integrationEndpointManager,
      store: integrationStore,
      secrets,
      dispatcher: webhookDispatcher,
      executor,
      scheduler: integrationTaskScheduler,
      coordinator: integrationCoordinator
    });
    registerSessionRoutes(api, sessionManager, runRepository);
    registerRunRoutes(api, { runRepository, eventStore, sessionManager, executor, scheduler });
  }, { prefix: "/api" });
  registerIntegrationRoutes(app, {
    manager: integrationEndpointManager,
    coordinator: integrationCoordinator,
    store: integrationStore,
    eventStore,
    executor,
    scheduler: integrationTaskScheduler
  });

  const webRoot = deps.webRoot ?? resolve(process.cwd(), "dist/web");
  app.register(fastifyStatic, { root: webRoot, wildcard: true, suppressWarning: true });
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split("?", 1)[0] ?? request.url;
    if (path === "/api" || path?.startsWith("/api/") || path === "/integration" || path?.startsWith("/integration/")) {
      return reply.code(404).send({ error: { code: "not_found", message: "API route not found" } });
    }
    const acceptsHtml = request.headers.accept?.includes("text/html") ?? false;
    const lastSegment = path.split("/").at(-1) ?? "";
    const assetLike = /\.[^./]+$/.test(lastSegment);
    const assetPath = path === "/assets" || path.startsWith("/assets/");
    const hasWebIndex = existsSync(join(webRoot, "index.html"));
    if (hasWebIndex && (request.method === "GET" || request.method === "HEAD") && acceptsHtml && !assetPath && !assetLike) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: { code: "not_found", message: "Route not found" } });
  });
  let stopped = false;
  let shutdownError: unknown;
  app.addHook("preClose", async () => {
    if (stopped) return;
    stopped = true;
    const failures: unknown[] = [];
    integrationTaskScheduler.stop();
    try {
      await webhookDispatcher.stop();
    } catch (error) {
      failures.push(error);
    }
    try {
      await scheduler.stop();
    } catch (error) {
      failures.push(error);
    }
    try {
      await projectEnvironmentScheduler.stop();
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
  integrationTaskScheduler.start();
  webhookDispatcher.start();
  projectEnvironmentScheduler.start();

  return app;
};
