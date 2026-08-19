import { constants, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";

import {
  createAcpRuntime,
  createRuntimeStore,
  type AcpAgentRegistry,
  type AcpRuntime,
  type AcpRuntimeEvent,
  type AcpRuntimeHandle,
  type AcpRuntimeOptions,
  type AcpRuntimeTurn,
  type AcpRuntimeTurnResult,
  type AcpRuntimeUsageBreakdown
} from "acpx/runtime";

import type { AppConfig } from "../config.js";
import type { Provider, TokenUsage, TokenUsageTotals } from "../domain.js";
import { SkillManager } from "../skills/skill-manager.js";
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
import { settleBestEffort } from "./bounded-operation.js";

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
type RuntimeTarget = {
  provider: Provider;
  agentId: number;
  sessionId: number;
  browserProfilePath: string;
  instructions: string;
};

export class AgentRuntimeError extends Error {
  constructor(readonly code: "invalid_runtime_target" | "session_not_ready" | "session_resume_failed" | "runtime_shutdown", message: string) {
    super(message);
    this.name = "AgentRuntimeError";
  }
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const runtimeProviderEntries = new Set([
  "archived_sessions",
  "attachments",
  "browser",
  "browser-profiles",
  "daemon",
  "debug",
  "downloads",
  "file-history",
  "generated_images",
  "ipc",
  "jobs",
  "node_repl",
  "paste-cache",
  "pastes",
  "process_manager",
  "projects",
  "sandboxes",
  "session-env",
  "sessions",
  "shell_snapshots",
  "tasks",
  "teams",
  "transcripts",
  "workspace",
  "worktrees"
]);

const isRuntimeProviderEntry = (name: string): boolean => {
  const normalized = name.toLowerCase();
  return runtimeProviderEntries.has(normalized)
    || /(^|[._-])(cache|history|log|logs|tmp|temp|lock|locks|state)([._-]|$)/i.test(normalized)
    || /\.(db|sqlite)(-.+)?$/i.test(normalized);
};

const copyProviderHome = (source: string, destination: string): void => {
  mkdirSync(destination, { recursive: true });
  if (!existsSync(source)) return;

  for (const entry of readdirSync(source)) {
    if (isRuntimeProviderEntry(entry)) continue;
    const sourcePath = join(source, entry);
    const destinationPath = join(destination, entry);
    rmSync(destinationPath, { force: true, recursive: true });
    cpSync(sourcePath, destinationPath, {
      recursive: true,
      force: true,
      mode: constants.COPYFILE_FICLONE,
      filter: (path) => path === sourcePath
        || !relative(sourcePath, path).split(sep).some(isRuntimeProviderEntry)
    });
  }
};

const codexConfigWithManagedSettings = (
  home: string,
  instructions: string,
  disabledSkills: string
): string => {
  const path = join(home, "config.toml");
  const hostConfig = existsSync(path) ? readFileSync(path, "utf8") : "";
  const preservedConfig = hostConfig
    .replace(/^\s*developer_instructions\s*=.*(?:\r?\n|$)/m, "")
    .trim();
  return [
    instructions.trim() === "" ? "" : `developer_instructions = ${JSON.stringify(instructions)}`,
    preservedConfig,
    disabledSkills
  ].filter((section) => section !== "").join("\n\n");
};

const assertTarget = (provider: Provider, agentId: number, sessionId: number): void => {
  if (!providers.has(provider) || !Number.isSafeInteger(agentId) || agentId <= 0
    || !Number.isSafeInteger(sessionId) || sessionId < 0) {
    throw new AgentRuntimeError("invalid_runtime_target", "Runtime target must contain a known Provider and numeric identifiers");
  }
};

const targetName = (target: RuntimeTarget): string => {
  assertTarget(target.provider, target.agentId, target.sessionId);
  return `remote:${target.provider}:${target.agentId}:${target.sessionId}`;
};

class RemoteAgentRegistry implements AcpAgentRegistry {
  private readonly targets = new Map<string, RuntimeTarget>();

  constructor(private readonly dataDir: string, private readonly skillManager: SkillManager) {}

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

    const providerHome = join(this.dataDir, "agents", String(target.agentId), "provider-home");
    const environment = [`REMOTE_AGENT_BROWSER_PROFILE=${shellQuote(target.browserProfilePath)}`];
    if (target.provider === "hermes") {
      const home = join(providerHome, "hermes");
      const hostHome = process.env.HERMES_HOME ?? join(homedir(), ".hermes");
      copyProviderHome(hostHome, home);
      environment.push(`HERMES_HOME=${shellQuote(home)}`);
    } else if (target.provider === "codex") {
      const agentHome = join(providerHome, "codex");
      const home = join(agentHome, "sessions", String(target.sessionId));
      const hostHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
      copyProviderHome(hostHome, home);
      const disabledSkills = this.skillManager.hostSkillFiles().map((path) => [
        "[[skills.config]]",
        `path = ${JSON.stringify(path)}`,
        "enabled = false"
      ].join("\n")).join("\n\n");
      const config = codexConfigWithManagedSettings(home, target.instructions, disabledSkills);
      writeFileSync(join(home, "config.toml"), config === "" ? "" : `${config}\n`, { mode: 0o600 });
      environment.push(`CODEX_HOME=${shellQuote(home)}`);
    } else {
      const home = join(providerHome, "claude");
      const hostHome = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
      copyProviderHome(hostHome, home);
      environment.push(`CLAUDE_CONFIG_DIR=${shellQuote(home)}`);
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
  runtime: AcpRuntime;
  registry: RemoteAgentRegistry;
  handle: AcpRuntimeHandle;
  providerSessionId: string | null;
  provider: Provider;
  agentId: number;
  workspacePath: string;
  browserProfilePath: string;
  instructions: string;
  target: string;
};

type ActiveTurn = {
  handle: AcpRuntimeHandle;
  turn: AcpRuntimeTurn;
};

type SessionOperation = {
  barrier: Promise<void>;
  completion: Promise<void>;
};

class RuntimeShutdownFailure extends Error {
  constructor(
    readonly stage: "active_cancel" | "session_operation" | "handle_close" | "late_handle_close",
    readonly sessionId: number,
    reason: unknown
  ) {
    super(`Runtime shutdown ${stage} failed for Session ${sessionId}`, { cause: reason });
    this.name = "RuntimeShutdownFailure";
  }
}

type RuntimeShutdownFailureSnapshot = Readonly<{
  stage: RuntimeShutdownFailure["stage"];
  sessionId: number;
  message: string;
}>;

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

const validUsageValue = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;

const usageContent = (event: Extract<AcpRuntimeEvent, { type: "status" }>): Partial<TokenUsage> => {
  const usage: Partial<TokenUsage> = {};
  const fields = [
    ["inputTokens", event.breakdown?.inputTokens],
    ["outputTokens", event.breakdown?.outputTokens],
    ["cachedReadTokens", event.breakdown?.cachedReadTokens],
    ["cachedWriteTokens", event.breakdown?.cachedWriteTokens],
    ["thoughtTokens", event.breakdown?.thoughtTokens],
    ["totalTokens", event.breakdown?.totalTokens],
    ["contextUsedTokens", event.used],
    ["contextWindowTokens", event.size]
  ] as const;
  for (const [field, source] of fields) {
    const value = validUsageValue(source);
    if (value !== undefined) usage[field] = value;
  }
  return usage;
};

const sessionUsageContent = (source: AcpRuntimeUsageBreakdown | undefined): Partial<TokenUsageTotals> | undefined => {
  if (source === undefined) return undefined;
  const usage: Partial<TokenUsageTotals> = {};
  const fields = [
    ["inputTokens", source.inputTokens],
    ["outputTokens", source.outputTokens],
    ["cachedReadTokens", source.cachedReadTokens],
    ["cachedWriteTokens", source.cachedWriteTokens],
    ["thoughtTokens", source.thoughtTokens],
    ["totalTokens", source.totalTokens]
  ] as const;
  for (const [field, value] of fields) {
    const normalized = validUsageValue(value);
    if (normalized !== undefined) usage[field] = normalized;
  }
  return Object.keys(usage).length === 0 ? undefined : usage;
};

const aggregateSessionUsage = (source: {
  cumulative?: AcpRuntimeUsageBreakdown;
  perRequest?: Record<string, AcpRuntimeUsageBreakdown>;
} | undefined): Partial<TokenUsageTotals> | undefined => {
  const requests = Object.values(source?.perRequest ?? {});
  if (requests.length === 0) return sessionUsageContent(source?.cumulative);

  const total: Partial<TokenUsageTotals> = {};
  for (const request of requests) {
    const usage = sessionUsageContent(request);
    if (usage === undefined) continue;
    for (const field of [
      "inputTokens",
      "outputTokens",
      "cachedReadTokens",
      "cachedWriteTokens",
      "thoughtTokens",
      "totalTokens"
    ] as const) {
      const value = usage[field];
      if (value !== undefined && value !== null) total[field] = (total[field] ?? 0) + value;
    }
  }
  return Object.keys(total).length === 0 ? undefined : total;
};

const mapEvent = (event: AcpRuntimeEvent): RuntimeEvent | undefined => {
  if (event.type === "text_delta") {
    return { type: "message", stream: event.stream ?? "output", text: event.text };
  }
  if (event.type === "tool_call") return { type: "tool", content: toolContent(event) };
  if (event.type === "status") {
    if (event.tag === "usage_update") return { type: "usage", usage: usageContent(event) };
    return { type: "status", text: event.text };
  }
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
  if (input.instructions.trim() !== "") sections.unshift(`Agent instructions:\n${input.instructions}`);
  if (input.memory.trim() !== "") sections.push(`Memory:\n${input.memory}`);
  return sections.join("\n\n");
};

/**
 * Adapts the embedded acpx API to the service's provider-neutral Runtime contract.
 */
export class AcpxAgentRuntime implements AgentRuntime {
  private readonly sessions = new Map<number, ManagedSession>();
  private readonly activeTurns = new Map<number, ActiveTurn>();
  private readonly sessionOperations = new Map<number, SessionOperation>();
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | undefined;
  private readonly shutdownFailures: RuntimeShutdownFailure[] = [];

  constructor(private readonly config: AppConfig, private readonly skillManager = new SkillManager({ dataDir: config.dataDir })) {}

  async ensureSession(input: RuntimeSessionInput): Promise<RuntimeSession> {
    this.assertRunning();
    return this.serializeSession(input.sessionId, () => this.ensureSessionLocked(input));
  }

  private async ensureSessionLocked(input: RuntimeSessionInput): Promise<RuntimeSession> {
    assertTarget(input.provider, input.agentId, input.sessionId);
    const existing = this.sessions.get(input.sessionId);
    const reusable = existing !== undefined && this.canReuse(existing, input);
    if (reusable && input.providerSessionId === null) {
      return { providerSessionId: existing.providerSessionId };
    }
    if (existing !== undefined) {
      await existing.runtime.close({
        handle: existing.handle,
        reason: reusable ? "session_handle_refreshed" : "session_handle_replaced"
      });
      this.sessions.delete(input.sessionId);
      existing.registry.unregister(existing.target);
    }

    const registry = new RemoteAgentRegistry(this.config.dataDir, this.skillManager);
    const agent = registry.register({
      provider: input.provider,
      agentId: input.agentId,
      sessionId: input.sessionId,
      browserProfilePath: input.browserProfilePath,
      instructions: input.instructions
    });
    const runtime = this.createRuntime(registry, undefined, input.mcpServers);
    const handle = await runtime.ensureSession({
      sessionKey: `remote-agent:${input.sessionId}`,
      agent,
      mode: "persistent",
      cwd: input.workspacePath,
      ...(input.providerSessionId === null && input.provider === "claude_code"
        ? { sessionOptions: { systemPrompt: { append: systemPrompt(input) } } }
        : input.providerSessionId === null ? {} : { resumeSessionId: input.providerSessionId })
    });
    const providerSessionId = handle.agentSessionId ?? handle.backendSessionId ?? null;

    if (this.shuttingDown) {
      const outcome = await settleBestEffort(() => runtime.close({ handle, reason: "service_shutdown" }));
      if (outcome.status === "fulfilled") {
        registry.unregister(agent);
      } else {
        this.sessions.set(input.sessionId, {
          runtime,
          registry,
          handle,
          providerSessionId,
          provider: input.provider,
          agentId: input.agentId,
          workspacePath: input.workspacePath,
          browserProfilePath: input.browserProfilePath,
          instructions: input.instructions,
          target: agent
        });
        this.recordShutdownFailure("late_handle_close", input.sessionId, outcome.reason);
      }
      throw new AgentRuntimeError("runtime_shutdown", "Runtime is shutting down");
    }

    if (
      input.providerSessionId !== null
      && providerSessionId !== null
      && providerSessionId !== input.providerSessionId
    ) {
      try {
        await runtime.close({
          handle,
          reason: "provider_session_id_mismatch"
        });
      } finally {
        this.sessions.delete(input.sessionId);
        registry.unregister(agent);
      }
      throw new AgentRuntimeError(
        "session_resume_failed",
        "Provider session resume returned a different session ID"
      );
    }

    this.sessions.set(input.sessionId, {
      runtime,
      registry,
      handle,
      providerSessionId,
      provider: input.provider,
      agentId: input.agentId,
      workspacePath: input.workspacePath,
      browserProfilePath: input.browserProfilePath,
      instructions: input.instructions,
      target: agent
    });
    return { providerSessionId };
  }

  startTurn(input: RuntimeTurnInput): RuntimeTurn {
    this.assertRunning();
    if (this.sessionOperations.has(input.sessionId)) {
      throw new AgentRuntimeError("session_not_ready", "Runtime session is being changed");
    }
    const session = this.sessions.get(input.sessionId);
    if (session === undefined) {
      throw new AgentRuntimeError("session_not_ready", "Runtime session has not been ensured");
    }
    if (this.activeTurns.has(input.sessionId)) {
      throw new AgentRuntimeError("session_not_ready", "Runtime session still has an active Turn");
    }
    const turn = session.runtime.startTurn({
      handle: session.handle,
      text: input.text,
      mode: "prompt",
      requestId: String(input.requestId)
    });
    const activeTurn = { handle: session.handle, turn };
    this.activeTurns.set(input.sessionId, activeTurn);
    const result = turn.result.then(async (canonical): Promise<RuntimeTurnResult> => {
      const mapped = mapResult(canonical);
      try {
        const getStatus = session.runtime.getStatus;
        if (getStatus === undefined) return mapped;
        const status = await getStatus.call(session.runtime, { handle: session.handle });
        const sessionUsage = aggregateSessionUsage(status.usage);
        return sessionUsage === undefined ? mapped : { ...mapped, sessionUsage };
      } catch (_error) {
        return mapped;
      }
    });
    const clearActiveTurn = (): void => this.clearActiveTurn(input.sessionId, activeTurn);

    return {
      events: {
        async *[Symbol.asyncIterator]() {
          let completed = false;
          try {
            for await (const event of turn.events) {
              const mapped = mapEvent(event);
              if (mapped !== undefined) yield mapped;
            }
            completed = true;
          } finally {
            if (completed) clearActiveTurn();
          }
        }
      },
      result,
      cancel: async (): Promise<void> => turn.cancel({ reason: "cancelled_by_request" }),
      closeEvents: async (): Promise<void> => {
        await turn.closeStream();
        clearActiveTurn();
      }
    };
  }

  async cancel(sessionId: number): Promise<void> {
    const activeTurn = this.activeTurns.get(sessionId);
    if (activeTurn !== undefined) {
      await activeTurn.turn.cancel({ reason: "cancelled_by_request" });
      return;
    }
    const session = this.sessions.get(sessionId);
    if (session !== undefined) {
      await session.runtime.cancel({ handle: session.handle, reason: "cancelled_by_request" });
    }
  }

  async reset(input: RuntimeSessionInput): Promise<void> {
    this.assertRunning();
    await this.serializeSession(input.sessionId, async () => {
      await this.ensureSessionLocked(input);
      const session = this.sessions.get(input.sessionId);
      if (session === undefined) {
        throw new AgentRuntimeError("session_not_ready", "Runtime session has not been ensured");
      }
      await session.runtime.close({
        handle: session.handle,
        reason: "provider_session_reset",
        discardPersistentState: true
      });
      this.sessions.delete(input.sessionId);
      this.activeTurns.delete(input.sessionId);
      session.registry.unregister(session.target);
    });
  }

  async forgetSession(sessionId: number): Promise<void> {
    this.assertRunning();
    await this.serializeSession(sessionId, async () => {
      const session = this.sessions.get(sessionId);
      if (session === undefined) return;
      try {
        await session.runtime.close({
          handle: session.handle,
          reason: "session_deleted",
          discardPersistentState: true
        });
      } finally {
        this.sessions.delete(sessionId);
        this.activeTurns.delete(sessionId);
        session.registry.unregister(session.target);
      }
    });
  }

  async doctor(provider: Provider, agentId: number): Promise<RuntimeDoctor> {
    this.assertRunning();
    const sessionId = 0;
    assertTarget(provider, agentId, sessionId);
    const registry = new RemoteAgentRegistry(this.config.dataDir, this.skillManager);
    const probeAgent = registry.register({
      provider,
      agentId,
      sessionId,
      browserProfilePath: join(this.config.dataDir, "agents", String(agentId), "doctor-browser"),
      instructions: ""
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

  /**
   * Stops accepting work, cancels active Turns, and closes cached Handles without discarding persistent state.
   */
  shutdown(): Promise<void> {
    if (this.shutdownPromise === undefined) {
      this.shutdownPromise = this.performShutdown();
      return this.shutdownPromise;
    }
    return this.shutdownPromise.then(
      () => this.throwCurrentShutdownFailures(),
      (error: unknown) => {
        this.throwCurrentShutdownFailures();
        throw error;
      }
    );
  }

  /**
   * Exposes an immutable snapshot, including failures recorded after the first bounded shutdown attempt.
   */
  get shutdownFailureState(): readonly RuntimeShutdownFailureSnapshot[] {
    return Object.freeze(this.shutdownFailures.map(({ stage, sessionId, message }) => Object.freeze({
      stage,
      sessionId,
      message
    })));
  }

  private async performShutdown(): Promise<void> {
    this.shuttingDown = true;

    const activeTurns = [...this.activeTurns.entries()];
    await Promise.all(activeTurns.map(async ([sessionId, { turn }]) => {
      const outcome = await settleBestEffort(() => turn.cancel({ reason: "service_shutdown" }));
      if (outcome.status !== "fulfilled") {
        this.recordShutdownFailure("active_cancel", sessionId, outcome.reason);
      }
    }));

    const operations = [...this.sessionOperations.entries()];
    await Promise.all(operations.map(async ([sessionId, operation]) => {
      const outcome = await settleBestEffort(() => operation.completion);
      if (outcome.status !== "fulfilled") {
        this.recordShutdownFailure("session_operation", sessionId, outcome.reason);
      }
    }));
    const sessions = [...this.sessions.entries()];
    await Promise.all(sessions.map(async ([sessionId, session]) => {
      const outcome = await settleBestEffort(() => this.serializeSession(sessionId, async () => {
        await session.runtime.close({ handle: session.handle, reason: "service_shutdown" });
      }));
      if (outcome.status === "fulfilled") {
        if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
        session.registry.unregister(session.target);
        this.activeTurns.delete(sessionId);
      } else {
        this.recordShutdownFailure("handle_close", sessionId, outcome.reason);
      }
    }));

    if (this.shutdownFailures.length > 0) {
      const error = this.createShutdownError();
      console.error(error);
      throw error;
    }
  }

  private createShutdownError(): AggregateError {
    return new AggregateError(
      [...this.shutdownFailures],
      "Runtime shutdown timed out or failed; process exit is required to release any remaining provider resources"
    );
  }

  private throwCurrentShutdownFailures(): void {
    if (this.shutdownFailures.length > 0) throw this.createShutdownError();
  }

  private recordShutdownFailure(
    stage: RuntimeShutdownFailure["stage"],
    sessionId: number,
    reason: unknown
  ): void {
    this.shutdownFailures.push(new RuntimeShutdownFailure(stage, sessionId, reason));
  }

  private canReuse(session: ManagedSession, input: RuntimeSessionInput): boolean {
    return session.provider === input.provider
      && session.agentId === input.agentId
      && session.workspacePath === input.workspacePath
      && session.browserProfilePath === input.browserProfilePath
      && session.instructions === input.instructions
      && (input.providerSessionId === null || session.providerSessionId === input.providerSessionId);
  }

  private assertRunning(): void {
    if (this.shuttingDown) {
      throw new AgentRuntimeError("runtime_shutdown", "Runtime is shutting down");
    }
  }

  private clearActiveTurn(sessionId: number, activeTurn: ActiveTurn): void {
    if (this.activeTurns.get(sessionId) === activeTurn) this.activeTurns.delete(sessionId);
  }

  private serializeSession<T>(sessionId: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionOperations.get(sessionId)?.barrier ?? Promise.resolve();
    const run = previous.then(operation);
    const completion = run.then(() => undefined);
    const state: SessionOperation = {
      completion,
      barrier: completion.catch(() => undefined)
    };
    this.sessionOperations.set(sessionId, state);
    return run.finally(() => {
      if (this.sessionOperations.get(sessionId) === state) this.sessionOperations.delete(sessionId);
    });
  }

  private createRuntime(
    agentRegistry: AcpAgentRegistry,
    probeAgent?: string,
    mcpServers: RuntimeSessionInput["mcpServers"] = []
  ): AcpRuntime {
    const options: AcpRuntimeOptions = {
      cwd: this.config.projectEnvironmentsRoot,
      sessionStore: createRuntimeStore({ stateDir: join(this.config.dataDir, "acpx") }),
      agentRegistry,
      permissionMode: "approve-all",
      nonInteractivePermissions: "fail",
      mcpServers,
      ...(probeAgent === undefined ? {} : { probeAgent })
    };
    return createAcpRuntime(options);
  }
}
