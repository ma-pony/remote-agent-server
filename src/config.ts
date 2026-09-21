import { z } from "zod";
import { captureUpstreamsSchema, captureSecrets, type CaptureUpstreams } from "./agent-usage/capture/config.js";
import { isAbsolute } from "node:path";
import { tokenizerProfilesSchema, type TokenizerProfileConfig } from "./agent-usage/tokenizer-config.js";

export type AppConfig = {
  host: string;
  port: number;
  apiToken: string;
  dataDir: string;
  databasePath: string;
  projectEnvironmentsRoot: string;
  sessionsRoot: string;
  maxConcurrentRuns: number;
  maxConcurrentWebhookDeliveries: number;
  maxConcurrentEnvironmentBuilds: number;
  projectEnvironmentCheckIntervalMs: number;
  projectPrepareTimeoutMs: number;
  sessionRetentionMs: number;
  runTimeoutMs?: number;
  runtimeIdleMs?: number;
  usageImportRoots?: Record<string, string>;
  usageCaptureUpstreams?: CaptureUpstreams;
  usageTokenizers?: TokenizerProfileConfig[];
};

const configSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  API_TOKEN: z.string().min(1),
  DATA_DIR: z.string().default("/srv/remote-agent/data"),
  DATABASE_PATH: z.string().default("/srv/remote-agent/data/remote-agent.sqlite3"),
  PROJECT_ENVIRONMENTS_ROOT: z.string().default("/srv/remote-agent/environments"),
  SESSIONS_ROOT: z.string().default("/srv/remote-agent/sessions"),
  MAX_CONCURRENT_RUNS: z.coerce.number().int().min(1).max(64).default(4),
  MAX_CONCURRENT_WEBHOOK_DELIVERIES: z.coerce.number().int().min(1).max(64).default(4),
  MAX_CONCURRENT_ENVIRONMENT_BUILDS: z.coerce.number().int().min(1).max(64).default(1),
  PROJECT_ENVIRONMENT_CHECK_INTERVAL_HOURS: z.coerce.number().positive().default(3),
  PROJECT_PREPARE_TIMEOUT_MINUTES: z.coerce.number().positive().default(30),
  SESSION_RETENTION_HOURS: z.coerce.number().int().min(0).max(8760).default(7 * 24),
  RUN_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),
  RUNTIME_IDLE_MINUTES: z.coerce.number().nonnegative().default(5),
  USAGE_TOKENIZERS: z.string().default("[]").transform((value, context) => {
    try { return JSON.parse(value) as unknown; }
    catch { context.addIssue({ code: "custom", message: "USAGE_TOKENIZERS must be a JSON array" }); return z.NEVER; }
  }).pipe(tokenizerProfilesSchema),
  USAGE_CAPTURE_UPSTREAMS: z.string().default("{}").transform((value, context) => {
    try { return JSON.parse(value) as unknown; }
    catch { context.addIssue({ code: "custom", message: "USAGE_CAPTURE_UPSTREAMS must be a JSON object" }); return z.NEVER; }
  }).pipe(captureUpstreamsSchema),
  USAGE_IMPORT_ROOTS: z.string().default("{}").transform((value, context) => {
    try { return JSON.parse(value) as unknown; }
    catch { context.addIssue({ code: "custom", message: "USAGE_IMPORT_ROOTS must be a JSON object" }); return z.NEVER; }
  }).pipe(z.record(z.string().regex(/^[a-zA-Z0-9_-]+$/), z.string().refine(isAbsolute, "Import roots must be absolute paths")))
});

/**
 * Loads service configuration from environment variables.
 */
export const loadConfig = (env: Record<string, string | undefined>): AppConfig => {
  const config = configSchema.parse(env);
  captureSecrets(config.USAGE_CAPTURE_UPSTREAMS, env);

  return {
    host: config.HOST,
    port: config.PORT,
    apiToken: config.API_TOKEN,
    dataDir: config.DATA_DIR,
    databasePath: config.DATABASE_PATH,
    projectEnvironmentsRoot: config.PROJECT_ENVIRONMENTS_ROOT,
    sessionsRoot: config.SESSIONS_ROOT,
    maxConcurrentRuns: config.MAX_CONCURRENT_RUNS,
    maxConcurrentWebhookDeliveries: config.MAX_CONCURRENT_WEBHOOK_DELIVERIES,
    maxConcurrentEnvironmentBuilds: config.MAX_CONCURRENT_ENVIRONMENT_BUILDS,
    projectEnvironmentCheckIntervalMs: config.PROJECT_ENVIRONMENT_CHECK_INTERVAL_HOURS * 60 * 60 * 1000,
    projectPrepareTimeoutMs: config.PROJECT_PREPARE_TIMEOUT_MINUTES * 60 * 1000,
    sessionRetentionMs: config.SESSION_RETENTION_HOURS * 60 * 60 * 1000,
    runTimeoutMs: config.RUN_TIMEOUT_MINUTES * 60 * 1000,
    runtimeIdleMs: config.RUNTIME_IDLE_MINUTES * 60 * 1000,
    usageImportRoots: config.USAGE_IMPORT_ROOTS,
    usageCaptureUpstreams: config.USAGE_CAPTURE_UPSTREAMS,
    usageTokenizers: config.USAGE_TOKENIZERS
  };
};
