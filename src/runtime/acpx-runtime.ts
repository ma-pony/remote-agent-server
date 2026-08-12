import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  createAcpRuntime,
  createRuntimeStore,
  type AcpAgentRegistry,
  type AcpRuntime,
  type AcpRuntimeEvent,
  type AcpRuntimeHandle,
  type AcpRuntimeOptions,
  type AcpRuntimeTurn,
  type AcpRuntimeTurnResult
} from "acpx/runtime";

import type { AppConfig } from "../config.js";
import type { Provider } from "../domain.js";
import type {
  AgentRuntime,
  RuntimeDoctor,
  RuntimeEvent,
  RuntimeSession,
  RuntimeSessionInput,
  RuntimeTurn,
  RuntimeTurnInput,
  RuntimeTurnResult
} from "./agent-runtime.js";

export const ACP_AGENT = {
  claude_code: "claude",
  codex: "codex",
  hermes: "hermes"
} as const;

const ACP_COMMAND: Record<(typeof ACP_AGENT)[Provider], string> = {
  claude: "npx -y @agentclientprotocol/claude-agent-acp@^0.60.0",
  codex: "npx -y @agentclientprotocol/codex-acp@^1.1.5",
  hermes: "hermes acp"
};

const providers = new Set<Provider>(["claude_code", "codex", "hermes"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RuntimeTarget = {
  provider: Provider;
  agentId: string;
  sessionId: string;
  browserProfilePath: string;
};

export class AgentRuntimeError extends Error {
  constructor(readonly code: "invalid_runtime_target" | "session_not_ready" | "session_resume_failed", message: string) {
    super(message);
    this.name = "AgentRuntimeError";
  }
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const assertTarget = (provider: Provider, agentId: string, sessionId: string): void => {
  if (!providers.has(provider) || !uuidPattern.test(agentId) || !uuidPattern.test(sessionId)) {
    throw new AgentRuntimeError("invalid_runtime_target", "Runtime target must contain a known Provider and UUID identifiers");
  }
};

const targetName = (target: RuntimeTarget): string => {
  assertTarget(target.provider, target.agentId, target.sessionId);
  return `remote:${target.provider}:${target.agentId}:${target.sessionId}`;
};

class RemoteAgentRegistry implements AcpAgentRegistry {
  private readonly targets = new Map<string, RuntimeTarget>();

  constructor(private readonly dataDir: string) {}

  register(target: RuntimeTarget): string {
    const name = targetName(target);
    this.targets.set(name, target);
    return name;
  }

  resolve(agentName: string): string {
    const target = this.targets.get(agentName);
    if (target === undefined) {
      throw new AgentRuntimeError("invalid_runtime_target", "Unknown Runtime target");
    }

    const environment = [`REMOTE_AGENT_BROWSER_PROFILE=${shellQuote(target.browserProfilePath)}`];
    if (target.provider === "hermes") {
      environment.push(
        `HERMES_HOME=${shellQuote(join(this.dataDir, "agents", target.agentId, "provider-home", "hermes"))}`
      );
    }
    return `env ${environment.join(" ")} ${ACP_COMMAND[ACP_AGENT[target.provider]]}`;
  }

  list(): string[] {
    return [...this.targets.keys()];
  }

  clear(): void {
    this.targets.clear();
  }

  unregister(agentName: string): void {
    this.targets.delete(agentName);
  }
}

type ManagedSession = {
  handle: AcpRuntimeHandle;
  providerSessionId: string | null;
  provider: Provider;
  agentId: string;
  workspacePath: string;
  browserProfilePath: string;
  target: string;
};

type ActiveTurn = {
  handle: AcpRuntimeHandle;
  turn: AcpRuntimeTurn;
};

const toolContent = (event: Extract<AcpRuntimeEvent, { type: "tool_call" }>): Record<string, unknown> => {
  const content: Record<string, unknown> = {};
  for (const key of [
    "text",
    "tag",
    "toolCallId",
    "status",
    "title",
    "kind",
    "locations",
    "rawInput",
    "rawOutput",
    "content"
  ] as const) {
    const value = event[key];
    if (value !== undefined) content[key] = value;
  }
  return content;
};

const mapEvent = (event: AcpRuntimeEvent): RuntimeEvent | undefined => {
  if (event.type === "text_delta") {
    return { type: "message", stream: event.stream ?? "output", text: event.text };
  }
  if (event.type === "tool_call") return { type: "tool", content: toolContent(event) };
  if (event.type === "status") return { type: "status", text: event.text };
  if (event.type === "error") return { type: "error", code: event.code, message: event.message };
  return undefined;
};

const mapResult = (result: AcpRuntimeTurnResult): RuntimeTurnResult => {
  if (result.status === "completed") return { status: "completed" };
  if (result.status === "cancelled") return { status: "cancelled" };
  return { status: "failed", code: result.error.code, message: result.error.message };
};

const systemPrompt = (input: RuntimeSessionInput): string => {
  const sections = [
    `Workspace root: ${input.workspacePath}`,
    `Browser profile: ${input.browserProfilePath}`
  ];
  if (input.memory.trim() !== "") sections.push(`Memory:\n${input.memory}`);
  return sections.join("\n\n");
};

/**
 * Adapts the embedded acpx API to the service's provider-neutral Runtime contract.
 */
export class AcpxAgentRuntime implements AgentRuntime {
  private readonly registry: RemoteAgentRegistry;
  private readonly runtime: AcpRuntime;
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly sessionOperations = new Map<string, Promise<void>>();

  constructor(private readonly config: AppConfig) {
    this.registry = new RemoteAgentRegistry(config.dataDir);
    this.runtime = this.createRuntime(this.registry);
  }

  async ensureSession(input: RuntimeSessionInput): Promise<RuntimeSession> {
    return this.serializeSession(input.sessionId, () => this.ensureSessionLocked(input));
  }

  private async ensureSessionLocked(input: RuntimeSessionInput): Promise<RuntimeSession> {
    assertTarget(input.provider, input.agentId, input.sessionId);
    const existing = this.sessions.get(input.sessionId);
    if (existing !== undefined && this.canReuse(existing, input)) {
      return { providerSessionId: existing.providerSessionId };
    }
    if (existing !== undefined) {
      await this.runtime.close({ handle: existing.handle, reason: "session_handle_replaced" });
      this.sessions.delete(input.sessionId);
      this.registry.unregister(existing.target);
    }

    const agent = this.registry.register({
      provider: input.provider,
      agentId: input.agentId,
      sessionId: input.sessionId,
      browserProfilePath: input.browserProfilePath
    });
    const handle = await this.runtime.ensureSession({
      sessionKey: `remote-agent:${input.sessionId}`,
      agent,
      mode: "persistent",
      cwd: input.workspacePath,
      ...(input.providerSessionId === null
        ? { sessionOptions: { systemPrompt: { append: systemPrompt(input) } } }
        : { resumeSessionId: input.providerSessionId })
    });
    const providerSessionId = handle.agentSessionId ?? handle.backendSessionId ?? null;

    if (
      input.providerSessionId !== null
      && providerSessionId !== null
      && providerSessionId !== input.providerSessionId
    ) {
      try {
        await this.runtime.close({
          handle,
          reason: "provider_session_id_mismatch"
        });
      } finally {
        this.sessions.delete(input.sessionId);
        this.registry.unregister(agent);
      }
      throw new AgentRuntimeError(
        "session_resume_failed",
        "Provider session resume returned a different session ID"
      );
    }

    this.sessions.set(input.sessionId, {
      handle,
      providerSessionId,
      provider: input.provider,
      agentId: input.agentId,
      workspacePath: input.workspacePath,
      browserProfilePath: input.browserProfilePath,
      target: agent
    });
    return { providerSessionId };
  }

  startTurn(input: RuntimeTurnInput): RuntimeTurn {
    if (this.sessionOperations.has(input.sessionId)) {
      throw new AgentRuntimeError("session_not_ready", "Runtime session is being changed");
    }
    const session = this.sessions.get(input.sessionId);
    if (session === undefined) {
      throw new AgentRuntimeError("session_not_ready", "Runtime session has not been ensured");
    }
    const turn = this.runtime.startTurn({
      handle: session.handle,
      text: input.text,
      mode: "prompt",
      requestId: input.requestId
    });
    const activeTurn = { handle: session.handle, turn };
    this.activeTurns.set(input.sessionId, activeTurn);
    const result = turn.result.then(mapResult);
    void turn.result.then(
      () => this.clearActiveTurn(input.sessionId, activeTurn),
      () => this.clearActiveTurn(input.sessionId, activeTurn)
    );

    return {
      events: {
        async *[Symbol.asyncIterator]() {
          for await (const event of turn.events) {
            const mapped = mapEvent(event);
            if (mapped !== undefined) yield mapped;
          }
        }
      },
      result,
      cancel: async (): Promise<void> => turn.cancel({ reason: "cancelled_by_request" })
    };
  }

  async cancel(sessionId: string): Promise<void> {
    const activeTurn = this.activeTurns.get(sessionId);
    if (activeTurn !== undefined) {
      await activeTurn.turn.cancel({ reason: "cancelled_by_request" });
      return;
    }
    const session = this.sessions.get(sessionId);
    if (session !== undefined) {
      await this.runtime.cancel({ handle: session.handle, reason: "cancelled_by_request" });
    }
  }

  async reset(input: RuntimeSessionInput): Promise<void> {
    await this.serializeSession(input.sessionId, async () => {
      await this.ensureSessionLocked(input);
      const session = this.sessions.get(input.sessionId);
      if (session === undefined) {
        throw new AgentRuntimeError("session_not_ready", "Runtime session has not been ensured");
      }
      await this.runtime.close({
        handle: session.handle,
        reason: "provider_session_reset",
        discardPersistentState: true
      });
      this.sessions.delete(input.sessionId);
      this.activeTurns.delete(input.sessionId);
      this.registry.unregister(session.target);
    });
  }

  async doctor(provider: Provider, agentId: string): Promise<RuntimeDoctor> {
    const sessionId = randomUUID();
    assertTarget(provider, agentId, sessionId);
    const registry = new RemoteAgentRegistry(this.config.dataDir);
    const probeAgent = registry.register({
      provider,
      agentId,
      sessionId,
      browserProfilePath: join(this.config.dataDir, "agents", agentId, "doctor-browser")
    });
    const runtime = this.createRuntime(registry, probeAgent);
    try {
      const report = await runtime.doctor?.();
      return report === undefined
        ? { ok: false, message: "acpx doctor is unavailable", details: [] }
        : { ok: report.ok, message: report.message, details: report.details ?? [] };
    } finally {
      registry.clear();
    }
  }

  private canReuse(session: ManagedSession, input: RuntimeSessionInput): boolean {
    return session.provider === input.provider
      && session.agentId === input.agentId
      && session.workspacePath === input.workspacePath
      && session.browserProfilePath === input.browserProfilePath
      && (input.providerSessionId === null || session.providerSessionId === input.providerSessionId);
  }

  private clearActiveTurn(sessionId: string, activeTurn: ActiveTurn): void {
    if (this.activeTurns.get(sessionId) === activeTurn) this.activeTurns.delete(sessionId);
  }

  private serializeSession<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionOperations.get(sessionId) ?? Promise.resolve();
    const run = previous.then(operation);
    const settled = run.then(() => undefined, () => undefined);
    this.sessionOperations.set(sessionId, settled);
    return run.finally(() => {
      if (this.sessionOperations.get(sessionId) === settled) this.sessionOperations.delete(sessionId);
    });
  }

  private createRuntime(agentRegistry: AcpAgentRegistry, probeAgent?: string): AcpRuntime {
    const options: AcpRuntimeOptions = {
      cwd: this.config.workspaceTemplate,
      sessionStore: createRuntimeStore({ stateDir: join(this.config.dataDir, "acpx") }),
      agentRegistry,
      permissionMode: "approve-all",
      nonInteractivePermissions: "fail",
      ...(probeAgent === undefined ? {} : { probeAgent })
    };
    return createAcpRuntime(options);
  }
}
