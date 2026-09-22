import { HostUsageCapture } from "./agent-usage/capture/host-capture.js";
import { takeCaptureSecrets } from "./agent-usage/capture/config.js";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { ManagedUsageSources } from "./agent-usage/managed-sources.js";
import { registerUsageSourceRoutes } from "./agent-usage/source-routes.js";
import { registerUsageQueryRoutes } from "./agent-usage/query-routes.js";
import { McpUsageObserver } from "./agent-usage/mcp-observer.js";

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
import { WebhookIngress } from "./integrations/webhook-ingress.js";
import { WebhookBatchDispatcher } from "./integrations/webhook-batch-dispatcher.js";
import { registerWebhookIngressRoutes, registerWebhookReceiverAdminRoutes } from "./integrations/webhook-ingress-routes.js";
import { SdkMcpChecker, type McpChecker } from "./mcp/mcp-checker.js";
import { McpManager } from "./mcp/mcp-manager.js";
import { registerMcpRoutes } from "./mcp/mcp-routes.js";
import { RunMcpPreparer } from "./mcp/run-mcp-preparer.js";
import { SecretStore } from "./mcp/secret-store.js";
import { ProjectEnvironmentBuilder } from "./project-environments/project-environment-builder.js";
import {
  SystemProjectEnvironmentCommands,
  type ProjectEnvironmentCommands
} from "./project-environments/project-environment-commands.js";
import { registerProjectEnvironmentRoutes } from "./project-environments/project-environment-routes.js";
import {
  ProjectEnvironmentScheduler,
  type ProjectEnvironmentCheckScheduler
} from "./project-environments/project-environment-scheduler.js";
import { ProjectEnvironmentStore } from "./project-environments/project-environment-store.js";
import { ProviderExtensionManager } from "./provider-extensions/provider-extension-manager.js";
import { ProviderMcpCatalog } from "./provider-extensions/provider-mcp-catalog.js";
import { AcpxAgentRuntime } from "./runtime/acpx-runtime.js";
import type { AgentRuntime } from "./runtime/agent-runtime.js";
import { SkillProjector } from "./runtime/skill-projector.js";
import { SkillManager } from "./skills/skill-manager.js";
import { SkillSourceManager } from "./skills/skill-source-manager.js";
import { registerSkillRoutes } from "./skills/skill-routes.js";
import { RunExecutor } from "./runs/run-executor.js";
import { RunRepository } from "./runs/run-repository.js";
import { registerRunRoutes } from "./runs/run-routes.js";
import { RunScheduler } from "./runs/run-scheduler.js";
import { SessionManager } from "./sessions/session-manager.js";
import {
  SessionCleanupScheduler,
  type SessionCleanupSchedulerLike
} from "./sessions/session-cleanup-scheduler.js";
import { registerSessionRoutes } from "./sessions/session-routes.js";
import { registerConcurrencySettingsRoutes } from "./settings/concurrency-settings-routes.js";
import { ConcurrencySettingsStore } from "./settings/concurrency-settings-store.js";
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
  skillSourceManager?: SkillSourceManager;
  projectEnvironmentStore?: ProjectEnvironmentStore;
  projectEnvironmentCommands?: ProjectEnvironmentCommands;
  projectEnvironmentScheduler?: ProjectEnvironmentCheckScheduler;
  sessionCleanupScheduler?: SessionCleanupSchedulerLike;
  mcpManager?: McpManager;
  mcpChecker?: McpChecker;
  providerExtensionManager?: ProviderExtensionManager;
  integrationStore?: IntegrationStore;
  integrationProjection?: IntegrationProjection;
  webhookDispatcher?: WebhookDispatcher;
  concurrencySettingsStore?: ConcurrencySettingsStore;
  webhookFetch?: typeof fetch;
  webRoot?: string;
  usageSources?: ManagedUsageSources;
};

/**
 * Builds the HTTP API from the supplied infrastructure dependencies.
 */
export const buildApp = (deps: AppDependencies): FastifyInstance => {
  const app = Fastify({ forceCloseConnections: true });
  const usageSources = deps.usageSources ?? new ManagedUsageSources(deps.db, deps.config);
  const usageObserver = new McpUsageObserver(usageSources.collector);
  const usageCapture = usageSources.collector.capture ?? new HostUsageCapture(usageSources.collector, deps.config.usageCaptureUpstreams ?? {},
    takeCaptureSecrets(deps.config.usageCaptureUpstreams ?? {}, process.env));
  const concurrencySettingsStore = deps.concurrencySettingsStore ?? new ConcurrencySettingsStore(deps.db);
  const skillSourceManager = deps.skillSourceManager ?? new SkillSourceManager({ dataDir: deps.config.dataDir });
  const skillManager = deps.skillManager ?? new SkillManager({ dataDir: deps.config.dataDir, sourceCatalog: () => skillSourceManager.catalog() });
  const providerExtensionManager = deps.providerExtensionManager ?? new ProviderExtensionManager({ db: deps.db });
  const secrets = SecretStore.open({ dataDir: deps.config.dataDir });
  const mcpManager = deps.mcpManager ?? new McpManager({
    db: deps.db,
    secrets
  });
  const mcpChecker = deps.mcpChecker ?? new SdkMcpChecker();
  const providerMcpCatalog = new ProviderMcpCatalog({ db: deps.db, mcpManager });
  const mcpPreparer = new RunMcpPreparer({ manager: mcpManager, checker: mcpChecker, observer: usageObserver });
  const runtime = deps.runtime ?? new AcpxAgentRuntime(deps.config, skillManager, providerExtensionManager, usageCapture);
  const projectEnvironmentStore = deps.projectEnvironmentStore ?? new ProjectEnvironmentStore({ db: deps.db });
  const projectEnvironmentCommands = deps.projectEnvironmentCommands ?? new SystemProjectEnvironmentCommands();
  const agentManager = new AgentManager({
    db: deps.db,
    dataDir: deps.config.dataDir,
    runtime,
    projectEnvironmentStore,
    concurrencySettingsStore
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
    fetch: deps.webhookFetch,
    concurrencySettings: concurrencySettingsStore
  });
  const workspaceManager = deps.workspaceManager ?? createWorkspaceManager({
    projectEnvironmentsRoot: deps.config.projectEnvironmentsRoot,
    sessionsRoot: deps.config.sessionsRoot,
    commandRunner: deps.commandRunner
  });
  const projectEnvironmentBuilder = new ProjectEnvironmentBuilder({
    store: projectEnvironmentStore,
    workspaceManager,
    commands: projectEnvironmentCommands,
    projectEnvironmentsRoot: deps.config.projectEnvironmentsRoot,
    prepareTimeoutMs: deps.config.projectPrepareTimeoutMs
  });
  const sessionManager = new SessionManager({
    db: deps.db,
    dataDir: deps.config.dataDir,
    agentManager,
    runtime,
    workspaceManager,
    projectEnvironmentStore,
    projectEnvironmentRevisionCleaner: projectEnvironmentBuilder,
    projectEnvironmentCommands,
    projectPrepareTimeoutMs: deps.config.projectPrepareTimeoutMs,
    mcpManager,
    usageCollector: usageSources.collector
  });
  const sessionCleanupScheduler = deps.sessionCleanupScheduler ?? new SessionCleanupScheduler({
    sessionManager,
    runtimeSettings: concurrencySettingsStore,
    retentionMs: deps.config.sessionRetentionMs,
    intervalMs: 10 * 60 * 1000
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
    builder: projectEnvironmentBuilder,
    intervalMs: deps.config.projectEnvironmentCheckIntervalMs,
    concurrencySettings: concurrencySettingsStore
  });
  const executor = new RunExecutor({
    runtime,
    skillProjector,
    runRepository,
    eventStore,
    sessionManager,
    mcpPreparer,
    providerExtensionManager,
    runtimeSettings: concurrencySettingsStore,
    runTimeoutMs: deps.config.runTimeoutMs
  });
  const scheduler = new RunScheduler({
    runRepository,
    executor,
    concurrencySettings: concurrencySettingsStore
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

  const webhookIngress = new WebhookIngress({ store: integrationStore, secrets, coordinator: integrationCoordinator });
  const webhookBatchDispatcher = new WebhookBatchDispatcher({ store: integrationStore, secrets, coordinator: integrationCoordinator });
  app.get("/api/health", () => ({ ok: true }));
  app.register((api) => {
    api.addHook("onRequest", requireApiToken(deps.config.apiToken));
    api.get("/auth/verify", async (_request, reply) => reply.code(204).send());
    registerUsageSourceRoutes(api, usageSources);
    registerUsageQueryRoutes(api, usageSources.collector);
    registerConcurrencySettingsRoutes(api, concurrencySettingsStore);
    registerProjectEnvironmentRoutes(api, projectEnvironmentStore, projectEnvironmentScheduler);
    registerAgentRoutes(api, agentManager, skillManager, runRepository, providerExtensionManager);
    registerSkillRoutes(api, agentManager, skillManager, skillSourceManager);
    registerMcpRoutes(api, { mcpManager, mcpChecker, providerMcpCatalog });
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
    registerWebhookReceiverAdminRoutes(api, webhookIngress);
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
  registerWebhookIngressRoutes(app, webhookIngress);

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
    try { await webhookBatchDispatcher.stop(); } catch (error) { failures.push(error); }
    try { await skillSourceManager.close(); } catch (error) { failures.push(error); }
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
      await sessionCleanupScheduler.stop();
    } catch (error) {
      failures.push(error);
    }
    try { await usageSources.collector.stopRecovery(); } catch (error) { failures.push(error); }
    try {
      await runtime.shutdown();
    } catch (error) {
      failures.push(error);
    }
    try { await usageCapture.close(); } catch (error) { failures.push(error); }
    try { await usageSources.collector.harvestFinalSessions(); } catch (error) { failures.push(error); }
    try { await usageSources.collector.sources.close(); } catch (error) { failures.push(error); }
    try { await usageObserver.close(); } catch (error) { failures.push(error); }
    try { await usageSources.collector.attribution.close(); } catch (error) { failures.push(error); }
    if (failures.length === 1) shutdownError = failures[0];
    if (failures.length > 1) shutdownError = new AggregateError(failures, "Application shutdown failed");
  });
  app.addHook("onClose", async () => {
    if (shutdownError !== undefined) throw shutdownError;
  });
  app.addHook("onReady", async () => {
    usageSources.collector.startRecovery();
    scheduler.start();
    integrationTaskScheduler.start();
    webhookBatchDispatcher.start();
    webhookDispatcher.start();
    projectEnvironmentScheduler.start();
    sessionCleanupScheduler.start();
  });

  return app;
};
