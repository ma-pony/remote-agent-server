export type Provider = "claude_code" | "codex" | "hermes";
export type AgentProvider = Provider;
export type SessionStatus = "idle" | "running";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type IntegrationTaskStatus = RunStatus;
export type EventType = "message" | "tool" | "status" | "error";
export type ProjectEnvironmentRevisionStatus = "preparing" | "ready" | "failed";

export type ProjectEnvironment = {
  id: string;
  name: string;
  currentRevisionId: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type EnvironmentRepository = {
  id: string;
  projectEnvironmentId: string;
  name: string;
  gitUrl: string;
  prepareCommand: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProjectEnvironmentRevision = {
  id: string;
  projectEnvironmentId: string;
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
  id: string;
  name: string;
  provider: AgentProvider;
  enabled: boolean;
  projectEnvironmentId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Session = {
  id: string;
  agentId: string;
  title: string;
  status: SessionStatus;
  providerSessionId: string | null;
  workspacePath: string;
  projectEnvironmentRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
};

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

export type Event = {
  id: string;
  runId: string;
  seq: number;
  type: EventType;
  contentJson: string;
  createdAt: string;
};
