import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
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
import type { ProviderExtensionManager } from "../provider-extensions/provider-extension-manager.js";
import { SkillManager } from "../skills/skill-manager.js";
import type {
  AgentRuntime,
  RuntimeDoctor,
  RuntimeEvent,
  RuntimeModelCatalog,
  RuntimeModelCatalogInput,
  RuntimeSession,
  RuntimeSessionInput,
  RuntimeTurn,
  RuntimeTurnInput,
  RuntimeTurnResult
} from "./agent-runtime.js";
import { settleBestEffort } from "./bounded-operation.js";
import { ProviderExtensionProjector } from "./provider-extension-projector.js";

export const RUNTIME_RELEASE_RETRY_MS = 5_000;

export const ACP_AGENT = {
  claude_code: "claude",
  codex: "codex",
  hermes: "hermes"
} as const;

const ACP_COMMAND: Record<(typeof ACP_AGENT)[Provider], string> = {
  claude: "npx -y @agentclientprotocol/claude-agent-acp@^0.60.0",
  codex: "",
  hermes: "hermes acp"
};
const CODEX_ACP_ENTRYPOINT = createRequire(import.meta.url).resolve("@agentclientprotocol/codex-acp");

const providers = new Set<Provider>(["claude_code", "codex", "hermes"]);
type RuntimeTarget = {
  provider: Provider;
  agentId: number;
  coreProfileId: number;
  legacySessionNamespace: boolean;
  sessionId: number;
  browserProfilePath: string;
  instructions: string;
};

export class AgentRuntimeError extends Error {
  constructor(
    readonly code:
      | "invalid_runtime_target"
      | "session_not_ready"
      | "session_resume_failed"
      | "runtime_shutdown"
      | "model_selection_unsupported",
    message: string
  ) {
    super(message);
    this.name = "AgentRuntimeError";
  }
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const acpCommand = (provider: Provider): string => provider === "codex"
  ? `${shellQuote(process.execPath)} ${shellQuote(CODEX_ACP_ENTRYPOINT)}`
  : ACP_COMMAND[ACP_AGENT[provider]];

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

const copyProviderHome = async (source: string, destination: string): Promise<void> => {
  await mkdir(destination, { recursive: true });
  let entries: string[];
  try {
    entries = await readdir(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  await Promise.all(entries.map(async (entry) => {
    if (isRuntimeProviderEntry(entry)) return;
    const sourcePath = join(source, entry);
    const destinationPath = join(destination, entry);
    await rm(destinationPath, { force: true, recursive: true });
    await cp(sourcePath, destinationPath, {
      recursive: true,
      force: true,
      mode: constants.COPYFILE_FICLONE,
      filter: (path) => path === sourcePath
        || !relative(sourcePath, path).split(sep).some(isRuntimeProviderEntry)
    });
  }));
};

const codexConfigWithManagedSettings = async (
  home: string,
  instructions: string,
  disabledSkills: string
): Promise<string> => {
  const managedMcpStart = "# remote-agent-mcp-exposure-start";
  const managedMcpEnd = "# remote-agent-mcp-exposure-end";
  const path = join(home, "config.toml");
  let hostConfig = "";
  try {
    hostConfig = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const withoutManagedMcp = hostConfig
    .replace(new RegExp(`${managedMcpStart}[\\s\\S]*?${managedMcpEnd}\\s*`, "g"), "");
  const preservedConfig = withoutManagedMcp
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
  return target.legacySessionNamespace || target.coreProfileId === 0
    ? `remote:${target.provider}:${target.agentId}:${target.sessionId}`
    : `remote:${target.provider}:${target.agentId}:${target.coreProfileId}:${target.sessionId}`;
};

const persistentSessionKey = (input: RuntimeSessionInput): string => input.coreProfileId === undefined
  || input.legacySessionNamespace !== false
  ? `remote-agent:${input.sessionId}`
  : `remote-agent:${input.sessionId}:core:${input.coreProfileId}`;

class RemoteAgentRegistry implements AcpAgentRegistry {
  private readonly targets = new Map<string, RuntimeTarget>();
  private readonly commands = new Map<string, string>();

  constructor(
    private readonly dataDir: string,
    private readonly skillManager: SkillManager,
    private readonly providerHomePreparations: Map<string, Promise<void>>,
    private readonly extensionProjector?: ProviderExtensionProjector
  ) {}

  register(target: RuntimeTarget): string {
    const name = targetName(target);
    this.targets.set(name, target);
    return name;
  }

  async prepare(agentName: string): Promise<void> {
    const target = this.targets.get(agentName);
    if (target === undefined) {
      throw new AgentRuntimeError("invalid_runtime_target", "Unknown Runtime target");
    }

    const providerHome = join(this.dataDir, "agents", String(target.agentId), "provider-home");
    const environment = [`REMOTE_AGENT_BROWSER_PROFILE=${shellQuote(target.browserProfilePath)}`];
    if (target.provider === "hermes") {
      const home = join(providerHome, "hermes");
      const hostHome = process.env.HERMES_HOME ?? join(homedir(), ".hermes");
      await this.prepareProviderHome(hostHome, home);
      environment.push(`HERMES_HOME=${shellQuote(home)}`);
    } else if (target.provider === "codex") {
      const agentHome = join(providerHome, "codex");
      const home = target.legacySessionNamespace
        ? join(agentHome, "sessions", String(target.sessionId))
        : join(agentHome, "profiles", String(target.coreProfileId), "sessions", String(target.sessionId));
      const hostHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
      await this.prepareProviderHome(hostHome, home);
      await this.extensionProjector?.prepare({ agentId: target.agentId, provider: target.provider, home });
      const disabledSkills = this.skillManager.hostSkillFiles().map((path) => [
        "[[skills.config]]",
        `path = ${JSON.stringify(path)}`,
        "enabled = false"
      ].join("\n")).join("\n\n");
      const config = await codexConfigWithManagedSettings(
        home,
        target.instructions,
        disabledSkills
      );
      await writeFile(join(home, "config.toml"), config === "" ? "" : `${config}\n`, { mode: 0o600 });
      environment.push(`CODEX_HOME=${shellQuote(home)}`);
    } else {
      const home = join(providerHome, "claude");
      const hostHome = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
      await this.prepareProviderHome(hostHome, home);
      await this.extensionProjector?.prepare({ agentId: target.agentId, provider: target.provider, home });
      environment.push(`CLAUDE_CONFIG_DIR=${shellQuote(home)}`);
    }
    this.commands.set(agentName, `env ${environment.join(" ")} ${acpCommand(target.provider)}`);
  }

  resolve(agentName: string): string {
    const command = this.commands.get(agentName);
    if (command === undefined) {
      throw new AgentRuntimeError("session_not_ready", "Runtime target has not been prepared");
    }
    return command;
  }

  list(): string[] {
    return [...this.targets.keys()];
  }

  clear(): void {
    this.targets.clear();
    this.commands.clear();
  }

  unregister(agentName: string): void {
    this.targets.delete(agentName);
    this.commands.delete(agentName);
  }

  private async prepareProviderHome(source: string, destination: string): Promise<void> {
    let preparation = this.providerHomePreparations.get(destination);
    if (preparation === undefined) {
      preparation = copyProviderHome(source, destination);
      this.providerHomePreparations.set(destination, preparation);
      void preparation.catch(() => {
        if (this.providerHomePreparations.get(destination) === preparation) {
          this.providerHomePreparations.delete(destination);
        }
      });
    }
    await preparation;
  }
}

type ManagedSession = {
  runtime: AcpRuntime;
  registry: RemoteAgentRegistry;
  handle: AcpRuntimeHandle;
  providerSessionId: string | null;
  provider: Provider;
  agentId: number;
  coreProfileId: number;
  workspacePath: string;
  browserProfilePath: string;
  instructions: string;
  configurationFingerprint: string;
  target: string;
  model?: string;
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

const configurationFingerprint = (input: RuntimeSessionInput): string => createHash("sha256")
  .update(JSON.stringify({
    instructions: input.instructions,
    memory: input.memory,
    skillsRevision: input.skillsRevision ?? "",
    extensionsRevision: input.extensionsRevision ?? "",
    mcpServers: input.mcpServers
  }))
  .digest("hex");

/**
 * Adapts the embedded acpx API to the service's provider-neutral Runtime contract.
 */
export class AcpxAgentRuntime implements AgentRuntime {
  private readonly sessions = new Map<number, ManagedSession>();
  private readonly activeTurns = new Map<number, ActiveTurn>();
  private readonly sessionOperations = new Map<number, SessionOperation>();
  private readonly idleTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly releaseRetryTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | undefined;
  private readonly shutdownFailures: RuntimeShutdownFailure[] = [];
  private readonly providerHomePreparations = new Map<string, Promise<void>>();
  private readonly extensionProjector: ProviderExtensionProjector | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly skillManager = new SkillManager({ dataDir: config.dataDir }),
    providerExtensionManager?: ProviderExtensionManager
  ) {
    this.extensionProjector = providerExtensionManager === undefined
      ? undefined
      : new ProviderExtensionProjector(providerExtensionManager);
  }

  async ensureSession(input: RuntimeSessionInput): Promise<RuntimeSession> {
    this.assertRunning();
    this.clearIdleTimer(input.sessionId);
    if (this.releaseRetryTimers.has(input.sessionId)) {
      this.clearReleaseRetryTimer(input.sessionId);
      await this.releaseSession(input.sessionId);
    }
    return this.serializeSession(input.sessionId, () => this.ensureSessionLocked(input));
  }

  private async ensureSessionLocked(input: RuntimeSessionInput): Promise<RuntimeSession> {
    assertTarget(input.provider, input.agentId, input.sessionId);
    const existing = this.sessions.get(input.sessionId);
    const reusable = existing !== undefined && this.canReuse(existing, input);
    if (reusable) {
      await this.applyModel(existing, input.model);
      return { providerSessionId: existing.providerSessionId };
    }
    if (existing !== undefined) {
      await existing.runtime.close({
        handle: existing.handle,
        reason: this.hasSameTarget(existing, input) ? "session_handle_refreshed" : "session_handle_replaced"
      });
      this.sessions.delete(input.sessionId);
      existing.registry.unregister(existing.target);
    }

    const registry = new RemoteAgentRegistry(
      this.config.dataDir,
      this.skillManager,
      this.providerHomePreparations,
      this.extensionProjector
    );
    const agent = registry.register({
      provider: input.provider,
      agentId: input.agentId,
      coreProfileId: input.coreProfileId ?? 0,
      legacySessionNamespace: input.legacySessionNamespace ?? true,
      sessionId: input.sessionId,
      browserProfilePath: input.browserProfilePath,
      instructions: input.instructions
    });
    await registry.prepare(agent);
    const runtime = this.createRuntime(registry, undefined, input.mcpServers);
    const sessionOptions = {
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.providerSessionId === null && input.provider === "claude_code"
        ? { systemPrompt: { append: systemPrompt(input) } }
        : {})
    };
    const handle = await runtime.ensureSession({
      sessionKey: persistentSessionKey(input),
      agent,
      mode: "persistent",
      cwd: input.workspacePath,
      ...(Object.keys(sessionOptions).length === 0 ? {} : { sessionOptions }),
      ...(input.providerSessionId === null ? {} : { resumeSessionId: input.providerSessionId })
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
          coreProfileId: input.coreProfileId ?? 0,
          workspacePath: input.workspacePath,
          browserProfilePath: input.browserProfilePath,
          instructions: input.instructions,
          configurationFingerprint: configurationFingerprint(input),
          target: agent,
          ...(input.model === undefined ? {} : { model: input.model })
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
      coreProfileId: input.coreProfileId ?? 0,
      workspacePath: input.workspacePath,
      browserProfilePath: input.browserProfilePath,
      instructions: input.instructions,
      configurationFingerprint: configurationFingerprint(input),
      target: agent,
      ...(input.model === undefined ? {} : { model: input.model })
    });
    return { providerSessionId };
  }

  startTurn(input: RuntimeTurnInput): RuntimeTurn {
    this.assertRunning();
    this.clearIdleTimer(input.sessionId);
    if (this.sessionOperations.has(input.sessionId) || this.releaseRetryTimers.has(input.sessionId)) {
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

  async releaseSession(sessionId: number): Promise<void> {
    this.assertRunning();
    this.clearIdleTimer(sessionId);
    this.clearReleaseRetryTimer(sessionId);
    await this.serializeSession(sessionId, async () => {
      const session = this.sessions.get(sessionId);
      if (session === undefined) return;
      try {
        await session.runtime.close({
          handle: session.handle,
          reason: "runtime_released",
          discardPersistentState: false
        });
      } catch (error) {
        this.scheduleReleaseRetry(sessionId);
        throw error;
      }
      if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
      this.activeTurns.delete(sessionId);
      session.registry.unregister(session.target);
    });
  }

  async reset(input: RuntimeSessionInput): Promise<void> {
    this.assertRunning();
    this.clearIdleTimer(input.sessionId);
    this.clearReleaseRetryTimer(input.sessionId);
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
    this.clearIdleTimer(sessionId);
    this.clearReleaseRetryTimer(sessionId);
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

  async listModels(input: RuntimeModelCatalogInput): Promise<RuntimeModelCatalog> {
    this.assertRunning();
    const sessionId = 0;
    assertTarget(input.provider, input.agentId, sessionId);
    const registry = new RemoteAgentRegistry(
      this.config.dataDir,
      this.skillManager,
      this.providerHomePreparations,
      this.extensionProjector
    );
    const probeAgent = registry.register({
      provider: input.provider,
      agentId: input.agentId,
      coreProfileId: input.coreProfileId ?? 0,
      legacySessionNamespace: false,
      sessionId,
      browserProfilePath: join(this.config.dataDir, "agents", String(input.agentId), "model-catalog-browser"),
      instructions: input.instructions
    });
    await registry.prepare(probeAgent);
    const runtime = this.createRuntime(registry);
    let handle: AcpRuntimeHandle | undefined;
    try {
      handle = await runtime.ensureSession({
        sessionKey: input.coreProfileId === undefined
          ? `remote-agent:model-catalog:${input.agentId}`
          : `remote-agent:model-catalog:${input.agentId}:core:${input.coreProfileId}`,
        agent: probeAgent,
        mode: "oneshot",
        cwd: input.workspacePath
      });
      const status = await runtime.getStatus?.({ handle });
      const availableModels = [...new Set(status?.models?.availableModelIds ?? [])];
      return {
        supported: availableModels.length > 0,
        currentModel: status?.models?.currentModelId ?? null,
        availableModels
      };
    } finally {
      try {
        if (handle !== undefined) {
          await runtime.close({
            handle,
            reason: "model_catalog_loaded",
            discardPersistentState: true
          });
        }
      } finally {
        registry.clear();
      }
    }
  }

  async doctor(provider: Provider, agentId: number): Promise<RuntimeDoctor> {
    this.assertRunning();
    const sessionId = 0;
    assertTarget(provider, agentId, sessionId);
    const registry = new RemoteAgentRegistry(
      this.config.dataDir,
      this.skillManager,
      this.providerHomePreparations,
      this.extensionProjector
    );
    const probeAgent = registry.register({
      provider,
      agentId,
      coreProfileId: 0,
      legacySessionNamespace: false,
      sessionId,
      browserProfilePath: join(this.config.dataDir, "agents", String(agentId), "doctor-browser"),
      instructions: ""
    });
    await registry.prepare(probeAgent);
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
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    for (const timer of this.releaseRetryTimers.values()) clearTimeout(timer);
    this.releaseRetryTimers.clear();

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
    return this.hasSameTarget(session, input)
      && session.instructions === input.instructions
      && session.configurationFingerprint === configurationFingerprint(input);
  }

  private hasSameTarget(session: ManagedSession, input: RuntimeSessionInput): boolean {
    return session.provider === input.provider
      && session.agentId === input.agentId
      && session.coreProfileId === (input.coreProfileId ?? 0)
      && session.workspacePath === input.workspacePath
      && session.browserProfilePath === input.browserProfilePath
      && (input.providerSessionId === null || session.providerSessionId === input.providerSessionId);
  }

  private assertRunning(): void {
    if (this.shuttingDown) {
      throw new AgentRuntimeError("runtime_shutdown", "Runtime is shutting down");
    }
  }

  private clearActiveTurn(sessionId: number, activeTurn: ActiveTurn): void {
    if (this.activeTurns.get(sessionId) !== activeTurn) return;
    this.activeTurns.delete(sessionId);
    this.scheduleIdleRelease(sessionId);
  }

  private scheduleIdleRelease(sessionId: number): void {
    const idleMs = this.config.runtimeIdleMs ?? 0;
    if (idleMs === 0 || this.shuttingDown || !this.sessions.has(sessionId) || this.activeTurns.has(sessionId)) return;
    this.clearIdleTimer(sessionId);
    const timer = setTimeout(() => {
      this.idleTimers.delete(sessionId);
      if (this.shuttingDown || this.activeTurns.has(sessionId) || !this.sessions.has(sessionId)) return;
      void this.releaseSession(sessionId).catch((error: unknown) => console.error(error));
    }, idleMs);
    timer.unref();
    this.idleTimers.set(sessionId, timer);
  }

  private scheduleReleaseRetry(sessionId: number): void {
    if (this.shuttingDown || !this.sessions.has(sessionId)) return;
    this.clearReleaseRetryTimer(sessionId);
    const timer = setTimeout(() => {
      this.releaseRetryTimers.delete(sessionId);
      if (this.shuttingDown || !this.sessions.has(sessionId)) return;
      void this.releaseSession(sessionId).catch((error: unknown) => console.error(error));
    }, RUNTIME_RELEASE_RETRY_MS);
    timer.unref();
    this.releaseRetryTimers.set(sessionId, timer);
  }

  private clearIdleTimer(sessionId: number): void {
    const timer = this.idleTimers.get(sessionId);
    if (timer !== undefined) clearTimeout(timer);
    this.idleTimers.delete(sessionId);
  }

  private clearReleaseRetryTimer(sessionId: number): void {
    const timer = this.releaseRetryTimers.get(sessionId);
    if (timer !== undefined) clearTimeout(timer);
    this.releaseRetryTimers.delete(sessionId);
  }

  private async applyModel(session: ManagedSession, model: string | undefined): Promise<void> {
    if (model === undefined || model === session.model) return;
    if (session.runtime.setConfigOption === undefined) {
      throw new AgentRuntimeError("model_selection_unsupported", "Agent Core does not support model selection");
    }
    await session.runtime.setConfigOption({
      handle: session.handle,
      key: "model",
      value: model
    });
    session.model = model;
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
    const providerMcpServers = mcpServers
      .map(({ startupTimeoutSeconds: _startupTimeoutSeconds, ...server }) => server);
    const options: AcpRuntimeOptions = {
      cwd: this.config.projectEnvironmentsRoot,
      sessionStore: createRuntimeStore({ stateDir: join(this.config.dataDir, "acpx") }),
      agentRegistry,
      permissionMode: "approve-all",
      nonInteractivePermissions: "fail",
      mcpServers: providerMcpServers,
      ...(probeAgent === undefined ? {} : { probeAgent })
    };
    return createAcpRuntime(options);
  }
}
