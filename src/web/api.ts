import { fetchEventSource } from "@microsoft/fetch-event-source";

export type Provider = "claude_code" | "codex" | "hermes";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type Agent = {
  id: string;
  name: string;
  provider: Provider;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type DoctorResult = { ok: boolean; message: string; details: string[] };

export type Session = {
  id: string;
  agentId: string;
  title: string;
  status: "idle" | "running";
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

/** Sends one authenticated JSON request to the server API. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = sessionStorage.getItem("apiToken");
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`/api${path}`, { ...init, headers });
  if (!response.ok) throw await response.json();
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
