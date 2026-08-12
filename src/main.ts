import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";

import { buildApp } from "./app.js";
import { loadConfig, type AppConfig } from "./config.js";
import { migrate, openDatabase } from "./db.js";
import { AcpxAgentRuntime } from "./runtime/acpx-runtime.js";
import type { AgentRuntime } from "./runtime/agent-runtime.js";
import { RunRepository } from "./runs/run-repository.js";
import { BtrfsWorkspaceManager, type CommandRunner, systemCommandRunner } from "./workspaces/btrfs-workspace.js";

export type StartServerOptions = {
  env?: Record<string, string | undefined>;
  runtime?: AgentRuntime;
  commandRunner?: CommandRunner;
  listen?: (app: FastifyInstance, config: AppConfig) => Promise<unknown>;
  installSignalHandlers?: boolean;
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
  const db = openDatabase(config.databasePath);
  let app: FastifyInstance | undefined;

  try {
    migrate(db);
    const workspaceManager = new BtrfsWorkspaceManager({
      workspaceTemplate: config.workspaceTemplate,
      sessionsRoot: config.sessionsRoot,
      commandRunner: options.commandRunner ?? systemCommandRunner
    });
    await workspaceManager.check();

    const runRepository = new RunRepository({ db });
    runRepository.recoverAfterRestart();
    const runtime = options.runtime ?? new AcpxAgentRuntime(config);
    app = buildApp({ config, db, runtime, workspaceManager, runRepository });

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
      onSignal = () => {
        void close().catch((error: unknown) => {
          console.error(error);
          process.exitCode = 1;
        });
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
