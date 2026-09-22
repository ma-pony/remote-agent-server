import { UsageError } from "./core/errors.js";
import { loadModelTokenizers } from "./tokenizer-config.js";
import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type Database from "better-sqlite3";
import type { AppConfig } from "../config.js";
import { HostUsageCollector } from "./host-collector.js";
import { FileUsageSource } from "./adapters/file-source.js";
import { parseProviderLog, createProviderLogParser } from "./adapters/provider-logs.js";
import { parseContextSnapshot } from "./adapters/context-snapshot.js";
import type { SourceConfig, SourceRecord } from "./source-coordinator.js";

export type SourceRegistration = {
  sourceKey: string;
  kind: "codex_log" | "claude_log" | "context_snapshot";
  inputRef: { importRootId: string; relativePath: string } | { providerSessionRef: string; relativePath: string };
  mappings: Array<{ sourceSessionKey: string; sessionId: string; providerEpochId: string }>;
};
type HostSession = { agent_id: number; provider: string; provider_session_id: string | null };

/** Host authority over paths and subject mappings; the reusable coordinator never discovers files. */
export class ManagedUsageSources {
  readonly collector: HostUsageCollector;
  private readonly adapters: Record<SourceRegistration["kind"], FileUsageSource>;
  constructor(private readonly db: Database.Database, private readonly config: AppConfig) {
    this.adapters = Object.fromEntries((["codex_log", "claude_log", "context_snapshot"] as const).map((kind) => [kind, new FileUsageSource({
      resolve: (input) => this.resolve(input, kind),
      parse: (text) => kind === "context_snapshot" ? parseContextSnapshot(text) : parseProviderLog(kind, text.split("\n")),
      appendOnly: kind !== "context_snapshot",
      incremental: kind === "context_snapshot" ? undefined : (state) => createProviderLogParser(kind, state),
      capabilities: { usage: kind === "codex_log" ? "provider_session" : "model_request", context: kind === "context_snapshot" ? "partial" : "none",
        identity: "explicit", version: kind === "context_snapshot" ? "context-snapshot/1" : "provider-logs/1" }
    })])) as Record<SourceRegistration["kind"], FileUsageSource>;
    this.collector = new HostUsageCollector(db, this.adapters, (sessionId) => this.discover(sessionId), loadModelTokenizers(config.usageTokenizers, resolve(config.dataDir, "tokenizers")));
  }

  private async discover(sessionId: number): Promise<void> {
    const session = this.session(String(sessionId));
    if (!session.provider_session_id || !["codex", "claude_code"].includes(session.provider)) return;
    const nativeSessionId = session.provider_session_id;
    const providerRoot = join(this.config.dataDir, "agents", String(session.agent_id), "provider-home");
    const kind = session.provider === "codex" ? "codex_log" : "claude_log";
    const root = kind === "codex_log" ? join(providerRoot, "codex", "sessions", String(sessionId)) : join(providerRoot, "claude");
    const epoch = this.collector.epoch(sessionId);
    const existing = new Set(this.collector.sources.listSources(this.collector.namespace, { sessionId: String(sessionId) })
      .map((source) => source.sourceKey));
    let visited = 0;
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > 8) throw new UsageError("usage_discovery_limit");
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      for (const entry of entries) {
        if (++visited > 5000) throw new UsageError("usage_discovery_limit");
        if (entry.isDirectory()) { await walk(join(directory, entry.name), depth + 1); continue; }
        if (!entry.isFile() || !(entry.name === `${nativeSessionId}.jsonl`
          || kind === "codex_log" && entry.name.endsWith(`-${nativeSessionId}.jsonl`))) continue;
        const path = relative(root, join(directory, entry.name));
        const sourceKey = `managed:${epoch}:${path}`;
        if (existing.has(sourceKey)) continue;
        await this.register({ sourceKey, kind, inputRef: { providerSessionRef: String(sessionId), relativePath: path },
          mappings: [{ sourceSessionKey: nativeSessionId, sessionId: String(sessionId), providerEpochId: epoch }] });
      }
    };
    await walk(kind === "codex_log" ? join(root, "sessions") : join(root, "projects"), 0);
  }

  async register(request: SourceRegistration): Promise<{ source: SourceRecord; created: boolean }> {
    const mappings = request.mappings.map((mapping) => {
      const sessionId = Number(mapping.sessionId);
      const session = this.session(mapping.sessionId);
      const binding = this.collector.binding(sessionId);
      const subject = this.db.prepare("SELECT state FROM agent_usage_subjects WHERE namespace = ? AND kind = 'session' AND subject_id = ?")
        .get(binding.namespace, binding.sessionId) as { state: string };
      if (subject.state !== "active") throw new UsageError("usage_collection_pending");
      const currentEpoch = this.collector.epoch(sessionId);
      const knownEpoch = this.db.prepare("SELECT 1 FROM agent_usage_ledger WHERE namespace = ? AND session_id = ? AND epoch_id = ? LIMIT 1")
        .get(binding.namespace, binding.sessionId, mapping.providerEpochId);
      if (mapping.providerEpochId !== currentEpoch && knownEpoch === undefined) throw new UsageError("usage_epoch_mismatch");
      if ("providerSessionRef" in request.inputRef && (request.inputRef.providerSessionRef !== mapping.sessionId
        || session.provider_session_id !== mapping.sourceSessionKey)) throw new UsageError("usage_mapping_mismatch");
      return { ...mapping, agentId: String(session.agent_id) };
    });
    const inputRef: Record<string, string> = { ...request.inputRef };
    const boundary = JSON.parse(await this.adapters[request.kind].freeze(inputRef)) as { identity: string };
    inputRef.fileIdentity = boundary.identity;
    const config: SourceConfig = { ...request, namespace: this.collector.namespace, mappings, inputRef };
    const existed = this.collector.sources.listSources(this.collector.namespace, { sourceKey: request.sourceKey }).length > 0;
    // Revalidate inside registration after path I/O: maintenance/deletion may have started meanwhile.
    for (const mapping of mappings) {
      this.session(mapping.sessionId);
      const binding = this.collector.binding(Number(mapping.sessionId));
      if (this.collector.sources.maintenance(binding)) throw new UsageError("usage_collection_pending");
    }
    return { source: this.collector.sources.registerSource(config), created: !existed };
  }

  private session(id: string): HostSession {
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new UsageError("usage_session_not_found");
    const row = this.db.prepare("SELECT s.agent_id, s.provider_session_id, a.provider FROM sessions s JOIN agents a ON a.id = s.agent_id WHERE s.id = ?")
      .get(Number(id)) as HostSession | undefined;
    if (!row) throw new UsageError("usage_session_not_found");
    return row;
  }

  private async resolve(input: Record<string, string>, kind: SourceRegistration["kind"]): Promise<string> {
    const path = input.relativePath;
    if (!path || isAbsolute(path) || path.includes("\0") || path.split(/[\\/]/).includes("..")) throw new UsageError("usage_source_path_denied");
    let root: string;
    if (input.importRootId !== undefined && input.providerSessionRef === undefined) {
      const configured = this.config.usageImportRoots?.[input.importRootId];
      if (!configured) throw new UsageError("usage_source_path_denied");
      root = configured;
    } else if (input.providerSessionRef !== undefined && input.importRootId === undefined) {
      const session = this.session(input.providerSessionRef);
      if (kind === "codex_log" && session.provider === "codex") {
        root = join(this.config.dataDir, "agents", String(session.agent_id), "provider-home", "codex", "sessions", input.providerSessionRef);
      } else if (kind === "claude_log" && session.provider === "claude_code" && session.provider_session_id !== null) {
        if (path.split(/[\\/]/).at(-1) !== `${session.provider_session_id}.jsonl`) throw new UsageError("usage_source_path_denied");
        root = join(this.config.dataDir, "agents", String(session.agent_id), "provider-home", "claude");
      } else throw new UsageError("usage_source_path_denied");
    } else throw new UsageError("usage_source_path_denied");
    try {
      const [base, file] = await Promise.all([realpath(root), realpath(join(root, path))]);
      const relativePath = relative(base, file);
      if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new Error();
      return file;
    } catch { throw new UsageError("usage_source_path_denied"); }
  }
}
