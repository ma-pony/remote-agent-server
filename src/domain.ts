export type Provider = "claude_code" | "codex" | "hermes";
export type AgentProvider = Provider;
export type SessionStatus = "idle" | "running";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type IntegrationTaskStatus = RunStatus;
export type EventType = "message" | "tool" | "status" | "error";
export type ProjectEnvironmentRevisionStatus = "preparing" | "ready" | "failed";

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

export type TokenUsageTotals = Omit<TokenUsage, "contextUsedTokens" | "contextWindowTokens">;

export type TokenUsageSummary = {
  sessionCount: number;
  measuredSessionCount: number;
  usage: TokenUsageTotals;
};

export type ProjectEnvironment = {
  id: number;
  name: string;
  currentRevisionId: number | null;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type EnvironmentRepository = {
  id: number;
  projectEnvironmentId: number;
  name: string;
  gitUrl: string;
  prepareCommand: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProjectEnvironmentRevision = {
  id: number;
  projectEnvironmentId: number;
  status: ProjectEnvironmentRevisionStatus;
  workspacePath: string | null;
  inputFingerprint: string;
  failureStage: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export type ProjectEnvironmentDetail = ProjectEnvironment & {
  repositories: EnvironmentRepository[];
  currentRevision: ProjectEnvironmentRevision | null;
  latestRevision: ProjectEnvironmentRevision | null;
};

export type Agent = {
  id: number;
  name: string;
  provider: AgentProvider;
  enabled: boolean;
  instructions: string;
  maxConcurrentRuns: number | null;
  effectiveMaxConcurrentRuns: number;
  projectEnvironmentId: number | null;
  createdAt: string;
  updatedAt: string;
};

export type Session = {
  id: number;
  agentId: number;
  title: string;
  status: SessionStatus;
  providerSessionId: string | null;
  storageCleanedAt: string | null;
  workspacePath: string;
  projectEnvironmentRevisionId: number | null;
  instructionsSnapshot: string;
  usage: TokenUsageTotals | null;
  createdAt: string;
  updatedAt: string;
};

export type SessionListItem = Session & {
  agentName: string;
  agentProvider: Provider;
  projectEnvironmentName: string | null;
  integration: {
    endpointId: number;
    endpointName: string;
    endpointSlug: string;
    conversationKey: string | null;
    latestRequestId: string | null;
  } | null;
};

export type Page<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

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

export type Event = {
  id: number;
  runId: number;
  seq: number;
  type: EventType;
  contentJson: string;
  createdAt: string;
};
