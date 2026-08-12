type Provider = "claude_code" | "codex" | "hermes";

type Agent = {
  id: string;
  name: string;
  provider: Provider;
  enabled: boolean;
};

type Doctor = {
  ok: boolean;
  message: string;
  details: string[];
};

type Session = {
  id: string;
};

type Run = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  result: string | null;
  error: string | null;
};

type RunEvent = {
  id: string;
  seq: number;
  type: "message" | "tool" | "status" | "error";
};

export type SmokeConfig = {
  apiToken: string;
  baseUrl: string;
  pollIntervalMs: number;
  runTimeoutMs: number;
};

type SmokeTrace = {
  provider: Provider;
  agentId?: string;
  sessionId?: string;
  runIds: string[];
};

const PROVIDERS = ["claude_code", "codex", "hermes"] as const;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_RUN_TIMEOUT_MS = 300_000;

class ApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: string
  ) {
    super(`${method} ${path} failed with HTTP ${status}: ${body || "empty response"}`);
    this.name = "ApiError";
  }
}

const positiveInteger = (name: string, value: string | undefined, fallback: number): number => {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
};

/**
 * Reads only the environment needed by the explicit real-provider smoke command.
 */
export const readSmokeConfig = (env: Record<string, string | undefined>): SmokeConfig => {
  const apiToken = env.API_TOKEN?.trim();
  if (apiToken === undefined || apiToken === "") {
    throw new Error("API_TOKEN is required; load the deployment .env before running smoke:providers");
  }

  const rawBaseUrl = env.SMOKE_BASE_URL?.trim() || "http://127.0.0.1:3000";
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(rawBaseUrl);
  } catch (_error) {
    throw new Error("SMOKE_BASE_URL must be an absolute HTTP(S) URL");
  }
  if (parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:") {
    throw new Error("SMOKE_BASE_URL must use HTTP or HTTPS");
  }

  return {
    apiToken,
    baseUrl: `${parsedBaseUrl.toString().replace(/\/$/, "").replace(/\/api$/, "")}/api`,
    pollIntervalMs: positiveInteger("SMOKE_POLL_INTERVAL_MS", env.SMOKE_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS),
    runTimeoutMs: positiveInteger("SMOKE_RUN_TIMEOUT_MS", env.SMOKE_RUN_TIMEOUT_MS, DEFAULT_RUN_TIMEOUT_MS)
  };
};

const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

const toErrorText = (body: string): string => {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } };
    if (parsed.error?.message !== undefined) return `${parsed.error.code ?? "error"}: ${parsed.error.message}`;
  } catch (_error) {
    // Keep a non-JSON response intact for diagnostics.
  }
  return body;
};

const request = async <T>(
  config: SmokeConfig,
  path: string,
  method: "GET" | "POST" | "PATCH" = "GET",
  body?: unknown
): Promise<T> => {
  const response = await fetch(`${config.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${config.apiToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  if (!response.ok) throw new ApiError(method, path, response.status, toErrorText(text));
  try {
    return JSON.parse(text) as T;
  } catch (_error) {
    throw new Error(`${method} ${path} returned invalid JSON`);
  }
};

const logTrace = (trace: SmokeTrace, outcome: "running" | "succeeded" | "failed"): void => {
  console.log(JSON.stringify({
    outcome,
    provider: trace.provider,
    agentId: trace.agentId ?? null,
    sessionId: trace.sessionId ?? null,
    runIds: trace.runIds
  }));
};

const smokeAgentName = (provider: Provider): string => `remote-agent-smoke-${provider}`;

const ensureAgent = async (config: SmokeConfig, trace: SmokeTrace): Promise<Agent> => {
  const agents = await request<Agent[]>(config, "/agents");
  const existing = agents.find((agent) => agent.name === smokeAgentName(trace.provider) && agent.provider === trace.provider);
  const agent = existing === undefined
    ? await request<Agent>(config, "/agents", "POST", { name: smokeAgentName(trace.provider), provider: trace.provider })
    : existing.enabled
      ? existing
      : await request<Agent>(config, `/agents/${existing.id}`, "PATCH", { enabled: true });
  trace.agentId = agent.id;
  return agent;
};

const assertDoctor = async (config: SmokeConfig, agent: Agent): Promise<void> => {
  const doctor = await request<Doctor>(config, `/agents/${agent.id}/doctor`);
  if (!doctor.ok) {
    throw new Error(`Provider doctor failed for ${agent.provider}: ${doctor.message}${doctor.details.length === 0 ? "" : ` (${doctor.details.join("; ")})`}`);
  }
};

const createSession = async (config: SmokeConfig, agent: Agent, trace: SmokeTrace): Promise<Session> => {
  const session = await request<Session>(config, "/sessions", "POST", {
    agentId: agent.id,
    title: `smoke-${agent.provider}-${new Date().toISOString()}`
  });
  trace.sessionId = session.id;
  return session;
};

const waitForTerminalRun = async (config: SmokeConfig, runId: string): Promise<Run> => {
  const deadline = Date.now() + config.runTimeoutMs;
  while (true) {
    const run = await request<Run>(config, `/runs/${runId}`);
    if (run.status === "succeeded") return run;
    if (run.status === "failed" || run.status === "cancelled") {
      throw new Error(`Run ${run.id} ended ${run.status}: ${run.error ?? "no error detail"}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Run ${run.id} did not reach a terminal status within ${config.runTimeoutMs}ms (last status: ${run.status})`);
    }
    await sleep(config.pollIntervalMs);
  }
};

const run = async (config: SmokeConfig, session: Session, input: string, trace: SmokeTrace): Promise<Run> => {
  const created = await request<Run>(config, `/sessions/${session.id}/runs`, "POST", { input });
  trace.runIds.push(created.id);
  console.log(`provider=${trace.provider} agent=${trace.agentId} session=${session.id} run=${created.id}`);
  return waitForTerminalRun(config, created.id);
};

const assertEventHistory = async (config: SmokeConfig, runId: string): Promise<void> => {
  const events = await request<RunEvent[]>(config, `/runs/${runId}/events?afterSeq=0`);
  if (events.length === 0) throw new Error(`Run ${runId} succeeded without persisted event history`);
  if (events.some((event) => !Number.isInteger(event.seq) || event.seq < 1)) {
    throw new Error(`Run ${runId} returned invalid event sequence history`);
  }
};

const verifyProvider = async (config: SmokeConfig, provider: Provider): Promise<void> => {
  const trace: SmokeTrace = { provider, runIds: [] };
  try {
    const agent = await ensureAgent(config, trace);
    await assertDoctor(config, agent);
    const session = await createSession(config, agent, trace);
    await run(config, session, "只回复当前工作目录的目录名", trace);
    const secondRun = await run(config, session, "只回复你上一轮看到的目录名", trace);
    await assertEventHistory(config, secondRun.id);
    logTrace(trace, "succeeded");
  } catch (error) {
    logTrace(trace, "failed");
    throw error;
  }
};

const usage = (): void => {
  console.log(`Usage: API_TOKEN=... pnpm smoke:providers

Optional environment:
  SMOKE_BASE_URL=http://127.0.0.1:3000
  SMOKE_POLL_INTERVAL_MS=1000
  SMOKE_RUN_TIMEOUT_MS=300000

This command performs real HTTP requests and real Provider runs. It does not mock Providers.`);
};

export const main = async (env: Record<string, string | undefined> = process.env): Promise<void> => {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    usage();
    return;
  }
  const config = readSmokeConfig(env);
  for (const provider of PROVIDERS) {
    console.log(`Starting real smoke for ${provider}`);
    await verifyProvider(config, provider);
  }
};

const isEntrypoint = process.argv[1]?.endsWith("smoke-providers.ts") ?? false;

if (isEntrypoint) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
