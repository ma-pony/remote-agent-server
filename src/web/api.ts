import { fetchEventSource } from "@microsoft/fetch-event-source";

export type Provider = "claude_code" | "codex" | "hermes";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type Agent = {
  id: string;
  name: string;
  provider: Provider;
  enabled: boolean;
  projectEnvironmentId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DoctorResult = { ok: boolean; message: string; details: string[] };
export type AgentDoctorResult = {
  provider: DoctorResult;
  projectEnvironment: { ok: boolean; message: string; revisionId: string | null };
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
  id: string;
  projectEnvironmentId: string;
  name: string;
  gitUrl: string;
  prepareCommand: string | null;
  workspacePath: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProjectEnvironmentRevision = {
  id: string;
  projectEnvironmentId: string;
  status: "preparing" | "ready" | "failed";
  workspacePath: string | null;
  inputFingerprint: string;
  failureStage: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export type ProjectEnvironment = {
  id: string;
  name: string;
  currentRevisionId: string | null;
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
  id: string;
  agentId: string;
  title: string;
  status: "idle" | "running";
  providerSessionId: string | null;
  workspacePath: string;
  projectEnvironmentRevisionId: string | null;
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
  id: string;
  agentId: string;
  key: string;
  label: string;
  description: string | null;
  required: boolean;
  secret: boolean;
  createdAt: string;
  updatedAt: string;
};

export type McpValueView = {
  id: string;
  source: "fixed" | "session_parameter" | "runtime";
  name?: string;
  value?: string;
  secret?: boolean;
  configured?: boolean;
  parameterKey?: string;
  runtimeKey?: "agent_id" | "session_id" | "run_id" | "workspace_path" | "browser_profile_path";
};

export type AgentMcpServerSummary = {
  id: string;
  agentId: string;
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

export type AgentMcpServerDetail = AgentMcpServerSummary & (
  | { transport: "http"; url: string; headers: McpValueView[] }
  | { transport: "stdio"; command: string; arguments: McpValueView[]; environment: McpValueView[] }
);

export type Run = {
  id: string;
  sessionId: string;
  status: RunStatus;
  input: string;
  result: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type SessionDetail = Session & { runs: Run[] };

export type RunEvent = {
  id: string;
  runId: string;
  seq: number;
  type: "message" | "tool" | "status" | "error";
  contentJson: string;
  createdAt: string;
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
  runId: string,
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
