import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
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
import Database from "better-sqlite3";
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
  sessionId: number;
  providerSessionId: string | null;
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

const copyProviderHome = async (
  source: string,
  destination: string,
  preserveExistingEntries: ReadonlySet<string> = new Set()
): Promise<void> => {
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
    if (!preserveExistingEntries.has(entry)) {
      await rm(destinationPath, { force: true, recursive: true });
    }
    await cp(sourcePath, destinationPath, {
      recursive: true,
      force: true,
      mode: constants.COPYFILE_FICLONE,
      filter: (path) => {
        if (path === sourcePath) return true;
        const parts = relative(sourcePath, path).split(sep);
        return !parts.some(isRuntimeProviderEntry)
          && !(preserveExistingEntries.has(entry) && parts[0]?.startsWith("_remote-agent-managed-"));
      }
    });
  }));
};

const HERMES_HOME_PREPARED_MARKER = ".remote-agent-hermes-home-prepared-v1";
const HERMES_MANAGED_ENTRIES = new Set(["skills"]);

const providerSessionEntry = (name: string, providerSessionId: string): boolean =>
  name === providerSessionId || name.startsWith(`${providerSessionId}.`);

const sessionHomeEntry = (name: string): boolean => /^(?:0|[1-9]\d*)$/.test(name);

/**
 * Copies only one legacy Provider conversation into its Session-owned home.
 * The legacy `sessions` directory now also contains isolated service Sessions,
 * so it is deliberately inspected only one level deep.
 */
const copyLegacyProviderSession = async (
  source: string,
  destination: string,
  providerSessionId: string
): Promise<void> => {
  const copyMatches = async (directory: string, relativeDirectory = ""): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const sourcePath = join(directory, entry.name);
      const destinationPath = join(destination, relativeDirectory, entry.name);
      if (relativeDirectory === "" && entry.name === "sessions" && entry.isDirectory()) {
        const legacySessions = await readdir(sourcePath, { withFileTypes: true }).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        });
        for (const legacySession of legacySessions) {
          if (!providerSessionEntry(legacySession.name, providerSessionId) || sessionHomeEntry(legacySession.name)) continue;
          const legacyPath = join(sourcePath, legacySession.name);
          const migratedPath = join(destinationPath, legacySession.name);
          await mkdir(destinationPath, { recursive: true });
          await rm(migratedPath, { force: true, recursive: true });
          await cp(legacyPath, migratedPath, { recursive: true, force: true, mode: constants.COPYFILE_FICLONE });
        }
        continue;
      }
      if (providerSessionEntry(entry.name, providerSessionId)) {
        await mkdir(join(destination, relativeDirectory), { recursive: true });
        await rm(destinationPath, { force: true, recursive: true });
        await cp(sourcePath, destinationPath, { recursive: true, force: true, mode: constants.COPYFILE_FICLONE });
      } else if (entry.isDirectory()) {
        await copyMatches(sourcePath, join(relativeDirectory, entry.name));
      }
    }
  };
  await copyMatches(source);
};

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const markHermesHomePrepared = async (home: string): Promise<void> => {
  const marker = join(home, HERMES_HOME_PREPARED_MARKER);
  const temporary = `${marker}.tmp-${randomUUID()}`;
  await writeFile(temporary, "ready\n", { mode: 0o600 });
  try {
    await rename(temporary, marker);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};

const removeStateSnapshot = async (path: string): Promise<void> => {
  await Promise.all([path, `${path}-wal`, `${path}-shm`].map((candidate) => rm(candidate, { force: true })));
};

/** Copies a consistent SQLite snapshot, retaining only the resumed session and its lineage. */
const copyLegacyHermesState = async (source: string, destination: string, providerSessionId: string): Promise<boolean> => {
  const sourcePath = join(source, "state.db");
  if (!await fileExists(sourcePath)) return false;
  const destinationPath = join(destination, "state.db");
  const temporaryPath = `${destinationPath}.migration-${randomUUID()}`;
  const sourceDatabase = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    const exists = sourceDatabase.prepare("SELECT 1 FROM sessions WHERE id = ? LIMIT 1").get(providerSessionId);
    if (exists === undefined) return false;
    await sourceDatabase.backup(temporaryPath);
  } catch (error) {
    await removeStateSnapshot(temporaryPath);
    throw error;
  } finally {
    sourceDatabase.close();
  }
  try {
    const migratedDatabase = new Database(temporaryPath);
    try {
      const retained = `WITH RECURSIVE retained(id) AS (
        SELECT id FROM sessions WHERE id = ?
        UNION
        SELECT sessions.parent_session_id FROM sessions JOIN retained ON sessions.id = retained.id
          WHERE sessions.parent_session_id IS NOT NULL
      )`;
      migratedDatabase.prepare(`${retained} DELETE FROM messages WHERE session_id NOT IN (SELECT id FROM retained)`)
        .run(providerSessionId);
      migratedDatabase.prepare(`${retained} DELETE FROM compression_locks WHERE session_id NOT IN (SELECT id FROM retained)`)
        .run(providerSessionId);
      migratedDatabase.prepare(`${retained} DELETE FROM sessions WHERE id NOT IN (SELECT id FROM retained)`)
        .run(providerSessionId);
    } finally {
      migratedDatabase.close();
    }
    await rename(temporaryPath, destinationPath);
    return true;
  } catch (error) {
    await removeStateSnapshot(temporaryPath);
    throw error;
  }
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
  return `remote:${target.provider}:${target.agentId}:${target.sessionId}`;
};

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
      const legacyHome = join(providerHome, "hermes");
      const home = join(legacyHome, "sessions", String(target.sessionId));
      const hostHome = process.env.HERMES_HOME ?? join(homedir(), ".hermes");
      await this.prepareHermesHome(hostHome, legacyHome, home, target.providerSessionId);
      environment.push(`HERMES_HOME=${shellQuote(home)}`);
    } else if (target.provider === "codex") {
      const agentHome = join(providerHome, "codex");
      const home = join(agentHome, "sessions", String(target.sessionId));
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
    await this.prepareHome(destination, () => copyProviderHome(source, destination));
  }

  private async prepareHermesHome(
    hostHome: string,
    legacyHome: string,
    destination: string,
    providerSessionId: string | null
  ): Promise<void> {
    await this.prepareHome(destination, async () => {
      if (await fileExists(join(destination, HERMES_HOME_PREPARED_MARKER))) return;
      await copyProviderHome(hostHome, destination, HERMES_MANAGED_ENTRIES);
      await copyProviderHome(legacyHome, destination, HERMES_MANAGED_ENTRIES);
      if (providerSessionId !== null) {
        await copyLegacyProviderSession(legacyHome, destination, providerSessionId);
        if (!await copyLegacyHermesState(legacyHome, destination, providerSessionId)) {
          throw new AgentRuntimeError("session_resume_failed", "Legacy Hermes state does not contain the Provider session");
        }
      }
      await markHermesHomePrepared(destination);
    });
  }

  private async prepareHome(destination: string, prepare: () => Promise<void>): Promise<void> {
    let preparation = this.providerHomePreparations.get(destination);
    if (preparation === undefined) {
      preparation = prepare();
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
      sessionId: input.sessionId,
      providerSessionId: input.providerSessionId,
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
      sessionKey: `remote-agent:${input.sessionId}`,
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
      sessionId,
      providerSessionId: null,
      browserProfilePath: join(this.config.dataDir, "agents", String(input.agentId), "model-catalog-browser"),
      instructions: input.instructions
    });
    await registry.prepare(probeAgent);
    const runtime = this.createRuntime(registry);
    let handle: AcpRuntimeHandle | undefined;
    try {
      handle = await runtime.ensureSession({
        sessionKey: `remote-agent:model-catalog:${input.agentId}`,
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
      sessionId,
      providerSessionId: null,
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
