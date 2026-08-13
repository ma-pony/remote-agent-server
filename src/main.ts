import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";

import { buildApp } from "./app.js";
import { loadConfig, type AppConfig } from "./config.js";
import { migrate, openDatabase } from "./db.js";
import { EventStore } from "./events/event-store.js";
import { IntegrationProjection } from "./integrations/integration-projection.js";
import { IntegrationStore } from "./integrations/integration-store.js";
import { McpManager } from "./mcp/mcp-manager.js";
import { SecretStore } from "./mcp/secret-store.js";
import { AcpxAgentRuntime } from "./runtime/acpx-runtime.js";
import { importLegacyProjectEnvironment } from "./project-environments/import-legacy-project-environment.js";
import { ProjectEnvironmentStore } from "./project-environments/project-environment-store.js";
import type { AgentRuntime } from "./runtime/agent-runtime.js";
import { RunRepository } from "./runs/run-repository.js";
import { createWorkspaceManager } from "./workspaces/create-workspace-manager.js";
import { type FileSystemInspector } from "./workspaces/apfs-workspace.js";
import { systemCommandRunner, type CommandRunner } from "./workspaces/workspace-manager.js";

export type StartServerOptions = {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  runtime?: AgentRuntime;
  commandRunner?: CommandRunner;
  fileSystemInspector?: FileSystemInspector;
  listen?: (app: FastifyInstance, config: AppConfig) => Promise<unknown>;
  installSignalHandlers?: boolean;
  exitProcess?: (code: number) => void;
};

export type RunningServer = {
  app: FastifyInstance;
  db: Database.Database;
  runRepository: RunRepository;
  close(): Promise<void>;
};

const defaultListen = (app: FastifyInstance, config: AppConfig): Promise<string> =>
  app.listen({ host: config.host, port: config.port });

/**
 * Boots the single-process service in recovery-safe order.
 */
export const startServer = async (options: StartServerOptions = {}): Promise<RunningServer> => {
  const config = loadConfig(options.env ?? process.env);
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(dirname(config.databasePath), { recursive: true });
  mkdirSync(config.projectEnvironmentsRoot, { recursive: true });
  mkdirSync(config.sessionsRoot, { recursive: true });
  const db = openDatabase(config.databasePath);
  let app: FastifyInstance | undefined;

  try {
    migrate(db);
    const workspaceManager = createWorkspaceManager({
      platform: options.platform,
      workspaceTemplate: config.workspaceTemplate,
      sessionsRoot: config.sessionsRoot,
      commandRunner: options.commandRunner,
      fileSystemInspector: options.fileSystemInspector
    });
    await workspaceManager.check();

    const projectEnvironmentStore = new ProjectEnvironmentStore({ db });
    const interruptedRevisions = projectEnvironmentStore.recoverPreparing();
    for (const revision of interruptedRevisions) {
      if (revision.workspacePath === null) continue;
      try {
        await workspaceManager.removeRevision(revision.workspacePath);
        projectEnvironmentStore.clearRevisionWorkspacePath(revision.id);
      } catch (_error) {
        // The failed revision stays visible so its exact Workspace can be cleaned manually.
      }
    }
    await importLegacyProjectEnvironment({
      db,
      store: projectEnvironmentStore,
      workspaceTemplate: config.workspaceTemplate,
      commandRunner: options.commandRunner ?? systemCommandRunner
    });

    const integrationStore = new IntegrationStore({ db });
    let eventStore!: EventStore;
    const integrationProjection = new IntegrationProjection({
      db,
      store: integrationStore,
      listEvents: (runId) => eventStore.list(runId, 0)
    });
    const runRepository = new RunRepository({ db, projection: integrationProjection });
    eventStore = new EventStore({ db, projection: integrationProjection });
    runRepository.recoverAfterRestart();
    integrationProjection.recover();
    // Task 6 WebhookDispatcher recovery belongs here, before the HTTP app is created.
    const runtime = options.runtime ?? new AcpxAgentRuntime(config);
    const mcpManager = new McpManager({ db, secrets: SecretStore.open({ dataDir: config.dataDir }) });
    app = buildApp({
      config,
      db,
      runtime,
      workspaceManager,
      runRepository,
      eventStore,
      projectEnvironmentStore,
      mcpManager,
      integrationStore,
      integrationProjection
    });

    let closing: Promise<void> | undefined;
    let onSignal: (() => void) | undefined;
    const close = (): Promise<void> => {
      closing ??= (async () => {
        try {
          await app!.close();
        } finally {
          if (onSignal !== undefined) {
            process.off("SIGINT", onSignal);
            process.off("SIGTERM", onSignal);
          }
          db.close();
        }
      })();
      return closing;
    };

    await (options.listen ?? defaultListen)(app, config);
    if (options.installSignalHandlers ?? true) {
      const exitProcess = options.exitProcess ?? ((code: number): never => process.exit(code));
      let signalHandled = false;
      onSignal = () => {
        if (signalHandled) return;
        signalHandled = true;
        process.off("SIGINT", onSignal!);
        process.off("SIGTERM", onSignal!);
        void close()
          .then(
            () => exitProcess(0),
            (error: unknown) => {
              console.error(error);
              exitProcess(1);
            }
          );
      };
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
    }
    return { app, db, runRepository, close };
  } catch (error) {
    if (app !== undefined) {
      try {
        await app.close();
      } catch (_closeError) {
        // Startup failure remains authoritative.
      }
    }
    db.close();
    throw error;
  }
};

const isEntrypoint = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  void startServer().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
