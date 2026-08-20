import { fetchEventSource } from "@microsoft/fetch-event-source";

export type Provider = "claude_code" | "codex" | "hermes";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type Agent = {
  id: number;
  name: string;
  provider: Provider;
  enabled: boolean;
  instructions: string;
  projectEnvironmentId: number | null;
  createdAt: string;
  updatedAt: string;
};

export type DoctorResult = { ok: boolean; message: string; details: string[] };
export type AgentDoctorResult = {
  provider: DoctorResult;
  projectEnvironment: { ok: boolean; message: string; revisionId: number | null };
};

export type AgentSkill = {
  id: string;
  name: string;
  description: string;
  source: "codex" | "agents" | "claude" | "plugin" | "upload" | "missing";
  enabled: boolean;
  available: boolean;
};

export type EnvironmentRepository = {
  id: number;
  projectEnvironmentId: number;
  name: string;
  gitUrl: string;
  prepareCommand: string | null;
  workspacePath: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProjectEnvironmentRevision = {
  id: number;
  projectEnvironmentId: number;
  status: "preparing" | "ready" | "failed";
  workspacePath: string | null;
  inputFingerprint: string;
  failureStage: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export type ProjectEnvironment = {
  id: number;
  name: string;
  currentRevisionId: number | null;
  lastCheckedAt: string | null;
  workspacePath: string | null;
  sync: {
    status: "idle" | "queued" | "running";
    automatic: true;
    intervalMs: number;
    nextScheduledAt: string;
  };
  repositories: EnvironmentRepository[];
  currentRevision: ProjectEnvironmentRevision | null;
  latestRevision: ProjectEnvironmentRevision | null;
  createdAt: string;
  updatedAt: string;
};

export type Session = {
  id: number;
  agentId: number;
  title: string;
  status: "idle" | "running";
  providerSessionId: string | null;
  workspacePath: string;
  projectEnvironmentRevisionId: number | null;
  instructionsSnapshot: string;
  createdAt: string;
  updatedAt: string;
  mcpParametersValid?: boolean;
  missingMcpParameters?: string[];
  mcpParameters?: SessionMcpParameterStatus[];
};

export type SessionMcpParameterStatus = {
  key: string;
  label: string;
  description: string | null;
  required: boolean;
  secret: boolean;
  configured: boolean;
  value?: string;
};

export type AgentSessionParameter = {
  id: number;
  agentId: number;
  key: string;
  label: string;
  description: string | null;
  required: boolean;
  secret: boolean;
  createdAt: string;
  updatedAt: string;
};

export type McpValueView = {
  id: number;
  source: "fixed" | "session_parameter" | "runtime";
  name?: string;
  value?: string;
  secret?: boolean;
  configured?: boolean;
  parameterKey?: string;
  runtimeKey?: "agent_id" | "session_id" | "run_id" | "workspace_path" | "browser_profile_path";
};

export type AgentMcpServerSummary = {
  id: number;
  agentId: number;
  name: string;
  transport: "http" | "stdio";
  enabled: boolean;
  checkTimeoutSeconds: number;
  lastCheckedAt: string | null;
  lastCheckStatus: "passed" | "failed" | null;
  lastCheckMessage: string | null;
  lastToolCount: number | null;
  createdAt: string;
  updatedAt: string;
};

export type SharedMcpServerSummary = {
  id: number;
  name: string;
  transport: "http" | "stdio";
  checkTimeoutSeconds: number;
  sourceAgentId: number;
  sourceAgentName: string;
};

export type AgentMcpServerDetail = AgentMcpServerSummary & (
  | { transport: "http"; url: string; headers: McpValueView[] }
  | { transport: "stdio"; command: string; arguments: McpValueView[]; environment: McpValueView[] }
);

export type Run = {
  id: number;
  sessionId: number;
  status: RunStatus;
  input: string;
  result: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  usage: TokenUsage | null;
};

export type TokenUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedReadTokens: number | null;
  cachedWriteTokens: number | null;
  thoughtTokens: number | null;
  totalTokens: number | null;
  contextUsedTokens: number | null;
  contextWindowTokens: number | null;
};

export type TokenUsageSummary = {
  sessionCount: number;
  measuredSessionCount: number;
  usage: Omit<TokenUsage, "contextUsedTokens" | "contextWindowTokens">;
};

export type SessionDetail = Session & { runs: Run[]; usageSummary?: TokenUsageSummary };

export type RunEvent = {
  id: number;
  runId: number;
  seq: number;
  type: "message" | "tool" | "status" | "error";
  contentJson: string;
  createdAt: string;
};

export type IntegrationTaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type IntegrationParameterMapping =
  | { parameterKey: string; source: "request"; requestKey: string }
  | { parameterKey: string; source: "fixed"; configured: boolean };
export type IntegrationParameterMappingInput =
  | { parameterKey: string; source: "request"; requestKey: string }
  | { parameterKey: string; source: "fixed"; value: string };
export type IntegrationParameterMappingUpdateInput =
  | { parameterKey: string; source: "request"; requestKey: string }
  | { parameterKey: string; source: "fixed"; value?: string };
export type IntegrationTask = {
  id: number;
  endpointId: number;
  conversationId: number | null;
  sessionId: number;
  runId: number | null;
  requestId: string;
  message: string;
  status: IntegrationTaskStatus;
  result: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};
export type IntegrationEndpointSummary = {
  id: number;
  name: string;
  slug: string;
  agentId: number;
  enabled: boolean;
  activeConversationCount: number;
  activeTaskCount: number;
  latestTask: Pick<IntegrationTask, "id" | "requestId" | "status" | "createdAt"> | null;
  createdAt: string;
  updatedAt: string;
};
export type IntegrationEndpoint = Omit<IntegrationEndpointSummary,
  "activeConversationCount" | "activeTaskCount" | "latestTask"> & {
    promptPrefix: string;
    parameterMappings: IntegrationParameterMapping[];
  };
export type IntegrationEndpointInput = {
  name: string;
  slug: string;
  agentId: number;
  enabled: boolean;
  promptPrefix: string;
  parameterMappings: IntegrationParameterMappingInput[];
};
export type IntegrationEndpointUpdateInput = Omit<Partial<IntegrationEndpointInput>, "parameterMappings"> & {
  parameterMappings?: IntegrationParameterMappingUpdateInput[];
};
export type IntegrationConversation = {
  id: number;
  endpointId: number;
  conversationKey: string;
  sessionId: number;
  status: "active" | "ended";
  createdAt: string;
  endedAt: string | null;
};
export type WebhookEventType =
  | "task.queued" | "task.started" | "task.succeeded" | "task.failed" | "task.cancelled"
  | "message.user.received" | "message.agent.reply" | "message.system.notice"
  | "tool.started" | "tool.completed" | "tool.failed";
export type IntegrationWebhook = {
  id: number;
  endpointId: number;
  name: string;
  url: string;
  enabled: boolean;
  events: WebhookEventType[];
  headers: Array<{ name: string; configured: true }>;
  signingSecretConfigured: true;
  timeoutSeconds: number;
  createdAt: string;
  updatedAt: string;
};
export type IntegrationWebhookInput = {
  name: string;
  url: string;
  enabled: boolean;
  events: WebhookEventType[];
  headers: Record<string, string>;
  timeoutSeconds: number;
};
export type WebhookDelivery = {
  id: number;
  eventId: string;
  sequence: number;
  dispatchOrder: number;
  subscriptionId: number;
  taskId: number | null;
  eventType: string;
  status: "pending" | "delivering" | "succeeded" | "failed";
  attemptCount: number;
  nextAttemptAt: string;
  lastStatusCode: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ApiError = { error?: { code?: string; message?: string }; message?: string };

export class RunStreamPermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunStreamPermanentError";
  }
}

export const isRunStreamPermanentError = (error: unknown): error is RunStreamPermanentError =>
  error instanceof RunStreamPermanentError;

/** Sends one authenticated request to the server API. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = sessionStorage.getItem("apiToken");
  const headers = new Headers(init.headers);
  if (init.body != null && !headers.has("content-type")) headers.set("content-type", "application/json");
  headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`/api${path}`, { ...init, headers });
  if (!response.ok) throw await response.json();
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

/** Opens an authenticated Event stream from the supplied sequence cursor. */
export function streamRunEvents(
  runId: number,
  afterSeq: number,
  onEvent: (event: RunEvent) => void,
  signal: AbortSignal
): Promise<void> {
  return fetchEventSource(`/api/runs/${runId}/events/stream?afterSeq=${afterSeq}`, {
    headers: { authorization: `Bearer ${sessionStorage.getItem("apiToken")}` },
    signal,
    openWhenHidden: true,
    onopen(response) {
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok) {
        const message = `Event stream request failed with HTTP ${response.status}`;
        if (response.status < 500) throw new RunStreamPermanentError(message);
        throw new Error(message);
      }
      if (!contentType.toLowerCase().startsWith("text/event-stream")) {
        throw new RunStreamPermanentError(`Event stream returned unsupported content type: ${contentType || "missing"}`);
      }
      return Promise.resolve();
    },
    onmessage(message) {
      onEvent(JSON.parse(message.data) as RunEvent);
    },
    onclose() {
      throw new Error("Event stream closed");
    },
    onerror(error) {
      throw error;
    }
  });
}

export const errorMessage = (error: unknown): string => {
  if (typeof error !== "object" || error === null) return String(error);
  const value = error as ApiError;
  return value.error?.message ?? value.message ?? "请求失败，请稍后重试";
};

export const integrationApi = {
  listEndpoints: (signal?: AbortSignal) => api<IntegrationEndpointSummary[]>("/integration-endpoints", { signal }),
  getEndpoint: (id: number, signal?: AbortSignal) => api<IntegrationEndpoint>(`/integration-endpoints/${id}`, { signal }),
  createEndpoint: (input: IntegrationEndpointInput) => api<{ endpoint: IntegrationEndpoint; token: string }>(
    "/integration-endpoints", { method: "POST", body: JSON.stringify(input) }
  ),
  updateEndpoint: (id: number, input: IntegrationEndpointUpdateInput) => api<IntegrationEndpoint>(
    `/integration-endpoints/${id}`, { method: "PATCH", body: JSON.stringify(input) }
  ),
  rotateEndpointToken: (id: number) => api<{ endpoint: IntegrationEndpoint; token: string }>(
    `/integration-endpoints/${id}/rotate-token`, { method: "POST" }
  ),
  deleteEndpoint: (id: number) => api<void>(`/integration-endpoints/${id}`, { method: "DELETE" }),
  listConversations: (id: number, signal?: AbortSignal) => api<IntegrationConversation[]>(
    `/integration-endpoints/${id}/conversations`, { signal }
  ),
  listTasks: (id: number, signal?: AbortSignal) => api<IntegrationTask[]>(
    `/integration-endpoints/${id}/tasks`, { signal }
  ),
  createTestTask: (id: number, input: {
    conversationKey?: string;
    message: string;
    parameters: Record<string, string>;
  }) => api<IntegrationTask>(`/integration-endpoints/${id}/test-tasks`, {
    method: "POST", body: JSON.stringify(input)
  }),
  getTask: (id: number, signal?: AbortSignal) => api<IntegrationTask>(`/integration-tasks/${id}`, { signal }),
  cancelTask: (id: number, signal?: AbortSignal) => api<IntegrationTask>(
    `/integration-tasks/${id}/cancel`, { method: "POST", signal }
  ),
  listWebhooks: (id: number, signal?: AbortSignal) => api<IntegrationWebhook[]>(
    `/integration-endpoints/${id}/webhooks`, { signal }
  ),
  createWebhook: (id: number, input: IntegrationWebhookInput) => api<{
    webhook: IntegrationWebhook; signingSecret: string;
  }>(`/integration-endpoints/${id}/webhooks`, { method: "POST", body: JSON.stringify(input) }),
  updateWebhook: (endpointId: number, id: number, input: Partial<IntegrationWebhookInput>) => api<IntegrationWebhook>(
    `/integration-endpoints/${endpointId}/webhooks/${id}`, { method: "PATCH", body: JSON.stringify(input) }
  ),
  deleteWebhook: (endpointId: number, id: number) => api<void>(
    `/integration-endpoints/${endpointId}/webhooks/${id}`, { method: "DELETE" }
  ),
  testWebhook: (endpointId: number, id: number) => api<WebhookDelivery>(
    `/integration-endpoints/${endpointId}/webhooks/${id}/test`, { method: "POST" }
  ),
  listDeliveries: (endpointId: number, signal?: AbortSignal) => api<WebhookDelivery[]>(
    `/integration-endpoints/${endpointId}/webhook-deliveries`, { signal }
  ),
  retryDelivery: (id: number) => api<WebhookDelivery>(`/webhook-deliveries/${id}/retry`, { method: "POST" })
};
