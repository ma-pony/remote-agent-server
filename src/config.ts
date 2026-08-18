import { z } from "zod";

export type AppConfig = {
  host: string;
  port: number;
  apiToken: string;
  dataDir: string;
  databasePath: string;
  projectEnvironmentsRoot: string;
  sessionsRoot: string;
  maxConcurrentRuns: number;
  projectEnvironmentCheckIntervalMs: number;
  projectPrepareTimeoutMs: number;
};

const configSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  API_TOKEN: z.string().min(1),
  DATA_DIR: z.string().default("/srv/remote-agent/data"),
  DATABASE_PATH: z.string().default("/srv/remote-agent/data/remote-agent.sqlite3"),
  PROJECT_ENVIRONMENTS_ROOT: z.string().default("/srv/remote-agent/environments"),
  SESSIONS_ROOT: z.string().default("/srv/remote-agent/sessions"),
  MAX_CONCURRENT_RUNS: z.coerce.number().int().positive().default(4),
  PROJECT_ENVIRONMENT_CHECK_INTERVAL_HOURS: z.coerce.number().positive().default(3),
  PROJECT_PREPARE_TIMEOUT_MINUTES: z.coerce.number().positive().default(30)
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
    projectEnvironmentsRoot: config.PROJECT_ENVIRONMENTS_ROOT,
    sessionsRoot: config.SESSIONS_ROOT,
    maxConcurrentRuns: config.MAX_CONCURRENT_RUNS,
    projectEnvironmentCheckIntervalMs: config.PROJECT_ENVIRONMENT_CHECK_INTERVAL_HOURS * 60 * 60 * 1000,
    projectPrepareTimeoutMs: config.PROJECT_PREPARE_TIMEOUT_MINUTES * 60 * 1000
  };
};
