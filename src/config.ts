import { z } from "zod";

export type AppConfig = {
  host: string;
  port: number;
  apiToken: string;
  dataDir: string;
  databasePath: string;
  workspaceTemplate: string;
  sessionsRoot: string;
  maxConcurrentRuns: number;
};

const configSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  API_TOKEN: z.string().min(1),
  DATA_DIR: z.string().default("/srv/remote-agent/data"),
  DATABASE_PATH: z.string().default("/srv/remote-agent/data/remote-agent.sqlite3"),
  WORKSPACE_TEMPLATE: z.string().default("/srv/remote-agent/template/workspace"),
  SESSIONS_ROOT: z.string().default("/srv/remote-agent/sessions"),
  MAX_CONCURRENT_RUNS: z.coerce.number().int().positive().default(4)
});

/**
 * Loads service configuration from environment variables.
 */
export const loadConfig = (env: Record<string, string | undefined>): AppConfig => {
  const config = configSchema.parse(env);

  return {
    host: config.HOST,
    port: config.PORT,
    apiToken: config.API_TOKEN,
    dataDir: config.DATA_DIR,
    databasePath: config.DATABASE_PATH,
    workspaceTemplate: config.WORKSPACE_TEMPLATE,
    sessionsRoot: config.SESSIONS_ROOT,
    maxConcurrentRuns: config.MAX_CONCURRENT_RUNS
  };
};
