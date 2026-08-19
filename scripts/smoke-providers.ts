type Provider = "claude_code" | "codex" | "hermes";
type HttpMethod = "GET" | "POST" | "PATCH";

export type Agent = {
  id: number;
  name: string;
  provider: Provider;
  enabled: boolean;
  projectEnvironmentId: number | null;
};

type Doctor = { ok: boolean; message: string; details: string[] };
type AgentDoctor = {
  provider: Doctor;
  projectEnvironment: { ok: boolean; message: string; revisionId: number | null };
};
type ProjectEnvironment = { id: number; name: string; currentRevisionId: number | null };
type Session = { id: number };
type Run = { id: number; status: string; result: string | null; error: string | null };
type RunEvent = { id: number; seq: number; type: "message" | "tool" | "status" | "error" };

export type SmokeConfig = {
  apiToken: string;
  baseUrl: string;
  pollIntervalMs: number;
  runTimeoutMs: number;
};

export type SmokeApi = {
  request<T>(path: string, method?: HttpMethod, body?: unknown, timeoutMs?: number): Promise<T>;
};

type FetchResponse = { ok: boolean; status: number; text(): Promise<string> };
type FetchImplementation = (url: string, init: RequestInit) => Promise<FetchResponse>;
type SmokeTrace = { provider: Provider; agentId?: number; sessionId?: number; runIds: number[] };
export type MainDependencies = { args?: string[]; api?: SmokeApi };

const PROVIDERS = ["claude_code", "codex", "hermes"] as const;
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const NON_TERMINAL_RUN_STATUSES = new Set(["queued", "running"]);
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_RUN_TIMEOUT_MS = 300_000;
const MAX_REQUEST_TIMEOUT_MS = 30_000;

class ApiError extends Error {
  constructor(readonly method: string, readonly path: string, readonly status: number, readonly body: string) {
    super(`${method} ${path} failed with HTTP ${status}: ${body || "empty response"}`);
    this.name = "ApiError";
  }
}

class RequestTimeoutError extends Error {
  constructor(method: string, path: string, timeoutMs: number) {
    super(`${method} ${path} timed out after ${timeoutMs}ms`);
    this.name = "RequestTimeoutError";
  }
}

const positiveInteger = (name: string, value: string | undefined, fallback: number): number => {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
};

/** Reads only the environment needed by the explicit real-provider smoke command. */
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

const requestTimeout = (config: SmokeConfig): number => Math.min(config.runTimeoutMs, MAX_REQUEST_TIMEOUT_MS);

/** Creates an authenticated API client whose fetch and body-read share one abort deadline. */
export const createSmokeApi = (
  config: SmokeConfig,
  fetchImplementation: FetchImplementation = fetch as unknown as FetchImplementation
): SmokeApi => ({
  async request<T>(path: string, method: HttpMethod = "GET", body?: unknown, timeoutMs: number = requestTimeout(config)): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetchImplementation(`${config.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${config.apiToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) throw new ApiError(method, path, response.status, toErrorText(text));
      try {
        return JSON.parse(text) as T;
      } catch (_error) {
        throw new Error(`${method} ${path} returned invalid JSON`);
      }
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new RequestTimeoutError(method, path, timeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
});

const logTrace = (trace: SmokeTrace, outcome: "prepared" | "succeeded" | "failed"): void => {
  console.log(JSON.stringify({
    outcome,
    provider: trace.provider,
    agentId: trace.agentId ?? null,
    sessionId: trace.sessionId ?? null,
    runIds: trace.runIds
  }));
};

const smokeAgentName = (provider: Provider): string => `remote-agent-smoke-${provider}`;

/** Finds exactly one durable smoke Agent, creating it only when none exists. */
export const ensureAgent = async (
  api: SmokeApi,
  provider: Provider,
  projectEnvironmentId: number
): Promise<Agent> => {
  const agents = await api.request<Agent[]>("/agents");
  const matches = agents.filter((agent) => agent.name === smokeAgentName(provider) && agent.provider === provider);
  if (matches.length > 1) {
    throw new Error(`Found duplicate smoke Agents for ${provider}: ${matches.map((agent) => agent.id).join(", ")}; remove duplicates before continuing`);
  }
  const existing = matches[0];
  if (existing === undefined) {
    return api.request<Agent>("/agents", "POST", {
      name: smokeAgentName(provider),
      provider,
      projectEnvironmentId
    });
  }
  return existing.enabled && existing.projectEnvironmentId === projectEnvironmentId
    ? existing
    : api.request<Agent>(`/agents/${existing.id}`, "PATCH", { enabled: true, projectEnvironmentId });
};

/** Selects one deterministic ready project environment for the complete smoke. */
export const ensureReadyProjectEnvironment = async (api: SmokeApi): Promise<ProjectEnvironment> => {
  const environments = await api.request<ProjectEnvironment[]>("/project-environments");
  const ready = environments
    .filter((environment) => environment.currentRevisionId !== null)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id - right.id);
  if (ready.length === 0) {
    throw new Error("No ready project environment exists; create and prepare one before Provider smoke");
  }
  return ready[0]!;
};

const assertDoctor = async (api: SmokeApi, agent: Agent): Promise<void> => {
  const doctor = await api.request<AgentDoctor>(`/agents/${agent.id}/doctor`);
  if (!doctor.provider.ok) {
    throw new Error(`Provider doctor failed for ${agent.provider}: ${doctor.provider.message}${doctor.provider.details.length === 0 ? "" : ` (${doctor.provider.details.join("; ")})`}`);
  }
  if (!doctor.projectEnvironment.ok) {
    throw new Error(`Project environment doctor failed for ${agent.provider}: ${doctor.projectEnvironment.message}`);
  }
};

const createSession = async (api: SmokeApi, agent: Agent, trace: SmokeTrace): Promise<Session> => {
  const session = await api.request<Session>("/sessions", "POST", {
    agentId: agent.id,
    title: `smoke-${agent.provider}-${new Date().toISOString()}`
  });
  trace.sessionId = session.id;
  return session;
};

/** Polls a Run without ever allowing one request or body read to exceed the Run deadline. */
export const waitForTerminalRun = async (api: SmokeApi, config: SmokeConfig, runId: number): Promise<Run> => {
  const deadline = Date.now() + config.runTimeoutMs;
  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error(`Run ${runId} did not reach a terminal status within ${config.runTimeoutMs}ms`);
    const run = await api.request<Run>(`/runs/${runId}`, "GET", undefined, remainingMs);
    if (run.status === "succeeded") return run;
    if (run.status === "failed" || run.status === "cancelled") {
      throw new Error(`Run ${run.id} ended ${run.status}: ${run.error ?? "no error detail"}`);
    }
    if (!NON_TERMINAL_RUN_STATUSES.has(run.status) && !TERMINAL_RUN_STATUSES.has(run.status)) {
      throw new Error(`Run ${run.id} returned unknown status: ${run.status}`);
    }
    const pauseMs = Math.min(config.pollIntervalMs, deadline - Date.now());
    if (pauseMs <= 0) throw new Error(`Run ${run.id} did not reach a terminal status within ${config.runTimeoutMs}ms (last status: ${run.status})`);
    await sleep(pauseMs);
  }
};

const run = async (api: SmokeApi, config: SmokeConfig, session: Session, input: string, trace: SmokeTrace): Promise<Run> => {
  const created = await api.request<Run>(`/sessions/${session.id}/runs`, "POST", { input });
  trace.runIds.push(created.id);
  console.log(`provider=${trace.provider} agent=${trace.agentId} session=${session.id} run=${created.id}`);
  return waitForTerminalRun(api, config, created.id);
};

/** Ensures second-turn history starts at one and contains no order, duplicate, or gap errors. */
export const assertEventHistory = async (api: SmokeApi, runId: number): Promise<void> => {
  const events = await api.request<RunEvent[]>(`/runs/${runId}/events?afterSeq=0`);
  if (events.length === 0) throw new Error(`Run ${runId} succeeded without persisted event history`);
  if (events.some((event, index) => !Number.isInteger(event.seq) || event.seq !== index + 1)) {
    throw new Error(`Run ${runId} event seq must start at 1 and be strictly contiguous`);
  }
};

const verifyProvider = async (
  api: SmokeApi,
  config: SmokeConfig,
  provider: Provider,
  projectEnvironmentId: number
): Promise<void> => {
  const trace: SmokeTrace = { provider, runIds: [] };
  try {
    const agent = await ensureAgent(api, provider, projectEnvironmentId);
    trace.agentId = agent.id;
    await assertDoctor(api, agent);
    const session = await createSession(api, agent, trace);
    await run(api, config, session, "只回复当前工作目录的目录名", trace);
    const secondRun = await run(api, config, session, "只回复你上一轮看到的目录名", trace);
    await assertEventHistory(api, secondRun.id);
    logTrace(trace, "succeeded");
  } catch (error) {
    logTrace(trace, "failed");
    throw error;
  }
};

export const prepareProviders = async (api: SmokeApi): Promise<void> => {
  const environment = await ensureReadyProjectEnvironment(api);
  for (const provider of PROVIDERS) {
    const trace: SmokeTrace = { provider, runIds: [] };
    try {
      trace.agentId = (await ensureAgent(api, provider, environment.id)).id;
      logTrace(trace, "prepared");
    } catch (error) {
      logTrace(trace, "failed");
      throw error;
    }
  }
};

const usage = (): void => {
  console.log(`Usage: API_TOKEN=... pnpm smoke:providers [--prepare]

  --prepare ensures and prints exactly one smoke Agent ID per Provider. It creates no Session/Run and does not call doctor.

Optional environment:
  SMOKE_BASE_URL=http://127.0.0.1:3000
  SMOKE_POLL_INTERVAL_MS=1000
  SMOKE_RUN_TIMEOUT_MS=300000

This command performs real HTTP requests. Without --prepare it also performs real Provider runs; it does not mock Providers.`);
};

export const main = async (
  env: Record<string, string | undefined> = process.env,
  dependencies: MainDependencies = {}
): Promise<void> => {
  const args = dependencies.args ?? process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }
  if (args.some((arg) => arg !== "--prepare")) throw new Error(`Unknown argument: ${args.find((arg) => arg !== "--prepare")}`);
  const config = readSmokeConfig(env);
  const api = dependencies.api ?? createSmokeApi(config);
  if (args.includes("--prepare")) return prepareProviders(api);
  const environment = await ensureReadyProjectEnvironment(api);
  for (const provider of PROVIDERS) {
    console.log(`Starting real smoke for ${provider}`);
    await verifyProvider(api, config, provider, environment.id);
  }
};

const isEntrypoint = process.argv[1]?.endsWith("smoke-providers.ts") ?? false;
if (isEntrypoint) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
