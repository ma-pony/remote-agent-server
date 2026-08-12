export type Provider = "claude_code" | "codex" | "hermes";
export type AgentProvider = Provider;
export type SessionStatus = "idle" | "running";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type EventType = "message" | "tool" | "status" | "error";

export type Agent = {
  id: string;
  name: string;
  provider: AgentProvider;
  enabled: boolean;
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
