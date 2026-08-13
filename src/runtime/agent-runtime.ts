import type { Provider } from "../domain.js";
import type { RuntimeMcpServer } from "../mcp/mcp-types.js";

export type RuntimeSessionInput = {
  sessionId: string;
  agentId: string;
  provider: Provider;
  workspacePath: string;
  browserProfilePath: string;
  providerSessionId: string | null;
  memory: string;
  mcpServers: RuntimeMcpServer[];
};

export type RuntimeSession = { providerSessionId: string | null };
export type RuntimeTurnInput = { sessionId: string; requestId: string; text: string };
export type RuntimeEvent =
  | { type: "message"; stream: "output" | "thought"; text: string }
  | { type: "tool"; content: Record<string, unknown> }
  | { type: "status"; text: string }
  | { type: "error"; code?: string; message: string };
export type RuntimeTurnResult =
  | { status: "completed" }
  | { status: "cancelled" }
  | { status: "failed"; code?: string; message: string };
export type RuntimeDoctor = { ok: boolean; message: string; details: string[] };

export type RuntimeTurn = {
  events: AsyncIterable<RuntimeEvent>;
  result: Promise<RuntimeTurnResult>;
  cancel(): Promise<void>;
  closeEvents(): Promise<void>;
};

export interface AgentRuntime {
  ensureSession(input: RuntimeSessionInput): Promise<RuntimeSession>;
  startTurn(input: RuntimeTurnInput): RuntimeTurn;
  cancel(sessionId: string): Promise<void>;
  reset(input: RuntimeSessionInput): Promise<void>;
  doctor(provider: Provider, agentId: string): Promise<RuntimeDoctor>;
  shutdown(): Promise<void>;
}
