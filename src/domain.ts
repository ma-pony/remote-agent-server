import type { AgentModelPolicy } from "./agents/model-policy.js";

export type Provider = "claude_code" | "codex" | "hermes" | "deepseek_harness";
/** Application-supported runtime behavior, shared by preflight and management UI. */
export const PROVIDER_CAPABILITIES = {
  claude_code: { label: "Claude Code", instructions: true, rtk: "hook" },
  codex: { label: "Codex", instructions: true, rtk: "hook" },
  hermes: { label: "Hermes", instructions: false, rtk: "plugin" },
  deepseek_harness: { label: "DeepSeek Harness", instructions: true, rtk: "unsupported" }
} as const satisfies Record<Provider, { label: string; instructions: boolean; rtk: "hook" | "plugin" | "unsupported" }>;
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
  modelPolicy: AgentModelPolicy;
  providerDefaultModel: string | null;
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
  createdAt: string;
  updatedAt: string;
};

/** A provider-native conversation owned by one business Session. */
export type ExecutionContext = {
  id: number;
  sessionId: number;
  provider: Provider;
  providerSessionId: string | null;
  legacyStorageSessionId: number | null;
  handoff: string | null;
  createdAt: string;
  retiredAt: string | null;
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
  rtk?: import("./rtk/rtk-types.js").RtkRunSnapshot | null;
  eventsPrunedAt?: string | null;
  eventsPrunedThroughSeq?: number;
  attachments?: import("./attachments/attachment-types.js").Attachment[];
  id: number;
  sessionId: number;
  executionContextId: number | null;
  provider: Provider | null;
  status: RunStatus;
  input: string;
  result: string | null;
  error: string | null;
  resolvedModel: string | null;
  skillsRevision: string | null;
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
